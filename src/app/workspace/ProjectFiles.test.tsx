import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectFile, ProjectFileList, ProjectFilesApi } from '../project-files-types';
import { FILE_MAX_BYTES, PROJECT_FILES_MAX_BYTES } from '../project-files-types';
import ProjectFiles from './ProjectFiles';
import { summaryMember, summaryProject, summaryProps } from './summary-test-fixtures';

const row: ProjectFile = {
  id: 'file-a',
  workspace_id: summaryProject.workspace_id,
  project_id: summaryProject.id,
  name: 'Diseño.pdf',
  content_type: 'application/pdf',
  size: 1024,
  status: 'ready',
  object_path: 'internal/path',
  version: 3,
  created_by: summaryProject.owner_id,
  created_at: '2026-10-28T12:00:00Z',
};
function list(items: ProjectFile[]): ProjectFileList {
  return {
    items,
    used_bytes: items.reduce((sum, file) => sum + file.size, 0),
    max_bytes: PROJECT_FILES_MAX_BYTES,
    max_file_bytes: FILE_MAX_BYTES,
    max_files: 100,
  };
}
function api(initial: ProjectFile[] = [row]): ProjectFilesApi {
  let items = initial;
  return {
    scopeKey: ['files', 'user', 'workspace'],
    list: vi.fn().mockImplementation(async () => list(items)),
    upload: vi.fn().mockImplementation(async (_project, file: File, id: string) => {
      const saved = { ...row, id, name: file.name, size: file.size, version: 1 };
      items = [...items, saved];
      return saved;
    }),
    download: vi.fn().mockResolvedValue(new Blob(['content'], { type: 'application/pdf' })),
    rename: vi.fn().mockImplementation(async (file: ProjectFile, name: string) => {
      const saved = { ...file, name, version: file.version + 1 };
      items = items.map(item => (item.id === file.id ? saved : item));
      return saved;
    }),
    remove: vi.fn().mockImplementation(async (file: ProjectFile) => {
      items = items.filter(item => item.id !== file.id);
    }),
  };
}
function provider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { client, wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
async function mount(source = api(), data = summaryProps(), project = summaryProject) {
  const supplied = provider();
  const view = render(<ProjectFiles data={data} project={project} api={source} />, { wrapper: supplied.wrapper });
  await waitFor(() => expect(source.list).toHaveBeenCalled());
  return { ...view, ...supplied, source, data };
}
async function openMenu(name = row.name) {
  await userEvent.click(screen.getByRole('button', { name: `Opciones de ${name}` }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('archivos privados del proyecto', () => {
  it('abre los detalles solicitados desde búsqueda sin descargar el contenido', async () => {
    const source = api();
    const { wrapper } = provider();
    render(<ProjectFiles data={summaryProps()} project={summaryProject} api={source} focusFileId={row.id} />, { wrapper });
    await screen.findByRole('dialog');
    expect(screen.getByRole('dialog')).toHaveTextContent(row.name);
    expect(source.download).not.toHaveBeenCalled();
    expect(source.remove).not.toHaveBeenCalled();
  });
  it('ofrece cuadrícula/lista, filtros y metadatos con colores sin descargar para previsualizar', async () => {
    const source = api([row, { ...row, id: 'text', name: 'Notas.txt', content_type: 'text/plain' }]);
    await mount(source);
    expect(await screen.findByRole('button', { name: 'Ver detalles de Diseño.pdf' })).toBeInTheDocument();
    expect(source.download).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Tipo de archivo' }), 'pdf');
    expect(screen.queryByRole('button', { name: 'Ver detalles de Notas.txt' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Lista de archivos' }));
    expect(screen.getByRole('columnheader', { name: 'Subido por' })).toBeInTheDocument();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar archivos' }), 'no existe');
    expect(screen.getByRole('heading', { name: 'No encontramos esos archivos' })).toBeInTheDocument();
    expect(source.download).not.toHaveBeenCalled();
  });
  it('no consulta ni expone filas de un proyecto ilegible o de otro espacio', () => {
    const source = api();
    const { wrapper } = provider();
    render(<ProjectFiles data={summaryProps({ capabilities: {} })} project={summaryProject} api={source} />, { wrapper });
    expect(source.list).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Archivos no disponibles' })).toBeInTheDocument();
  });
  it.each([
    { readOnly: true },
    { project: { ...summaryProject, archived_at: '2026-10-28T12:00:00Z' } },
    { capabilities: { [summaryProject.id]: { project_id: summaryProject.id, permissions: ['project.read'], access_level: 'read' } } },
  ])('conserva lectura y descarga sin escrituras: %j', async extra => {
    const project = 'project' in extra ? extra.project : summaryProject;
    const { project: _, ...override } = extra as {
      project?: typeof summaryProject;
      readOnly?: boolean;
      capabilities?: ReturnType<typeof summaryProps>['capabilities'];
    };
    void _;
    await mount(api(), summaryProps(override), project);
    await screen.findByRole('button', { name: 'Ver detalles de Diseño.pdf' });
    expect(screen.queryByRole('button', { name: 'Subir archivos' })).not.toBeInTheDocument();
    await openMenu();
    expect(screen.getByRole('menuitem', { name: 'Descargar' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Cambiar nombre' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Eliminar archivo' })).not.toBeInTheDocument();
  });
  it('valida formato/tamaño y quota del proyecto antes de transmitir archivos', async () => {
    const source = api([]);
    vi.mocked(source.list).mockResolvedValue({ ...list([]), max_bytes: 3 });
    await mount(source);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Subir archivos' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Seleccionar archivos'), { target: { files: [new File(['hello'], 'grande.txt', { type: 'text/plain' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent('supera el almacenamiento');
    expect(source.upload).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Seleccionar archivos'), { target: { files: [new File(['x'], 'script.html', { type: 'text/html' })] } });
    expect(screen.getByText(/extensión admitida/)).toBeInTheDocument();
    expect(source.upload).not.toHaveBeenCalled();
  });
  it('un lote de formatos rechazados no bloquea seleccionar archivos válidos después', async () => {
    const source = api([]);
    await mount(source);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Subir archivos' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Seleccionar archivos'), {
      target: { files: Array.from({ length: 10 }, (_, i) => new File(['x'], `script-${i}.html`, { type: 'text/html' })) },
    });
    expect(source.upload).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Seleccionar archivos'), { target: { files: [new File(['texto'], 'nota.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(source.upload).toHaveBeenCalledOnce());
    expect(await screen.findByText('Guardado')).toBeInTheDocument();
  });

  it('actualiza el presupuesto reservado tras un fallo sin mostrar cinco MiB como tamaño del archivo', async () => {
    const source = api([]);
    vi.mocked(source.upload).mockImplementationOnce(async (_project, file: File, id: string) => {
      vi.mocked(source.list).mockResolvedValue({ ...list([{ ...row, id, name: file.name, size: file.size, status: 'pending' }]), used_bytes: FILE_MAX_BYTES });
      throw new Error('Respuesta perdida');
    });
    await mount(source);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Subir archivos' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Seleccionar archivos'), { target: { files: [new File(['hola'], 'nota.txt', { type: 'text/plain' })] } });
    expect(await screen.findByText('Respuesta perdida')).toBeInTheDocument();
    expect(await screen.findByText(/1 archivo · 5 MB de 50 MB/)).toBeInTheDocument();
    expect(screen.getByText(/4 B · Tú/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeEnabled();
  });

  it('exige cinco MiB de margen temporal incluso para una carga pequeña', async () => {
    const pending = Array.from({ length: 9 }, (_, id) => ({ ...row, id: `pending-${id}`, status: 'pending' as const, size: 1 }));
    const source = api([...pending, { ...row, size: 1 }]);
    vi.mocked(source.list).mockResolvedValue({ ...list([...pending, { ...row, size: 1 }]), used_bytes: 9 * FILE_MAX_BYTES + 1 });
    await mount(source);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Subir archivos' })).toBeEnabled());
    expect(screen.getByText('Necesitas 5 MiB libres para iniciar una carga; al confirmarse cuenta su tamaño real.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Seleccionar archivos'), { target: { files: [new File(['a'], 'nota.txt', { type: 'text/plain' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent('supera el almacenamiento');
    expect(source.upload).not.toHaveBeenCalled();
  });

  it('limita cada lote a diez archivos y no fabrica porcentajes', async () => {
    const source = api([]);
    await mount(source);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Subir archivos' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Seleccionar archivos'), {
      target: { files: Array.from({ length: 11 }, (_, i) => new File(['hello'], `${i}.txt`, { type: 'text/plain' })) },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('hasta 10');
    expect(source.upload).not.toHaveBeenCalled();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
  });
  it('sube secuencialmente y reintenta con la misma identidad tras una respuesta ambigua', async () => {
    const source = api([]);
    vi.mocked(source.upload)
      .mockRejectedValueOnce(new Error('Respuesta perdida'))
      .mockResolvedValueOnce({ ...row, id: 'confirmed', name: 'nota.txt', size: 4 });
    await mount(source);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Subir archivos' })).toBeEnabled());
    const file = new File(['hola'], 'nota.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Seleccionar archivos'), { target: { files: [file] } });
    expect(await screen.findByText('Respuesta perdida')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(source.upload).toHaveBeenCalledTimes(2));
    expect(vi.mocked(source.upload).mock.calls[1]).toEqual(vi.mocked(source.upload).mock.calls[0]);
    expect(screen.getByText('Guardado')).toBeInTheDocument();
  });
  it('no transmite el segundo archivo hasta confirmar el primero', async () => {
    const source = api([]),
      pending = deferred<ProjectFile>();
    vi.mocked(source.upload)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ...row, id: 'second' });
    await mount(source);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Subir archivos' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Seleccionar archivos'), {
      target: { files: [new File(['a'], 'a.txt', { type: 'text/plain' }), new File(['b'], 'b.txt', { type: 'text/plain' })] },
    });
    await waitFor(() => expect(source.upload).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Subiendo y confirmando…')).toBeInTheDocument();
    await act(async () => pending.resolve({ ...row, id: 'first' }));
    await waitFor(() => expect(source.upload).toHaveBeenCalledTimes(2));
  });
  it('conserva el nombre y la versión de edición si llega un conflicto', async () => {
    const source = api();
    vi.mocked(source.rename)
      .mockRejectedValueOnce(new Error('La versión cambió'))
      .mockResolvedValueOnce({ ...row, name: 'Edición.pdf', version: 4 });
    const input = await mount(source);
    await screen.findByRole('button', { name: 'Ver detalles de Diseño.pdf' });
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cambiar nombre' }));
    await userEvent.clear(screen.getByRole('textbox', { name: 'Nombre del archivo' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Nombre del archivo' }), 'Edición.pdf');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar nombre' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La versión cambió');
    input.rerender(<ProjectFiles data={summaryProps()} project={summaryProject} api={source} />);
    expect(screen.getByRole('textbox', { name: 'Nombre del archivo' })).toHaveValue('Edición.pdf');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar nombre' }));
    await waitFor(() => expect(source.rename).toHaveBeenCalledTimes(2));
    expect(vi.mocked(source.rename).mock.calls[1]).toEqual([row, 'Edición.pdf']);
  });
  it('pide el nombre exacto y elimina únicamente el archivo elegido', async () => {
    const source = api([row, { ...row, id: 'kept', name: 'Conservado.pdf' }]);
    await mount(source);
    await screen.findByRole('button', { name: 'Ver detalles de Diseño.pdf' });
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Eliminar archivo' }));
    expect(screen.getByRole('button', { name: 'Eliminar archivo definitivamente' })).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Escribe el nombre exacto del archivo' }), row.name);
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar archivo definitivamente' }));
    await waitFor(() => expect(source.remove).toHaveBeenCalledExactlyOnceWith(row));
    expect(await screen.findByRole('button', { name: 'Ver detalles de Conservado.pdf' })).toBeInTheDocument();
  });
  it('ofrece retirar cargas incompletas sin permitir descargar o renombrarlas', async () => {
    const source = api([{ ...row, status: 'pending' }]);
    await mount(source);
    await screen.findByText('Carga pendiente de confirmar');
    await openMenu();
    expect(screen.getByRole('menuitem', { name: 'Retirar carga' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Descargar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Cambiar nombre' })).not.toBeInTheDocument();
  });
  it('oculta autores del directorio no autorizado y usa Tú solo para la cuenta actual', async () => {
    const source = api([{ ...row, created_by: summaryMember.user_id }]);
    await mount(
      source,
      summaryProps({
        currentUserId: 'reader',
        workspace: {
          id: summaryProject.workspace_id,
          kind: 'team',
          name: 'Editorial',
          owner_id: summaryProject.owner_id,
          version: 1,
          permissions: ['project.read'],
        },
        capabilities: { [summaryProject.id]: { project_id: summaryProject.id, permissions: ['project.read'], access_level: 'read' } },
        members: [summaryMember],
      }),
    );
    await screen.findByRole('button', { name: 'Ver detalles de Diseño.pdf' });
    expect(screen.queryByText(summaryMember.display_name)).not.toBeInTheDocument();
    expect(screen.getByText(/Miembro/)).toBeInTheDocument();
  });
  it('descarta descargas tardías al cambiar de cuenta antes de crear una URL local', async () => {
    const source = api(),
      pending = deferred<Blob>();
    vi.mocked(source.download).mockReturnValueOnce(pending.promise);
    const create = vi.fn(() => 'blob:private');
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = create;
        static revokeObjectURL = vi.fn();
      },
    );
    const view = await mount(source);
    await screen.findByRole('button', { name: 'Ver detalles de Diseño.pdf' });
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Descargar' }));
    await waitFor(() => expect(source.download).toHaveBeenCalledOnce());
    const next = api([]);
    next.scopeKey = ['new-user'];
    view.rerender(<ProjectFiles data={summaryProps({ currentUserId: 'new-user' })} project={summaryProject} api={next} />);
    await act(async () => pending.resolve(new Blob(['secret'])));
    expect(create).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it('ignora subidas y consultas tardías del proyecto anterior', async () => {
    const source = api([]),
      waiting = deferred<ProjectFile>();
    vi.mocked(source.upload).mockReturnValueOnce(waiting.promise);
    const view = await mount(source);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Subir archivos' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Seleccionar archivos'), { target: { files: [new File(['a'], 'a.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(source.upload).toHaveBeenCalledOnce());
    const other = { ...summaryProject, id: 'other-project', name: 'Otro' };
    const next = api([]);
    next.scopeKey = ['new-project'];
    view.rerender(<ProjectFiles data={summaryProps({ projects: [other] })} project={other} api={next} />);
    await act(async () => waiting.resolve({ ...row, name: 'Privado.pdf' }));
    expect(screen.queryByText('Privado.pdf')).not.toBeInTheDocument();
    expect(screen.queryByText('Guardado')).not.toBeInTheDocument();
  });
  it('revoca la URL Blob local al cerrar el detalle, sin exponer enlaces compartidos', async () => {
    const create = vi.fn(() => 'blob:private'),
      revoke = vi.fn();
    vi.stubGlobal(
      'URL',
      class extends URL {
        static createObjectURL = create;
        static revokeObjectURL = revoke;
      },
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const source = api();
    await mount(source);
    await screen.findByRole('button', { name: 'Ver detalles de Diseño.pdf' });
    await userEvent.click(screen.getByRole('button', { name: 'Ver detalles de Diseño.pdf' }));
    await userEvent.click(screen.getByRole('button', { name: 'Descargar archivo' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(source.download).toHaveBeenCalledExactlyOnceWith(row);
    expect(screen.queryByText('internal/path')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(revoke).toHaveBeenCalledWith('blob:private');
  });

  it('acepta su propia subida aunque el padre marque pending durante el guardado', async () => {
    const source = api([]),
      waiting = deferred<ProjectFile>();
    vi.mocked(source.upload).mockReturnValueOnce(waiting.promise);
    const view = await mount(source);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Subir archivos' })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Seleccionar archivos'), { target: { files: [new File(['a'], 'a.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(source.upload).toHaveBeenCalledOnce());
    view.rerender(<ProjectFiles data={summaryProps({ pending: true })} project={summaryProject} api={source} />);
    await act(async () => waiting.resolve({ ...row, name: 'a.txt' }));
    expect(await screen.findByText('Guardado')).toBeInTheDocument();
  });

  it('aborta una lectura abandonada y no muestra sus nombres en el proyecto siguiente', async () => {
    const source = api([]),
      waiting = deferred<ProjectFileList>();
    vi.mocked(source.list).mockReturnValueOnce(waiting.promise);
    const view = await mount(source);
    const signal = vi.mocked(source.list).mock.calls[0][1];
    const other = { ...summaryProject, id: 'other-project', name: 'Otro' };
    const next = api([]);
    next.scopeKey = ['other'];
    view.rerender(<ProjectFiles data={summaryProps({ projects: [other] })} project={other} api={next} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => waiting.resolve(list([row])));
    expect(screen.queryByText(row.name)).not.toBeInTheDocument();
  });

  it('separa la caché por cuenta incluso si un adaptador conserva accidentalmente su scopeKey', async () => {
    const source = api();
    vi.mocked(source.list)
      .mockResolvedValueOnce(list([row]))
      .mockResolvedValue(list([]));
    const view = await mount(source);
    await screen.findByRole('button', { name: 'Ver detalles de Diseño.pdf' });
    const nextData = summaryProps({
      currentUserId: 'other-reader',
      workspace: { ...summaryProps().workspace!, permissions: ['project.read'] },
      capabilities: { [summaryProject.id]: { project_id: summaryProject.id, access_level: 'read', permissions: ['project.read'] } },
    });
    view.rerender(<ProjectFiles data={nextData} project={summaryProject} api={source} />);
    expect(screen.queryByRole('button', { name: 'Ver detalles de Diseño.pdf' })).not.toBeInTheDocument();
    await waitFor(() => expect(source.list).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('heading', { name: 'Todavía no hay archivos' })).toBeInTheDocument();
  });

  it('un fallo de carga oculta datos y permite actualizarlos', async () => {
    const source = api();
    vi.mocked(source.list)
      .mockRejectedValueOnce(new Error('Sin conexión'))
      .mockResolvedValue(list([row]));
    await mount(source);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sin conexión');
    expect(screen.queryByText(row.name)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar archivos' }));
    expect(await screen.findByRole('button', { name: 'Ver detalles de Diseño.pdf' })).toBeInTheDocument();
  });
});

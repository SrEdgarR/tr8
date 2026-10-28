import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { CommunicationApi, CommentThread, TaskComment } from '../communication-types';
import { DataError } from '../data/errors';
import TaskComments from './TaskComments';
import { summaryTask } from './summary-test-fixtures';

const comment: TaskComment = {
  id: 'comment-a',
  workspace_id: summaryTask.workspace_id,
  task_id: summaryTask.id,
  author_id: summaryTask.owner_id,
  author_name: 'Edgar',
  body: 'Primera actualización',
  mentions: [],
  reactions: [],
  version: 1,
  sequence: 1,
  created_at: '2026-10-28T12:00:00Z',
  updated_at: '2026-10-28T12:00:00Z',
  can_edit: true,
  can_delete: true,
};
const participant = { member_id: 'member-a', display_name: 'Ana' };
function source(initial = [comment]): CommunicationApi {
  let rows = initial;
  return {
    scopeKey: ['communication', 'user-a', 'workspace-a', 'acl1'],
    thread: vi
      .fn()
      .mockImplementation(async () => ({ items: [...rows].sort((a, b) => b.sequence - a.sequence), next_before_id: null, participants: [participant] })),
    create: vi.fn().mockImplementation(async (_task, id: string, body: string, mentions: string[]) => {
      const saved = { ...comment, id, body, sequence: 10, mentions: mentions.includes(participant.member_id) ? [participant] : [] };
      rows = [...rows.filter(row => row.id !== id), saved];
      return saved;
    }),
    update: vi.fn().mockImplementation(async (row: TaskComment, body: string) => {
      const saved = { ...row, body, version: row.version + 1, updated_at: '2026-10-28T13:00:00Z' };
      rows = rows.map(item => (item.id === row.id ? saved : item));
      return saved;
    }),
    remove: vi.fn().mockImplementation(async (row: TaskComment) => {
      rows = rows.filter(item => item.id !== row.id);
    }),
    react: vi.fn().mockImplementation(async (row: TaskComment, emoji: '👍', active: boolean) => {
      const saved = { ...row, reactions: active ? [{ emoji, count: 1, mine: true }] : [] };
      rows = rows.map(item => (item.id === row.id ? saved : item));
      return saved;
    }),
    inbox: vi.fn().mockResolvedValue({ items: [], unread_count: 0 }),
    setRead: vi.fn(),
    readAll: vi.fn(),
    dismiss: vi.fn(),
  };
}
function provider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { client, wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
async function mount(api = source(), props: Partial<React.ComponentProps<typeof TaskComments>> = {}) {
  const supplied = provider();
  const view = render(<TaskComments task={summaryTask} api={api} readOnly={false} {...props} />, { wrapper: supplied.wrapper });
  await waitFor(() => expect(api.thread).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText('Cargando conversación…')).not.toBeInTheDocument());
  return { api, ...supplied, ...view };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('conversación real de tareas', () => {
  it('abre un comentario anterior desde búsqueda cargando solo las páginas necesarias', async () => {
    const target = { ...comment, id: 'searched-comment', sequence: 50, body: 'Comentario encontrado en una página anterior' };
    const api = source();
    vi.mocked(api.thread).mockImplementation(async (_task, before) =>
      before === null
        ? {
            items: Array.from({ length: 50 }, (_, index) => ({ ...comment, id: `recent-${index}`, sequence: 100 - index })),
            next_before_id: 51,
            participants: [],
          }
        : { items: [target], next_before_id: null, participants: [] },
    );
    await mount(api, { focusCommentId: target.id });
    await screen.findByText(target.body);
    await waitFor(() => expect(screen.getByText(target.body).closest('article')).toHaveFocus());
    expect(api.thread).toHaveBeenCalledTimes(2);
    expect(api.create).not.toHaveBeenCalled();
  });
  it('avisa si el comentario de un enlace ya no existe sin mostrar contenido ajeno', async () => {
    const api = source([]);
    await mount(api, { focusCommentId: 'removed-comment' });
    await screen.findByText('El comentario ya no está disponible. Actualiza la búsqueda para comprobarlo.');
    expect(api.thread).toHaveBeenCalledTimes(1);
    expect(api.create).not.toHaveBeenCalled();
  });
  it.each([
    { version: 1, updated_at: '2026-10-28T12:00:00.001Z', edited: false },
    { version: 2, updated_at: comment.created_at, edited: true },
  ])('identifica una edición por la versión confirmada: %j', async ({ version, updated_at, edited }) => {
    await mount(source([{ ...comment, version, updated_at }]));
    expect(screen.queryByText('Editado') !== null).toBe(edited);
  });
  it('muestra comentarios por secuencia con autores, menciones y texto escapado', async () => {
    const { container } = await mount(
      source([{ ...comment, id: 'later', sequence: 2, body: '<img src=x onerror=alert(1)>', mentions: [participant] }, comment]),
    );
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('@Ana')).toBeInTheDocument();
    expect(screen.getAllByRole('article').map(row => row.textContent)).toEqual([expect.stringContaining(comment.body), expect.stringContaining('<img src=x')]);
  });
  it('muestra un estado vacío real y no fabrica comentarios', async () => {
    const api = source([]);
    await mount(api);
    expect(screen.getByText('Aún no hay comentarios')).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });
  it.each([{ readOnly: true }, { task: { ...summaryTask, archived_at: '2026-10-28T00:00:00Z' } }])('conserva conversación sin escrituras: %j', async props => {
    await mount(source([{ ...comment, reactions: [{ emoji: '👍', count: 2, mine: false }] }]), props);
    expect(screen.getByText(comment.body)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Escribe un comentario' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Eliminar comentario de Edgar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '👍 · 2 reacciones' })).toBeDisabled();
  });
  it('un moderador puede borrar sin permiso para publicar o reaccionar', async () => {
    const api = source([{ ...comment, can_edit: false, can_delete: true }]);
    await mount(api, { canComment: false });
    expect(screen.queryByRole('textbox', { name: 'Escribe un comentario' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reaccionar al/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar comentario de Edgar' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Eliminar comentario' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(expect.objectContaining({ id: comment.id })));
  });
  it('añade una mención estructurada y publica una sola vez con UUID', async () => {
    const api = source([]);
    const onChanged = vi.fn();
    await mount(api, { onChanged });
    await userEvent.type(screen.getByRole('textbox', { name: 'Escribe un comentario' }), 'Revisemos @An');
    await userEvent.click(screen.getByRole('button', { name: 'Ana' }));
    expect(screen.getByText('@Ana')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Comentar' }));
    await waitFor(() => expect(api.create).toHaveBeenCalledOnce());
    expect(api.create).toHaveBeenCalledWith(summaryTask, expect.stringMatching(/^[0-9a-f-]{36}$/i), 'Revisemos', ['member-a']);
    expect(await screen.findByText('Comentario publicado.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Escribe un comentario' })).toHaveValue('');
    expect(onChanged).toHaveBeenCalledOnce();
  });
  it('puede quitar una mención antes de enviar y cerrar el selector con Escape', async () => {
    const api = source([]);
    await mount(api);
    await userEvent.click(screen.getByRole('button', { name: 'Mencionar a una persona' }));
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Buscar personas para mencionar' }), { key: 'Escape' });
    expect(screen.queryByRole('searchbox', { name: 'Buscar personas para mencionar' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Mencionar a una persona' }));
    await userEvent.click(screen.getByRole('button', { name: 'Ana' }));
    await userEvent.click(screen.getByRole('button', { name: 'Quitar mención a Ana' }));
    expect(screen.queryByText('@Ana')).not.toBeInTheDocument();
  });
  it('sin directorio no muestra sugerencias ni adivina nombres', async () => {
    const api = source([]);
    vi.mocked(api.thread).mockResolvedValue({ items: [], next_before_id: null, participants: [] });
    await mount(api);
    expect(screen.getByRole('button', { name: 'Mencionar a una persona' })).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Escribe un comentario' }), '@Ana');
    expect(screen.queryByRole('button', { name: 'Ana' })).not.toBeInTheDocument();
  });
  it('permite Ctrl+Enter y no envía durante la composición de texto', async () => {
    const api = source([]);
    await mount(api);
    fireEvent.change(screen.getByRole('textbox', { name: 'Escribe un comentario' }), { target: { value: 'Actualización con teclado' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Escribe un comentario' }), { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(api.create).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Escribe un comentario' }), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(api.create).toHaveBeenCalledOnce());
  });
  it('limita por caracteres Unicode y evita comentarios en blanco', async () => {
    await mount(source([]));
    const input = screen.getByRole('textbox', { name: 'Escribe un comentario' });
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: 'Comentar' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '🚀'.repeat(4000) } });
    expect(screen.getByText('4000/4000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comentar' })).toBeEnabled();
    fireEvent.change(input, { target: { value: '🚀'.repeat(4001) } });
    expect(screen.getByRole('button', { name: 'Comentar' })).toBeDisabled();
  });
  it('conserva ID y contenido al reintentar un envío ambiguo sin duplicar', async () => {
    const api = source([]);
    vi.mocked(api.create).mockRejectedValueOnce(new Error('Respuesta perdida'));
    await mount(api);
    await userEvent.type(screen.getByRole('textbox', { name: 'Escribe un comentario' }), 'Mi borrador');
    await userEvent.click(screen.getByRole('button', { name: 'Comentar' }));
    await screen.findByRole('button', { name: 'Reintentar envío' });
    expect(screen.getByRole('textbox', { name: 'Escribe un comentario' })).toHaveValue('Mi borrador');
    expect(screen.getByRole('textbox', { name: 'Escribe un comentario' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar envío' }));
    await screen.findByText('Comentario publicado.');
    expect(vi.mocked(api.create).mock.calls[0]).toEqual(vi.mocked(api.create).mock.calls[1]);
    expect(screen.getAllByText('Mi borrador')).toHaveLength(1);
  });
  it('no pierde el borrador al cambiar el estado global pendiente', async () => {
    const api = source([]);
    const { rerender } = await mount(api);
    await userEvent.type(screen.getByRole('textbox', { name: 'Escribe un comentario' }), 'Pendiente');
    rerender(<TaskComments task={summaryTask} api={api} readOnly />);
    rerender(<TaskComments task={summaryTask} api={api} readOnly={false} />);
    expect(screen.getByRole('textbox', { name: 'Escribe un comentario' })).toHaveValue('Pendiente');
  });
  it('mantiene el composer visible y el borrador al recibir un guardado global pendiente', async () => {
    const api = source();
    const { rerender } = await mount(api);
    await userEvent.type(screen.getByRole('textbox', { name: 'Escribe un comentario' }), 'Borrador conservado');
    rerender(<TaskComments task={summaryTask} api={api} readOnly={false} pending />);
    expect(screen.getByRole('textbox', { name: 'Escribe un comentario' })).toHaveValue('Borrador conservado');
    expect(screen.getByRole('textbox', { name: 'Escribe un comentario' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Comentar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Editar comentario de Edgar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Eliminar comentario de Edgar' })).toBeDisabled();
    expect(screen.queryByText(/necesitas acceso de edición/)).not.toBeInTheDocument();
    rerender(<TaskComments task={summaryTask} api={api} readOnly={false} pending={false} />);
    expect(screen.getByRole('textbox', { name: 'Escribe un comentario' })).toHaveValue('Borrador conservado');
    expect(screen.getByRole('textbox', { name: 'Escribe un comentario' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Comentar' })).toBeEnabled();
    expect(api.create).not.toHaveBeenCalled();
  });
  it('permite corregir un envío rechazado de forma definitiva sin perder el borrador', async () => {
    const api = source([]);
    vi.mocked(api.create).mockRejectedValueOnce(new DataError('La persona ya no está disponible para mencionar.', '22023'));
    await mount(api);
    await userEvent.type(screen.getByRole('textbox', { name: 'Escribe un comentario' }), 'Revisar con @An');
    await userEvent.click(screen.getByRole('button', { name: 'Ana' }));
    await userEvent.click(screen.getByRole('button', { name: 'Comentar' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('textbox', { name: 'Escribe un comentario' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Escribe un comentario' })).toHaveValue('Revisar con ');
    await userEvent.click(screen.getByRole('button', { name: 'Quitar mención a Ana' }));
    await userEvent.click(screen.getByRole('button', { name: 'Comentar' }));
    await screen.findByText('Comentario publicado.');
    expect(vi.mocked(api.create).mock.calls[1][1]).not.toBe(vi.mocked(api.create).mock.calls[0][1]);
    expect(vi.mocked(api.create).mock.calls[1][3]).toEqual([]);
  });
  it('el cambio de cuenta/tarea descarta borrador y oculta respuestas anteriores tardías', async () => {
    const api = source();
    const { rerender } = await mount(api);
    await userEvent.type(screen.getByRole('textbox', { name: 'Escribe un comentario' }), 'Secreto anterior');
    const next = source([]);
    next.scopeKey = ['communication', 'other-user'];
    rerender(<TaskComments task={{ ...summaryTask, id: 'next-task' }} api={next} readOnly={false} />);
    await screen.findByText('Aún no hay comentarios');
    expect(screen.queryByText(comment.body)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Escribe un comentario' })).toHaveValue('');
  });
  it('oculta el contenido cacheado ante una denegación de consulta', async () => {
    const api = source();
    await mount(api);
    expect(screen.getByText(comment.body)).toBeInTheDocument();
    vi.mocked(api.thread).mockRejectedValue(new DataError('Acceso retirado', '42501'));
    await userEvent.click(screen.getByRole('button', { name: 'Actualizar comentarios' }));
    await screen.findByRole('alert');
    expect(screen.queryByText(comment.body)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
  it('oculta conversación inmediatamente si una escritura revela pérdida de acceso', async () => {
    const api = source();
    vi.mocked(api.create).mockRejectedValue(new DataError('Acceso retirado', '42501'));
    await mount(api);
    const blocked = deferred<CommentThread>();
    vi.mocked(api.thread).mockReturnValue(blocked.promise);
    await userEvent.type(screen.getByRole('textbox', { name: 'Escribe un comentario' }), 'Mensaje');
    await userEvent.click(screen.getByRole('button', { name: 'Comentar' }));
    await screen.findByText('Actualiza la conversación para comprobar tu acceso.');
    expect(screen.queryByText(comment.body)).not.toBeInTheDocument();
  });
  it('edita con la versión original y conserva las menciones', async () => {
    const api = source([{ ...comment, mentions: [participant] }]);
    await mount(api);
    await userEvent.click(screen.getByRole('button', { name: 'Editar comentario de Edgar' }));
    const input = screen.getByRole('textbox', { name: 'Editar comentario' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Texto corregido');
    expect(screen.getByText(/menciones originales se conservan/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Guardar comentario' }));
    await screen.findByText('Comentario actualizado.');
    expect(api.update).toHaveBeenCalledWith({ ...comment, mentions: [participant] }, 'Texto corregido');
    expect(screen.getByText('@Ana')).toBeInTheDocument();
  });
  it('requiere revisar la versión más reciente tras un conflicto de edición', async () => {
    const api = source();
    await mount(api);
    await userEvent.click(screen.getByRole('button', { name: 'Editar comentario de Edgar' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Editar comentario' }), { target: { value: 'Mi cambio' } });
    vi.mocked(api.update).mockRejectedValue(new DataError('Cambió en otra pestaña', 'PT409'));
    vi.mocked(api.thread).mockResolvedValue({ items: [{ ...comment, body: 'Versión remota', version: 2 }], next_before_id: null, participants: [] });
    await userEvent.click(screen.getByRole('button', { name: 'Guardar comentario' }));
    await screen.findByRole('button', { name: 'Cargar versión actual' });
    expect(screen.getByRole('button', { name: 'Guardar comentario' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cargar versión actual' }));
    expect(screen.getByRole('textbox', { name: 'Editar comentario' })).toHaveValue('Versión remota');
  });
  it('confirma la eliminación de un solo comentario y conserva los demás', async () => {
    const other = { ...comment, id: 'comment-b', sequence: 2, author_name: 'Ana', body: 'Se conserva', can_delete: false, can_edit: false };
    const api = source([comment, other]);
    await mount(api);
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar comentario de Edgar' }));
    expect(api.remove).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    expect(api.remove).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Eliminar comentario de Edgar' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Eliminar comentario' }));
    await screen.findByText('Comentario eliminado.');
    expect(screen.getByText(other.body)).toBeInTheDocument();
    expect(screen.queryByText(comment.body)).not.toBeInTheDocument();
    expect(api.remove).toHaveBeenCalledWith(comment);
  });
  it('envía estado deseado de reacción y puede retirarla sin modificar texto o versión', async () => {
    const api = source();
    await mount(api);
    await userEvent.click(screen.getByRole('button', { name: 'Reaccionar al comentario de Edgar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reaccionar con 👍' }));
    const reaction = await screen.findByRole('button', { name: '👍 · 1 reacción' });
    expect(reaction).toHaveAttribute('aria-pressed', 'true');
    expect(api.react).toHaveBeenCalledWith(comment, '👍', true);
    await userEvent.click(reaction);
    await waitFor(() => expect(api.react).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.react).mock.calls[1][2]).toBe(false);
    expect(api.update).not.toHaveBeenCalled();
  });
  it('pagina hacia comentarios anteriores sin duplicarlos', async () => {
    const api = source();
    vi.mocked(api.thread).mockImplementation(async (_task, before) =>
      before == null
        ? { items: [{ ...comment, sequence: 51 }], next_before_id: 51, participants: [] }
        : { items: [{ ...comment, id: 'older', body: 'Anterior', sequence: 1 }], next_before_id: null, participants: [] },
    );
    await mount(api);
    await userEvent.click(screen.getByRole('button', { name: 'Ver anteriores' }));
    await screen.findByText('Anterior');
    expect(api.thread).toHaveBeenCalledWith(summaryTask, 51, expect.any(AbortSignal));
    expect(screen.getAllByRole('article').map(row => row.textContent)).toEqual([expect.stringContaining('Anterior'), expect.stringContaining(comment.body)]);
    expect(screen.queryByRole('button', { name: 'Ver anteriores' })).not.toBeInTheDocument();
  });
  it('una respuesta de envío tras desmontar no actualiza otra conversación ni llama callbacks', async () => {
    const api = source([]);
    const sent = deferred<TaskComment>();
    const changed = vi.fn();
    vi.mocked(api.create).mockReturnValue(sent.promise);
    const { unmount } = await mount(api, { onChanged: changed });
    await userEvent.type(screen.getByRole('textbox', { name: 'Escribe un comentario' }), 'Mensaje pendiente');
    await userEvent.click(screen.getByRole('button', { name: 'Comentar' }));
    unmount();
    await act(async () => {
      sent.resolve(comment);
      await sent.promise;
    });
    expect(changed).not.toHaveBeenCalled();
  });
});

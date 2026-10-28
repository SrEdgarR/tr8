import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FolderPlus, Plus } from 'lucide-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GlobalSearchApi, GlobalSearchPage, GlobalSearchQuery, GlobalSearchResult, SearchKind } from '../search-types';
import { DataError } from '../data/errors';
import GlobalSearch, { type GlobalSearchProps, type SearchCommand } from './GlobalSearch';

const base: GlobalSearchResult = {
  id: 'project-a',
  kind: 'project',
  workspace_id: 'workspace-a',
  project_id: 'project-a',
  task_id: null,
  title: 'Plan de lanzamiento',
  snippet: 'Planificar la próxima entrega.',
  project_name: 'Plan de lanzamiento',
  project_color: '#5A67D8',
  project_icon: 'rocket',
  status: 'active',
  priority: null,
  content_type: null,
  member_id: null,
  author_name: null,
  updated_at: '2026-10-28T12:00:00Z',
  archived: false,
};
function row(kind: SearchKind, id = `${kind}-a`, title = `Plan de ${kind}`): GlobalSearchResult {
  return {
    ...base,
    id,
    kind,
    title,
    project_id: kind === 'project' ? id : kind === 'member' ? null : base.id,
    task_id: kind === 'task' ? id : kind === 'comment' ? 'task-a' : null,
    member_id: kind === 'member' ? id : null,
    author_name: kind === 'comment' ? 'Ana' : null,
    status: kind === 'file' ? 'ready' : kind === 'task' || kind === 'comment' ? 'todo' : 'active',
    priority: kind === 'task' ? 'high' : null,
    content_type: kind === 'file' ? 'application/pdf' : null,
  };
}
function page(input: GlobalSearchQuery, values: GlobalSearchResult[]): GlobalSearchPage {
  const visible = values.filter(value => input.include_archived || !value.archived);
  const counts = { project: 0, task: 0, member: 0, file: 0, comment: 0 };
  for (const item of visible) counts[item.kind]++;
  const selected = visible.filter(value => input.kind === 'all' || value.kind === input.kind);
  const items =
    input.kind === 'all'
      ? ['project', 'task', 'member', 'file', 'comment'].flatMap(kind => selected.filter(value => value.kind === kind).slice(0, input.limit))
      : selected.slice(input.offset, input.offset + input.limit);
  return {
    workspace_id: 'workspace-a',
    query: input.query,
    kind: input.kind,
    include_archived: input.include_archived,
    items,
    counts,
    next_offset: input.kind !== 'all' && input.offset + input.limit < selected.length ? input.offset + input.limit : null,
  };
}
function source(values = [base]): GlobalSearchApi {
  return {
    scopeKey: ['search', 'user-a', 'workspace-a', 'acl-1'],
    search: vi.fn().mockImplementation(async (input: GlobalSearchQuery) => page(input, values)),
  };
}
const clients: QueryClient[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const client of clients.splice(0)) client.clear();
});
function mount(options: Partial<GlobalSearchProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const props: GlobalSearchProps = { api: source(), mode: 'page', onSelect: vi.fn(), ...options };
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const view = render(<GlobalSearch {...props} />, { wrapper });
  return { ...view, client, props, replace: (next: Partial<GlobalSearchProps>) => view.rerender(<GlobalSearch {...props} {...next} />) };
}
function input() {
  return screen.getByRole('combobox', { name: 'Buscar en TR8' });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
async function search(term = 'Plan') {
  fireEvent.change(input(), { target: { value: term } });
  return screen.findByRole('option', { name: /^Plan de lanzamiento/ });
}

describe('búsqueda global y paleta de acciones', () => {
  it('no consulta al abrir vacía ni presenta conteos inventados', () => {
    const { props } = mount();
    expect(props.api.search).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Proyectos' })).toHaveTextContent('Proyectos');
    expect(screen.getByRole('button', { name: 'Proyectos' })).not.toHaveTextContent('0');
    expect(screen.getByText('Encuentra contenido dentro del espacio seleccionado.')).toBeInTheDocument();
  });
  it('espera 250ms y cancela el temporizador anterior antes de consultar', async () => {
    vi.useFakeTimers();
    const { props } = mount();
    fireEvent.change(input(), { target: { value: 'pla' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
    expect(props.api.search).not.toHaveBeenCalled();
    fireEvent.change(input(), { target: { value: 'Plan' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(props.api.search).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(props.api.search).toHaveBeenCalledExactlyOnceWith(
      { query: 'Plan', kind: 'all', include_archived: false, offset: 0, limit: 10 },
      expect.any(AbortSignal),
    );
  });
  it.each(['p', 'x'.repeat(101), 'Plan\tprivado'])('no envía una consulta no válida: %j', async term => {
    const { props } = mount();
    fireEvent.change(input(), { target: { value: term } });
    await act(async () => {
      await new Promise(done => window.setTimeout(done, 280));
    });
    expect(props.api.search).not.toHaveBeenCalled();
  });
  it('vuelve a esperar el debounce al regresar rápidamente a una consulta anterior', async () => {
    vi.useFakeTimers();
    const { props } = mount();
    fireEvent.change(input(), { target: { value: 'Plan' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(props.api.search).toHaveBeenCalledTimes(1);
    fireEvent.change(input(), { target: { value: 'Otro' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    fireEvent.change(input(), { target: { value: 'Plan' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(props.api.search).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(props.api.search).toHaveBeenCalledTimes(2);
  });
  it('cuenta caracteres Unicode sin limitar por unidades UTF16', async () => {
    const api = source([]),
      query = '🚀'.repeat(100);
    mount({ api });
    fireEvent.change(input(), { target: { value: query } });
    await waitFor(() => expect(api.search).toHaveBeenCalled());
    expect(vi.mocked(api.search).mock.calls[0][0].query).toBe(query);
  });
  it('agrupa los cinco tipos, conserva colores y devuelve solo el resultado seleccionado', async () => {
    const api = source([base, row('task'), row('member'), row('file'), row('comment')]);
    const { props, container } = mount({ api });
    await search();
    for (const name of ['Proyectos', 'Tareas', 'Personas', 'Archivos', 'Comentarios']) expect(screen.getByRole('group', { name })).toBeInTheDocument();
    expect(container.querySelector('.gs-kind-pdf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Todos 5' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: /Plan de file/ }));
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'file', id: 'file-a' }));
    expect(api.search).toHaveBeenCalledOnce();
  });
  it('trata HTML y expresiones especiales como texto, con resaltado seguro', async () => {
    const title = '<img src=x onerror=alert(1)> [Plan] %_';
    const { container } = mount({ api: source([{ ...base, title, snippet: '<script>alert(1)</script>' }]) });
    fireEvent.change(input(), { target: { value: '[Plan]' } });
    const option = await screen.findByRole('option', { name: /img src=x/ });
    expect(option).toHaveTextContent(title);
    expect(container.querySelector('img,script')).toBeNull();
    expect(within(option).getByText('[Plan]', { selector: 'mark' })).toBeInTheDocument();
  });
  it('retira resultados anteriores inmediatamente al cambiar el término', async () => {
    const api = source(),
      waiting = deferred<GlobalSearchPage>();
    const { props } = mount({ api });
    await search();
    vi.mocked(api.search).mockReturnValue(waiting.promise);
    fireEvent.change(input(), { target: { value: 'Otros' } });
    expect(screen.queryByRole('option', { name: /Plan de lanzamiento/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Proyectos 1' })).not.toBeInTheDocument();
    expect(props.onSelect).not.toHaveBeenCalled();
  });
  it('aborta una petición obsoleta e ignora una respuesta tardía', async () => {
    const api = source(),
      waiting = deferred<GlobalSearchPage>();
    vi.mocked(api.search).mockReturnValueOnce(waiting.promise);
    mount({ api });
    fireEvent.change(input(), { target: { value: 'Anterior' } });
    await waitFor(() => expect(api.search).toHaveBeenCalledOnce());
    const signal = vi.mocked(api.search).mock.calls[0][1]!;
    fireEvent.change(input(), { target: { value: 'Plan' } });
    await screen.findByRole('option', { name: /Plan de lanzamiento/ });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      waiting.resolve(
        page({ query: 'Anterior', kind: 'all', include_archived: false, offset: 0, limit: 10 }, [{ ...base, title: 'Contenido anterior privado' }]),
      );
    });
    expect(screen.queryByRole('option', { name: /Contenido anterior privado/ })).not.toBeInTheDocument();
  });
  it('separa el borrador y la respuesta al cambiar cuenta o revisión de acceso', async () => {
    const first = source(),
      second = source([{ ...base, title: 'Nuevo resultado' }]);
    second.scopeKey = ['search', 'user-b', 'workspace-b', 'acl-2'];
    const { replace } = mount({ api: first, initialQuery: 'Plan' });
    await screen.findByRole('option', { name: /Plan de lanzamiento/ });
    replace({ api: second, initialQuery: 'Nuevo' });
    expect(input()).toHaveValue('Nuevo');
    expect(screen.queryByRole('option', { name: /Plan de lanzamiento/ })).not.toBeInTheDocument();
    await screen.findByRole('option', { name: /Nuevo resultado/ });
  });
  it('no muestra resultados en caché después de perder autorización', async () => {
    const api = source(),
      { client } = mount({ api });
    await search();
    vi.mocked(api.search).mockRejectedValue(new DataError('Acceso retirado', 'PT404'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: api.scopeKey });
    });
    await waitFor(() => expect(screen.queryByRole('option', { name: /Plan de lanzamiento/ })).not.toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('Acceso retirado');
    expect(screen.queryByRole('button', { name: 'Proyectos 1' })).not.toBeInTheDocument();
  });
  it('permite reintentar un error de consulta sin perder el término', async () => {
    const api = source();
    vi.mocked(api.search).mockRejectedValueOnce(new DataError('Sin conexión'));
    mount({ api });
    fireEvent.change(input(), { target: { value: 'Plan' } });
    await screen.findByRole('alert');
    expect(input()).toHaveValue('Plan');
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar búsqueda' }));
    await screen.findByRole('option', { name: /Plan de lanzamiento/ });
  });
  it('consulta una categoría concreta e incluye archivados solo al solicitarlo', async () => {
    const api = source([row('task'), { ...row('task', 'task-old', 'Plan antiguo'), archived: true }]);
    mount({ api });
    fireEvent.change(input(), { target: { value: 'Plan' } });
    await screen.findByRole('option', { name: /Plan de task/ });
    await userEvent.click(screen.getByRole('button', { name: 'Tareas 1' }));
    await waitFor(() =>
      expect(api.search).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: 'task', limit: 25, offset: 0, include_archived: false }),
        expect.any(AbortSignal),
      ),
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Incluir archivados' }));
    await screen.findByRole('option', { name: /Plan antiguo/ });
    expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'task', include_archived: true }), expect.any(AbortSignal));
  });
  it('pagina una categoría sin duplicar la página anterior', async () => {
    const api = source(Array.from({ length: 30 }, (_, i) => row('task', `task-${i}`, `Plan número ${i}`)));
    mount({ api, initialKind: 'task', initialQuery: 'Plan' });
    await screen.findByRole('button', { name: 'Cargar más resultados' });
    expect(screen.getAllByRole('option')).toHaveLength(25);
    await userEvent.click(screen.getByRole('button', { name: 'Cargar más resultados' }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(30));
    expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25, kind: 'task', limit: 25 }), expect.any(AbortSignal));
    expect(screen.queryByRole('button', { name: 'Cargar más resultados' })).not.toBeInTheDocument();
  });
  it('usa límites pequeños en la paleta y ofrece todos los resultados', async () => {
    const onClose = vi.fn(),
      onShowAll = vi.fn(),
      api = source();
    mount({ api, mode: 'palette', onClose, onShowAll });
    await search();
    expect(api.search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ limit: 5, kind: 'all' }), expect.any(AbortSignal));
    await userEvent.click(screen.getByRole('button', { name: 'Ver todos los resultados' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onShowAll).toHaveBeenCalledExactlyOnceWith('Plan', 'all');
  });
  it('cambia al tipo seleccionado desde Ver todos de un grupo', async () => {
    const api = source(Array.from({ length: 12 }, (_, i) => row('task', `task-${i}`, `Plan ${i}`)));
    mount({ api, initialQuery: 'Plan' });
    const group = await screen.findByRole('group', { name: 'Tareas' });
    await userEvent.click(within(group).getByRole('button', { name: 'Ver todos' }));
    await waitFor(() => expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'task', offset: 0, limit: 25 }), expect.any(AbortSignal)));
  });
  it('navega con flechas y Enter manteniendo el foco en el combobox', async () => {
    const order: string[] = [],
      api = source([base, row('task')]);
    const onClose = vi.fn(() => order.push('close')),
      onSelect = vi.fn(() => order.push('select'));
    mount({ api, mode: 'palette', onClose, onSelect });
    await search();
    expect(input()).toHaveFocus();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Plan de task/ })).toHaveAttribute('aria-selected', 'true');
    const active = input().getAttribute('aria-activedescendant');
    expect(active).toBe(screen.getByRole('option', { name: /Plan de task/ }).id);
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'task' }));
    expect(order).toEqual(['close', 'select']);
  });
  it('muestra acciones permitidas, omite deshabilitadas al recorrer y cierra antes de ejecutar', async () => {
    const calls: string[] = [],
      disabled = vi.fn(),
      action = vi.fn(() => calls.push('run'));
    const commands: SearchCommand[] = [
      { id: 'new-project', label: 'Nuevo proyecto', icon: FolderPlus, run: action, shortcut: 'P' },
      { id: 'locked-task', label: 'Nueva tarea bloqueada', icon: Plus, run: disabled, disabled: true },
    ];
    const { props } = mount({ mode: 'palette', actions: commands, onClose: () => calls.push('close') });
    expect(props.api.search).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: /Nueva tarea bloqueada/ })).toBeDisabled();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(calls).toEqual(['close', 'run']);
    expect(disabled).not.toHaveBeenCalled();
  });
  it('filtra las acciones y no ejecuta Enter durante composición IME', async () => {
    const run = vi.fn();
    mount({ mode: 'palette', actions: [{ id: 'create', label: 'Nuevo proyecto', icon: Plus, run }] });
    fireEvent.change(input(), { target: { value: 'proy' } });
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(run).toHaveBeenCalledOnce();
  });
  it('cierra con Escape y permite Tab sin secuestrar su comportamiento', async () => {
    const onClose = vi.fn();
    mount({ mode: 'palette', onClose });
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    fireEvent(input(), tab);
    expect(tab.defaultPrevented).toBe(false);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('cierra al pulsar el fondo auténtico del diálogo', () => {
    const onClose = vi.fn();
    mount({ mode: 'palette', onClose });
    const dialog = screen.getByRole('dialog', { name: 'Buscar en TR8' });
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 500, 400));
    fireEvent(dialog, new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20, button: 0 }));
    fireEvent.click(dialog, { clientX: 20, clientY: 20, detail: 1 });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('notifica texto y categoría de la página sin reiniciar el borrador por un eco de props', async () => {
    const onQueryChange = vi.fn(),
      { replace } = mount({ onQueryChange });
    fireEvent.change(input(), { target: { value: 'Mi consulta' } });
    expect(onQueryChange).toHaveBeenLastCalledWith('Mi consulta', 'all');
    replace({ initialQuery: 'Valor anterior', initialKind: 'file' });
    expect(input()).toHaveValue('Mi consulta');
    await userEvent.click(screen.getByRole('button', { name: 'Archivos' }));
    expect(onQueryChange).toHaveBeenLastCalledWith('Mi consulta', 'file');
  });
  it('no guarda consultas ni resultados en localStorage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    mount();
    await search();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});

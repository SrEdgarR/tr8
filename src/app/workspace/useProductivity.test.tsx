import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ProductivityApi, ProductivityState, SavedTaskView, TaskViewConfig } from '../productivity-types';
import useProductivity from './useProductivity';
import ProductivityTasks from './ProductivityTasks';
import { summaryProps } from './summary-test-fixtures';

vi.mock('./TasksView', () => ({
  default: ({ savedViews, favoriteTaskIds }: { savedViews: SavedTaskView[]; favoriteTaskIds: string[] }) => (
    <>
      <output aria-label="Vistas del contexto">{savedViews.map(view => view.name).join(',')}</output>
      <output aria-label="Favoritos del contexto">{favoriteTaskIds.join(',')}</output>
    </>
  ),
}));
const config: TaskViewConfig = {
  schemaVersion: 1,
  view: 'table',
  query: '',
  statuses: [],
  priorities: [],
  projectIds: [],
  assigneeIds: [],
  due: 'all',
  sort: 'manual',
  direction: 'asc',
  group: 'none',
  columns: ['status', 'priority'],
  favoritesOnly: false,
};
const saved: SavedTaskView = {
  id: 'view-a',
  workspace_id: 'workspace-a',
  context: 'tasks',
  project_id: null,
  name: 'Vista global',
  config,
  version: 1,
  created_at: '2026-10-27T14:00:00Z',
  updated_at: '2026-10-27T14:00:00Z',
};
const empty: ProductivityState = { favorites: [], views: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function api(scope = 'a'): ProductivityApi {
  return {
    scopeKey: ['collaboration', `user-${scope}`, `workspace-${scope}`, 'productivity'],
    load: vi.fn().mockResolvedValue(empty),
    setFavorite: vi.fn(),
    createView: vi.fn(),
    updateView: vi.fn(),
    deleteView: vi.fn(),
    reorderTasks: vi.fn(),
  };
}
function provider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { client, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}

describe('preferencias de productividad integradas', () => {
  it('oculta metadatos cuando falla la carga y permite recuperar el estado explícitamente', async () => {
    const source = api();
    vi.mocked(source.load).mockRejectedValueOnce(new Error('Sin conexión')).mockResolvedValue(empty);
    const { wrapper } = provider();
    const { result } = renderHook(() => useProductivity(source, true), { wrapper });
    await waitFor(() => expect(result.current.error).toBe('Sin conexión'));
    expect(result.current.available).toBe(false);
    expect(result.current.state).toEqual(empty);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.available).toBe(true));
    expect(result.current.error).toBeNull();
  });

  it('guarda favoritos personales y refresca sin duplicarlos ni reescribir el contenido', async () => {
    const source = api();
    vi.mocked(source.setFavorite).mockResolvedValue({ kind: 'task', id: 'task-a', project_id: 'project-a', favorite: true });
    vi.mocked(source.load)
      .mockResolvedValueOnce(empty)
      .mockResolvedValue({ favorites: [{ kind: 'task', id: 'task-a', project_id: 'project-a' }], views: [] });
    const { wrapper } = provider();
    const { result } = renderHook(() => useProductivity(source, true), { wrapper });
    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      await result.current.setFavorite('task', 'task-a', true);
    });
    await waitFor(() => expect(result.current.state.favorites).toHaveLength(1));
    expect(source.setFavorite).toHaveBeenCalledWith('task', 'task-a', true);
    expect(source.reorderTasks).not.toHaveBeenCalled();
    await waitFor(() => expect(source.load).toHaveBeenCalledTimes(2));
  });

  it('al cambiar de espacio no muestra una respuesta tardía del directorio de preferencias anterior', async () => {
    const first = api('a'),
      second = api('b');
    const late = deferred<ProductivityState>();
    vi.mocked(first.load).mockReturnValue(late.promise);
    const { wrapper } = provider();
    const { result, rerender } = renderHook(({ source }: { source: ProductivityApi }) => useProductivity(source, true), {
      wrapper,
      initialProps: { source: first },
    });
    rerender({ source: second });
    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => late.resolve({ favorites: [{ kind: 'project', id: 'old-secret', project_id: 'old-secret' }], views: [] }));
    expect(result.current.state).toEqual(empty);
  });

  it('rechaza una mutación tardía de otro ámbito sin insertar favoritos en la cuenta nueva', async () => {
    const first = api('a'),
      second = api('b');
    const late = deferred<Awaited<ReturnType<ProductivityApi['setFavorite']>>>();
    vi.mocked(first.setFavorite).mockReturnValue(late.promise);
    const { wrapper, client } = provider();
    const { result, rerender } = renderHook(({ source }: { source: ProductivityApi }) => useProductivity(source, true), {
      wrapper,
      initialProps: { source: first },
    });
    await waitFor(() => expect(result.current.available).toBe(true));
    let caught!: Promise<unknown>;
    act(() => {
      caught = result.current.setFavorite('project', 'old-project', true).catch(error => error);
    });
    rerender({ source: second });
    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => late.resolve({ kind: 'project', id: 'old-project', project_id: 'old-project', favorite: true }));
    expect(await caught).toBeInstanceOf(Error);
    expect(result.current.state).toEqual(empty);
    expect(client.getQueryData([...second.scopeKey, 'state'])).toEqual(empty);
  });

  it('una pérdida de acceso retira metadatos visibles y rechaza nuevos guardados', async () => {
    const source = api();
    vi.mocked(source.load).mockResolvedValue({ favorites: [{ kind: 'project', id: 'project-a', project_id: 'project-a' }], views: [saved] });
    const { wrapper } = provider();
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useProductivity(source, enabled), {
      wrapper,
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.state.views).toHaveLength(1));
    rerender({ enabled: false });
    expect(result.current.state).toEqual(empty);
    await expect(result.current.setFavorite('project', 'project-a', false)).rejects.toThrow('Actualiza');
    expect(source.setFavorite).not.toHaveBeenCalled();
  });

  it('no confirma una mutación que llega después de deshabilitar el mismo ámbito', async () => {
    const source = api();
    const late = deferred<Awaited<ReturnType<ProductivityApi['setFavorite']>>>();
    vi.mocked(source.setFavorite).mockReturnValue(late.promise);
    const { wrapper, client } = provider();
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useProductivity(source, enabled), {
      wrapper,
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.available).toBe(true));
    let caught!: Promise<unknown>;
    act(() => {
      caught = result.current.setFavorite('project', 'old-project', true).catch(error => error);
    });
    rerender({ enabled: false });
    await act(async () => late.resolve({ kind: 'project', id: 'old-project', project_id: 'old-project', favorite: true }));
    expect(await caught).toBeInstanceOf(Error);
    expect(client.getQueryData([...source.scopeKey, 'state'])).toEqual(empty);
  });

  it('cada superficie recibe solo sus vistas guardadas y conserva el ámbito al actualizar los datos', async () => {
    const source = api();
    const views: SavedTaskView[] = [
      saved,
      { ...saved, id: 'view-mine', context: 'mine', name: 'Solo mías' },
      { ...saved, id: 'view-project-a', context: 'project', project_id: 'project-summary-a', name: 'Proyecto A' },
      { ...saved, id: 'view-project-b', context: 'project', project_id: 'project-other', name: 'Proyecto B' },
    ];
    vi.mocked(source.load).mockResolvedValue({ favorites: [], views });
    const { wrapper } = provider();
    const Wrapper = ({ context, projectId }: { context: 'tasks' | 'mine' | 'project'; projectId?: string }) => {
      const controller = useProductivity(source, true);
      return (
        <ProductivityTasks
          data={summaryProps({ productivity: source })}
          controller={controller}
          context={context}
          projectId={projectId}
          tasks={[]}
          projects={[]}
          pending={false}
          onCreate={() => {}}
          onOpen={() => {}}
          onMove={async () => {}}
        />
      );
    };
    const { rerender } = render(<Wrapper context="tasks" />, { wrapper });
    await waitFor(() => expect(screen.getByLabelText('Vistas del contexto')).toHaveTextContent('Vista global'));
    expect(screen.getByLabelText('Vistas del contexto')).not.toHaveTextContent('Solo mías');
    rerender(<Wrapper context="mine" />);
    expect(screen.getByLabelText('Vistas del contexto')).toHaveTextContent('Solo mías');
    rerender(<Wrapper context="project" projectId="project-summary-a" />);
    expect(screen.getByLabelText('Vistas del contexto')).toHaveTextContent('Proyecto A');
    expect(screen.getByLabelText('Vistas del contexto')).not.toHaveTextContent('Proyecto B');
    rerender(<Wrapper context="project" projectId="project-other" />);
    expect(screen.getByLabelText('Vistas del contexto')).toHaveTextContent('Proyecto B');
    expect(screen.getByLabelText('Vistas del contexto')).not.toHaveTextContent('Proyecto A');
  });

  it('deshabilitar y rehabilitar el mismo ámbito no revive una mutación de la generación anterior', async () => {
    const source = api();
    const late = deferred<Awaited<ReturnType<ProductivityApi['setFavorite']>>>();
    vi.mocked(source.setFavorite).mockReturnValue(late.promise);
    const { wrapper, client } = provider();
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useProductivity(source, enabled), {
      wrapper,
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current.available).toBe(true));
    let caught!: Promise<unknown>;
    act(() => {
      caught = result.current.setFavorite('project', 'obsolete-project', true).catch(error => error);
    });
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => late.resolve({ kind: 'project', id: 'obsolete-project', project_id: 'obsolete-project', favorite: true }));
    expect(await caught).toBeInstanceOf(Error);
    expect(result.current.state).toEqual(empty);
    expect(client.getQueryData([...source.scopeKey, 'state'])).toEqual(empty);
  });

  it('volver al primer espacio tampoco admite un guardado de una visita anterior', async () => {
    const first = api('a'),
      second = api('b');
    const late = deferred<Awaited<ReturnType<ProductivityApi['setFavorite']>>>();
    vi.mocked(first.setFavorite).mockReturnValue(late.promise);
    const { wrapper, client } = provider();
    const { result, rerender } = renderHook(({ source }: { source: ProductivityApi }) => useProductivity(source, true), {
      wrapper,
      initialProps: { source: first },
    });
    await waitFor(() => expect(result.current.available).toBe(true));
    let caught!: Promise<unknown>;
    act(() => {
      caught = result.current.setFavorite('project', 'obsolete-project', true).catch(error => error);
    });
    rerender({ source: second });
    await waitFor(() => expect(result.current.available).toBe(true));
    rerender({ source: first });
    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => late.resolve({ kind: 'project', id: 'obsolete-project', project_id: 'obsolete-project', favorite: true }));
    expect(await caught).toBeInstanceOf(Error);
    expect(result.current.state).toEqual(empty);
    expect(client.getQueryData([...first.scopeKey, 'state'])).toEqual(empty);
  });
});

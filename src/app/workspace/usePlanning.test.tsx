import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanningApi, PlanningState, TaskDependency } from '../planning-types';
import usePlanning from './usePlanning';
import { summaryProject, summaryTask } from './summary-test-fixtures';

const empty: PlanningState = { dependencies: [], milestones: [] };
const edge: TaskDependency = {
  id: 'edge-a',
  workspace_id: summaryTask.workspace_id,
  task_id: summaryTask.id,
  blocker_task_id: 'before',
  version: 1,
  created_at: summaryTask.created_at,
};
function source(scope = 'a'): PlanningApi {
  return {
    scopeKey: ['user', scope, 'planning'],
    load: vi.fn().mockResolvedValue(empty),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    createMilestone: vi.fn(),
    updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(),
  };
}
function provider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { client, wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('planificación por cuenta y espacio', () => {
  it('no consulta si la superficie o el permiso no están habilitados', async () => {
    const api = source();
    const { wrapper } = provider();
    const { result } = renderHook(() => usePlanning(api, false), { wrapper });
    expect(result.current.state).toEqual(empty);
    expect(api.load).not.toHaveBeenCalled();
    await expect(result.current.addDependency(summaryTask, summaryTask, 'request')).rejects.toThrow('Actualiza');
    expect(api.addDependency).not.toHaveBeenCalled();
  });
  it('oculta los datos ante error y permite actualizar explícitamente', async () => {
    const api = source();
    vi.mocked(api.load)
      .mockRejectedValueOnce(new Error('Sin conexión'))
      .mockResolvedValue({ dependencies: [edge], milestones: [] });
    const { wrapper } = provider();
    const { result } = renderHook(() => usePlanning(api, true), { wrapper });
    await waitFor(() => expect(result.current.error).toBe('Sin conexión'));
    expect(result.current.state).toEqual(empty);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.state.dependencies).toEqual([edge]));
  });
  it('acepta el DTO confirmado sin duplicar una relación al reintentar', async () => {
    const api = source();
    vi.mocked(api.addDependency).mockResolvedValue(edge);
    vi.mocked(api.load).mockResolvedValue({ dependencies: [edge], milestones: [] });
    const { wrapper } = provider();
    const { result } = renderHook(() => usePlanning(api, true), { wrapper });
    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => {
      await result.current.addDependency(summaryTask, { ...summaryTask, id: 'before' }, 'stable-request');
    });
    expect(result.current.state.dependencies).toEqual([edge]);
    expect(api.addDependency).toHaveBeenCalledWith(summaryTask, expect.objectContaining({ id: 'before' }), 'stable-request');
  });
  it('no muestra una consulta tardía de la cuenta anterior', async () => {
    const first = source('a'),
      next = source('b'),
      late = deferred<PlanningState>();
    vi.mocked(first.load).mockReturnValue(late.promise);
    const { wrapper } = provider();
    const { result, rerender } = renderHook(({ api }) => usePlanning(api, true), { wrapper, initialProps: { api: first } });
    rerender({ api: next });
    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => late.resolve({ dependencies: [edge], milestones: [] }));
    expect(result.current.state).toEqual(empty);
  });
  it('rechaza la confirmación de una mutación de otro espacio', async () => {
    const first = source('a'),
      next = source('b'),
      late = deferred<TaskDependency>();
    vi.mocked(first.addDependency).mockReturnValue(late.promise);
    const { wrapper, client } = provider();
    const { result, rerender } = renderHook(({ api }) => usePlanning(api, true), { wrapper, initialProps: { api: first } });
    await waitFor(() => expect(result.current.available).toBe(true));
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.addDependency(summaryTask, summaryTask, 'request').catch(error => error);
    });
    rerender({ api: next });
    await waitFor(() => expect(result.current.available).toBe(true));
    await act(async () => late.resolve(edge));
    expect(await pending).toBeInstanceOf(Error);
    expect(client.getQueryData([...next.scopeKey, 'state'])).toEqual(empty);
    expect(client.getQueryData([...first.scopeKey, 'state'])).toEqual(empty);
  });
  it('retira los datos y rechaza el resultado al perder acceso al mismo espacio', async () => {
    const api = source(),
      late = deferred<TaskDependency>();
    vi.mocked(api.addDependency).mockReturnValue(late.promise);
    const { wrapper, client } = provider();
    const { result, rerender } = renderHook(({ enabled }) => usePlanning(api, enabled), { wrapper, initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.available).toBe(true));
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.addDependency(summaryTask, summaryTask, 'request').catch(error => error);
    });
    rerender({ enabled: false });
    await act(async () => late.resolve(edge));
    expect(await pending).toBeInstanceOf(Error);
    expect(result.current.state).toEqual(empty);
    expect(client.getQueryData([...api.scopeKey, 'state'])).toEqual(empty);
  });
  it('no guarda un hito mientras la carga inicial está pendiente', async () => {
    const api = source(),
      late = deferred<PlanningState>();
    vi.mocked(api.load).mockReturnValue(late.promise);
    const { wrapper } = provider();
    const { result } = renderHook(() => usePlanning(api, true), { wrapper });
    await expect(result.current.createMilestone(summaryProject, { name: 'Publicación', date: '2026-11-04', completed: false }, 'request')).rejects.toThrow(
      'Actualiza',
    );
    expect(api.createMilestone).not.toHaveBeenCalled();
    await act(async () => late.resolve(empty));
  });
});

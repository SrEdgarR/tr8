import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Favorite, ProductivityApi, ProductivityState, SavedTaskView, TaskViewConfig, TaskViewContext } from '../productivity-types';
import { errorMessage } from './helpers';

const EMPTY: ProductivityState = { favorites: [], views: [] };

export default function useProductivity(api: ProductivityApi | undefined, enabled: boolean) {
  const client = useQueryClient();
  const key = [...(api?.scopeKey ?? ['productivity-unavailable']), 'state'];
  const scope = JSON.stringify(key);
  const canOperate = Boolean(api && enabled);
  const live = useRef({ scope, enabled: canOperate, generation: 0 });
  if (live.current.scope !== scope || live.current.enabled !== canOperate) {
    live.current = { scope, enabled: canOperate, generation: live.current.generation + 1 };
  }
  const generation = live.current.generation;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const query = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const result = await api!.load(signal);
      if (!mounted.current || !live.current.enabled || live.current.generation !== generation) throw new Error('El acceso cambió durante la consulta.');
      return result;
    },
    enabled: canOperate,
    staleTime: 15000,
    refetchInterval: 30000,
    retry: false,
  });
  const mutation = useMutation({ mutationFn: async (operation: () => Promise<unknown>) => operation(), retry: false });
  const resetMutation = mutation.reset;
  useEffect(() => {
    resetMutation();
  }, [generation, resetMutation]);
  const available = Boolean(api && enabled && query.data && !query.error);
  const state = available ? query.data! : EMPTY;

  async function run<T>(operation: () => Promise<T>, update: (previous: ProductivityState, result: T) => ProductivityState): Promise<T> {
    if (!available || !mounted.current || !live.current.enabled || live.current.generation !== generation)
      throw new Error('Actualiza los favoritos y las vistas antes de guardar.');
    const result = (await mutation.mutateAsync(operation)) as T;
    if (!mounted.current || !live.current.enabled || live.current.generation !== generation)
      throw new Error('El espacio o tus permisos cambiaron. Comprueba el resultado al volver.');
    client.setQueryData<ProductivityState>(key, previous => update(previous ?? EMPTY, result));
    void client.invalidateQueries({ queryKey: key, exact: true });
    return result;
  }

  return {
    state,
    available,
    loading: Boolean(api && enabled && query.isPending),
    pending: mutation.isPending,
    error: query.error ? errorMessage(query.error) : mutation.error ? errorMessage(mutation.error) : null,
    refresh: () => {
      mutation.reset();
      void query.refetch();
    },
    setFavorite: (kind: Favorite['kind'], id: string, favorite: boolean) =>
      run(
        () => api!.setFavorite(kind, id, favorite),
        (previous, result) => ({
          ...previous,
          favorites: [
            ...previous.favorites.filter(row => row.kind !== kind || row.id !== id),
            ...(result.favorite ? [{ kind: result.kind, id: result.id, project_id: result.project_id }] : []),
          ],
        }),
      ),
    createView: (name: string, context: TaskViewContext, projectId: string | null, config: TaskViewConfig, requestId: string = crypto.randomUUID()) =>
      run(
        () => api!.createView(requestId, name, context, projectId, config),
        (previous, result) => ({ ...previous, views: [...previous.views.filter(row => row.id !== result.id), result] }),
      ),
    updateView: (view: SavedTaskView, name: string, config: TaskViewConfig) =>
      run(
        () => api!.updateView(view, name, config),
        (previous, result) => ({ ...previous, views: previous.views.map(row => (row.id === result.id ? result : row)) }),
      ),
    deleteView: (view: SavedTaskView) =>
      run(
        () => api!.deleteView(view),
        previous => ({ ...previous, views: previous.views.filter(row => row.id !== view.id) }),
      ),
  };
}

export type ProductivityController = ReturnType<typeof useProductivity>;

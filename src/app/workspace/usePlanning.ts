import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MilestoneInput, PlanningApi, PlanningState, ProjectMilestone, TaskDependency } from '../planning-types';
import type { Project, Task } from '../types';
import { errorMessage } from './helpers';

const EMPTY: PlanningState = { dependencies: [], milestones: [] };

export default function usePlanning(api: PlanningApi | undefined, enabled: boolean) {
  const client = useQueryClient();
  const key = [...(api?.scopeKey ?? ['planning-unavailable']), 'state'];
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

  async function run<T>(operation: () => Promise<T>, update: (previous: PlanningState, result: T) => PlanningState): Promise<T> {
    if (!available || !mounted.current || !live.current.enabled || live.current.generation !== generation)
      throw new Error('Actualiza la planificación antes de guardar.');
    const result = (await mutation.mutateAsync(operation)) as T;
    if (!mounted.current || !live.current.enabled || live.current.generation !== generation)
      throw new Error('El espacio o tus permisos cambiaron. Comprueba el resultado al volver.');
    client.setQueryData<PlanningState>(key, previous => update(previous ?? EMPTY, result));
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
    addDependency: (task: Task, blocker: Task, requestId: string) =>
      run(
        () => api!.addDependency(task, blocker, requestId),
        (previous, result) => ({ ...previous, dependencies: [...previous.dependencies.filter(row => row.id !== result.id), result] }),
      ),
    removeDependency: (edge: TaskDependency) =>
      run(
        () => api!.removeDependency(edge),
        previous => ({ ...previous, dependencies: previous.dependencies.filter(row => row.id !== edge.id) }),
      ),
    createMilestone: (project: Project, input: MilestoneInput, requestId: string) =>
      run(
        () => api!.createMilestone(project, input, requestId),
        (previous, result) => ({ ...previous, milestones: [...previous.milestones.filter(row => row.id !== result.id), result] }),
      ),
    updateMilestone: (row: ProjectMilestone, input: MilestoneInput) =>
      run(
        () => api!.updateMilestone(row, input),
        (previous, result) => ({ ...previous, milestones: previous.milestones.map(item => (item.id === result.id ? result : item)) }),
      ),
    deleteMilestone: (row: ProjectMilestone) =>
      run(
        () => api!.deleteMilestone(row),
        previous => ({ ...previous, milestones: previous.milestones.filter(item => item.id !== row.id) }),
      ),
  };
}

export type PlanningController = ReturnType<typeof usePlanning>;

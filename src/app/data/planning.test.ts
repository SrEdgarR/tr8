import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { MilestoneInput, ProjectMilestone, TaskDependency } from '../planning-types';
import type { Project, Task } from '../types';
import { createPlanningRepository, isMilestoneInput } from './planning';

const uid = (n: number) => `f9500000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = uid(1),
  projectId = uid(2),
  taskId = uid(3),
  blockerId = uid(4),
  requestId = uid(5);
const task = { id: taskId, workspace_id: workspace, project_id: projectId, version: 3 } as Task;
const blocker = { ...task, id: blockerId, project_id: uid(7), version: 4 };
const project = { id: projectId, workspace_id: workspace, version: 2 } as Project;
const input: MilestoneInput = { name: 'Publicar', date: '2026-11-20', completed: false };
const edge: TaskDependency = {
  id: requestId,
  workspace_id: workspace,
  task_id: taskId,
  blocker_task_id: blockerId,
  version: 1,
  created_at: '2026-10-28T12:00:00Z',
};
const milestone: ProjectMilestone = {
  id: requestId,
  workspace_id: workspace,
  project_id: projectId,
  ...input,
  version: 2,
  created_at: edge.created_at,
  updated_at: edge.created_at,
};
function setup(data: unknown = { dependencies: [], milestones: [] }, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { rpc, repository: createPlanningRepository({ rpc } as unknown as SupabaseClient, workspace) };
}

describe('planning browser contract', () => {
  it('loads exactly the current workspace with optional request cancellation', async () => {
    const abortSignal = vi.fn().mockResolvedValue({ data: { dependencies: [edge], milestones: [milestone] }, error: null });
    const rpc = vi.fn().mockReturnValue({ abortSignal });
    const controller = new AbortController();
    const repository = createPlanningRepository({ rpc } as unknown as SupabaseClient, workspace);
    expect(await repository.load(controller.signal)).toEqual({ dependencies: [edge], milestones: [milestone] });
    expect(rpc).toHaveBeenCalledWith('tr8_v2_planning', { p_workspace_id: workspace, p_action: 'load', p_input: {} });
    expect(abortSignal).toHaveBeenCalledWith(controller.signal);
  });
  it('creates a cross-project dependency with stable identity and both current task versions', async () => {
    const { repository, rpc } = setup(edge);
    expect(await repository.addDependency(task, blocker, requestId)).toEqual(edge);
    expect(rpc).toHaveBeenCalledWith('tr8_v2_planning', {
      p_workspace_id: workspace,
      p_action: 'add_dependency',
      p_input: { id: requestId, task_id: taskId, task_version: 3, blocker_task_id: blockerId, blocker_version: 4 },
    });
    expect(task.version).toBe(3);
    expect(blocker.version).toBe(4);
  });
  it('rejects self links, foreign workspaces, invalid versions and unstable request IDs before network access', async () => {
    const { repository, rpc } = setup(edge);
    await expect(repository.addDependency(task, task, requestId)).rejects.toMatchObject({ code: '22023' });
    await expect(repository.addDependency(task, { ...blocker, workspace_id: uid(8) }, requestId)).rejects.toMatchObject({ code: '22023' });
    await expect(repository.addDependency({ ...task, version: 0 }, blocker, requestId)).rejects.toMatchObject({ code: '22023' });
    await expect(repository.addDependency(task, blocker, 'bad')).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('does not accept a substituted task or blocker in the server result', async () => {
    for (const data of [
      { ...edge, task_id: uid(8) },
      { ...edge, blocker_task_id: uid(8) },
      { ...edge, workspace_id: uid(8) },
      { ...edge, id: uid(8) },
    ]) {
      const { repository } = setup(data);
      await expect(repository.addDependency(task, blocker, requestId)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    }
  });
  it('removes only the exact dependency ID and expected version', async () => {
    const { repository, rpc } = setup({ id: edge.id, deleted: true });
    await repository.removeDependency(edge);
    expect(rpc).toHaveBeenCalledWith('tr8_v2_planning', { p_workspace_id: workspace, p_action: 'remove_dependency', p_input: { id: edge.id, version: 1 } });
  });
  it('preserves stale-write error semantics', async () => {
    const { repository } = setup(null, { code: 'PT409', message: 'changed' });
    await expect(repository.removeDependency(edge)).rejects.toMatchObject({ code: 'PT409' });
  });
  it('normalizes the milestone name while preserving the civil date', async () => {
    const { repository, rpc } = setup(milestone);
    expect(await repository.createMilestone(project, { ...input, name: ' Publicar ' }, requestId)).toEqual(milestone);
    expect(rpc).toHaveBeenCalledWith('tr8_v2_planning', {
      p_workspace_id: workspace,
      p_action: 'create_milestone',
      p_input: { id: requestId, project_id: projectId, input },
    });
  });
  it('validates actual civil dates, closed input and finite name length', () => {
    expect(isMilestoneInput({ ...input, date: '2028-02-29' })).toBe(true);
    for (const value of [
      { ...input, date: '2027-02-29' },
      { ...input, date: '2026-13-01' },
      { ...input, date: '2026-11-20T00:00:00Z' },
      { ...input, date: '0000-01-01' },
      { ...input, date: null },
      { ...input, name: ' ' },
      { ...input, name: 'x'.repeat(121) },
      { ...input, completed: 'true' },
      { ...input, owner_id: uid(9) },
    ])
      expect(isMilestoneInput(value)).toBe(false);
  });
  it('rejects malformed or foreign milestone input before network access', async () => {
    const { repository, rpc } = setup(milestone);
    await expect(repository.createMilestone({ ...project, workspace_id: uid(8) }, input, requestId)).rejects.toMatchObject({ code: '22023' });
    await expect(repository.createMilestone(project, { ...input, date: '2026-02-31' }, requestId)).rejects.toMatchObject({ code: '22023' });
    await expect(repository.createMilestone(project, { ...input, owner_id: uid(9) } as MilestoneInput, requestId)).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('updates a milestone using its own CAS without changing its project', async () => {
    const { repository, rpc } = setup({ ...milestone, completed: true, version: 3 });
    await expect(repository.updateMilestone(milestone, { ...input, completed: true })).resolves.toMatchObject({ version: 3, completed: true });
    expect(rpc).toHaveBeenCalledWith('tr8_v2_planning', {
      p_workspace_id: workspace,
      p_action: 'update_milestone',
      p_input: { id: milestone.id, version: 2, input: { ...input, completed: true } },
    });
  });
  it('rejects stale or substituted update responses', async () => {
    for (const data of [
      { ...milestone, version: 2 },
      { ...milestone, version: 3, project_id: uid(8) },
    ]) {
      const { repository } = setup(data);
      await expect(repository.updateMilestone(milestone, input)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    }
  });
  it('deletes only the selected milestone and checks the response identity', async () => {
    const { repository, rpc } = setup({ id: milestone.id, deleted: true });
    await repository.deleteMilestone(milestone);
    expect(rpc).toHaveBeenCalledWith('tr8_v2_planning', { p_workspace_id: workspace, p_action: 'delete_milestone', p_input: { id: milestone.id, version: 2 } });
    const other = setup({ id: uid(8), deleted: true });
    await expect(other.repository.deleteMilestone(milestone)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });
  it('fails closed for cross-workspace, duplicate and invalid loaded records', async () => {
    for (const data of [
      null,
      { dependencies: [], milestones: [], extra: true },
      { dependencies: [edge, edge], milestones: [] },
      { dependencies: [edge, { ...edge, id: uid(8) }], milestones: [] },
      { dependencies: [{ ...edge, workspace_id: uid(8) }], milestones: [] },
      { dependencies: [{ ...edge, blocker_task_id: taskId }], milestones: [] },
      { dependencies: [], milestones: [milestone, milestone] },
      { dependencies: [], milestones: [{ ...milestone, date: '2026-02-30' }] },
      { dependencies: [], milestones: [{ ...milestone, updated_at: 'bad' }] },
    ]) {
      const { repository } = setup(data);
      await expect(repository.load()).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    }
  });
  it('rejects responses over workspace and project limits', async () => {
    const many = Array.from({ length: 51 }, (_, index) => ({ ...milestone, id: uid(index + 100) }));
    await expect(setup({ dependencies: [], milestones: many }).repository.load()).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    const edges = Array.from({ length: 1001 }, (_, index) => ({ ...edge, id: uid(index + 100), task_id: uid(index + 2000) }));
    await expect(setup({ dependencies: edges, milestones: [] }).repository.load()).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });
});

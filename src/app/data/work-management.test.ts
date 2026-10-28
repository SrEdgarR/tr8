import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { Project, ProjectInput, Task } from '../types';
import { PROJECT_TEMPLATES, type TaskDetailsInput } from '../work-management-types';
import { createWorkManagementRepository, isTaskDetailsInput } from './work-management';

const uid = (n: number) => `f9400000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = uid(1),
  projectId = uid(2),
  taskId = uid(3),
  targetId = uid(4),
  requestId = uid(5);
const project: Project = {
  id: projectId,
  workspace_id: workspace,
  owner_id: uid(10),
  name: 'Sitio',
  description: 'Contexto',
  code: 'P-QA',
  color: '#5A67D8',
  icon: 'globe',
  status: 'active',
  start_date: '2026-10-28',
  due_date: '2026-11-20',
  lead_member_id: uid(11),
  archived_at: null,
  version: 4,
  created_at: '2026-10-28T10:00:00Z',
  updated_at: '2026-10-28T10:00:00Z',
};
const input: ProjectInput = { name: ' Sitio ', description: ' Contexto ', color: '#5A67D8', icon: 'globe', status: 'active' };
const task: Task = {
  id: taskId,
  workspace_id: workspace,
  project_id: projectId,
  owner_id: uid(10),
  task_number: 1,
  title: 'Verificar',
  description: '',
  status: 'todo',
  priority: 'medium',
  start_date: null,
  due_date: null,
  assignee_member_id: null,
  position: 1024,
  version: 7,
  created_at: '2026-10-28T10:00:00Z',
  updated_at: '2026-10-28T10:00:00Z',
  archived_at: null,
  labels: [],
  estimate_minutes: null,
  subtasks: [],
};
const details: TaskDetailsInput = { labels: ['Diseño'], estimate_minutes: 90, subtasks: [{ id: uid(20), title: 'Revisar teclado', done: false }] };
function setup(value: unknown = task) {
  const rpc = vi.fn().mockResolvedValue({ data: value, error: null });
  return { rpc, repository: createWorkManagementRepository({ rpc } as unknown as SupabaseClient, workspace) };
}

describe('work management browser contract', () => {
  it('exposes only the three finite templates with actual task titles', () => {
    expect(PROJECT_TEMPLATES.map(t => t.key)).toEqual(['website', 'launch', 'sprint']);
    expect(PROJECT_TEMPLATES.every(t => t.tasks.length === 5)).toBe(true);
  });
  it('creates a project atomically with explicit planning and template fields under a stable UUID', async () => {
    const { rpc, repository } = setup({ ...project, id: requestId });
    await repository.createProject({ ...input, template_key: 'website' }, requestId);
    expect(rpc).toHaveBeenCalledWith('tr8_v2_work_management', {
      p_workspace_id: workspace,
      p_action: 'create_project',
      p_input: {
        id: requestId,
        input: {
          name: 'Sitio',
          description: 'Contexto',
          color: '#5A67D8',
          icon: 'globe',
          status: 'active',
          start_date: null,
          due_date: null,
          lead_member_id: null,
          template_key: 'website',
        },
      },
    });
  });
  it('preserves omitted planning and lead fields on updates while explicit null clears them', async () => {
    const { rpc, repository } = setup(project);
    await repository.updateProject(project, input);
    expect(rpc.mock.calls[0][1].p_input).toMatchObject({
      id: projectId,
      version: 4,
      input: { start_date: project.start_date, due_date: project.due_date, lead_member_id: project.lead_member_id },
    });
    await repository.updateProject(project, { ...input, lead_member_id: null, start_date: null, due_date: null });
    expect(rpc.mock.calls[1][1].p_input.input).toMatchObject({ start_date: null, due_date: null, lead_member_id: null });
  });
  it('duplicates a project with source version, explicit task inclusion and exact request identity', async () => {
    const { rpc, repository } = setup({ ...project, id: requestId });
    await repository.duplicateProject(project, { name: ' Copia ', includeTasks: true }, requestId);
    expect(rpc.mock.calls[0][1]).toEqual({
      p_workspace_id: workspace,
      p_action: 'duplicate_project',
      p_input: { id: projectId, version: 4, request_id: requestId, name: 'Copia', include_tasks: true },
    });
  });
  it('updates bounded details using the task version without changing its base fields', async () => {
    const { rpc, repository } = setup({ ...task, ...details });
    await repository.updateTaskDetails(task, details);
    expect(rpc.mock.calls[0][1].p_input).toEqual({ id: taskId, version: 7, input: details });
  });
  it('distinguishes task copy from move and carries the explicit assignment clearing choice', async () => {
    const { rpc, repository } = setup({ ...task, id: requestId, project_id: targetId });
    await repository.duplicateTask(task, targetId, requestId);
    expect(rpc.mock.calls[0][1].p_action).toBe('duplicate_task');
    rpc.mockResolvedValue({ data: { ...task, project_id: targetId }, error: null });
    await repository.moveTask(task, targetId, requestId, true);
    expect(rpc.mock.calls[1][1].p_input).toEqual({ id: taskId, version: 7, target_project_id: targetId, request_id: requestId, clear_assignee: true });
  });
  it('archives and restores with server version and request identity', async () => {
    const { rpc, repository } = setup(task);
    await repository.archiveTask(task, true, requestId);
    await repository.archiveTask(task, false, uid(6));
    expect(rpc.mock.calls.map(c => c[1].p_input)).toEqual([
      { id: taskId, version: 7, archived: true, request_id: requestId },
      { id: taskId, version: 7, archived: false, request_id: uid(6) },
    ]);
  });
  it.each([
    { ...details, labels: ['A', 'a'] },
    { ...details, labels: [' x'] },
    { ...details, labels: [''] },
    { ...details, labels: Array(11).fill('x') },
    { ...details, labels: ['x'.repeat(41)] },
    { ...details, estimate_minutes: -1 },
    { ...details, estimate_minutes: 100001 },
    { ...details, estimate_minutes: 1.5 },
    { ...details, estimate_minutes: '10' },
    { ...details, subtasks: [{ id: 'bad', title: 'x', done: false }] },
    { ...details, subtasks: [{ id: uid(20), title: '', done: false }] },
    { ...details, subtasks: [{ id: uid(20), title: 'x', done: 'false' }] },
    { ...details, subtasks: [...details.subtasks, ...details.subtasks] },
    { ...details, sql: 'select *' },
    { ...details, subtasks: [{ ...details.subtasks[0], owner_id: uid(99) }] },
  ])('rejects unknown or malformed task details without transmitting them %j', invalid => {
    expect(isTaskDetailsInput(invalid)).toBe(false);
    const { rpc, repository } = setup();
    expect(() => repository.updateTaskDetails(task, invalid as TaskDetailsInput)).toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, name: 42 },
    { ...input, description: null },
    { ...input, owner_id: uid(99) },
    { ...input, template_key: 'custom' },
    { ...input, start_date: '2026-02-30' },
    { ...input, start_date: '2026-12-01', due_date: '2026-11-01' },
  ])('rejects malformed project fields before RPC %j', invalid => {
    const { rpc, repository } = setup(project);
    expect(() => repository.createProject(invalid as ProjectInput, requestId)).toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects cross-workspace task and project sources before sending data', () => {
    const { rpc, repository } = setup();
    expect(() => repository.updateTaskDetails({ ...task, workspace_id: uid(99) }, details)).toThrow();
    expect(() => repository.updateProject({ ...project, workspace_id: uid(99) }, input)).toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...task, workspace_id: uid(99) },
    { ...task, id: uid(99) },
    { ...task, project_id: targetId },
    { ...task, labels: ['x', 'x'] },
    { ...task, version: 0 },
  ])('fails closed on malformed or out-of-scope task responses %j', async invalid => {
    const { repository } = setup(invalid);
    await expect(repository.updateTaskDetails(task, details)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });
  it('surfaces version conflicts and never converts a provider failure into success', async () => {
    const { rpc, repository } = setup();
    rpc.mockResolvedValue({ data: null, error: { code: 'PT409', message: 'changed' } });
    await expect(repository.archiveTask(task, true, requestId)).rejects.toMatchObject({ code: 'PT409' });
  });
});

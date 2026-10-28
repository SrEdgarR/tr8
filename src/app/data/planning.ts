import type { SupabaseClient } from '@supabase/supabase-js';
import type { MilestoneInput, PlanningApi, PlanningState, ProjectMilestone, TaskDependency } from '../planning-types';
import type { Project, Task } from '../types';
import { DataError, dataError } from './errors';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const version = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 999999999;
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const fail = () => new DataError('Revisa las dependencias y los datos del hito.', '22023');
const malformed = () => new DataError('La respuesta no corresponde a esta versión de TR8. Actualiza los datos.', 'CLIENT_UPGRADE_REQUIRED');
function date(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01' || value > '9999-12-31') return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 50 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
export function isMilestoneInput(value: unknown): value is MilestoneInput {
  return (
    record(value) &&
    closed(value, ['name', 'date', 'completed']) &&
    typeof value.name === 'string' &&
    value.name.trim() === value.name &&
    value.name.length > 0 &&
    value.name.length <= 120 &&
    date(value.date) &&
    typeof value.completed === 'boolean'
  );
}
function milestoneInput(value: MilestoneInput): MilestoneInput {
  if (!record(value) || typeof value.name !== 'string') throw fail();
  const trimmed = { ...value, name: value.name.trim() };
  if (!isMilestoneInput(trimmed)) throw fail();
  return trimmed;
}
function isDependency(value: unknown, workspaceId: string): value is TaskDependency {
  return (
    record(value) &&
    closed(value, ['id', 'workspace_id', 'task_id', 'blocker_task_id', 'version', 'created_at']) &&
    id(value.id) &&
    value.workspace_id === workspaceId &&
    id(value.task_id) &&
    id(value.blocker_task_id) &&
    value.task_id !== value.blocker_task_id &&
    version(value.version) &&
    timestamp(value.created_at)
  );
}
function isMilestone(value: unknown, workspaceId: string): value is ProjectMilestone {
  return (
    record(value) &&
    closed(value, ['id', 'workspace_id', 'project_id', 'name', 'date', 'completed', 'version', 'created_at', 'updated_at']) &&
    id(value.id) &&
    value.workspace_id === workspaceId &&
    id(value.project_id) &&
    isMilestoneInput({ name: value.name, date: value.date, completed: value.completed }) &&
    version(value.version) &&
    timestamp(value.created_at) &&
    timestamp(value.updated_at)
  );
}
function requireTask(value: Task, workspaceId: string) {
  if (!record(value) || value.workspace_id !== workspaceId || !id(value.id) || !id(value.project_id) || !version(value.version)) throw fail();
}
function requireProject(value: Project, workspaceId: string) {
  if (!record(value) || value.workspace_id !== workspaceId || !id(value.id) || !version(value.version)) throw fail();
}

export function createPlanningRepository(client: SupabaseClient, workspaceId: string): Omit<PlanningApi, 'scopeKey'> {
  if (!id(workspaceId)) throw fail();
  async function request(action: string, input: Record<string, unknown>, signal?: AbortSignal) {
    let query = client.rpc('tr8_v2_planning', { p_workspace_id: workspaceId, p_action: action, p_input: input });
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw dataError(error);
    return data as unknown;
  }
  function checkedMilestone(value: unknown, expectedId: string, projectId: string) {
    if (!isMilestone(value, workspaceId) || value.id !== expectedId || value.project_id !== projectId) throw malformed();
    return value;
  }
  async function remove(action: string, value: TaskDependency | ProjectMilestone) {
    const result = await request(action, { id: value.id, version: value.version });
    if (!record(result) || !closed(result, ['id', 'deleted']) || result.id !== value.id || result.deleted !== true) throw malformed();
  }
  return {
    async load(signal): Promise<PlanningState> {
      const value = await request('load', {}, signal);
      if (
        !record(value) ||
        !closed(value, ['dependencies', 'milestones']) ||
        !Array.isArray(value.dependencies) ||
        value.dependencies.length > 1000 ||
        !value.dependencies.every(item => isDependency(item, workspaceId)) ||
        new Set(value.dependencies.map(item => item.id)).size !== value.dependencies.length ||
        new Set(value.dependencies.map(item => `${item.task_id}:${item.blocker_task_id}`)).size !== value.dependencies.length ||
        !Array.isArray(value.milestones) ||
        value.milestones.length > 200 ||
        !value.milestones.every(item => isMilestone(item, workspaceId)) ||
        new Set(value.milestones.map(item => item.id)).size !== value.milestones.length
      )
        throw malformed();
      const counts = new Map<string, number>();
      for (const milestone of value.milestones) counts.set(milestone.project_id, (counts.get(milestone.project_id) ?? 0) + 1);
      if ([...counts.values()].some(count => count > 50)) throw malformed();
      return { dependencies: value.dependencies, milestones: value.milestones };
    },
    async addDependency(task, blocker, requestId) {
      requireTask(task, workspaceId);
      requireTask(blocker, workspaceId);
      if (!id(requestId) || task.id === blocker.id) throw fail();
      const value = await request('add_dependency', {
        id: requestId,
        task_id: task.id,
        task_version: task.version,
        blocker_task_id: blocker.id,
        blocker_version: blocker.version,
      });
      if (!isDependency(value, workspaceId) || value.id !== requestId || value.task_id !== task.id || value.blocker_task_id !== blocker.id) throw malformed();
      return value;
    },
    async removeDependency(edge) {
      if (!isDependency(edge, workspaceId)) throw fail();
      await remove('remove_dependency', edge);
    },
    async createMilestone(project, input, requestId) {
      requireProject(project, workspaceId);
      if (!id(requestId)) throw fail();
      return checkedMilestone(
        await request('create_milestone', { id: requestId, project_id: project.id, input: milestoneInput(input) }),
        requestId,
        project.id,
      );
    },
    async updateMilestone(milestone, input) {
      if (!isMilestone(milestone, workspaceId)) throw fail();
      const result = checkedMilestone(
        await request('update_milestone', { id: milestone.id, version: milestone.version, input: milestoneInput(input) }),
        milestone.id,
        milestone.project_id,
      );
      if (result.version !== milestone.version + 1) throw malformed();
      return result;
    },
    async deleteMilestone(milestone) {
      if (!isMilestone(milestone, workspaceId)) throw fail();
      await remove('delete_milestone', milestone);
    },
  };
}

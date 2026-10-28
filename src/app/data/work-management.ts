import type { SupabaseClient } from '@supabase/supabase-js';
import type { Project, ProjectInput, Task } from '../types';
import { PROJECT_TEMPLATES, type TaskDetailsInput, type WorkManagementApi } from '../work-management-types';
import { isProjectIcon } from '../project-identity';
import { DataError, dataError } from './errors';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const validId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const validVersion = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const fail = (message = 'Revisa los campos del proyecto o la tarea.') => new DataError(message, '22023');
const malformed = () => new DataError('La respuesta no corresponde a esta versión de TR8. Actualiza los datos.', 'CLIENT_UPGRADE_REQUIRED');
function date(value: unknown) {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function closed(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
export function isTaskDetailsInput(value: unknown): value is TaskDetailsInput {
  if (!record(value) || !closed(value, ['labels', 'estimate_minutes', 'subtasks'])) return false;
  if (
    !Array.isArray(value.labels) ||
    value.labels.length > 10 ||
    new Set(value.labels.map(label => (typeof label === 'string' ? label.toLocaleLowerCase('es') : label))).size !== value.labels.length ||
    value.labels.some(label => typeof label !== 'string' || !label.trim() || label !== label.trim() || label.length > 40)
  )
    return false;
  if (
    value.estimate_minutes !== null &&
    (typeof value.estimate_minutes !== 'number' ||
      !Number.isSafeInteger(value.estimate_minutes) ||
      value.estimate_minutes < 0 ||
      value.estimate_minutes > 100000)
  )
    return false;
  if (
    !Array.isArray(value.subtasks) ||
    value.subtasks.length > 100 ||
    new Set(value.subtasks.map(row => (record(row) ? row.id : row))).size !== value.subtasks.length
  )
    return false;
  return (
    new TextEncoder().encode(JSON.stringify(value.subtasks)).length <= 50000 &&
    value.subtasks.every(
      row =>
        record(row) &&
        closed(row, ['id', 'title', 'done']) &&
        validId(row.id) &&
        typeof row.title === 'string' &&
        row.title === row.title.trim() &&
        row.title.length > 0 &&
        row.title.length <= 240 &&
        typeof row.done === 'boolean',
    )
  );
}
function projectInput(input: ProjectInput, creating: boolean, previous?: Project) {
  const allowed = ['name', 'description', 'color', 'icon', 'status', 'start_date', 'due_date', 'lead_member_id', ...(creating ? ['template_key'] : [])];
  if (!record(input) || Object.keys(input).some(key => !allowed.includes(key))) throw fail();
  if (typeof input.name !== 'string' || typeof input.description !== 'string' || typeof input.color !== 'string' || typeof input.status !== 'string')
    throw fail();
  const value = {
    name: input.name?.trim(),
    description: input.description?.trim(),
    color: input.color,
    icon: input.icon ?? previous?.icon ?? 'folder',
    status: input.status,
    start_date: input.start_date === undefined ? (previous?.start_date ?? null) : input.start_date,
    due_date: input.due_date === undefined ? (previous?.due_date ?? null) : input.due_date,
    lead_member_id: input.lead_member_id === undefined ? (previous?.lead_member_id ?? null) : input.lead_member_id,
  };
  if (
    !value.name ||
    value.name.length > 120 ||
    typeof value.description !== 'string' ||
    value.description.length > 10000 ||
    !/^#[0-9a-f]{6}$/i.test(value.color) ||
    !isProjectIcon(value.icon) ||
    !['planning', 'active', 'hold', 'complete'].includes(value.status) ||
    !date(value.start_date) ||
    !date(value.due_date) ||
    (value.start_date && value.due_date && value.start_date > value.due_date) ||
    (value.lead_member_id !== null && !validId(value.lead_member_id))
  )
    throw fail();
  const template = input.template_key ?? null;
  if (creating && template !== null && !PROJECT_TEMPLATES.some(item => item.key === template)) throw fail();
  return creating ? { ...value, template_key: template } : value;
}
function requireId(id: string) {
  if (!validId(id)) throw fail();
}
function requireTask(task: Task, workspaceId: string) {
  if (task.workspace_id !== workspaceId || !validId(task.id) || !validId(task.project_id) || !validVersion(task.version)) throw fail();
}
function requireProject(project: Project, workspaceId: string) {
  if (project.workspace_id !== workspaceId || !validId(project.id) || !validVersion(project.version)) throw fail();
}
function isProject(value: unknown, workspaceId: string): value is Project {
  return (
    record(value) &&
    validId(value.id) &&
    value.workspace_id === workspaceId &&
    validId(value.owner_id) &&
    validVersion(value.version) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    typeof value.description === 'string' &&
    typeof value.code === 'string' &&
    typeof value.color === 'string' &&
    /^#[0-9a-f]{6}$/i.test(value.color) &&
    ['planning', 'active', 'hold', 'complete'].includes(String(value.status)) &&
    isProjectIcon(value.icon) &&
    date(value.start_date) &&
    date(value.due_date) &&
    (value.lead_member_id === null || validId(value.lead_member_id)) &&
    (value.archived_at === null || typeof value.archived_at === 'string')
  );
}
function isTask(value: unknown, workspaceId: string): value is Task {
  return (
    record(value) &&
    value.workspace_id === workspaceId &&
    validId(value.id) &&
    validId(value.project_id) &&
    validId(value.owner_id) &&
    validVersion(value.version) &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    Number.isSafeInteger(value.task_number) &&
    Number.isSafeInteger(value.position) &&
    date(value.start_date) &&
    date(value.due_date) &&
    ['backlog', 'todo', 'progress', 'review', 'done'].includes(String(value.status)) &&
    ['none', 'low', 'medium', 'high', 'urgent'].includes(String(value.priority)) &&
    (value.archived_at === null || typeof value.archived_at === 'string') &&
    isTaskDetailsInput({ labels: value.labels, estimate_minutes: value.estimate_minutes, subtasks: value.subtasks })
  );
}

export function createWorkManagementRepository(client: SupabaseClient, workspaceId: string): Omit<WorkManagementApi, 'scopeKey'> {
  requireId(workspaceId);
  async function rpc<T>(
    action: string,
    input: Record<string, unknown>,
    predicate: (value: unknown, workspaceId: string) => value is T,
    expectedId: string,
    expectedProjectId?: string,
  ): Promise<T> {
    const { data, error } = await client.rpc('tr8_v2_work_management', { p_workspace_id: workspaceId, p_action: action, p_input: input });
    if (error) throw dataError(error);
    if (!predicate(data, workspaceId) || !record(data) || data.id !== expectedId || (expectedProjectId !== undefined && data.project_id !== expectedProjectId))
      throw malformed();
    return data;
  }
  return {
    createProject(input, requestId) {
      requireId(requestId);
      return rpc('create_project', { id: requestId, input: projectInput(input, true) }, isProject, requestId);
    },
    updateProject(project, input) {
      requireProject(project, workspaceId);
      return rpc('update_project', { id: project.id, version: project.version, input: projectInput(input, false, project) }, isProject, project.id);
    },
    duplicateProject(project, input, requestId) {
      requireProject(project, workspaceId);
      requireId(requestId);
      if (
        !record(input) ||
        !closed(input, ['name', 'includeTasks']) ||
        typeof input.name !== 'string' ||
        !input.name.trim() ||
        input.name.trim().length > 120 ||
        typeof input.includeTasks !== 'boolean'
      )
        throw fail();
      return rpc(
        'duplicate_project',
        { id: project.id, version: project.version, request_id: requestId, name: input.name.trim(), include_tasks: input.includeTasks },
        isProject,
        requestId,
      );
    },
    updateTaskDetails(task, input) {
      requireTask(task, workspaceId);
      if (!isTaskDetailsInput(input)) throw fail('Revisa las etiquetas, la estimación y las subtareas.');
      return rpc('update_task_details', { id: task.id, version: task.version, input }, isTask, task.id, task.project_id);
    },
    duplicateTask(task, targetProjectId, requestId) {
      requireTask(task, workspaceId);
      requireId(targetProjectId);
      requireId(requestId);
      return rpc(
        'duplicate_task',
        { id: task.id, version: task.version, target_project_id: targetProjectId, request_id: requestId },
        isTask,
        requestId,
        targetProjectId,
      );
    },
    moveTask(task, targetProjectId, requestId, clearAssignee = false) {
      requireTask(task, workspaceId);
      requireId(targetProjectId);
      requireId(requestId);
      if (typeof clearAssignee !== 'boolean') throw fail();
      return rpc(
        'move_task',
        { id: task.id, version: task.version, target_project_id: targetProjectId, request_id: requestId, clear_assignee: clearAssignee },
        isTask,
        task.id,
        targetProjectId,
      );
    },
    archiveTask(task, archived, requestId) {
      requireTask(task, workspaceId);
      requireId(requestId);
      if (typeof archived !== 'boolean') throw fail();
      return rpc('archive_task', { id: task.id, version: task.version, archived, request_id: requestId }, isTask, task.id, task.project_id);
    },
  };
}

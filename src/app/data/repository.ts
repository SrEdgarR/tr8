import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AppContext,
  Project,
  ProjectCapability,
  ProjectInput,
  Task,
  TaskInput,
  TaskPatch,
  WorkspaceInvitation,
  WorkspaceMember,
  WorkspaceSummary,
} from '../types';
import { dataError, DataError } from './errors';
import { createCollaborationRepository } from './collaboration';
import { createCalendarRepository } from './calendar';

export interface WorkspaceData {
  projects: Project[];
  tasks: Task[];
  capabilities?: Record<string, ProjectCapability>;
}

const PAGE_SIZE = 250;

async function readScoped<T>(client: SupabaseClient, table: string, workspaceId: string, signal?: AbortSignal): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = client
      .from(table)
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('id')
      .range(offset, offset + PAGE_SIZE - 1);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw dataError(error);
    const page = data as T[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function validateProject(input: ProjectInput): ProjectInput {
  const value = { ...input, name: input.name.trim(), description: input.description.trim() };
  if (!value.name || value.name.length > 120 || value.description.length > 10000 || !/^#[0-9a-f]{6}$/i.test(value.color))
    throw new DataError('Revisa el nombre y el color del proyecto.');
  return value;
}

function validateTask(input: TaskInput): TaskInput {
  const value = { ...input, title: input.title.trim(), description: input.description.trim() };
  if (!value.title || value.title.length > 240 || value.description.length > 20000) throw new DataError('El título debe tener entre 1 y 240 caracteres.');
  if (value.start_date && value.due_date && value.start_date > value.due_date)
    throw new DataError('La fecha de vencimiento no puede ser anterior a la de inicio.');
  return value;
}

async function rpc<T>(client: SupabaseClient, name: string, parameters: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(name, parameters);
  if (error) throw dataError(error);
  if (Array.isArray(data)) {
    if (!data.length) throw new DataError('La operación no devolvió el registro guardado. Actualiza los datos.');
    return data[0] as T;
  }
  if (data === null && name !== 'tr8_v2_delete_task') throw new DataError('No se pudo confirmar el registro guardado.');
  return data as T;
}

export function createRepository(client: SupabaseClient) {
  return {
    ...createCollaborationRepository(client),
    ...createCalendarRepository(client),
    async context(): Promise<AppContext> {
      const context = await rpc<AppContext>(client, 'tr8_v2_get_context', {});
      if (context.contract_version !== 2) throw new DataError('TR8 necesita actualizarse. Recarga la página para continuar.', 'CLIENT_UPGRADE_REQUIRED');
      return context;
    },
    async load(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceData> {
      if (!workspaceId) throw new DataError('Selecciona un espacio para continuar.');
      const [projects, tasks] = await Promise.all([
        readScoped<Project>(client, 'tr8_workspace_projects', workspaceId, signal),
        readScoped<Task>(client, 'tr8_workspace_tasks', workspaceId, signal),
      ]);
      return { projects, tasks };
    },
    async resolveProject(id: string, signal?: AbortSignal): Promise<Pick<Project, 'workspace_id'> | null> {
      let query = client.from('tr8_workspace_projects').select('workspace_id').eq('id', id);
      if (signal) query = query.abortSignal(signal);
      const { data, error } = await query.maybeSingle();
      if (error) throw dataError(error);
      return data as Pick<Project, 'workspace_id'> | null;
    },
    createTeam(name: string, requestId: string): Promise<WorkspaceSummary> {
      const cleaned = name.trim();
      if (!cleaned || cleaned.length > 120) throw new DataError('El nombre del equipo debe tener entre 1 y 120 caracteres.');
      return rpc(client, 'tr8_v2_create_team', { p_id: requestId, p_name: cleaned });
    },
    async members(workspaceId: string): Promise<WorkspaceMember[]> {
      const { data, error } = await client.rpc('tr8_v2_list_members', { p_workspace_id: workspaceId });
      if (error) throw dataError(error);
      return data as WorkspaceMember[];
    },
    async invitations(workspaceId: string): Promise<WorkspaceInvitation[]> {
      const { data, error } = await client.rpc('tr8_v2_list_invitations', { p_workspace_id: workspaceId });
      if (error) throw dataError(error);
      return data as WorkspaceInvitation[];
    },
    acceptInvitation(token: string): Promise<{ workspace_id: string; member_id: string; status: 'accepted' }> {
      return rpc(client, 'tr8_v2_accept_invitation', { p_token: token });
    },
    createProject(workspaceId: string, input: ProjectInput, requestId: string): Promise<Project> {
      const value = validateProject(input);
      return rpc(client, 'tr8_v2_create_project', {
        p_workspace_id: workspaceId,
        p_id: requestId,
        p_name: value.name,
        p_description: value.description,
        p_color: value.color,
        p_status: value.status,
      });
    },
    updateProject(project: Project, input: ProjectInput): Promise<Project> {
      return rpc(client, 'tr8_v2_update_project', {
        p_workspace_id: project.workspace_id,
        p_id: project.id,
        p_version: project.version,
        p_patch: validateProject(input),
      });
    },
    archiveProject(project: Project, archived: boolean): Promise<Project> {
      return rpc(client, 'tr8_v2_update_project', {
        p_workspace_id: project.workspace_id,
        p_id: project.id,
        p_version: project.version,
        p_patch: { archived_at: archived ? new Date().toISOString() : null },
      });
    },
    createTask(workspaceId: string, input: TaskInput, requestId: string): Promise<Task> {
      const value = validateTask(input);
      return rpc(client, 'tr8_v2_create_task', {
        p_workspace_id: workspaceId,
        p_id: requestId,
        p_project_id: value.project_id,
        p_title: value.title,
        p_description: value.description,
        p_status: value.status,
        p_priority: value.priority,
        p_start_date: value.start_date,
        p_due_date: value.due_date,
      });
    },
    updateTask(task: Task, patch: TaskPatch): Promise<Task> {
      validateTask({ ...task, ...patch });
      const cleaned = { ...patch };
      if (cleaned.title !== undefined) cleaned.title = cleaned.title.trim();
      if (cleaned.description !== undefined) cleaned.description = cleaned.description.trim();
      return rpc(client, 'tr8_v2_update_task', { p_workspace_id: task.workspace_id, p_id: task.id, p_version: task.version, p_patch: cleaned });
    },
    async deleteTask(task: Task): Promise<void> {
      await rpc(client, 'tr8_v2_delete_task', { p_workspace_id: task.workspace_id, p_id: task.id, p_version: task.version });
    },
  };
}

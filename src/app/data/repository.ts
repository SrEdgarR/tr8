import type { SupabaseClient } from '@supabase/supabase-js';
import type { Project, ProjectInput, Task, TaskInput, TaskPatch } from '../types';
import { dataError, DataError } from './errors';

export interface WorkspaceData {
  projects: Project[];
  tasks: Task[];
}

const PAGE_SIZE = 500;

async function readAll<T>(client: SupabaseClient, table: string, signal?: AbortSignal): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = client
      .from(table)
      .select('*')
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
  if (data === null && name !== 'gr8r_delete_task') throw new DataError('No se pudo confirmar el registro guardado.');
  return data as T;
}

export function createRepository(client: SupabaseClient) {
  return {
    async load(signal?: AbortSignal): Promise<WorkspaceData> {
      const [projects, tasks, access] = await Promise.all([
        readAll<Project>(client, 'gr8r_projects', signal),
        readAll<Task>(client, 'gr8r_tasks', signal),
        rpc<boolean>(client, 'gr8r_check_access', {}),
      ]);
      if (!access)
        throw new DataError('Esta cuenta todavía no está autorizada en este espacio. Comprueba el correo confirmado y la configuración de acceso.', '42501');
      return { projects, tasks };
    },
    createProject(input: ProjectInput, requestId: string): Promise<Project> {
      const value = validateProject(input);
      return rpc(client, 'gr8r_create_project', {
        p_id: requestId,
        p_name: value.name,
        p_description: value.description,
        p_color: value.color,
        p_status: value.status,
      });
    },
    updateProject(project: Project, input: ProjectInput): Promise<Project> {
      return rpc(client, 'gr8r_update_project', { p_id: project.id, p_version: project.version, p_patch: validateProject(input) });
    },
    archiveProject(project: Project, archived: boolean): Promise<Project> {
      return rpc(client, 'gr8r_update_project', {
        p_id: project.id,
        p_version: project.version,
        p_patch: { archived_at: archived ? new Date().toISOString() : null },
      });
    },
    createTask(input: TaskInput, requestId: string): Promise<Task> {
      const value = validateTask(input);
      return rpc(client, 'gr8r_create_task', {
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
      return rpc(client, 'gr8r_update_task', { p_id: task.id, p_version: task.version, p_patch: cleaned });
    },
    async deleteTask(task: Task): Promise<void> {
      await rpc(client, 'gr8r_delete_task', { p_id: task.id, p_version: task.version });
    },
  };
}

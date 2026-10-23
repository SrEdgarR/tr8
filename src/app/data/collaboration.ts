import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActivityEntry, ActivityPage, AssignableMember, ProjectAccess, ProjectCapability, Task, WorkspaceMember, WorkspaceRole } from '../types';
import { DataError, dataError } from './errors';

type RecordValue = Record<string, unknown>;
const malformed = () => new DataError('La respuesta no corresponde a esta versión de TR8. Actualiza los datos.', 'CLIENT_UPGRADE_REQUIRED');
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const version = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const stringFields = (value: RecordValue, fields: string[]) => fields.every(field => typeof value[field] === 'string');

export function isMember(value: unknown): value is WorkspaceMember {
  return (
    record(value) &&
    stringFields(value, ['id', 'user_id', 'display_name', 'status']) &&
    version(value.version) &&
    typeof value.is_owner === 'boolean' &&
    typeof value.can_manage_roles === 'boolean' &&
    typeof value.can_remove === 'boolean' &&
    strings(value.permissions) &&
    Array.isArray(value.roles) &&
    value.roles.every(role => record(role) && stringFields(role, ['id', 'name']) && (role.template_key === null || typeof role.template_key === 'string'))
  );
}

function isRole(value: unknown): value is WorkspaceRole {
  return (
    record(value) &&
    stringFields(value, ['id', 'workspace_id', 'name', 'created_at', 'updated_at']) &&
    version(value.version) &&
    strings(value.permissions) &&
    (value.template_key === null || typeof value.template_key === 'string')
  );
}

function isAccess(value: unknown): value is ProjectAccess {
  return (
    record(value) &&
    stringFields(value, ['workspace_id', 'project_id', 'member_id', 'display_name']) &&
    version(value.version) &&
    ['read', 'write'].includes(String(value.access_level))
  );
}

function isAssignable(value: unknown): value is AssignableMember {
  return record(value) && stringFields(value, ['id', 'user_id', 'display_name']) && typeof value.is_owner === 'boolean';
}

function isActivity(value: unknown): value is ActivityEntry {
  return (
    record(value) &&
    version(value.id) &&
    stringFields(value, ['actor_id', 'actor_name', 'action', 'created_at']) &&
    (value.project_id === null || typeof value.project_id === 'string') &&
    (value.resource_id === null || typeof value.resource_id === 'string')
  );
}

export function isCapability(value: unknown): value is ProjectCapability {
  return record(value) && typeof value.project_id === 'string' && ['read', 'write'].includes(String(value.access_level)) && strings(value.permissions);
}

export function createCollaborationRepository(client: SupabaseClient) {
  async function request(name: string, parameters: RecordValue, signal?: AbortSignal): Promise<unknown> {
    let query = client.rpc(`tr8_v2_${name}`, parameters);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw dataError(error);
    if (data === null) throw malformed();
    return data;
  }

  async function pageList<T>(name: string, parameters: RecordValue, validate: (value: unknown) => value is T, signal?: AbortSignal): Promise<T[]> {
    const result: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await request(name, { ...parameters, p_cursor: cursor, p_limit: 100 }, signal);
      if (
        !record(response) ||
        !Array.isArray(response.items) ||
        !response.items.every(validate) ||
        !(response.next_cursor === null || typeof response.next_cursor === 'string')
      )
        throw malformed();
      result.push(...response.items);
      cursor = response.next_cursor;
      if (cursor && cursors.has(cursor)) throw malformed();
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return result;
  }

  async function memberMutation(name: string, workspaceId: string, member: WorkspaceMember, extra: RecordValue = {}) {
    const value = await request(name, { p_workspace_id: workspaceId, p_member_id: member.id, p_version: member.version, ...extra });
    if (!isMember(value)) throw malformed();
    return value;
  }

  async function roleMutation(name: string, parameters: RecordValue) {
    const value = await request(name, parameters);
    if (!isRole(value)) throw malformed();
    return value;
  }

  return {
    projectCapabilities: (workspaceId: string, signal?: AbortSignal) =>
      pageList('list_project_capabilities', { p_workspace_id: workspaceId }, isCapability, signal),
    memberDirectory: (workspaceId: string, signal?: AbortSignal) => pageList('list_members_page', { p_workspace_id: workspaceId }, isMember, signal),
    roles: (workspaceId: string, signal?: AbortSignal) => pageList('list_roles', { p_workspace_id: workspaceId }, isRole, signal),
    async createRole(workspaceId: string, id: string, name: string, permissions: string[]) {
      return roleMutation('create_role', { p_workspace_id: workspaceId, p_id: id, p_name: name.trim(), p_permissions: permissions });
    },
    async updateRole(workspaceId: string, role: WorkspaceRole, name: string, permissions: string[]) {
      return roleMutation('update_role', {
        p_workspace_id: workspaceId,
        p_id: role.id,
        p_version: role.version,
        p_name: name.trim(),
        p_permissions: permissions,
      });
    },
    async deleteRole(workspaceId: string, role: WorkspaceRole) {
      const value = await request('delete_role', { p_workspace_id: workspaceId, p_id: role.id, p_version: role.version });
      if (!record(value) || value.id !== role.id || value.deleted !== true) throw malformed();
      return value;
    },
    setMemberRoles: (workspaceId: string, member: WorkspaceMember, roleIds: string[]) =>
      memberMutation('set_member_roles', workspaceId, member, { p_role_ids: roleIds }),
    removeMember: (workspaceId: string, member: WorkspaceMember) => memberMutation('remove_member', workspaceId, member),
    projectAccess: (workspaceId: string, projectId: string, signal?: AbortSignal) =>
      pageList('list_project_access', { p_workspace_id: workspaceId, p_project_id: projectId }, isAccess, signal),
    async setProjectAccess(workspaceId: string, projectId: string, memberId: string, expectedVersion: number, accessLevel: 'read' | 'write') {
      const value = await request('set_project_access', {
        p_workspace_id: workspaceId,
        p_project_id: projectId,
        p_member_id: memberId,
        p_version: expectedVersion,
        p_access_level: accessLevel,
      });
      if (!isAccess(value)) throw malformed();
      return value;
    },
    async removeProjectAccess(access: ProjectAccess) {
      const value = await request('remove_project_access', {
        p_workspace_id: access.workspace_id,
        p_project_id: access.project_id,
        p_member_id: access.member_id,
        p_version: access.version,
      });
      if (!record(value) || value.member_id !== access.member_id || value.deleted !== true) throw malformed();
      return value;
    },
    assignableMembers: (workspaceId: string, projectId: string, signal?: AbortSignal) =>
      pageList('list_assignable_members', { p_workspace_id: workspaceId, p_project_id: projectId }, isAssignable, signal),
    async assignTask(task: Task, memberId: string | null): Promise<Task> {
      let value = await request('assign_task', { p_workspace_id: task.workspace_id, p_id: task.id, p_version: task.version, p_assignee_member_id: memberId });
      if (Array.isArray(value)) value = value[0];
      if (
        !record(value) ||
        value.id !== task.id ||
        !version(value.version) ||
        !(value.assignee_member_id === null || typeof value.assignee_member_id === 'string')
      )
        throw malformed();
      return value as unknown as Task;
    },
    async projectCapability(workspaceId: string, projectId: string, signal?: AbortSignal) {
      const value = await request('get_project_capabilities', { p_workspace_id: workspaceId, p_project_id: projectId }, signal);
      if (!isCapability(value) || value.project_id !== projectId) throw malformed();
      return value;
    },
    async activity(workspaceId: string, projectId: string | null, beforeId: number | null = null, signal?: AbortSignal): Promise<ActivityPage> {
      const value = await request('list_activity', { p_workspace_id: workspaceId, p_project_id: projectId, p_before_id: beforeId, p_limit: 50 }, signal);
      if (!record(value) || !Array.isArray(value.items) || !value.items.every(isActivity) || !(value.next_before_id === null || version(value.next_before_id)))
        throw malformed();
      return value as unknown as ActivityPage;
    },
  };
}

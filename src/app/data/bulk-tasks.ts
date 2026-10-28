import type { SupabaseClient } from '@supabase/supabase-js';
import type { BulkTaskItem, BulkTaskOperation, BulkTaskRequest, BulkTaskResult, BulkTasksApi } from '../bulk-task-types';
import { DataError, dataError } from './errors';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => field in value);
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const invalid = () => new DataError('Selecciona entre 1 y 50 tareas y revisa la acción antes de confirmar.', '22023');
const malformed = () =>
  new DataError('No pudimos confirmar el resultado del lote. Revisa los datos o reintenta la misma solicitud.', 'CLIENT_UPGRADE_REQUIRED');

function validOperation(value: unknown): value is BulkTaskOperation {
  if (!record(value)) return false;
  if (value.kind === 'status')
    return exact(value, ['kind', 'status']) && typeof value.status === 'string' && ['backlog', 'todo', 'progress', 'review', 'done'].includes(value.status);
  if (value.kind === 'priority')
    return exact(value, ['kind', 'priority']) && typeof value.priority === 'string' && ['none', 'low', 'medium', 'high', 'urgent'].includes(value.priority);
  if (value.kind === 'assign') return exact(value, ['kind', 'assignee_member_id']) && (value.assignee_member_id === null || id(value.assignee_member_id));
  return (value.kind === 'archive' || value.kind === 'delete') && exact(value, ['kind']);
}

function validItems(value: unknown): value is BulkTaskItem[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 50 &&
    value.every(
      item =>
        record(item) &&
        exact(item, ['id', 'project_id', 'version']) &&
        id(item.id) &&
        id(item.project_id) &&
        Number.isSafeInteger(item.version) &&
        Number(item.version) > 0 &&
        Number(item.version) <= 2147483647,
    ) &&
    new Set(value.map(item => item.id.toLowerCase())).size === value.length
  );
}

function validRequest(value: unknown): value is BulkTaskRequest {
  return (
    record(value) &&
    exact(value, ['id', 'requested_at']) &&
    id(value.id) &&
    typeof value.requested_at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.requested_at) &&
    Number.isFinite(Date.parse(value.requested_at)) &&
    new Date(value.requested_at).toISOString() === value.requested_at
  );
}

function result(value: unknown, items: BulkTaskItem[], request: BulkTaskRequest): value is BulkTaskResult {
  if (
    !record(value) ||
    !exact(value, ['request_id', 'results']) ||
    typeof value.request_id !== 'string' ||
    value.request_id.toLowerCase() !== request.id.toLowerCase() ||
    !Array.isArray(value.results) ||
    value.results.length !== items.length
  )
    return false;
  const expected = new Set(items.map(item => item.id.toLowerCase()));
  for (const row of value.results) {
    if (!record(row) || !exact(row, ['id', 'outcome', 'code']) || !id(row.id) || !expected.delete(row.id.toLowerCase())) return false;
    if (row.outcome === 'applied' ? row.code !== null : row.outcome !== 'rejected' || typeof row.code !== 'string' || !/^[A-Z0-9]{5}$/.test(row.code))
      return false;
  }
  return expected.size === 0;
}

export function createBulkTasksRepository(client: SupabaseClient, workspaceId: string): Omit<BulkTasksApi, 'scopeKey'> {
  if (!id(workspaceId)) throw invalid();
  return {
    async apply(operation, items, request) {
      if (!validOperation(operation) || !validItems(items) || !validRequest(request)) throw invalid();
      const frozenItems = items.map(item => ({ ...item }));
      const frozenRequest = { ...request };
      try {
        const { data, error } = await client.rpc('tr8_v2_bulk_tasks', {
          p_workspace_id: workspaceId,
          p_request_id: frozenRequest.id,
          p_requested_at: frozenRequest.requested_at,
          p_operation: { ...operation },
          p_items: frozenItems,
        });
        if (error) throw dataError(error);
        if (!result(data, frozenItems, frozenRequest)) throw malformed();
        return data;
      } catch (cause) {
        throw dataError(cause);
      }
    },
  };
}

import { FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js';
import { DataError, dataError } from './errors';

export const GOOGLE_TASKS_STATES = ['disconnected', 'connected', 'paused', 'needs_reauthorization', 'error'] as const;
export type GoogleTasksState = (typeof GOOGLE_TASKS_STATES)[number];
export interface GoogleTasksStatus {
  configured: boolean;
  enabled: boolean;
  state: GoogleTasksState;
  version: number;
  last_sync_at: string | null;
  next_sync_at: string | null;
  pending: number;
  failed: number;
  conflicts: number;
  reason: string | null;
  lists: { id: string; title: string; selected: boolean }[];
  conflict_items: { id: string; title: string; google_title: string | null; reason: string }[];
}
export type GoogleTasksChangeInput =
  | { action: 'tasks_reconcile' | 'tasks_pause' | 'tasks_resume' }
  | { action: 'tasks_select_list'; list_id: string; selected: boolean }
  | { action: 'tasks_resolve'; link_id: string; resolution: 'local' | 'google' };
export type GoogleTasksChange = GoogleTasksChangeInput & { request_id: string; expected_version: number };
export interface GoogleTasksApi {
  /** Personal identity scope; selecting a team must not share its owner's integration. */
  scopeKey: string[];
  load: (signal?: AbortSignal) => Promise<GoogleTasksStatus>;
  change: (input: GoogleTasksChange, signal?: AbortSignal) => Promise<GoogleTasksStatus>;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, maximum: number, allowEmpty = false): value is string =>
  typeof value === 'string' &&
  (allowEmpty || value.length > 0) &&
  value.length <= maximum &&
  Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
const reason = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);
const timestamp = (value: unknown) => value === null || (text(value, 50) && Number.isFinite(Date.parse(value)));
const malformed = () => new DataError('Actualiza TR8 para consultar la conexión con Google Tasks.', 'CLIENT_UPGRADE_REQUIRED');

export function parseGoogleTasksStatus(value: unknown): GoogleTasksStatus {
  if (
    !record(value) ||
    typeof value.configured !== 'boolean' ||
    typeof value.enabled !== 'boolean' ||
    !GOOGLE_TASKS_STATES.includes(value.state as GoogleTasksState) ||
    !count(value.version) ||
    !count(value.pending) ||
    !count(value.failed) ||
    !count(value.conflicts) ||
    !timestamp(value.last_sync_at) ||
    !timestamp(value.next_sync_at) ||
    (value.reason !== null && !reason(value.reason)) ||
    !Array.isArray(value.lists) ||
    value.lists.length > 2000 ||
    !Array.isArray(value.conflict_items) ||
    value.conflict_items.length > 100
  )
    throw malformed();
  const lists = value.lists.map(item => {
    if (!record(item) || !text(item.id, 1024) || !text(item.title, 1024, true) || typeof item.selected !== 'boolean') throw malformed();
    return { id: item.id, title: item.title, selected: item.selected };
  });
  const conflictItems = value.conflict_items.map(item => {
    if (
      !record(item) ||
      !text(item.id, 1024) ||
      !text(item.title, 1024, true) ||
      (item.google_title !== null && !text(item.google_title, 1024, true)) ||
      !reason(item.reason)
    )
      throw malformed();
    return { id: item.id, title: item.title, google_title: item.google_title as string | null, reason: item.reason };
  });
  if (new Set(lists.map(item => item.id)).size !== lists.length || new Set(conflictItems.map(item => item.id)).size !== conflictItems.length) throw malformed();
  return {
    configured: value.configured,
    enabled: value.enabled,
    state: value.state as GoogleTasksState,
    version: value.version,
    last_sync_at: value.last_sync_at as string | null,
    next_sync_at: value.next_sync_at as string | null,
    pending: value.pending,
    failed: value.failed,
    conflicts: value.conflicts,
    reason: value.reason as string | null,
    lists,
    conflict_items: conflictItems,
  };
}

const messages: Record<string, string> = {
  AUTH_REQUIRED: 'La sesión cambió. Inicia sesión de nuevo antes de configurar Google Tasks.',
  APP_ACCESS_DENIED: 'Esta cuenta ya no tiene acceso a la integración.',
  STALE_VERSION: 'La conexión cambió en otra pestaña. Revisa su estado antes de continuar.',
  RATE_LIMITED: 'Espera un momento antes de volver a solicitar la sincronización.',
  OPERATION_UNAVAILABLE: 'La operación ya no está disponible. Actualiza el estado de Google Tasks.',
  DEPENDENCY_UNAVAILABLE: 'Google Tasks todavía no está disponible. Tus proyectos y tareas siguen guardados.',
  INVALID_INPUT: 'No se pudo validar esta operación. Actualiza el estado y vuelve a intentarlo.',
};
async function functionError(error: unknown): Promise<DataError> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body: unknown = await error.context.json();
      if (record(body) && record(body.error) && typeof body.error.code === 'string' && messages[body.error.code])
        return new DataError(messages[body.error.code], body.error.code);
    } catch {
      // Remote diagnostics and credentials are not user-facing messages.
    }
  }
  return new DataError('No se pudo confirmar la operación con Google Tasks. Actualiza el estado antes de volver a intentarlo.', 'GOOGLE_TASKS_REQUEST_FAILED');
}

export function createGoogleTasksRepository(client: SupabaseClient) {
  return {
    async googleTasksStatus(signal?: AbortSignal): Promise<GoogleTasksStatus> {
      let query = client.rpc('tr8_v6_get_google_tasks_status');
      if (signal) query = query.abortSignal(signal);
      const { data, error } = await query;
      if (error) throw dataError(error);
      return parseGoogleTasksStatus(data);
    },
    async changeGoogleTasks(input: GoogleTasksChange, signal?: AbortSignal): Promise<GoogleTasksStatus> {
      const { data, error } = await client.functions.invoke('tr8-google', {
        body: {
          action: input.action,
          request_id: input.request_id,
          expected_version: input.expected_version,
          ...(input.action === 'tasks_select_list' ? { list_id: input.list_id, selected: input.selected } : {}),
          ...(input.action === 'tasks_resolve' ? { link_id: input.link_id, resolution: input.resolution } : {}),
        },
        signal,
        timeout: 60000,
      });
      if (error) throw await functionError(error);
      return parseGoogleTasksStatus(data);
    },
  };
}

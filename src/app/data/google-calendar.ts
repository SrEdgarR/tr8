import { FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js';
import { DataError, dataError } from './errors';

export const GOOGLE_STATES = [
  'disconnected',
  'authorizing',
  'provisioning',
  'provisioning_unknown',
  'connected',
  'needs_reauthorization',
  'disconnecting',
  'cleanup_failed',
  'error',
] as const;
export type GoogleState = (typeof GOOGLE_STATES)[number];
export const GOOGLE_REASONS = [
  'config_pending',
  'oauth_denied',
  'oauth_expired',
  'oauth_exchange_failed',
  'scope_missing',
  'refresh_missing',
  'reauthorization_required',
  'different_google_account',
  'provisioning_unknown',
  'remote_missing',
  'temporary_failure',
  'permanent_failure',
  'cleanup_failed',
  'budget_exhausted',
] as const;
export type GoogleReason = (typeof GOOGLE_REASONS)[number];
export interface GoogleCalendarStatus {
  configured: boolean;
  state: GoogleState;
  generation: number;
  version: number;
  last_sync_at: string | null;
  pending: number;
  failed: number;
  reason: GoogleReason | null;
}
export interface GoogleRequest {
  request_id: string;
  expected_version: number;
}
export interface GoogleAuthorization {
  authorization_url: string;
  state: string;
}
export interface GoogleCompletion {
  state: string;
  browser_secret: string;
}
export type GoogleChangeInput =
  | { action: 'reconcile' | 'retry_cleanup' | 'abandon_cleanup' | 'rebuild_missing' }
  | { action: 'disconnect'; mode: 'keep' | 'delete' }
  | { action: 'recover_calendar'; calendar_id: string };
export type GoogleChange = GoogleChangeInput & GoogleRequest;
export interface GoogleCalendarApi {
  /** Personal identity scope, independent of the selected workspace. */
  scopeKey: string[];
  callbackOrigin: string;
  load: (signal?: AbortSignal) => Promise<GoogleCalendarStatus>;
  begin: (input: GoogleRequest & { browser_secret: string }, signal?: AbortSignal) => Promise<GoogleAuthorization>;
  complete: (input: GoogleCompletion, signal?: AbortSignal) => Promise<GoogleCalendarStatus>;
  change: (input: GoogleChange, signal?: AbortSignal) => Promise<GoogleCalendarStatus>;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const malformed = () => new DataError('Actualiza TR8 para consultar la conexión con Google Calendar.', 'CLIENT_UPGRADE_REQUIRED');
export function parseGoogleStatus(value: unknown): GoogleCalendarStatus {
  if (
    !record(value) ||
    typeof value.configured !== 'boolean' ||
    !GOOGLE_STATES.includes(value.state as GoogleState) ||
    !count(value.generation) ||
    !count(value.version) ||
    !count(value.pending) ||
    !count(value.failed) ||
    (value.reason !== null && !GOOGLE_REASONS.includes(value.reason as GoogleReason)) ||
    (value.last_sync_at !== null &&
      (typeof value.last_sync_at !== 'string' || value.last_sync_at.length > 50 || !Number.isFinite(Date.parse(value.last_sync_at))))
  )
    throw malformed();
  return {
    configured: value.configured,
    state: value.state as GoogleState,
    generation: value.generation,
    version: value.version,
    last_sync_at: value.last_sync_at as string | null,
    pending: value.pending,
    failed: value.failed,
    reason: value.reason as GoogleReason | null,
  };
}
export function parseGoogleAuthorization(value: unknown): GoogleAuthorization {
  if (!record(value) || typeof value.authorization_url !== 'string' || typeof value.state !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.state))
    throw malformed();
  let url: URL;
  try {
    url = new URL(value.authorization_url);
  } catch {
    throw malformed();
  }
  if (
    url.origin !== 'https://accounts.google.com' ||
    url.pathname !== '/o/oauth2/v2/auth' ||
    url.username ||
    url.password ||
    url.hash ||
    url.searchParams.get('state') !== value.state ||
    url.searchParams.get('scope') !== 'https://www.googleapis.com/auth/calendar.app.created' ||
    url.searchParams.get('response_type') !== 'code' ||
    url.searchParams.get('code_challenge_method') !== 'S256'
  )
    throw malformed();
  return { authorization_url: url.href, state: value.state };
}
const messages: Record<string, string> = {
  AUTH_REQUIRED: 'La sesión cambió. Inicia sesión de nuevo antes de conectar Google.',
  APP_ACCESS_DENIED: 'Esta cuenta ya no tiene acceso a la integración.',
  STALE_VERSION: 'La conexión cambió en otra pestaña. Revisa su estado antes de continuar.',
  RATE_LIMITED: 'Espera un momento antes de volver a solicitar la sincronización.',
  OPERATION_UNAVAILABLE: 'El intento ya no está disponible. Actualiza el estado y vuelve a conectar Google.',
  DEPENDENCY_UNAVAILABLE: 'La conexión con Google todavía no está disponible. Tus proyectos y tareas siguen guardados.',
  INVALID_INPUT: 'No se pudo validar esta operación. Actualiza el estado y vuelve a intentarlo.',
};
async function functionError(error: unknown): Promise<DataError> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body: unknown = await error.context.json();
      if (record(body) && record(body.error) && typeof body.error.code === 'string' && messages[body.error.code])
        return new DataError(messages[body.error.code], body.error.code);
    } catch {
      /* Provider diagnostics and credentials never reach the UI. */
    }
  }
  return new DataError('No se pudo confirmar la operación con Google. Actualiza el estado antes de volver a intentarlo.', 'GOOGLE_REQUEST_FAILED');
}
export function createGoogleCalendarRepository(client: SupabaseClient) {
  async function invoke(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const { data, error } = await client.functions.invoke('tr8-google', { body, signal, timeout: 60000 });
    if (error) throw await functionError(error);
    return data;
  }
  return {
    async googleStatus(signal?: AbortSignal): Promise<GoogleCalendarStatus> {
      let query = client.rpc('tr8_v2_get_google_status');
      if (signal) query = query.abortSignal(signal);
      const { data, error } = await query;
      if (error) throw dataError(error);
      return parseGoogleStatus(data);
    },
    async beginGoogle(input: GoogleRequest & { browser_secret: string }, signal?: AbortSignal): Promise<GoogleAuthorization> {
      return parseGoogleAuthorization(
        await invoke({ action: 'begin', request_id: input.request_id, expected_version: input.expected_version, browser_secret: input.browser_secret }, signal),
      );
    },
    async completeGoogle(input: GoogleCompletion, signal?: AbortSignal): Promise<GoogleCalendarStatus> {
      const result = await invoke({ action: 'complete', state: input.state, browser_secret: input.browser_secret }, signal);
      return parseGoogleStatus(result);
    },
    async changeGoogle(input: GoogleChange, signal?: AbortSignal): Promise<GoogleCalendarStatus> {
      const result = await invoke(
        {
          action: input.action,
          request_id: input.request_id,
          expected_version: input.expected_version,
          ...(input.action === 'disconnect' ? { mode: input.mode } : {}),
          ...(input.action === 'recover_calendar' ? { calendar_id: input.calendar_id } : {}),
        },
        signal,
      );
      return parseGoogleStatus(result);
    },
  };
}

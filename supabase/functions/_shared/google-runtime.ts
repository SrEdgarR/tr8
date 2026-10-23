import { decryptGoogleSecret, encryptGoogleSecret, type GoogleSecretEnvelope } from './google-crypto.ts';
import { GoogleProvider, type GoogleOperation } from './google-provider.ts';
import { GoogleTasksProvider, type GoogleTasksOperation } from './google-tasks-provider.ts';

export interface GoogleActor {
  id: string;
  session: string;
}
export interface GoogleRuntime {
  appOrigin: string;
  callbackUri: string;
  clientId: string;
  configured: boolean;
  workerSecret: string;
  authenticate(request: Request): Promise<GoogleActor>;
  rpc(action: string, payload?: Record<string, unknown>, actor?: GoogleActor): Promise<unknown>;
  provider(beforeRequest: (operation: GoogleOperation) => Promise<boolean | void>): GoogleProvider;
  tasksProvider?(beforeRequest: (operation: GoogleTasksOperation) => Promise<boolean | void>): GoogleTasksProvider;
  encrypt(plaintext: string, purpose: string, userId: string, generation: string): Promise<GoogleSecretEnvelope>;
  decrypt(envelope: GoogleSecretEnvelope, purpose: string, userId: string, generation: string): Promise<string>;
}

export class GoogleServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
  return value as Record<string, unknown>;
}
export function text(value: unknown, maximum = 4096): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maximum ||
    Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new GoogleServiceError('INVALID_INPUT');
  return value;
}
export function uuid(value: unknown): string {
  const result = text(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) throw new GoogleServiceError('INVALID_INPUT');
  return result;
}
export function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new GoogleServiceError('INVALID_INPUT');
  return value;
}
export async function boundedJson(request: Request | Response, limit = 16_384): Promise<unknown> {
  if (!request.body) throw new GoogleServiceError('INVALID_INPUT');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) {
        await reader.cancel();
        throw new GoogleServiceError('INVALID_INPUT');
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    if (cause instanceof GoogleServiceError) throw cause;
    throw new GoogleServiceError('INVALID_INPUT');
  } finally {
    reader.releaseLock();
  }
}
function origin(value: string | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      return '';
    return url.origin;
  } catch {
    return '';
  }
}
function environmentKey(get: (name: string) => string | undefined, collection: string, legacy: string): string {
  try {
    const keys = JSON.parse(get(collection) ?? '{}');
    if (typeof keys.default === 'string' && keys.default.length) return keys.default;
  } catch {
    /* Never expose malformed server environment values. */
  }
  return get(legacy) ?? '';
}
function sqlError(value: unknown): GoogleServiceError {
  const code = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).code : null;
  if (code === 'PT409') return new GoogleServiceError('STALE_VERSION', 409);
  if (code === 'PT429') return new GoogleServiceError('RATE_LIMITED', 429);
  if (code === 'PT404') return new GoogleServiceError('OPERATION_UNAVAILABLE', 404);
  if (code === '42501' || code === 'PT403') return new GoogleServiceError('APP_ACCESS_DENIED', 403);
  if (code === 'PT401' || code === '28000') return new GoogleServiceError('AUTH_REQUIRED', 401);
  if (code === '22023' || code === 'PT400') return new GoogleServiceError('INVALID_INPUT');
  return new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
}

/** Native HTTPS transport keeps platform keys exclusively in the function environment. */
export function createGoogleRuntime(get: (name: string) => string | undefined, fetcher: typeof fetch = fetch): GoogleRuntime {
  const projectOrigin = origin(get('SUPABASE_URL'));
  if (!projectOrigin) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
  const publicKey = environmentKey(get, 'SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  const serverKey = environmentKey(get, 'SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  const appOrigin = origin(get('TR8_GOOGLE_APP_ORIGIN'));
  const callbackUri = `${projectOrigin}/functions/v1/tr8-google/callback`;
  const clientId = get('TR8_GOOGLE_CLIENT_ID') ?? '';
  const clientSecret = get('TR8_GOOGLE_CLIENT_SECRET') ?? '';
  const workerSecret = get('TR8_GOOGLE_WORKER_SECRET') ?? '';
  const activeKeyId = get('TR8_GOOGLE_ACTIVE_KEY') ?? '';
  let keys: Record<string, string> = {};
  try {
    keys = object(JSON.parse(get('TR8_GOOGLE_ENCRYPTION_KEYS') ?? '{}')) as Record<string, string>;
  } catch {
    /* Disabled until configured. */
  }
  const configured = Boolean(
    publicKey &&
    serverKey &&
    appOrigin &&
    clientId &&
    clientSecret &&
    /^[A-Za-z0-9_-]{43}$/.test(keys[activeKeyId] ?? '') &&
    /^[A-Za-z0-9_-]{43,128}$/.test(workerSecret),
  );
  async function platform(path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
    try {
      return await fetcher(`${projectOrigin}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
    }
  }
  return {
    appOrigin,
    callbackUri,
    clientId,
    configured,
    workerSecret,
    async authenticate(request) {
      const authorization = request.headers.get('authorization') ?? '';
      if (!/^Bearer [A-Za-z0-9_.-]{20,16384}$/.test(authorization)) throw new GoogleServiceError('AUTH_REQUIRED', 401);
      const response = await platform('/auth/v1/user', { apikey: publicKey, Authorization: authorization });
      if (!response.ok) throw new GoogleServiceError('AUTH_REQUIRED', 401);
      const user = object(await boundedJson(response));
      try {
        const payload = authorization.slice(7).split('.')[1];
        const claims = object(JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))));
        const id = uuid(user.id);
        if (claims.sub !== id || claims.role !== 'authenticated' || typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) throw new Error();
        return { id, session: uuid(claims.session_id) };
      } catch {
        throw new GoogleServiceError('AUTH_REQUIRED', 401);
      }
    },
    async rpc(action, payload = {}, actor) {
      const response = await platform(
        '/rest/v1/rpc/tr8_server_google',
        { apikey: serverKey, 'Content-Type': 'application/json' },
        { p_action: action, p_actor: actor?.id ?? null, p_session: actor?.session ?? null, p_payload: payload },
      );
      const result = await boundedJson(response, 131_072);
      if (!response.ok) throw sqlError(result);
      return result;
    },
    provider(beforeRequest) {
      if (!configured) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
      return new GoogleProvider({ clientId, clientSecret, redirectUri: callbackUri, beforeRequest, fetch: fetcher });
    },
    tasksProvider(beforeRequest) {
      if (!configured) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
      return new GoogleTasksProvider({ beforeRequest, fetch: fetcher });
    },
    async encrypt(plaintext, purpose, userId, generation) {
      return encryptGoogleSecret({ key: keys[activeKeyId], keyId: activeKeyId, purpose, userId, generation, plaintext });
    },
    async decrypt(envelope, purpose, userId, generation) {
      return decryptGoogleSecret({ key: keys[envelope.kid], keyId: envelope.kid, purpose, userId, generation, envelope });
    },
  };
}

export function reply(value: unknown, status = 200, allowedOrigin?: string): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin' } : {}),
    },
  });
}
export function errorReply(cause: unknown, allowedOrigin?: string): Response {
  const error = cause instanceof GoogleServiceError ? cause : new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
  return reply({ error: { code: error.code, message: 'No se pudo confirmar esta operación con Google Calendar.' } }, error.status, allowedOrigin);
}

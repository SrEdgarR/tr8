import { decodeBase64Url, decodeUtf8, type VaultEnvelope } from '../../../src/app/finance/compatibility/protocol.ts';
import { FinanceError, readFinanceBytes, type FinanceActor, type FinanceRuntime } from './handler.ts';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FinanceError('AUTH_REQUIRED', 401);
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new FinanceError('AUTH_REQUIRED', 401);
  return value;
}
function origin(value: string | undefined): string {
  try {
    const url = new URL(value ?? '');
    return (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) && url.origin === value
      ? url.origin
      : '';
  } catch {
    return '';
  }
}
function key(get: (name: string) => string | undefined, collection: string, fallback: string): string {
  try {
    const entries = JSON.parse(get(collection) ?? '{}');
    if (typeof entries.default === 'string') return entries.default;
  } catch {
    /* Disabled configuration must not expose environment data. */
  }
  return get(fallback) ?? '';
}

export function createFinanceRuntime(
  get: (name: string) => string | undefined,
  fetcher: typeof fetch = fetch,
  clock = Date.now,
  rpc: 'tr8_server_finance' | 'tr8_server_finance_coordinated' | 'tr8_server_vault_control' = 'tr8_server_finance',
): FinanceRuntime {
  const project = origin(get('SUPABASE_URL'));
  const app = origin(get('TR8_FINANCE_ALLOWED_ORIGIN'));
  const projectRef = get('TR8_FINANCE_TEST_PROJECT_REF') ?? '';
  const publicKey = key(get, 'SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
  const serverKey = key(get, 'SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
  // This delivery cannot be activated on the production project by environment
  // changes. Removing this isolated-project fence requires a separate release.
  const enabled =
    get('TR8_FINANCE_TESTING_ENABLED') === 'true' &&
    projectRef === 'kajcbwlnqcwcpbtqyieo' &&
    project === 'https://kajcbwlnqcwcpbtqyieo.supabase.co' &&
    Boolean(app && publicKey && serverKey);
  async function platform(path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
    try {
      return await fetcher(`${project}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
    }
  }
  return {
    origin: app,
    enabled,
    async authenticate(request): Promise<FinanceActor> {
      const authorization = request.headers.get('authorization') ?? '';
      if (!/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization) || authorization.length > 16_384)
        throw new FinanceError('AUTH_REQUIRED', 401);
      // Auth verifies the exact signed token before any of its claims are trusted.
      // This supports both legacy HS256 and asymmetric project signing keys.
      const result = await platform('/auth/v1/user', { apikey: publicKey, Authorization: authorization });
      if (!result.ok) throw new FinanceError('AUTH_REQUIRED', 401);
      try {
        const user = object(JSON.parse(decodeUtf8(await readFinanceBytes(result, 65_536))));
        const claims = object(JSON.parse(decodeUtf8(decodeBase64Url(authorization.slice(7).split('.')[1]))));
        const id = uuid(user.id);
        const now = clock() / 1000;
        if (
          claims.sub !== id ||
          claims.iss !== `${project}/auth/v1` ||
          claims.role !== 'authenticated' ||
          claims.is_anonymous !== false ||
          user.is_anonymous === true ||
          !(claims.aud === 'authenticated' || (Array.isArray(claims.aud) && claims.aud.includes('authenticated'))) ||
          typeof claims.exp !== 'number' ||
          !Number.isSafeInteger(claims.exp) ||
          claims.exp <= now ||
          (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > now))
        )
          throw new FinanceError('AUTH_REQUIRED', 401);
        const passwords = Array.isArray(claims.amr)
          ? claims.amr
              .map(object)
              .filter(
                proof => proof.method === 'password' && typeof proof.timestamp === 'number' && Number.isSafeInteger(proof.timestamp) && proof.timestamp <= now,
              )
          : [];
        const passwordAt = passwords.length ? Math.max(...passwords.map(proof => proof.timestamp as number)) : null;
        return { id, session: uuid(claims.session_id), expiresAt: claims.exp, passwordAt };
      } catch {
        throw new FinanceError('AUTH_REQUIRED', 401);
      }
    },
    async call(action, actor, args) {
      const result = await platform(
        `/rest/v1/rpc/${rpc}`,
        { apikey: serverKey, 'Content-Type': 'application/json' },
        { ...args, p_action: action, p_actor: actor.id, p_session: actor.session, p_token_exp: actor.expiresAt, p_password_at: actor.passwordAt },
      );
      const value = JSON.parse(decodeUtf8(await readFinanceBytes(result, 2_200_000))) as unknown;
      if (!result.ok) {
        const error = object(value);
        const sqlCode = error.code;
        const known: Record<string, [string, number]> = {
          PT401: ['AUTH_REQUIRED', 401],
          PT403: ['FINANCE_ACCESS_DENIED', 403],
          PT409: ['FINANCE_CONFLICT', 409],
          PT404: ['NOT_FOUND', 404],
          PT400: ['INVALID_INPUT', 400],
          PT413: ['ENVELOPE_TOO_LARGE', 413],
          PT428: ['REAUTHENTICATION_REQUIRED', 403],
        };
        const [code, status] = known[String(sqlCode)] ?? ['DEPENDENCY_UNAVAILABLE', 503];
        throw new FinanceError(code, status);
      }
      return value as { envelope?: VaultEnvelope };
    },
  };
}

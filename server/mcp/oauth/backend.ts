import {
  AccessDeniedError,
  InvalidClientError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
  type OAuthError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

export type OAuthServerAction = 'get_client' | 'begin' | 'challenge' | 'exchange' | 'refresh' | 'verify' | 'revoke';
export type OAuthServerDispatch = (action: OAuthServerAction, input: Record<string, unknown>) => Promise<unknown>;

const constructors: Record<string, new (message: string) => OAuthError> = {
  invalid_request: InvalidRequestError,
  invalid_client: InvalidClientError,
  invalid_grant: InvalidGrantError,
  invalid_scope: InvalidScopeError,
  invalid_target: InvalidTargetError,
  invalid_token: InvalidTokenError,
  access_denied: AccessDeniedError,
  temporarily_unavailable: TemporarilyUnavailableError,
  too_many_requests: TooManyRequestsError,
  server_error: ServerError,
};
const sqlCodes: Record<string, string> = {
  PT400: 'invalid_request',
  '22023': 'invalid_request',
  PT401: 'invalid_token',
  PT403: 'access_denied',
  '42501': 'access_denied',
  PT409: 'invalid_grant',
  PT429: 'too_many_requests',
};

/** Never copy a database diagnostic, token, authorization code or request into an error. */
export function oauthBackendError(code: unknown): OAuthError {
  const normalized = typeof code === 'string' ? (sqlCodes[code] ?? code) : 'server_error';
  const Constructor = constructors[normalized] ?? ServerError;
  return new Constructor('TR8 no pudo autorizar esta solicitud.');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Public Supabase key only. Each action is independently authorized in SQL. */
export function createOAuthBackend(options: { url: string; key: string; fetch?: typeof fetch }): OAuthServerDispatch {
  let base: URL;
  try {
    base = new URL(options.url);
  } catch {
    throw oauthBackendError('server_error');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !options.key) throw oauthBackendError('server_error');
  const request = options.fetch ?? fetch;
  return async (action, input) => {
    if (!['get_client', 'begin', 'challenge', 'exchange', 'refresh', 'verify', 'revoke'].includes(action)) throw oauthBackendError('invalid_request');
    let response: Response;
    let data: unknown;
    try {
      response = await request(new URL('/rest/v1/rpc/tr8_mcp_oauth_server', base), {
        method: 'POST',
        headers: { apikey: options.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_action: action, p_input: input }),
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
        cache: 'no-store',
      });
      data = await response.json();
    } catch {
      throw oauthBackendError('temporarily_unavailable');
    }
    if (!response.ok) throw oauthBackendError(record(data) ? data.code : undefined);
    if (record(data) && Object.hasOwn(data, '_tr8_oauth_error')) {
      const error = data._tr8_oauth_error;
      if (Object.keys(data).length !== 1 || !record(error) || Object.keys(error).length !== 1 || typeof error.code !== 'string')
        throw oauthBackendError(undefined);
      throw oauthBackendError(error.code);
    }
    return data;
  };
}

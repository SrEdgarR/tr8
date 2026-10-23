import { generatePkce, randomBase64Url, sha256Base64Url, type GoogleSecretEnvelope } from './google-crypto.ts';
import { beginAuthURL, GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE, GoogleProviderError, type GoogleOperation } from './google-provider.ts';
import { boundedJson, errorReply, GoogleServiceError, object, reply, text, uuid, version, type GoogleActor, type GoogleRuntime } from './google-runtime.ts';

export interface GoogleCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
}
const operations: Record<GoogleOperation, string> = {
  'oauth.exchange': 'oauth',
  'oauth.refresh': 'refresh',
  'oauth.revoke': 'revoke',
  'calendar.get': 'calendar_get',
  'calendar.insert': 'calendar_create',
  'event.get': 'event_get',
  'event.list': 'event_list',
  'event.insert': 'event_upsert',
  'event.update': 'event_upsert',
  'event.delete': 'event_delete',
};
export async function reserveGoogleRequest(
  runtime: GoogleRuntime,
  operation: GoogleOperation,
  actor?: GoogleActor,
  job?: Record<string, unknown>,
): Promise<boolean> {
  const reservation = await runtime.rpc('reserve_request', { purpose: operations[operation], ...(job ?? {}) }, actor);
  if (reservation === true) return true;
  const result = object(reservation);
  if (result.allowed === true) return true;
  if (result.reason === 'provisioning_unknown') throw new GoogleProviderError('unknown', 'provisioning_unknown');
  if (result.reason === 'budget_exhausted') return false;
  // A lost lease or changed access may not be turned into a retry that resets
  // provisioning or confirms an operation belonging to a newer worker.
  throw new GoogleProviderError('permanent', 'lease_unavailable');
}
export function credentials(value: string): GoogleCredentials {
  try {
    const result = object(JSON.parse(value));
    return {
      accessToken: text(result.accessToken, 16_384),
      refreshToken: text(result.refreshToken, 16_384),
      expiresAt: typeof result.expiresAt === 'number' && Number.isFinite(result.expiresAt) ? result.expiresAt : 0,
      ...(Array.isArray(result.scopes) && result.scopes.every(scope => typeof scope === 'string' && [GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE].includes(scope))
        ? { scopes: result.scopes as string[] }
        : {}),
    };
  } catch {
    throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
  }
}
function envelope(value: unknown): GoogleSecretEnvelope {
  return object(value) as unknown as GoogleSecretEnvelope;
}
function browserSecret(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(result)) throw new GoogleServiceError('INVALID_INPUT');
  return result;
}
function checkFields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new GoogleServiceError('INVALID_INPUT');
}
async function relayCallback(request: Request, runtime: GoogleRuntime): Promise<Response> {
  const url = new URL(request.url);
  const callback = new URL(runtime.callbackUri);
  // The hosted Supabase gateway removes /functions/v1 and forwards HTTP to
  // Deno. Keep Google's redirect URI public and fixed; accept only that URI
  // or its exact gateway representation, never a client-supplied redirect.
  const gatewayCallback = `http://${callback.host}${callback.pathname.replace(/^\/functions\/v1\//, '/')}`;
  if (!runtime.configured || url.username || url.password || url.hash || ![runtime.callbackUri, gatewayCallback].includes(`${url.origin}${url.pathname}`))
    throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
  const state = browserSecret(url.searchParams.get('state'));
  const stateHash = await sha256Base64Url(state);
  const relay = object(await runtime.rpc('relay', { state_hash: stateHash }));
  if (!runtime.appOrigin || relay.app_origin !== runtime.appOrigin) throw new GoogleServiceError('AUTH_REQUIRED', 401);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (!!code === !!error || (code && code.length > 4096)) throw new GoogleServiceError('INVALID_INPUT');
  const result = JSON.stringify(code ? { code: text(code, 4096) } : { error: error === 'access_denied' ? 'access_denied' : 'oauth_failed' });
  const resultEnvelope = await runtime.encrypt(result, `oauth-result:${stateHash}`, uuid(relay.user_id), '0');
  await runtime.rpc('record_oauth_result', { state_hash: stateHash, result_hash: await sha256Base64Url(result), result_envelope: resultEnvelope });
  // Supabase Free serves API responses, not callback HTML. Return to the app
  // without codes/state in its URL; the opener must still prove its live session.
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${runtime.appOrigin}/google-calendar/callback`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/** Request handler is dependency-injected for protocol and authorization tests. */
export function createGoogleUserHandler(runtime: GoogleRuntime) {
  return async (request: Request): Promise<Response> => {
    const requestOrigin = request.headers.get('origin');
    const corsOrigin = runtime.appOrigin && requestOrigin === runtime.appOrigin ? runtime.appOrigin : undefined;
    try {
      if (request.method === 'GET' && new URL(request.url).pathname.endsWith('/callback')) return await relayCallback(request, runtime);
      if (!corsOrigin) throw new GoogleServiceError('APP_ACCESS_DENIED', 403);
      if (request.method === 'OPTIONS')
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': corsOrigin,
            Vary: 'Origin',
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
            'Access-Control-Max-Age': '600',
          },
        });
      if (request.method !== 'POST' || !request.headers.get('content-type')?.startsWith('application/json')) throw new GoogleServiceError('INVALID_INPUT');
      const actor = await runtime.authenticate(request);
      const body = object(await boundedJson(request));
      const action = text(body.action, 32);
      const status = object(await runtime.rpc('status', {}, actor));
      if (!runtime.configured || status.configured !== true) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
      const provider = runtime.provider(operation => reserveGoogleRequest(runtime, operation, actor));
      if (action === 'begin') {
        checkFields(body, ['action', 'request_id', 'expected_version', 'browser_secret', 'tasks_requested']);
        if (body.tasks_requested !== undefined && typeof body.tasks_requested !== 'boolean') throw new GoogleServiceError('INVALID_INPUT');
        const requestId = uuid(body.request_id);
        const state = randomBase64Url();
        const stateHash = await sha256Base64Url(state);
        const pkce = await generatePkce();
        const pkceEnvelope = await runtime.encrypt(JSON.stringify({ state, verifier: pkce.verifier }), `pkce:${stateHash}`, actor.id, '0');
        const initiated = object(
          await runtime.rpc(
            'begin',
            {
              request_id: requestId,
              expected_version: version(body.expected_version),
              state_hash: stateHash,
              browser_hash: await sha256Base64Url(browserSecret(body.browser_secret)),
              pkce_envelope: pkceEnvelope,
              app_origin: runtime.appOrigin,
              ...(body.tasks_requested === true ? { tasks_requested: true } : {}),
            },
            actor,
          ),
        );
        // A lost response may replay the same logical request. Reuse the first
        // encrypted state/verifier rather than creating a second authorization.
        const storedHash = browserSecret(initiated.state_hash);
        const material = object(JSON.parse(await runtime.decrypt(envelope(initiated.pkce_envelope), `pkce:${storedHash}`, actor.id, '0')));
        const storedState = browserSecret(material.state);
        const storedVerifier = browserSecret(material.verifier);
        if ((await sha256Base64Url(storedState)) !== storedHash) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
        return reply(
          {
            authorization_url: beginAuthURL({
              state: storedState,
              challenge: await sha256Base64Url(storedVerifier),
              clientId: runtime.clientId,
              redirectUri: runtime.callbackUri,
              includeTasks: initiated.tasks_requested === true,
            }),
            state: storedState,
          },
          200,
          corsOrigin,
        );
      }
      if (action === 'complete') {
        checkFields(body, ['action', 'state', 'browser_secret']);
        const stateHash = await sha256Base64Url(browserSecret(body.state));
        const attempt = object(
          await runtime.rpc('consume_attempt', { state_hash: stateHash, browser_hash: await sha256Base64Url(browserSecret(body.browser_secret)) }, actor),
        );
        const attemptId = uuid(attempt.attempt_id);
        const fail = (reason: string) => runtime.rpc('authorization_failed', { attempt_id: attemptId, reason }, actor);
        try {
          const oauthResult = object(JSON.parse(await runtime.decrypt(envelope(attempt.result_envelope), `oauth-result:${stateHash}`, actor.id, '0')));
          if (!!oauthResult.code === !!oauthResult.error) throw new GoogleServiceError('INVALID_INPUT');
          if (oauthResult.error) return reply(await fail('oauth_denied'), 200, corsOrigin);
          const material = object(JSON.parse(await runtime.decrypt(envelope(attempt.pkce_envelope), `pkce:${stateHash}`, actor.id, '0')));
          if (material.state !== body.state) throw new GoogleServiceError('AUTH_REQUIRED', 401);
          const verifier = browserSecret(material.verifier);
          const tokens = await provider.exchange(text(oauthResult.code, 4096), verifier, attempt.tasks_requested === true);
          if (!tokens.scopes.includes(GOOGLE_CALENDAR_SCOPE)) return reply(await fail('scope_missing'), 200, corsOrigin);
          if (attempt.tasks_requested === true && !tokens.scopes.includes(GOOGLE_TASKS_SCOPE)) return reply(await fail('scope_missing'), 200, corsOrigin);
          const generation = String(version(attempt.generation));
          const refreshToken = tokens.refreshToken;
          const existingCalendar = typeof attempt.calendar_id === 'string' ? attempt.calendar_id : null;
          if (existingCalendar) {
            try {
              await provider.getCalendar(tokens.accessToken, existingCalendar);
            } catch (cause) {
              if (cause instanceof GoogleProviderError && (cause.kind === 'missing' || cause.reason === 'permission_denied'))
                return reply(await fail('different_google_account'), 200, corsOrigin);
              throw cause;
            }
          }
          if (!refreshToken) return reply(await fail('refresh_missing'), 200, corsOrigin);
          const secret: GoogleCredentials = {
            accessToken: tokens.accessToken,
            refreshToken,
            expiresAt: Date.now() + tokens.expiresIn * 1000,
            scopes: tokens.scopes,
          };
          const credentialEnvelope = await runtime.encrypt(JSON.stringify(secret), 'credentials', actor.id, generation);
          return reply(
            await runtime.rpc(
              'complete_authorization',
              {
                attempt_id: attemptId,
                credential_envelope: credentialEnvelope,
                keep_existing_calendar: Boolean(existingCalendar),
                ...(attempt.tasks_requested === true ? { tasks_granted: true } : {}),
              },
              actor,
            ),
            200,
            corsOrigin,
          );
        } catch (cause) {
          const reason =
            cause instanceof GoogleProviderError
              ? ['permission_missing', 'unexpected_permissions'].includes(cause.reason)
                ? 'scope_missing'
                : ['budget_exhausted', 'scope_missing', 'refresh_missing'].includes(cause.reason)
                  ? cause.reason
                  : 'oauth_exchange_failed'
              : 'oauth_exchange_failed';
          return reply(await fail(reason), 200, corsOrigin);
        }
      }
      if (['tasks_reconcile', 'tasks_pause', 'tasks_resume', 'tasks_select_list', 'tasks_resolve'].includes(action)) {
        checkFields(body, [
          'action',
          'request_id',
          'expected_version',
          ...(action === 'tasks_select_list' ? ['list_id', 'selected'] : action === 'tasks_resolve' ? ['link_id', 'resolution'] : []),
        ]);
        const input: Record<string, unknown> = { request_id: uuid(body.request_id), expected_version: version(body.expected_version) };
        if (action === 'tasks_select_list') {
          if (typeof body.selected !== 'boolean') throw new GoogleServiceError('INVALID_INPUT');
          input.list_id = text(body.list_id, 1024);
          input.selected = body.selected;
        }
        if (action === 'tasks_resolve') {
          if (body.resolution !== 'local' && body.resolution !== 'google') throw new GoogleServiceError('INVALID_INPUT');
          input.link_id = uuid(body.link_id);
          input.resolution = body.resolution;
        }
        return reply(await runtime.rpc(action, input, actor), 200, corsOrigin);
      }
      const changes = ['reconcile', 'disconnect', 'retry_cleanup', 'abandon_cleanup', 'recover_calendar', 'rebuild_missing'];
      if (!changes.includes(action)) throw new GoogleServiceError('INVALID_INPUT');
      checkFields(body, [
        'action',
        'request_id',
        'expected_version',
        ...(action === 'disconnect' ? ['mode'] : action === 'recover_calendar' ? ['calendar_id'] : []),
      ]);
      const payload: Record<string, unknown> = { request_id: uuid(body.request_id), expected_version: version(body.expected_version) };
      if (action === 'disconnect') {
        if (body.mode !== 'keep' && body.mode !== 'delete') throw new GoogleServiceError('INVALID_INPUT');
        payload.mode = body.mode;
      }
      if (action === 'recover_calendar') {
        const connection = object(await runtime.rpc('inspect_connection', {}, actor));
        if (connection.state !== 'provisioning_unknown' || connection.version !== payload.expected_version) throw new GoogleServiceError('STALE_VERSION', 409);
        const saved = credentials(
          await runtime.decrypt(envelope(connection.credential_envelope), 'credentials', actor.id, String(version(connection.generation))),
        );
        let accessToken = saved.accessToken;
        if (saved.expiresAt < Date.now() + 30_000) {
          const renewed = await provider.refresh(saved.refreshToken, saved.scopes?.includes(GOOGLE_TASKS_SCOPE));
          accessToken = renewed.accessToken;
          const next = {
            accessToken,
            refreshToken: renewed.refreshToken ?? saved.refreshToken,
            expiresAt: Date.now() + renewed.expiresIn * 1000,
            ...(saved.scopes ? { scopes: saved.scopes } : {}),
          };
          payload.credential_envelope = await runtime.encrypt(JSON.stringify(next), 'credentials', actor.id, String(version(connection.generation)));
          // Persist a rotated refresh token before another network call can
          // fail or the process can stop. This does not change the user CAS.
          const stored = await runtime.rpc('save_credentials', { generation: connection.generation, credential_envelope: payload.credential_envelope }, actor);
          if (stored !== true) throw new GoogleServiceError('STALE_VERSION', 409);
        }
        payload.calendar_id = (await provider.getCalendar(accessToken, text(body.calendar_id, 1024))).id;
      }
      return reply(await runtime.rpc(action, payload, actor), 200, corsOrigin);
    } catch (cause) {
      return errorReply(cause, corsOrigin);
    }
  };
}

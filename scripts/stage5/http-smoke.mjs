/**
 * Disabled-provider acceptance checks for the designated disposable project.
 * Usage: node scripts/stage5/http-smoke.mjs <private-fixtures.json> [app-origin]
 * Creates only disposable Auth sessions for existing example.test fixtures and
 * signs those sessions out locally. No Google OAuth flow, secret or domain row
 * is created. Refuses a configured Google integration before any Edge action.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_HOST = 'kajcbwlnqcwcpbtqyieo.supabase.co';
const PRODUCTION_REF = 'ggbjezprlsnhidlbjivl';
const USERS = ['owner', 'otherOwner', 'editor', 'outsider'];
const ALLOWED_APP_ORIGINS = ['http://127.0.0.1:5174', 'http://127.0.0.1:5173', 'https://tr8.vercel.app'];
const PRIVATE_TABLES = [
  'google_config',
  'google_connections',
  'google_oauth_attempts',
  'google_event_links',
  'google_jobs',
  'google_requests',
  'google_request_receipts',
];
const STATUS_KEYS = ['configured', 'state', 'generation', 'version', 'last_sync_at', 'pending', 'failed', 'reason'].sort().join('|');
let assertions = 0;
let requests = 0;
class SmokeError extends Error {}
function check(condition, label) {
  if (!condition) throw new SmokeError(label);
  assertions++;
}
function success(response, label) {
  check(response.status >= 200 && response.status < 300, label);
  return response.body;
}
function denied(response, label, codes = ['42501', 'PGRST106', 'PGRST202', 'PGRST205']) {
  check(response.status >= 400 && response.status < 500 && codes.includes(response.body?.code), label);
}
function statusShape(value) {
  check(value && Object.keys(value).sort().join('|') === STATUS_KEYS, 'status leaked credentials, account references or provider diagnostics');
  check(value.configured === false && value.reason === 'config_pending', 'disabled-provider suite refuses a configured integration');
  check(value.state === 'disconnected' && value.generation === 0 && value.version === 0, 'fixture Google connection is not clean; refusing Edge probes');
  check(value.last_sync_at === null && value.pending === 0 && value.failed === 0, 'unexpected fixture Google activity');
  return value;
}
function safeEdgeError(response) {
  check(
    response.body &&
      Object.keys(response.body).join('|') === 'error' &&
      response.body.error &&
      Object.keys(response.body.error).sort().join('|') === 'code|message' &&
      typeof response.body.error.message === 'string' &&
      response.body.error.message.length <= 200,
    'Edge error exposed unexpected metadata or diagnostics.',
  );
}

async function main() {
  if (!process.argv[2]) throw new SmokeError('Expected private synthetic-fixture config path.');
  const configPath = resolve(process.argv[2]);
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const privateLocation = relative(repository, configPath);
  if (!privateLocation || (!isAbsolute(privateLocation) && privateLocation !== '..' && !privateLocation.startsWith(`..${sep}`)))
    throw new SmokeError('Fixture credentials and result must remain outside the repository.');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const base = new URL(config.url);
  if (
    base.protocol !== 'https:' ||
    base.hostname !== TEST_HOST ||
    base.port ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    config.url.includes(PRODUCTION_REF)
  )
    throw new SmokeError('Refusing network access: only the designated disposable test project is accepted.');
  if (typeof config.key !== 'string' || !config.key || config.key.startsWith('sb_secret_')) throw new SmokeError('A public test-project key is required.');
  if (!config.key.startsWith('sb_publishable_')) {
    let claims;
    try {
      claims = JSON.parse(Buffer.from(config.key.split('.')[1] || '', 'base64url').toString('utf8'));
    } catch {
      throw new SmokeError('Invalid public test key.');
    }
    if (claims.role !== 'anon' || claims.ref !== TEST_HOST.split('.')[0]) throw new SmokeError('Privileged or foreign project keys are prohibited.');
  }
  const appOrigin = process.argv[3] ?? 'http://127.0.0.1:5174';
  if (!ALLOWED_APP_ORIGINS.includes(appOrigin)) throw new SmokeError('Unexpected application origin for this test suite.');
  for (const name of USERS) {
    const user = config.users?.[name];
    if (
      !user ||
      !/^[^@\s]+@example\.test$/i.test(user.email) ||
      typeof user.password !== 'string' ||
      user.password.length < 20 ||
      !/^[0-9a-f-]{36}$/i.test(user.id)
    )
      throw new SmokeError('Only existing synthetic example.test fixtures are accepted.');
  }
  async function request(path, token, method = 'GET', body, extraHeaders = {}) {
    const target = new URL(path, base);
    if (target.origin !== base.origin || !['/auth/v1/', '/rest/v1/', '/functions/v1/'].some(prefix => target.pathname.startsWith(prefix)))
      throw new SmokeError('Refusing an unexpected network target.');
    requests++;
    const response = await fetch(target, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {
        apikey: config.key,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let parsed = null;
    try {
      if (raw) parsed = JSON.parse(raw);
    } catch {
      throw new SmokeError('Expected a sanitized JSON API response.');
    }
    return { status: response.status, body: parsed, cors: response.headers.get('access-control-allow-origin'), cache: response.headers.get('cache-control') };
  }
  const tokens = {};
  const sessions = {};
  const rpc = (actor, name, params = {}, headers = {}) => request(`/rest/v1/rpc/${name}`, actor ? tokens[actor] : null, 'POST', params, headers);
  const edge = (actor, body, origin = appOrigin) =>
    request('/functions/v1/tr8-google', actor ? tokens[actor] : null, 'POST', body, origin === null ? {} : { Origin: origin });
  const initialStatus = {};
  try {
    for (const name of USERS) {
      const fixture = config.users[name];
      const login = success(
        await request('/auth/v1/token?grant_type=password', null, 'POST', { email: fixture.email, password: fixture.password }),
        'Synthetic fixture login failed.',
      );
      check(typeof login.access_token === 'string' && login.user?.id === fixture.id, 'Unexpected synthetic session identity.');
      const claims = JSON.parse(Buffer.from(login.access_token.split('.')[1], 'base64url').toString('utf8'));
      check(claims.sub === fixture.id && typeof claims.session_id === 'string', 'Synthetic session claims are invalid.');
      tokens[name] = login.access_token;
      sessions[name] = claims.session_id;
    }
    for (const actor of ['owner', 'otherOwner', 'editor']) {
      const context = success(await rpc(actor, 'tr8_v2_get_context'), 'Enabled fixture context failed.');
      check(context.external_invites_enabled === false, 'External onboarding gate changed.');
      initialStatus[actor] = statusShape(success(await rpc(actor, 'tr8_v2_get_google_status'), 'Own Google status failed.'));
      denied(
        await rpc(actor, 'tr8_v2_get_google_status', { p_user_id: config.users[actor === 'owner' ? 'otherOwner' : 'owner'].id }),
        'Client selected another Google connection.',
        ['PGRST202'],
      );
    }
    denied(await rpc('outsider', 'tr8_v2_get_google_status'), 'Unapproved account read Google state.', ['42501']);
    denied(await rpc(null, 'tr8_v2_get_google_status'), 'Anonymous request read Google state.', ['42501']);

    for (const actor of [null, 'owner', 'editor']) {
      denied(
        await rpc(actor, 'tr8_server_google', { p_action: 'status', p_actor: config.users.owner.id, p_session: sessions.owner, p_payload: {} }),
        'Public client reached the privileged server RPC.',
      );
      denied(await rpc(actor, 'v5_get_status', {}, { 'Content-Profile': 'tr8_private' }), 'Public client invoked a private Google function.');
      for (const table of PRIVATE_TABLES) {
        denied(await request(`/rest/v1/${table}?select=*`, actor ? tokens[actor] : null), 'Public alias exposed a private Google table.');
        denied(await request(`/rest/v1/${table}`, actor ? tokens[actor] : null, 'POST', {}), 'Client reached direct Google table inserts.');
        denied(
          await request(`/rest/v1/${table}?select=*`, actor ? tokens[actor] : null, 'GET', undefined, { 'Accept-Profile': 'tr8_private' }),
          'Client selected the private Google schema.',
        );
        denied(
          await request(`/rest/v1/${table}`, actor ? tokens[actor] : null, 'POST', {}, { 'Content-Profile': 'tr8_private' }),
          'Client reached private Google schema writes.',
        );
      }
      for (const headers of [{}, { 'x-tr8-worker-secret': config.key }]) {
        const response = await request('/functions/v1/tr8-google-worker', actor ? tokens[actor] : null, 'POST', {}, headers);
        check(response.status === 401 && response.body?.error?.code === 'AUTH_REQUIRED', 'Public key or user JWT authenticated the Google worker.');
        safeEdgeError(response);
        check(response.cors === null, 'Internal worker unexpectedly enabled browser CORS.');
      }
    }

    const validBegin = { action: 'begin', request_id: randomUUID(), expected_version: 0, browser_secret: randomBytes(32).toString('base64url') };
    for (const origin of ['https://attacker.example.test', null]) {
      const response = await edge('owner', validBegin, origin);
      check(response.status === 403 && response.body?.error?.code === 'APP_ACCESS_DENIED', 'Missing or foreign browser Origin was accepted.');
      safeEdgeError(response);
      check(response.cors === null, 'Foreign browser Origin received CORS access.');
    }
    const preflight = await request('/functions/v1/tr8-google', null, 'OPTIONS', undefined, {
      Origin: appOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,apikey,content-type,x-client-info',
    });
    check(preflight.status === 204 && preflight.cors === appOrigin, 'Configured test application Origin failed preflight.');
    const anon = await edge(null, validBegin);
    check(anon.status === 401 && anon.body?.error?.code === 'AUTH_REQUIRED', 'Anonymous browser began a Google connection.');
    safeEdgeError(anon);
    const outsider = await edge('outsider', validBegin);
    check(outsider.status === 403 && outsider.body?.error?.code === 'APP_ACCESS_DENIED', 'Unapproved browser account reached Google configuration.');
    safeEdgeError(outsider);
    const pending = await edge('owner', validBegin);
    check(pending.status === 503 && pending.body?.error?.code === 'DEPENDENCY_UNAVAILABLE', 'Unconfigured integration did not fail closed before OAuth.');
    safeEdgeError(pending);
    check(pending.cors === appOrigin && pending.cache?.includes('no-store'), 'Disabled-provider response is not private or retryable from the application.');

    for (const actor of ['owner', 'otherOwner', 'editor'])
      check(
        JSON.stringify(statusShape(success(await rpc(actor, 'tr8_v2_get_google_status'), 'Final own Google status failed.'))) ===
          JSON.stringify(initialStatus[actor]),
        'Denied probes created a Google connection or changed its state.',
      );
    const loggedOut = await request('/auth/v1/logout?scope=local', tokens.owner, 'POST');
    check(loggedOut.status === 204, 'Could not revoke the synthetic owner session created by this suite.');
    denied(await rpc('owner', 'tr8_v2_get_google_status'), 'A revoked session retained Google status access with its old JWT.', ['42501']);
    delete tokens.owner;
  } finally {
    // Only revoke the fresh sessions created above, never other test/browser sessions.
    for (const name of Object.keys(tokens)) {
      const response = await request('/auth/v1/logout?scope=local', tokens[name], 'POST');
      check(response.status === 204 || response.status === 401 || response.status === 403, 'Synthetic session cleanup failed.');
    }
  }
  const result = {
    result: 'passed',
    projectRef: TEST_HOST.split('.')[0],
    assertions,
    requests,
    subjects: USERS.length,
    provider: 'disabled; no Google calls or secrets',
    onboarding: 'disabled',
    scope:
      'Own live sessions, no arbitrary identity, private DML/RPC denial, exact browser Origin, public-worker denial, local logout and stale-JWT denial; no real OAuth or domain mutations.',
  };
  await writeFile(join(dirname(configPath), 'http-stage5-disabled-result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => {
  console.error(
    error instanceof SmokeError ? `Stage-5 HTTP checks failed: ${error.message}` : 'Stage-5 HTTP checks failed: local configuration or network error.',
  );
  process.exitCode = 1;
});

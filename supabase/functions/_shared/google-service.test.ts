import { describe, expect, it, vi } from 'vitest';
import { decryptGoogleSecret, encryptGoogleSecret, randomBase64Url } from './google-crypto.ts';
import { GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE, GoogleProvider } from './google-provider.ts';
import { GoogleServiceError, type GoogleRuntime } from './google-runtime.ts';
import { createGoogleUserHandler, reserveGoogleRequest } from './google-service.ts';

const actor = { id: '10000000-0000-4000-8000-000000000001', session: '10000000-0000-4000-8000-000000000002' };
const attemptId = '10000000-0000-4000-8000-000000000003';
const status = { configured: true, state: 'disconnected', generation: 0, version: 0, last_sync_at: null, pending: 0, failed: 0, reason: null };
function fixture(
  options: {
    configured?: boolean;
    scopes?: string;
    omitScope?: boolean;
    refresh?: boolean;
    previous?: boolean;
    previousScopes?: string[];
    persistedTasks?: boolean;
    remoteStatus?: number;
  } = {},
) {
  const key = randomBase64Url();
  let pending: Record<string, unknown> = {};
  let received: Record<string, unknown> = {};
  const remote = vi.fn<typeof fetch>(async url => {
    if (String(url).includes('/token'))
      return Response.json({
        access_token: 'synthetic-access-only',
        expires_in: 3600,
        token_type: 'Bearer',
        ...(options.refresh === false ? {} : { refresh_token: 'synthetic-refresh-only' }),
        ...(options.omitScope ? {} : { scope: options.scopes ?? GOOGLE_CALENDAR_SCOPE }),
      });
    return Response.json({ id: 'synthetic-calendar' }, { status: options.remoteStatus ?? 200 });
  });
  const encrypt: GoogleRuntime['encrypt'] = (plaintext, purpose, userId, generation) =>
    encryptGoogleSecret({ key, keyId: 'test', purpose, userId, generation, plaintext });
  const decrypt: GoogleRuntime['decrypt'] = (envelope, purpose, userId, generation) =>
    decryptGoogleSecret({ key, keyId: 'test', purpose, userId, generation, envelope });
  const persistedTasks = () => options.persistedTasks ?? pending.tasks_requested === true;
  const rpc = vi.fn<GoogleRuntime['rpc']>(async (action, payload = {}, owner) => {
    if (action === 'status') return status;
    if (action === 'begin') {
      if (!pending.request_id) pending = payload;
      return { attempt_id: attemptId, generation: 1, state_hash: pending.state_hash, pkce_envelope: pending.pkce_envelope, tasks_requested: persistedTasks() };
    }
    if (action === 'inspect_connection')
      return {
        ...status,
        state: 'provisioning_unknown',
        generation: 1,
        credential_envelope: await encrypt(
          JSON.stringify({
            accessToken: 'expired-access',
            refreshToken: 'old-refresh-only',
            expiresAt: 0,
            ...(options.previousScopes ? { scopes: options.previousScopes } : {}),
          }),
          'credentials',
          actor.id,
          '1',
        ),
      };
    if (action === 'save_credentials') return true;
    if (action === 'consume_attempt')
      return {
        attempt_id: attemptId,
        generation: 1,
        tasks_requested: persistedTasks(),
        pkce_envelope: pending.pkce_envelope,
        result_envelope: received.result_envelope,
        calendar_id: options.previous ? 'synthetic-calendar' : null,
        credential_envelope: options.previous
          ? await encrypt(JSON.stringify({ accessToken: 'old', refreshToken: 'previous-refresh-only', expiresAt: 0 }), 'credentials', actor.id, '1')
          : null,
      };
    if (action === 'complete_authorization') return { ...status, state: 'provisioning', generation: 1, version: 2 };
    if (action === 'authorization_failed') return { ...status, reason: payload.reason };
    if (action === 'relay') return { app_origin: 'https://tr8.example.test', user_id: actor.id };
    if (action === 'record_oauth_result') {
      received = payload;
      return { app_origin: 'https://tr8.example.test' };
    }
    if (action === 'reserve_request') {
      if (owner) expect(owner).toEqual(actor);
      else expect(payload.job_id).toBeDefined();
      return { allowed: true };
    }
    return status;
  });
  const runtime: GoogleRuntime = {
    configured: options.configured ?? true,
    appOrigin: 'https://tr8.example.test',
    callbackUri: 'https://project.supabase.co/functions/v1/tr8-google/callback',
    clientId: 'synthetic-client',
    workerSecret: randomBase64Url(),
    rpc,
    encrypt,
    decrypt,
    authenticate: vi.fn(async () => actor),
    provider: beforeRequest =>
      new GoogleProvider({
        clientId: 'synthetic-client',
        clientSecret: 'synthetic-client-secret',
        redirectUri: 'https://project.supabase.co/functions/v1/tr8-google/callback',
        beforeRequest,
        fetch: remote,
      }),
  };
  const handle = createGoogleUserHandler(runtime);
  const request = (body: unknown, origin = runtime.appOrigin) =>
    new Request('https://project.supabase.co/functions/v1/tr8-google', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-session' },
      body: JSON.stringify(body),
    });
  async function begin(tasksRequested?: boolean) {
    const browser = randomBase64Url();
    const response = await handle(
      request({
        action: 'begin',
        request_id: attemptId,
        expected_version: 0,
        browser_secret: browser,
        ...(tasksRequested === undefined ? {} : { tasks_requested: tasksRequested }),
      }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    return { browser, state: result.state as string, url: result.authorization_url as string };
  }
  async function complete(auth: { state: string; browser: string }, result = { code: 'synthetic-code' } as { code?: string; error?: string }) {
    const query = new URLSearchParams({ state: auth.state, ...(result as Record<string, string>) });
    expect((await handle(new Request(`${runtime.callbackUri}?${query}`))).status).toBe(302);
    return handle(request({ action: 'complete', state: auth.state, browser_secret: auth.browser }));
  }
  return { runtime, rpc, remote, handle, request, begin, complete, pending: () => pending };
}
describe('Google user service boundary', () => {
  it('rejects a foreign Origin before authentication or database access', async () => {
    const f = fixture();
    expect((await f.handle(f.request({ action: 'begin' }, 'https://attacker.example'))).status).toBe(403);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.runtime.authenticate).not.toHaveBeenCalled();
  });
  it('keeps an unconfigured integration unavailable without provider calls', async () => {
    const f = fixture({ configured: false });
    expect((await f.handle(f.request({ action: 'begin' }))).status).toBe(503);
    expect(f.remote).not.toHaveBeenCalled();
  });
  it('returns a fixed, scoped PKCE authorization URL and stores only hashes and ciphertext', async () => {
    const f = fixture();
    const auth = await f.begin();
    const url = new URL(auth.url);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(f.runtime.callbackUri);
    expect(url.searchParams.get('scope')).toBe(GOOGLE_CALENDAR_SCOPE);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(JSON.stringify(f.pending())).not.toContain(auth.browser);
    expect(JSON.stringify(f.pending())).not.toContain(auth.state);
    expect(f.pending().pkce_envelope).toMatchObject({ v: 1, kid: 'test' });
  });
  it('rejects arbitrary actor IDs and redirect destinations', async () => {
    const f = fixture();
    expect((await f.handle(f.request({ action: 'begin', actor_id: actor.id, redirect: 'https://attacker.example' }))).status).toBe(400);
    expect(f.rpc.mock.calls.some(([action]) => action === 'begin')).toBe(false);
  });
  it('reuses the first authorization URL after a lost begin response', async () => {
    const f = fixture();
    const body = { action: 'begin', request_id: attemptId, expected_version: 0, browser_secret: randomBase64Url() };
    const first = await (await f.handle(f.request(body))).json();
    const retry = await (await f.handle(f.request(body))).json();
    expect(retry).toEqual(first);
    expect(f.remote).not.toHaveBeenCalled();
    expect(JSON.stringify(retry)).not.toContain('ciphertext');
  });
  it('consumes the attempt before exchange and persists encrypted credentials only', async () => {
    const f = fixture();
    const auth = await f.begin();
    const response = await f.complete(auth);
    expect(response.status).toBe(200);
    expect((await response.json()).state).toBe('provisioning');
    const call = f.rpc.mock.calls.find(([action]) => action === 'complete_authorization')!;
    expect(call[1]?.credential_envelope).toMatchObject({ v: 1 });
    expect(JSON.stringify(call)).not.toContain('synthetic-refresh-only');
    expect(f.rpc.mock.calls.findIndex(([action]) => action === 'consume_attempt')).toBeLessThan(
      f.rpc.mock.calls.findIndex(([action]) => action === 'complete_authorization'),
    );
  });
  it.each([
    ['scope_missing', { scopes: 'openid' }],
    ['refresh_missing', { refresh: false }],
  ] as const)('does not connect when %s', async (reason, options) => {
    const f = fixture(options);
    const auth = await f.begin();
    const response = await f.complete(auth);
    expect((await response.json()).reason).toBe(reason);
    expect(f.rpc.mock.calls.some(([action]) => action === 'complete_authorization')).toBe(false);
  });
  it('consumes denial without exchanging a code', async () => {
    const f = fixture();
    const auth = await f.begin();
    const response = await f.complete(auth, { error: 'access_denied' });
    expect((await response.json()).reason).toBe('oauth_denied');
    expect(f.remote).not.toHaveBeenCalled();
  });
  it('requires exactly one completion result', async () => {
    const f = fixture();
    expect((await f.handle(f.request({ action: 'complete', code: 'x', error: 'x' }))).status).toBe(400);
    expect(f.rpc.mock.calls.some(([action]) => action === 'consume_attempt')).toBe(false);
  });
  it('preserves prior credentials without mixing a missing new refresh token with a new access token', async () => {
    const f = fixture({ previous: true, refresh: false });
    const auth = await f.begin();
    const response = await f.complete(auth);
    expect(response.status).toBe(200);
    expect((await response.json()).reason).toBe('refresh_missing');
    expect(f.remote).toHaveBeenCalledTimes(2);
    expect(f.rpc.mock.calls.some(([action]) => action === 'complete_authorization')).toBe(false);
  });
  it('does not replace a connection with a different account', async () => {
    const f = fixture({ previous: true, remoteStatus: 404 });
    const auth = await f.begin();
    const response = await f.complete(auth);
    expect((await response.json()).reason).toBe('different_google_account');
    expect(f.rpc.mock.calls.some(([action]) => action === 'complete_authorization')).toBe(false);
  });
  it('does not attribute a temporary Google failure to a different account', async () => {
    const f = fixture({ previous: true, remoteStatus: 429 });
    const auth = await f.begin();
    const response = await f.complete(auth);
    expect((await response.json()).reason).toBe('oauth_exchange_failed');
  });
  it('saves a rotated recovery credential before a calendar lookup can fail', async () => {
    const f = fixture({ remoteStatus: 404 });
    const response = await f.handle(f.request({ action: 'recover_calendar', request_id: attemptId, expected_version: 0, calendar_id: 'synthetic-calendar' }));
    expect(response.status).toBe(503);
    const write = f.rpc.mock.calls.find(([action]) => action === 'save_credentials');
    expect(write).toBeDefined();
    const saved = await f.runtime.decrypt(write![1]!.credential_envelope as Parameters<GoogleRuntime['decrypt']>[0], 'credentials', actor.id, '1');
    expect(JSON.parse(saved).refreshToken).toBe('synthetic-refresh-only');
    expect(f.rpc.mock.calls.some(([action]) => action === 'recover_calendar')).toBe(false);
  });
  it('encrypts the callback result and redirects to a fixed clean application URL without exchanging its code', async () => {
    const f = fixture();
    const state = randomBase64Url();
    const response = await f.handle(new Request(`${f.runtime.callbackUri}?state=${state}&code=${encodeURIComponent('</script><script>attack</script>')}`));
    const body = await response.text();
    expect(response.status).toBe(302);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Location')).toBe('https://tr8.example.test/google-calendar/callback');
    expect(body).toBe('');
    expect(f.rpc.mock.calls.map(([action]) => action)).toEqual(['relay', 'record_oauth_result']);
    expect(JSON.stringify(f.rpc.mock.calls)).not.toContain('<script>attack');
    expect(f.rpc.mock.calls[1][1]?.result_envelope).toMatchObject({ v: 1, kid: 'test' });
    expect(f.remote).not.toHaveBeenCalled();
  });
  it('accepts the exact hosted gateway callback while retaining the fixed public redirect URI', async () => {
    const f = fixture();
    const auth = await f.begin();
    f.rpc.mockClear();
    const response = await f.handle(new Request(`http://project.supabase.co/tr8-google/callback?state=${auth.state}&error=access_denied`));
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://tr8.example.test/google-calendar/callback');
    expect(f.runtime.callbackUri).toBe('https://project.supabase.co/functions/v1/tr8-google/callback');
    expect(f.rpc.mock.calls.map(([action]) => action)).toEqual(['relay', 'record_oauth_result']);
    expect(f.remote).not.toHaveBeenCalled();
  });
  it.each([
    'http://attacker.example/tr8-google/callback',
    'https://attacker.example/functions/v1/tr8-google/callback',
    'http://project.supabase.co/another-function/callback',
    'http://project.supabase.co/tr8-google/nested/callback',
  ])('rejects a different callback location: %s', async location => {
    const f = fixture();
    const response = await f.handle(new Request(`${location}?state=${randomBase64Url()}&error=access_denied`));
    expect(response.status).toBe(503);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.remote).not.toHaveBeenCalled();
  });
  it('rejects an expired callback using the durable store', async () => {
    const f = fixture();
    f.rpc.mockRejectedValueOnce(new GoogleServiceError('AUTH_REQUIRED', 401));
    expect((await f.handle(new Request(`${f.runtime.callbackUri}?state=${randomBase64Url()}&code=x`))).status).toBe(401);
  });
  it('never forwards diagnostic details on a backend failure', async () => {
    const f = fixture();
    f.rpc.mockRejectedValueOnce(new Error('synthetic-secret SQL postgres diagnostic'));
    const response = await f.handle(f.request({ action: 'reconcile' }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('synthetic-secret');
  });
  it('reserves every operation using its bounded purpose and current job fence', async () => {
    const f = fixture();
    const job = { job_id: attemptId, lease_token: attemptId };
    await reserveGoogleRequest(f.runtime, 'event.update', undefined, job);
    expect(f.rpc).toHaveBeenCalledWith('reserve_request', { purpose: 'event_upsert', ...job }, undefined);
  });
});

describe('Google Tasks capability is tied to the durable OAuth attempt', () => {
  it.each([
    [false, true],
    [true, false],
  ])('builds the URL from persisted Tasks=%s rather than the browser request=%s', async (persistedTasks, browserRequested) => {
    const f = fixture({ persistedTasks });
    const auth = await f.begin(browserRequested);
    const requestedScopes = new URL(auth.url).searchParams.get('scope')?.split(' ');
    expect(requestedScopes).toEqual(persistedTasks ? [GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE] : [GOOGLE_CALENDAR_SCOPE]);
    expect(f.pending().tasks_requested).toBe(browserRequested ? true : undefined);
    expect(f.remote).not.toHaveBeenCalled();
  });

  it('reuses the persisted combined grant on an exact begin replay without replacing PKCE material', async () => {
    const f = fixture({ persistedTasks: true });
    const body = { action: 'begin', request_id: attemptId, expected_version: 0, browser_secret: randomBase64Url(), tasks_requested: true };
    const first = await (await f.handle(f.request(body))).json();
    const originalEnvelope = f.pending().pkce_envelope;
    const replay = await (await f.handle(f.request(body))).json();
    expect(replay).toEqual(first);
    expect(new URL(replay.authorization_url).searchParams.get('scope')).toBe(`${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_TASKS_SCOPE}`);
    expect(f.pending().pkce_envelope).toEqual(originalEnvelope);
    expect(f.remote).not.toHaveBeenCalled();
  });

  it('stores the verified combined grant encrypted and passes only its server-confirmed capability to SQL', async () => {
    const f = fixture({ persistedTasks: true, previous: true, scopes: `${GOOGLE_TASKS_SCOPE} ${GOOGLE_CALENDAR_SCOPE}` });
    const auth = await f.begin(true);
    const response = await f.complete(auth);
    expect(response.status).toBe(200);
    const write = f.rpc.mock.calls.find(([action]) => action === 'complete_authorization');
    expect(write?.[1]).toMatchObject({ attempt_id: attemptId, tasks_granted: true, keep_existing_calendar: true });
    expect(write?.[2]).toEqual(actor);
    const encrypted = write![1]!.credential_envelope as Parameters<GoogleRuntime['decrypt']>[0];
    const stored = JSON.parse(await f.runtime.decrypt(encrypted, 'credentials', actor.id, '1'));
    expect(stored.scopes).toEqual([GOOGLE_TASKS_SCOPE, GOOGLE_CALENDAR_SCOPE]);
    expect(stored.refreshToken).toBe('synthetic-refresh-only');
    expect(JSON.stringify(write)).not.toContain(stored.refreshToken);
    expect(f.remote).toHaveBeenCalledTimes(2);
  });

  it.each([GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE, `${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_TASKS_SCOPE} openid`])(
    'keeps the old credentials when a requested combined grant is partial or broader: %s',
    async scopes => {
      const f = fixture({ persistedTasks: true, previous: true, scopes });
      const auth = await f.begin(true);
      const encrypt = vi.spyOn(f.runtime, 'encrypt');
      const response = await f.complete(auth);
      expect(response.status).toBe(200);
      expect((await response.json()).reason).toBe('scope_missing');
      expect(f.rpc.mock.calls.find(([action]) => action === 'authorization_failed')?.[1]).toEqual({ attempt_id: attemptId, reason: 'scope_missing' });
      expect(f.rpc.mock.calls.some(([action]) => ['complete_authorization', 'save_credentials'].includes(action))).toBe(false);
      expect(encrypt.mock.calls.some(([, purpose]) => purpose === 'credentials')).toBe(false);
      expect(f.remote).toHaveBeenCalledTimes(1);
    },
  );

  it('does not let the completion request assert its own Tasks capability', async () => {
    const f = fixture({ persistedTasks: false });
    const auth = await f.begin();
    const response = await f.handle(f.request({ action: 'complete', state: auth.state, browser_secret: auth.browser, tasks_granted: true }));
    expect(response.status).toBe(400);
    expect(f.rpc.mock.calls.some(([action]) => action === 'consume_attempt')).toBe(false);
    expect(f.remote).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves the previous Tasks capability across a recovery refresh, scope omitted=%s', async omitScope => {
    const f = fixture({
      previousScopes: [GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE],
      scopes: `${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_TASKS_SCOPE}`,
      omitScope,
      remoteStatus: 404,
    });
    const response = await f.handle(f.request({ action: 'recover_calendar', request_id: attemptId, expected_version: 0, calendar_id: 'synthetic-calendar' }));
    expect(response.status).toBe(503);
    const write = f.rpc.mock.calls.find(([action]) => action === 'save_credentials');
    expect(write).toBeDefined();
    const stored = JSON.parse(await f.runtime.decrypt(write![1]!.credential_envelope as Parameters<GoogleRuntime['decrypt']>[0], 'credentials', actor.id, '1'));
    expect(stored.scopes).toEqual([GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE]);
    expect(stored.refreshToken).toBe('synthetic-refresh-only');
    expect(f.rpc.mock.calls.some(([action]) => action === 'recover_calendar')).toBe(false);
  });

  it('does not replace stored mixed credentials with a refresh that explicitly lost Tasks permission', async () => {
    const f = fixture({ previousScopes: [GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE], scopes: GOOGLE_CALENDAR_SCOPE });
    const response = await f.handle(f.request({ action: 'recover_calendar', request_id: attemptId, expected_version: 0, calendar_id: 'synthetic-calendar' }));
    expect(response.status).toBe(503);
    expect(f.remote).toHaveBeenCalledTimes(1);
    expect(f.rpc.mock.calls.some(([action]) => ['save_credentials', 'recover_calendar'].includes(action))).toBe(false);
  });

  it.each([
    { export_enabled: true, export_list_id: 'selected-list' },
    { export_enabled: false, export_list_id: null },
  ])('configures future task export through the authenticated database boundary: %j', async settings => {
    const f = fixture();
    const response = await f.handle(f.request({ action: 'tasks_configure_export', request_id: attemptId, expected_version: 4, ...settings }));
    expect(response.status).toBe(200);
    expect(f.rpc.mock.calls.find(([action]) => action === 'tasks_configure_export')).toEqual([
      'tasks_configure_export',
      { request_id: attemptId, expected_version: 4, ...settings },
      actor,
    ]);
    expect(f.remote).not.toHaveBeenCalled();
  });

  it.each([
    { export_enabled: 'true', export_list_id: 'list' },
    { export_enabled: true },
    { export_enabled: true, export_list_id: '' },
    { export_enabled: true, export_list_id: 'list\nforeign' },
    { export_enabled: true, export_list_id: 'x'.repeat(1025) },
    { export_enabled: true, export_list_id: 'list', actor: actor.id },
    { export_enabled: true, export_list_id: 'list', backfill: true },
  ])('rejects malformed or expanded task export settings without a write: %j', async settings => {
    const f = fixture();
    const response = await f.handle(f.request({ action: 'tasks_configure_export', request_id: attemptId, expected_version: 4, ...settings }));
    expect(response.status).toBe(400);
    expect(f.rpc.mock.calls.some(([action]) => action === 'tasks_configure_export')).toBe(false);
    expect(f.remote).not.toHaveBeenCalled();
  });
});

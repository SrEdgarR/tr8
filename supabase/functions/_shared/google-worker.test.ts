// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_CALENDAR_SCOPE, GoogleProvider } from './google-provider.ts';
import { GoogleServiceError, type GoogleRuntime } from './google-runtime.ts';
import { createGoogleWorkerHandler, runGoogleWorker } from './google-worker.ts';

const user = 'ac3e3faf-122e-4fa8-8d3d-329fe7738548';
const connection = '7ab5bdab-3064-4016-943b-30a944e5a171';
const link = '5cc699ad-74d6-4a9a-bf4e-e14c217ad305';
const job = { job_id: '40b32678-cb2f-489c-bcbd-862765e253ba', lease_token: 'f6f57a89-43d4-4884-a0ad-283bcaef9383', kind: 'upsert' };
const id = 'bb5f7bc6434e477794c359a1708c80ec';
const envelope = { v: 1 as const, kid: 'key-v1', iv: 'synthetic-iv', ciphertext: 'encrypted-synthetic-credentials' };
const now = Date.UTC(2026, 9, 23);
const saved = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: now + 3_600_000 };
const projection = {
  id: '5de4810b-cdf3-4df4-b0cc-44d4e0c38023',
  project_id: 'cdd537da-e8ad-4e9d-92d6-b402bf9c7c55',
  title: 'Mi tarea',
  project_title: 'Mi proyecto',
  status: 'todo',
  due_date: '2026-10-25',
};
const prepared = {
  valid: true,
  kind: 'upsert',
  user_id: user,
  connection_id: connection,
  generation: 1,
  calendar_id: 'tr8-secondary@example.test',
  credential_envelope: envelope,
  time_zone: 'America/La_Paz',
  link: { id: link, event_id: id },
  event: projection,
  previously_synced: false,
};
const remote = { id, etag: '"version-1"', status: 'confirmed', extendedProperties: { private: { tr8_link: link, tr8_generation: '1' } } };
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
type FetchStep = Response | Error | (() => Response | Promise<Response>);

function fixture(kind = 'upsert', responses: FetchStep[] = []) {
  const state = {
    preparation: { ...structuredClone(prepared), kind } as Record<string, unknown>,
    prepareResults: [] as unknown[],
    claimed: [{ ...job, kind }] as unknown[],
    saved: { ...saved },
    savedAllowed: true,
    finishAllowed: true,
    reservations: [] as unknown[],
    results: [] as Record<string, unknown>[],
  };
  if (kind === 'provision') state.preparation.calendar_id = null;
  const rpc = vi.fn<GoogleRuntime['rpc']>(async (action, payload = {}) => {
    if (action === 'claim') return state.claimed;
    if (action === 'prepare') return state.prepareResults.length ? state.prepareResults.shift() : state.preparation;
    if (action === 'reserve_request') return state.reservations.length ? state.reservations.shift() : { allowed: true };
    if (action === 'save_credentials') return state.savedAllowed;
    if (action === 'finish') {
      state.results.push(payload);
      return state.finishAllowed;
    }
    throw new Error('Unexpected internal operation containing synthetic-secret');
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unplanned external request synthetic-secret');
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response() : response;
  });
  const runtime: GoogleRuntime = {
    appOrigin: 'https://tr8.example.test',
    callbackUri: 'https://project.example.test/functions/v1/tr8-google/callback',
    clientId: 'synthetic-client',
    configured: true,
    workerSecret: 's'.repeat(43),
    authenticate: vi.fn(async () => {
      throw new Error('Worker must never use a user JWT');
    }),
    rpc,
    provider: beforeRequest =>
      new GoogleProvider({
        clientId: 'synthetic-client',
        clientSecret: 'synthetic-secret',
        redirectUri: 'https://project.example.test/functions/v1/tr8-google/callback',
        fetch,
        beforeRequest,
      }),
    encrypt: vi.fn(async () => envelope),
    decrypt: vi.fn(async () => JSON.stringify(state.saved)),
  };
  return { runtime, state, rpc, fetch, run: () => runGoogleWorker(runtime, { now: () => now }) };
}
const outcome = (state: ReturnType<typeof fixture>['state']) => state.results.at(-1);
const renewed = () => json({ access_token: 'renewed-access', expires_in: 3600, token_type: 'Bearer', scope: GOOGLE_CALENDAR_SCOPE });

describe('Durable worker boundaries and recovery', () => {
  it('claims bounded batches and performs scans entirely inside SQL', async () => {
    const { run, rpc, fetch, state } = fixture('reconcile_scan');
    expect(await run()).toEqual({ processed: 1, finished: 1, deferred: 0, timed_out: false });
    expect(rpc.mock.calls.map(([action]) => action)).toEqual(['claim', 'prepare', 'finish']);
    expect(rpc.mock.calls[0][1]).toEqual({ limit: 2 });
    expect(outcome(state)?.outcome).toBe('succeeded');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{ valid: false }, { valid: false, wait: true }])('never finishes an invalid or waiting lease %j', async response => {
    const { run, state, fetch } = fixture();
    state.prepareResults.push(response);
    expect(await run()).toMatchObject({ finished: 0, deferred: 1 });
    expect(state.results).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not treat a stale finish token as confirmation', async () => {
    const { run, state } = fixture('reconcile_scan');
    state.finishAllowed = false;
    expect(await run()).toMatchObject({ finished: 0, deferred: 1 });
  });

  it('leaves a crashed/deadline worker lease for recovery and sends no late request', async () => {
    vi.useFakeTimers();
    try {
      const { runtime, rpc, fetch, state } = fixture();
      let complete: ((value: unknown) => void) | undefined;
      rpc.mockImplementationOnce(
        async () =>
          new Promise(resolve => {
            complete = resolve;
          }),
      );
      const pending = runGoogleWorker(runtime, { now: () => now, deadlineMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await pending).toMatchObject({ finished: 0, timed_out: true });
      complete?.([{ ...job }]);
      await vi.runAllTimersAsync();
      expect(fetch).not.toHaveBeenCalled();
      expect(state.results).toEqual([]);
      expect(rpc).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not perform external work after a connection generation changes', async () => {
    const { run, state, fetch } = fixture('upsert', [json(remote)]);
    state.prepareResults.push(prepared, { ...prepared, generation: 2 });
    expect(await run()).toMatchObject({ finished: 0, deferred: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.results).toEqual([]);
  });

  it.each(['lease_expired', 'access_changed', 'config_pending'])('does not finish or retry a reservation denied by the fence: %s', async reason => {
    const { run, state, fetch } = fixture();
    state.reservations.push({ allowed: false, reason });
    expect(await run()).toMatchObject({ finished: 0, deferred: 1 });
    expect(fetch).not.toHaveBeenCalled();
    expect(state.results).toEqual([]);
  });

  it('defers exhausted budgets without sending any external request', async () => {
    const { run, state, fetch } = fixture();
    state.reservations.push({ allowed: false, reason: 'budget_exhausted' });
    await run();
    expect(outcome(state)).toMatchObject({ outcome: 'retry', retry_after_seconds: 60 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed or oversized claims rather than processing unbounded work', async () => {
    const { run, state, fetch } = fixture();
    state.claimed = [{ ...job }, { ...job }, { ...job }];
    await expect(run()).rejects.toBeInstanceOf(GoogleServiceError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Google credential renewal and fenced writes', () => {
  it('persists a renewed credential before rechecking access and writing', async () => {
    const { run, state, rpc, fetch, runtime } = fixture('upsert', [renewed(), json(remote), json(remote)]);
    state.saved.expiresAt = now;
    await run();
    const actions = rpc.mock.calls.map(([action]) => action);
    expect(actions.indexOf('save_credentials')).toBeGreaterThan(actions.indexOf('reserve_request'));
    expect(actions.slice(actions.indexOf('save_credentials'), actions.indexOf('save_credentials') + 2)).toEqual(['save_credentials', 'prepare']);
    expect(JSON.parse((runtime.encrypt as ReturnType<typeof vi.fn>).mock.calls[0][0])).toMatchObject({
      accessToken: 'renewed-access',
      refreshToken: saved.refreshToken,
    });
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer renewed-access');
    expect(outcome(state)?.outcome).toBe('succeeded');
  });

  it('stops after renewal when saving credentials loses its lease', async () => {
    const { run, state, fetch } = fixture('upsert', [renewed()]);
    state.saved.expiresAt = now;
    state.savedAllowed = false;
    expect(await run()).toMatchObject({ finished: 0, deferred: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.results).toEqual([]);
  });

  it('stops after renewal if access was revoked before the next projection', async () => {
    const { run, state, fetch } = fixture('upsert', [renewed()]);
    state.saved.expiresAt = now;
    state.prepareResults.push(prepared, { valid: false });
    expect(await run()).toMatchObject({ finished: 0, deferred: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.results).toEqual([]);
  });

  it('refreshes once on HTTP 401, then reads and updates within four budgeted requests', async () => {
    const { run, state, rpc, fetch } = fixture('upsert', [json({}, 401), renewed(), json(remote), json(remote)]);
    await run();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(rpc.mock.calls.filter(([action]) => action === 'reserve_request')).toHaveLength(4);
    expect(outcome(state)?.outcome).toBe('succeeded');
  });

  it('pauses on invalid_grant without changing tasks or certifying delivery', async () => {
    const { run, state, fetch } = fixture('upsert', [json({ error: 'invalid_grant' }, 400)]);
    state.saved.expiresAt = now;
    await run();
    expect(outcome(state)?.outcome).toBe('needs_reauthorization');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the newest authorized task projection immediately before an external write', async () => {
    const { run, state, fetch } = fixture('upsert', [json(remote), json(remote)]);
    state.prepareResults.push(prepared, { ...prepared, event: { ...projection, title: 'Título vigente', due_date: '2026-11-01' } });
    await run();
    const body = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(body.summary).toBe('Título vigente');
    expect(body.start).toEqual({ date: '2026-11-01' });
    expect(outcome(state)?.outcome).toBe('succeeded');
  });
});

describe('Secondary calendar provisioning', () => {
  it('reserves calendar_create before its sole POST and records the known calendar ID', async () => {
    const { run, state, rpc, fetch } = fixture('provision', [json({ id: 'created@example.test' })]);
    await run();
    const request = rpc.mock.calls.find(([action]) => action === 'reserve_request');
    expect(request?.[1]).toMatchObject({ purpose: 'calendar_create', job_id: job.job_id, lease_token: job.lease_token });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outcome(state)).toMatchObject({ outcome: 'succeeded', calendar_id: 'created@example.test' });
  });

  it.each([new Error('network secret'), json({}, 503), new Response('invalid-json')])(
    'never retries an unknown calendar creation in the invocation',
    async response => {
      const { run, state, fetch } = fixture('provision', [response]);
      await run();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(outcome(state)).toMatchObject({ outcome: 'unknown', reason: 'provisioning_unknown' });
      expect(JSON.stringify(outcome(state))).not.toContain('network secret');
    },
  );

  it('does not create when the previous invocation already reserved provisioning', async () => {
    const { run, state, fetch } = fixture('provision');
    state.reservations.push({ allowed: false, reason: 'provisioning_unknown' });
    await run();
    expect(fetch).not.toHaveBeenCalled();
    expect(outcome(state)?.outcome).toBe('unknown');
  });

  it('retries only a classified no-effect calendar quota failure, respecting Retry-After', async () => {
    const { run, state, fetch } = fixture('provision', [json({}, 429, { 'retry-after': '180' })]);
    await run();
    expect(outcome(state)).toMatchObject({ outcome: 'retry', retry_after_seconds: 180 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('can retry a lost token renewal before any calendar creation was reserved', async () => {
    const { run, state, fetch, rpc } = fixture('provision', [new Error('token response lost')]);
    state.saved.expiresAt = now;
    await run();
    expect(outcome(state)?.outcome).toBe('retry');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls.some(([action, payload]) => action === 'reserve_request' && payload?.purpose === 'calendar_create')).toBe(false);
  });

  it('does not repeat calendar creation after a 401', async () => {
    const { run, state, fetch } = fixture('provision', [json({}, 401)]);
    await run();
    expect(outcome(state)?.outcome).toBe('needs_reauthorization');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Idempotent event synchronization', () => {
  it('creates a new event using its persisted ID and private ownership markers', async () => {
    const { run, state, fetch } = fixture('upsert', [json({}, 404), json(remote)]);
    await run();
    const body = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(body.id).toBe(id);
    expect(body.extendedProperties.private).toEqual({ tr8_link: link, tr8_generation: '1' });
    expect(outcome(state)?.outcome).toBe('succeeded');
  });

  it('updates an existing owned event conditionally', async () => {
    const { run, state, fetch } = fixture('upsert', [json(remote), json(remote)]);
    await run();
    expect(fetch.mock.calls[1][1]?.method).toBe('PUT');
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('if-match')).toBe(remote.etag);
    expect(outcome(state)?.outcome).toBe('succeeded');
  });

  it.each([
    { ...remote, extendedProperties: undefined },
    { ...remote, extendedProperties: { private: { tr8_link: 'someone-else', tr8_generation: '1' } } },
    { ...remote, extendedProperties: { private: { tr8_link: link, tr8_generation: '2' } } },
    { ...remote, etag: undefined },
  ])('never overwrites an event with foreign markers or no version', async resource => {
    const { run, state, fetch } = fixture('upsert', [json(resource)]);
    await run();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outcome(state)?.outcome).toBe('dead');
  });

  it.each([json({}, 404), json({ ...remote, status: 'cancelled' }), json({ error: { errors: [{ reason: 'deleted' }] } }, 410)])(
    'requires controlled rebuilding after a synchronized event disappears',
    async response => {
      const { run, state, fetch } = fixture('upsert', [response]);
      state.preparation.previously_synced = true;
      await run();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(outcome(state)?.outcome).toBe('remote_missing');
    },
  );

  it('does not reuse a known-deleted ID even if its initial confirmation was lost', async () => {
    const { run, state, fetch } = fixture('upsert', [json({ error: { errors: [{ reason: 'deleted' }] } }, 410)]);
    await run();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outcome(state)?.outcome).toBe('remote_missing');
  });

  it('reconciles a 409 using the same persisted ID before a conditional update', async () => {
    const { run, state, fetch } = fixture('upsert', [json({}, 404), json({}, 409), json(remote), json(remote)]);
    await run();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(String(fetch.mock.calls[2][0])).toContain(`/events/${id}`);
    expect(new Headers(fetch.mock.calls[3][1]?.headers).get('if-match')).toBe(remote.etag);
    expect(outcome(state)?.outcome).toBe('succeeded');
  });

  it('stops after four requests even when a conflict and 401 require more work', async () => {
    const { run, state, fetch } = fixture('upsert', [json({}, 404), json({}, 409), json({}, 401), renewed()]);
    await run();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(outcome(state)?.outcome).toBe('retry');
  });

  it('retries a lost insert with its original ID instead of allocating another', async () => {
    const { run, state, fetch } = fixture('upsert', [json({}, 404), new Error('response lost')]);
    await run();
    expect(outcome(state)?.outcome).toBe('retry');
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).id).toBe(id);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not confirm an insert response that contains an unexpected event ID', async () => {
    const { run, state } = fixture('upsert', [json({}, 404), json({ id: 'anotherid' })]);
    await run();
    expect(outcome(state)?.outcome).toBe('retry');
  });

  it('defers a concurrent remote edit on 412 instead of overwriting it unconditionally', async () => {
    const { run, state, fetch } = fixture('upsert', [json(remote), json({}, 412)]);
    await run();
    expect(outcome(state)?.outcome).toBe('retry');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not send a write if access is revoked after reading the remote event', async () => {
    const { run, state, fetch } = fixture('upsert', [json(remote)]);
    state.prepareResults.push(prepared, { valid: false });
    await run();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.results).toEqual([]);
  });
});

describe('Cleanup and revocation', () => {
  it('deletes only the owned registered event using its current ETag', async () => {
    const { run, state, fetch } = fixture('delete', [json(remote), new Response(null, { status: 204 })]);
    await run();
    expect(fetch.mock.calls[1][1]?.method).toBe('DELETE');
    expect(String(fetch.mock.calls[1][0])).toContain(`/events/${id}`);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('if-match')).toBe(remote.etag);
    expect(outcome(state)?.outcome).toBe('succeeded');
  });

  it.each([json({}, 404), json({ error: { errors: [{ reason: 'deleted' }] } }, 410), json({ id, status: 'cancelled' })])(
    'accepts an already missing/cancelled event without another delete',
    async response => {
      const { run, state, fetch } = fixture('delete', [response]);
      await run();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(outcome(state)?.outcome).toBe('succeeded');
    },
  );

  it('does not delete a foreign event or event changed concurrently after the read', async () => {
    for (const responses of [[json({ ...remote, extendedProperties: undefined })], [json(remote), json({}, 412)]]) {
      const { run, state } = fixture('delete', responses);
      await run();
      expect(outcome(state)?.outcome).not.toBe('succeeded');
    }
  });

  it.each([json({}, 404), json({ error: { errors: [{ reason: 'deleted' }] } }, 410)])(
    'confirms cleanup when the event disappears between GET and DELETE',
    async response => {
      const { run, state, fetch } = fixture('delete', [json(remote), response]);
      await run();
      expect(outcome(state)?.outcome).toBe('succeeded');
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([new Response(null, { status: 200 }), json({ error: 'invalid_token' }, 400), json({ error: 'invalid_grant' }, 400)])(
    'accepts confirmed or already revoked credentials without refreshing',
    async response => {
      const { run, state, fetch } = fixture('revoke', [response]);
      state.saved.expiresAt = now;
      await run();
      expect(outcome(state)?.outcome).toBe('succeeded');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toBe('https://oauth2.googleapis.com/revoke');
      expect(new URLSearchParams(String(fetch.mock.calls[0][1]?.body)).get('token')).toBe(saved.refreshToken);
    },
  );

  it('retries an unknown revocation safely without declaring credentials revoked', async () => {
    const { run, state, fetch } = fixture('revoke', [new Error('unknown result')]);
    await run();
    expect(outcome(state)?.outcome).toBe('retry');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Internal worker HTTP authentication', () => {
  const request = (headers: HeadersInit = {}, body = '{}', method = 'POST') =>
    new Request('https://project.example.test/functions/v1/tr8-google-worker', {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body }),
    });

  it.each([{}, { authorization: 'Bearer public-project-key' }, { 'x-tr8-worker-secret': 'wrong' }])(
    'rejects unauthenticated/public-key dispatch before configuration or SQL',
    async headers => {
      const { runtime, rpc } = fixture('reconcile_scan');
      runtime.configured = false;
      const response = await createGoogleWorkerHandler(runtime)(request(headers as HeadersInit));
      expect(response.status).toBe(401);
      expect(rpc).not.toHaveBeenCalled();
      expect(runtime.authenticate).not.toHaveBeenCalled();
    },
  );

  it('accepts only the internal secret header and returns sanitized counts', async () => {
    const { runtime, state } = fixture('reconcile_scan');
    const response = await createGoogleWorkerHandler(runtime)(request({ 'x-tr8-worker-secret': runtime.workerSecret }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ processed: 1, finished: 1 });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(state.results).toHaveLength(1);
  });

  it('reports missing configuration only after authenticating the worker', async () => {
    const { runtime, rpc } = fixture();
    runtime.configured = false;
    const response = await createGoogleWorkerHandler(runtime)(request({ 'x-tr8-worker-secret': runtime.workerSecret }));
    expect(response.status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('bounds reading an authorized request body before starting work', async () => {
    vi.useFakeTimers();
    try {
      const { runtime, rpc } = fixture();
      const request = new Request('https://project.example.test/functions/v1/tr8-google-worker', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tr8-worker-secret': runtime.workerSecret },
        body: new ReadableStream({
          start() {
            /* Deliberately never sends a byte. */
          },
        }),
        duplex: 'half',
      } as RequestInit);
      const pending = createGoogleWorkerHandler(runtime)(request);
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      await vi.advanceTimersByTimeAsync(2000);
      expect((await pending).status).toBe(400);
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['{"limit":3}', '{"action":"begin"}', '{"user_id":"another-user"}', 'invalid-json', 'x'.repeat(17_000)])(
    'rejects malformed/oversized/unbounded worker input',
    async body => {
      const { runtime, rpc } = fixture();
      const response = await createGoogleWorkerHandler(runtime)(request({ 'x-tr8-worker-secret': runtime.workerSecret }, body));
      expect(response.status).toBe(400);
      expect(rpc).not.toHaveBeenCalled();
      expect(await response.text()).not.toContain('synthetic-secret');
    },
  );
});

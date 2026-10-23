// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_CALENDAR_SCOPE, GoogleProvider } from './google-provider.ts';
import { GoogleTasksProvider, GOOGLE_TASKS_SCOPE } from './google-tasks-provider.ts';
import { GoogleServiceError, type GoogleRuntime } from './google-runtime.ts';
import { type GoogleCredentials } from './google-service.ts';
import { runGoogleTasksWorker } from './google-tasks-worker.ts';

const user = 'b937a95e-0096-415e-a6a6-4731b5b7b13d';
const connection = '280c2236-c15e-4904-9727-2b5730a8e214';
const link = '2724a0e4-ec99-40e0-8a1e-c7f2be37070d';
const jobId = '76a28a9e-8c37-4dc1-a922-d75209d78ced';
const leaseToken = '24070e77-8883-4dc3-9169-a4da1ca85cc1';
const listId = 'VGFza3M6bGlzdC1pZA';
const taskId = 'VGFzazo2NTY0';
const preparedHash = 'a'.repeat(32);
const now = Date.UTC(2026, 9, 23);
const envelope = { v: 1 as const, kid: 'key-v1', iv: 'synthetic-iv', ciphertext: 'encrypted-synthetic-credentials' };
const updatedEnvelope = { ...envelope, ciphertext: 'encrypted-renewed-synthetic-credentials' };
const saved: GoogleCredentials = {
  accessToken: 'synthetic-access',
  refreshToken: 'synthetic-refresh',
  expiresAt: now + 3_600_000,
  scopes: [GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE],
};
const remote = {
  id: taskId,
  title: 'Revisar proyecto',
  status: 'needsAction',
  due: '2026-10-24T00:00:00.000Z',
  etag: '"remote-version-1"',
  updated: '2026-10-23T00:00:00.000Z',
};
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
const renewal = () =>
  json({
    access_token: 'renewed-access',
    refresh_token: 'renewed-refresh',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: `${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_TASKS_SCOPE}`,
  });
type Kind = 'discover' | 'pull' | 'patch' | 'delete';
type FetchStep = Response | Error | (() => Response | Promise<Response>);

function fixture(kind: Kind, responses: FetchStep[] = []) {
  const state = {
    preparation: {
      valid: true,
      kind,
      user_id: user,
      connection_id: connection,
      generation: 1,
      credential_envelope: envelope,
      ...(kind === 'discover' ? { list_id: null } : { list_id: listId }),
      page_token: null,
      ...(kind === 'patch' || kind === 'delete' ? { link: { id: link, remote_task_id: taskId } } : {}),
    } as Record<string, unknown>,
    prepareResults: [] as unknown[],
    credentials: structuredClone(saved),
    saveAllowed: true,
    finishAllowed: true,
    applyListsAllowed: true,
    applyPageAllowed: true,
    reservations: [] as unknown[],
    decision: { action: 'none', valid: true } as Record<string, unknown>,
    finishes: [] as Record<string, unknown>[],
    appliedLists: [] as Record<string, unknown>[],
    appliedPages: [] as Record<string, unknown>[],
    trace: [] as string[],
  };
  const rpc = vi.fn<GoogleRuntime['rpc']>(async (action, payload = {}) => {
    state.trace.push(`rpc:${action}`);
    if (action === 'tasks_claim') return [{ job_id: jobId, lease_token: leaseToken, kind }];
    if (action === 'tasks_prepare') return state.prepareResults.length ? state.prepareResults.shift() : structuredClone(state.preparation);
    if (action === 'tasks_reserve_request') return state.reservations.length ? state.reservations.shift() : { allowed: true };
    if (action === 'tasks_save_credentials') return state.saveAllowed;
    if (action === 'tasks_apply_lists') {
      state.appliedLists.push(payload);
      return { applied: state.applyListsAllowed };
    }
    if (action === 'tasks_apply_page') {
      state.appliedPages.push(payload);
      return { applied: state.applyPageAllowed };
    }
    if (action === 'tasks_compare_remote') return state.decision;
    if (action === 'tasks_finish') {
      // Match the SQL boundary: only a known outbound write can report its
      // remote result, and it must retain the captured local projection hash.
      if (
        payload.outcome === 'succeeded' &&
        Object.hasOwn(payload, 'remote') &&
        (!Object.hasOwn(payload, 'prepared_hash') ||
          (payload.prepared_hash !== null && (typeof payload.prepared_hash !== 'string' || !/^[0-9a-f]{32}$/.test(payload.prepared_hash))))
      ) {
        throw new GoogleServiceError('INVALID_INPUT');
      }
      state.finishes.push(payload);
      return state.finishAllowed;
    }
    throw new Error('Unexpected RPC containing private-database-detail');
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    state.trace.push(`http:${init?.method ?? 'GET'}:${new URL(String(url)).hostname}`);
    const response = responses.shift();
    if (!response) throw new Error('Unexpected HTTP containing private-provider-detail');
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
      throw new Error('A worker cannot authenticate as an end user');
    }),
    rpc,
    provider: beforeRequest =>
      new GoogleProvider({
        clientId: 'synthetic-client',
        clientSecret: 'synthetic-client-secret',
        redirectUri: 'https://project.example.test/functions/v1/tr8-google/callback',
        beforeRequest,
        fetch,
      }),
    tasksProvider: beforeRequest => new GoogleTasksProvider({ beforeRequest, fetch }),
    encrypt: vi.fn(async () => updatedEnvelope),
    decrypt: vi.fn(async () => JSON.stringify(state.credentials)),
  };
  return { state, rpc, fetch, runtime, run: () => runGoogleTasksWorker(runtime, { now: () => now }) };
}

const lastFinish = (state: ReturnType<typeof fixture>['state']) => state.finishes.at(-1);
const reservations = (rpc: ReturnType<typeof fixture>['rpc']) =>
  rpc.mock.calls.filter(([action]) => action === 'tasks_reserve_request').map(([, payload]) => payload?.purpose);

describe('Google Tasks paginated imports', () => {
  it('applies the discovered lists and continuation cursor under the same lease before finishing', async () => {
    const list = { id: listId, title: 'Mis tareas', etag: '"list-version-1"', updated: remote.updated };
    const { state, rpc, fetch, run } = fixture('discover', [json({ items: [list], nextPageToken: 'next-list-page' })]);
    state.preparation.page_token = 'current-list-page';
    expect(await run()).toEqual({ processed: 1, finished: 1, deferred: 0, timed_out: false });
    const request = new URL(String(fetch.mock.calls[0][0]));
    expect(request.hostname).toBe('tasks.googleapis.com');
    expect(request.pathname).toBe('/tasks/v1/users/@me/lists');
    expect(request.searchParams.get('pageToken')).toBe('current-list-page');
    expect(state.appliedLists).toEqual([
      {
        job_id: jobId,
        lease_token: leaseToken,
        items: [{ id: list.id, title: list.title }],
        page_token: 'current-list-page',
        next_page_token: 'next-list-page',
      },
    ]);
    expect(state.trace.indexOf('rpc:tasks_apply_lists')).toBeLessThan(state.trace.indexOf('rpc:tasks_finish'));
    expect(reservations(rpc)).toEqual(['tasks_lists']);
    expect(lastFinish(state)).toMatchObject({ job_id: jobId, lease_token: leaseToken, outcome: 'succeeded' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('imports exactly a bounded page, tombstones and assignment flags without copying unneeded provider data', async () => {
    const items = Array.from({ length: 23 }, (_, index) => ({ ...remote, id: `Task_ID_${index}` }));
    const assigned = {
      ...remote,
      id: 'Task_ID_assigned',
      status: 'completed',
      hidden: true,
      assignmentInfo: { surfaceType: 'DOCUMENT', linkToTask: 'https://private.example.test/doc' },
    };
    const tombstone = { id: 'Task_ID_deleted', deleted: true };
    const { state, rpc, fetch, run } = fixture('pull', [json({ items: [...items, assigned, tombstone], nextPageToken: 'next-task-page' })]);
    state.preparation.page_token = 'current-task-page';
    expect(await run()).toMatchObject({ processed: 1, finished: 1 });
    const request = new URL(String(fetch.mock.calls[0][0]));
    expect(request.pathname).toBe(`/tasks/v1/lists/${listId}/tasks`);
    expect(request.searchParams.get('maxResults')).toBe('25');
    expect(request.searchParams.get('pageToken')).toBe('current-task-page');
    expect(request.searchParams.get('showHidden')).toBe('true');
    expect(request.searchParams.get('showDeleted')).toBe('true');
    expect(request.searchParams.get('showAssigned')).toBe('false');
    expect(state.appliedPages).toHaveLength(1);
    expect(state.appliedPages[0]).toMatchObject({ page_token: 'current-task-page', next_page_token: 'next-task-page' });
    const applied = state.appliedPages[0].items as Record<string, unknown>[];
    expect(applied).toHaveLength(25);
    expect(applied[0]).toEqual({
      id: 'Task_ID_0',
      deleted: false,
      etag: remote.etag,
      title: remote.title,
      completed: false,
      start_date: '2026-10-24',
      assigned: false,
    });
    expect(applied[23]).toMatchObject({ id: assigned.id, completed: true, assigned: true });
    expect(applied[24]).toEqual(tombstone);
    expect(JSON.stringify(applied)).not.toContain('private.example.test');
    expect(reservations(rpc)).toEqual(['tasks_list']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not certify a page after its lease has lost the right to apply it', async () => {
    const { state, run, fetch } = fixture('pull', [json({ items: [remote] })]);
    state.applyPageAllowed = false;
    expect(await run()).toEqual({ processed: 1, finished: 0, deferred: 1, timed_out: false });
    expect(state.appliedPages).toHaveLength(1);
    expect(state.finishes).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Google Tasks capability and renewal fences', () => {
  it('requires Tasks reauthorization for a legacy envelope and never sends Tasks HTTP', async () => {
    const { state, run, fetch, rpc } = fixture('pull');
    delete state.credentials.scopes;
    expect(await run()).toMatchObject({ finished: 1 });
    expect(lastFinish(state)).toMatchObject({ outcome: 'needs_reauthorization', reason: 'reauthorization_required' });
    expect(reservations(rpc)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.appliedPages).toEqual([]);
  });

  it('commits rotated credentials under the lease before the first Tasks request', async () => {
    const { state, run, fetch, rpc, runtime } = fixture('pull', [renewal(), json({ items: [remote] })]);
    state.credentials.expiresAt = now;
    expect(await run()).toMatchObject({ finished: 1 });
    const encrypted = JSON.parse((runtime.encrypt as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(encrypted).toEqual({
      accessToken: 'renewed-access',
      refreshToken: 'renewed-refresh',
      expiresAt: now + 3_600_000,
      scopes: saved.scopes,
    });
    expect(rpc.mock.calls.find(([action]) => action === 'tasks_save_credentials')?.[1]).toEqual({
      job_id: jobId,
      lease_token: leaseToken,
      credential_envelope: updatedEnvelope,
    });
    expect(state.trace.indexOf('rpc:tasks_save_credentials')).toBeLessThan(state.trace.indexOf('http:GET:tasks.googleapis.com'));
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer renewed-access');
    expect(reservations(rpc)).toEqual(['refresh', 'tasks_list']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops after refresh if persisting the credentials loses the lease', async () => {
    const { state, run, fetch } = fixture('pull', [renewal()]);
    state.credentials.expiresAt = now;
    state.saveAllowed = false;
    expect(await run()).toEqual({ processed: 1, finished: 0, deferred: 1, timed_out: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetch.mock.calls[0][0])).hostname).toBe('oauth2.googleapis.com');
    expect(state.finishes).toEqual([]);
    expect(state.appliedPages).toEqual([]);
  });
});

describe('Google Tasks conditional updates and deletion', () => {
  it('reads, compares and patches the same task with the exact remote ETag and records the returned version', async () => {
    const written = { ...remote, title: 'Proyecto revisado', status: 'completed', due: '2026-10-25T00:00:00.000Z', etag: '"remote-version-2"' };
    const { state, rpc, fetch, run } = fixture('patch', [json(remote), json(written)]);
    state.decision = {
      action: 'patch',
      valid: true,
      etag: remote.etag,
      prepared_hash: preparedHash,
      patch: { title: written.title, status: written.status, due: '2026-10-25' },
    };
    expect(await run()).toMatchObject({ finished: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetch.mock.calls[0][0])).pathname).toBe(`/tasks/v1/lists/${listId}/tasks/${taskId}`);
    expect(new URL(String(fetch.mock.calls[1][0])).pathname).toBe(new URL(String(fetch.mock.calls[0][0])).pathname);
    expect(fetch.mock.calls[1][1]?.method).toBe('PATCH');
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('if-match')).toBe(remote.etag);
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ title: written.title, status: 'completed', due: written.due });
    expect(rpc.mock.calls.find(([action]) => action === 'tasks_compare_remote')?.[1]).toMatchObject({
      remote: { id: taskId, completed: false, start_date: '2026-10-24' },
    });
    expect(lastFinish(state)).toMatchObject({
      outcome: 'succeeded',
      prepared_hash: preparedHash,
      remote: { id: taskId, title: written.title, completed: true, etag: written.etag, start_date: '2026-10-25' },
    });
    expect(reservations(rpc)).toEqual(['tasks_get', 'tasks_patch']);
  });

  it.each(['none', 'conflict'])('finishes an already observed %s without overwriting SQL state or inventing a write result', async action => {
    const { state, run, fetch } = fixture('patch', [json(remote)]);
    state.decision = { action, valid: true, link_id: link };
    expect(await run()).toMatchObject({ finished: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.method).toBe('GET');
    expect(lastFinish(state)).toEqual({ job_id: jobId, lease_token: leaseToken, outcome: 'succeeded' });
    expect(lastFinish(state)).not.toHaveProperty('remote');
    expect(lastFinish(state)).not.toHaveProperty('prepared_hash');
  });

  it('deletes only the linked task and preserves the null projection hash of the locally deleted task', async () => {
    const { state, rpc, run, fetch } = fixture('delete', [json(remote), new Response(null, { status: 204 })]);
    state.decision = { action: 'delete', valid: true, etag: remote.etag, prepared_hash: null };
    expect(await run()).toMatchObject({ finished: 1 });
    expect(fetch.mock.calls.map(([url, init]) => ({ path: new URL(String(url)).pathname, method: init?.method }))).toEqual([
      { path: `/tasks/v1/lists/${listId}/tasks/${taskId}`, method: 'GET' },
      { path: `/tasks/v1/lists/${listId}/tasks/${taskId}`, method: 'DELETE' },
    ]);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get('if-match')).toBe(remote.etag);
    expect(lastFinish(state)).toEqual({
      job_id: jobId,
      lease_token: leaseToken,
      outcome: 'succeeded',
      remote: { id: taskId, deleted: true },
      prepared_hash: null,
    });
    expect(reservations(rpc)).toEqual(['tasks_get', 'tasks_delete']);
  });

  it('retries an HTTP 412 without certifying the local change or making another write', async () => {
    const { state, run, fetch } = fixture('patch', [json(remote), json({ error: { message: 'private-provider-detail' } }, 412)]);
    state.decision = {
      action: 'patch',
      valid: true,
      etag: remote.etag,
      prepared_hash: preparedHash,
      patch: { title: remote.title, status: 'completed', due: '2026-10-24' },
    };
    expect(await run()).toMatchObject({ finished: 1 });
    expect(lastFinish(state)).toMatchObject({ outcome: 'retry', reason: 'temporary_failure' });
    expect(lastFinish(state)).not.toHaveProperty('remote');
    expect(JSON.stringify(state.finishes)).not.toContain('private-provider-detail');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never mutates an assigned task even if a compromised decision requests a patch', async () => {
    const { state, run, fetch } = fixture('patch', [json({ ...remote, assignmentInfo: { surfaceType: 'DOCUMENT' } })]);
    state.decision = {
      action: 'patch',
      valid: true,
      etag: remote.etag,
      prepared_hash: preparedHash,
      patch: { title: remote.title, status: 'completed', due: '2026-10-24' },
    };
    await run();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lastFinish(state)).toMatchObject({ outcome: 'dead' });
  });

  it('stops rather than applying a comparison result to a different destination returned by a later preparation', async () => {
    const { state, run, fetch } = fixture('patch', [json(remote)]);
    state.decision = {
      action: 'patch',
      valid: true,
      etag: remote.etag,
      prepared_hash: preparedHash,
      patch: { title: remote.title, status: 'completed', due: '2026-10-24' },
    };
    state.prepareResults.push(structuredClone(state.preparation), {
      ...structuredClone(state.preparation),
      link: { id: link, remote_task_id: 'Another_Task_ID' },
    });
    expect(await run()).toEqual({ processed: 1, finished: 0, deferred: 1, timed_out: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(state.finishes).toEqual([]);
  });

  it('confirms an already missing remote task without another deletion and keeps the null local hash', async () => {
    const { state, run, fetch } = fixture('delete', [json({}, 404)]);
    state.decision = { action: 'delete', valid: true, prepared_hash: null };
    expect(await run()).toMatchObject({ finished: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lastFinish(state)).toEqual({
      job_id: jobId,
      lease_token: leaseToken,
      outcome: 'succeeded',
      remote: { id: taskId, deleted: true },
      prepared_hash: null,
    });
  });

  it('rejects a PATCH response for another task without certifying its revision as a successful write', async () => {
    const { state, run, fetch } = fixture('patch', [json(remote), json({ ...remote, id: 'Another_Task_ID', etag: '"other-version"' })]);
    state.decision = {
      action: 'patch',
      valid: true,
      etag: remote.etag,
      prepared_hash: preparedHash,
      patch: { title: remote.title, status: 'completed', due: '2026-10-24' },
    };
    expect(await run()).toMatchObject({ finished: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(lastFinish(state)).toMatchObject({ outcome: 'retry' });
    expect(lastFinish(state)).not.toHaveProperty('remote');
    expect(lastFinish(state)).not.toHaveProperty('prepared_hash');
  });
});

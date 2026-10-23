// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GoogleProviderError } from './google-provider';
import { GOOGLE_TASKS_SCOPE, GoogleTasksProvider, type GoogleTasksOperation, type GoogleTasksPatch } from './google-tasks-provider';

const remote = {
  id: 'Q29tcGxldGU6dGFzay1pZA',
  title: 'Preparar la semana',
  status: 'needsAction',
  due: '2026-10-24T00:00:00.000Z',
  etag: '"task-version-1"',
  updated: '2026-10-23T12:30:00.000Z',
};
const remoteList = { id: 'VGFza0xpc3Q6MQ', title: 'Mis tareas', etag: '"list-version-1"', updated: remote.updated };
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });

function adapter(responses: Response[] = []) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Network failed with synthetic-provider-secret');
    return response;
  });
  const beforeRequest = vi.fn<(operation: GoogleTasksOperation) => Promise<boolean>>(async () => true);
  return { provider: new GoogleTasksProvider({ fetch, beforeRequest, now: () => Date.UTC(2026, 9, 23) }), fetch, beforeRequest };
}

describe('Google Tasks read protocol', () => {
  it('uses the dedicated Tasks scope and discovers lists without exposing tokens in URLs', async () => {
    const { provider, fetch, beforeRequest } = adapter([json({ items: [remoteList], nextPageToken: 'next +/&=' })]);
    const result = await provider.listTaskLists('synthetic-access-token', 'first +/&=');
    expect(GOOGLE_TASKS_SCOPE).toBe('https://www.googleapis.com/auth/tasks');
    expect(result).toEqual({ items: [remoteList], nextPageToken: 'next +/&=' });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.origin).toBe('https://tasks.googleapis.com');
    expect(url.pathname).toBe('/tasks/v1/users/@me/lists');
    expect(url.searchParams.get('maxResults')).toBe('25');
    expect(url.searchParams.get('pageToken')).toBe('first +/&=');
    expect(url.searchParams.get('fields')).toBe('nextPageToken,items(id,title,etag,updated)');
    expect(url.href).not.toContain('synthetic-access-token');
    expect(fetch.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer synthetic-access-token' });
    expect(beforeRequest).toHaveBeenCalledExactlyOnceWith('tasks.lists.list');
  });

  it('keeps the cursor fixed and includes completed, hidden and deleted tasks in each page', async () => {
    const { provider, fetch, beforeRequest } = adapter([json({ items: [remote], nextPageToken: 'next-page' }), json({ items: [] })]);
    const updatedMin = '2026-10-23T00:00:00.000Z';
    const first = await provider.listTasks('access', remoteList.id, { updatedMin });
    await provider.listTasks('access', remoteList.id, { updatedMin, pageToken: first.nextPageToken });
    for (const [index, call] of fetch.mock.calls.entries()) {
      const url = new URL(String(call[0]));
      expect(url.pathname).toBe(`/tasks/v1/lists/${remoteList.id}/tasks`);
      expect(url.searchParams.get('maxResults')).toBe('25');
      expect(url.searchParams.get('updatedMin')).toBe(updatedMin);
      expect(url.searchParams.get('showCompleted')).toBe('true');
      expect(url.searchParams.get('showHidden')).toBe('true');
      expect(url.searchParams.get('showDeleted')).toBe('true');
      expect(url.searchParams.get('showAssigned')).toBe('false');
      expect(url.searchParams.get('pageToken')).toBe(index === 0 ? null : 'next-page');
      expect(url.searchParams.get('fields')).not.toContain('notes');
      expect(url.searchParams.has('syncToken')).toBe(false);
    }
    expect(first.items).toEqual([{ ...remote, deleted: false, due: '2026-10-24', assigned: false }]);
    expect(beforeRequest.mock.calls.map(([operation]) => operation)).toEqual(['tasks.list', 'tasks.list']);
  });

  it('accepts empty collections when Google omits items', async () => {
    const { provider } = adapter([json({ kind: 'tasks#taskLists' }), json({ kind: 'tasks#tasks' })]);
    expect(await provider.listTaskLists('access')).toEqual({ items: [] });
    expect(await provider.listTasks('access', remoteList.id)).toEqual({ items: [] });
  });

  it('encodes opaque IDs rather than applying the Calendar base32 identifier restriction', async () => {
    const id = 'Opaque_Task+ID/with?query#fragment&x=1';
    const list = 'Opaque_List+ID/with?query#fragment&x=2';
    const { provider, fetch } = adapter([json({ ...remote, id })]);
    expect((await provider.getTask('access', list, id)).id).toBe(id);
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.origin).toBe('https://tasks.googleapis.com');
    expect(url.pathname).toBe(`/tasks/v1/lists/${encodeURIComponent(list)}/tasks/${encodeURIComponent(id)}`);
    expect(url.searchParams.has('query')).toBe(false);
    expect(url.hash).toBe('');
  });

  it('uses the civil day provided by Google, including a date that crosses UTC', async () => {
    const { provider } = adapter([json({ ...remote, due: '2026-01-01T00:15:00+14:00' })]);
    expect(await provider.getTask('access', remoteList.id, remote.id)).toMatchObject({ due: '2026-01-01' });
  });

  it('normalizes an absent date without inventing a time block', async () => {
    const undated: Record<string, unknown> = { ...remote };
    delete undated.due;
    const { provider } = adapter([json(undated)]);
    expect(await provider.getTask('access', remoteList.id, remote.id)).toEqual({ ...undated, due: null, deleted: false, assigned: false });
  });

  it('keeps completion, parent and hidden state and exposes the assigned-task restriction to the worker', async () => {
    const { provider } = adapter([
      json({
        ...remote,
        status: 'completed',
        completed: '2026-10-23T12:00:00Z',
        hidden: true,
        parent: 'Parent_Task+ID',
        assignmentInfo: { surfaceType: 'DOCUMENT' },
      }),
    ]);
    expect(await provider.getTask('access', remoteList.id, remote.id)).toMatchObject({
      status: 'completed',
      completed: '2026-10-23T12:00:00.000Z',
      hidden: true,
      parent: 'Parent_Task+ID',
      assigned: true,
      deleted: false,
    });
  });

  it('accepts deletion tombstones with only an ID and never recreates their missing fields', async () => {
    const { provider } = adapter([json({ items: [{ id: remote.id, deleted: true }] })]);
    expect(await provider.listTasks('access', remoteList.id)).toEqual({ items: [{ id: remote.id, deleted: true }] });
  });

  it.each([
    { ...remote, id: '' },
    { ...remote, id: 'bad\nidentifier' },
    { ...remote, title: 'x'.repeat(1025) },
    { ...remote, status: 'done' },
    { ...remote, etag: undefined },
    { ...remote, updated: '2026-02-30T00:00:00Z' },
    { ...remote, due: '2026-02-29T00:00:00Z' },
    { ...remote, due: 'not-a-date' },
    { ...remote, hidden: 'false' },
    { ...remote, assignmentInfo: 'unexpected' },
  ])('rejects malformed active resources without exposing the body %#', async body => {
    const { provider } = adapter([json(body)]);
    await expect(provider.getTask('access', remoteList.id, remote.id)).rejects.toMatchObject({ kind: 'unknown', reason: 'invalid_response' });
  });
});

describe('Google Tasks conditional mutations', () => {
  it('patches only the chosen fields and preserves a civil date as UTC midnight on the wire', async () => {
    const { provider, fetch, beforeRequest } = adapter([json(remote)]);
    await provider.patchTask('access', remoteList.id, remote.id, { title: 'Revisar proyecto', due: '2026-10-25' }, remote.etag);
    expect(fetch.mock.calls[0][1]?.method).toBe('PATCH');
    expect(fetch.mock.calls[0][1]?.headers).toEqual({
      Authorization: 'Bearer access',
      'Content-Type': 'application/json',
      'If-Match': remote.etag,
    });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ title: 'Revisar proyecto', due: '2026-10-25T00:00:00.000Z' });
    expect(beforeRequest).toHaveBeenCalledExactlyOnceWith('tasks.patch');
  });

  it('completes and reopens the same resource, clearing optional fields with null', async () => {
    const { provider, fetch } = adapter([json({ ...remote, status: 'completed' }), json(remote)]);
    await provider.patchTask('access', remoteList.id, remote.id, { status: 'completed' }, remote.etag);
    await provider.patchTask('access', remoteList.id, remote.id, { status: 'needsAction', completed: null, due: null }, '"task-version-2"');
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ status: 'completed' });
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ status: 'needsAction', completed: null, due: null });
    expect(new URL(String(fetch.mock.calls[0][0])).pathname).toBe(new URL(String(fetch.mock.calls[1][0])).pathname);
  });

  it('deletes only the requested resource with an exact precondition and accepts an empty success', async () => {
    const { provider, fetch, beforeRequest } = adapter([new Response(null, { status: 204 })]);
    await provider.deleteTask('access', remoteList.id, remote.id, remote.etag);
    expect(fetch.mock.calls[0][0]).toBe(`https://tasks.googleapis.com/tasks/v1/lists/${remoteList.id}/tasks/${remote.id}`);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'DELETE', headers: { 'If-Match': remote.etag }, redirect: 'manual' });
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
    expect(beforeRequest).toHaveBeenCalledExactlyOnceWith('tasks.delete');
  });

  it.each(['', '*', ' * ', 'bad\netag', 'e'.repeat(513)])('rejects an absent, wildcard or unsafe ETag before reserving %s', async etag => {
    const { provider, fetch, beforeRequest } = adapter();
    await expect(provider.patchTask('access', remoteList.id, remote.id, { status: 'completed' }, etag)).rejects.toBeInstanceOf(GoogleProviderError);
    await expect(provider.deleteTask('access', remoteList.id, remote.id, etag)).rejects.toBeInstanceOf(GoogleProviderError);
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { notes: 'Do not accidentally overwrite notes' },
    { id: 'another-task', status: 'completed' },
    { deleted: true },
    { title: undefined },
    { title: 'x'.repeat(1025) },
    { due: '2026-02-30' },
    { due: '2026-10-24T00:00:00Z' },
    { completed: 'not-a-date' },
    { status: 'done' },
  ])('rejects unsupported or malformed patches before reserving %#', async patch => {
    const { provider, beforeRequest, fetch } = adapter();
    await expect(provider.patchTask('access', remoteList.id, remote.id, patch as GoogleTasksPatch, remote.etag)).rejects.toMatchObject({
      reason: 'invalid_resource',
    });
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Google Tasks budget, boundaries and failures', () => {
  it('reserves each list, read, mutation and delete exactly once without refresh or retries', async () => {
    const { provider, fetch, beforeRequest } = adapter([
      json({ items: [remoteList] }),
      json({ items: [remote] }),
      json(remote),
      json(remote),
      new Response(null, { status: 204 }),
    ]);
    await provider.listTaskLists('access');
    await provider.listTasks('access', remoteList.id);
    await provider.getTask('access', remoteList.id, remote.id);
    await provider.patchTask('access', remoteList.id, remote.id, { status: 'completed' }, remote.etag);
    await provider.deleteTask('access', remoteList.id, remote.id, remote.etag);
    expect(beforeRequest.mock.calls.map(([operation]) => operation)).toEqual(['tasks.lists.list', 'tasks.list', 'tasks.get', 'tasks.patch', 'tasks.delete']);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('does not send if budget is exhausted or the durable reservation fails', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const beforeRequest of [
      async () => false,
      async () => {
        throw new Error('private-database-detail');
      },
    ]) {
      const provider = new GoogleTasksProvider({ fetch, beforeRequest });
      const error = await provider.getTask('access', remoteList.id, remote.id).catch(value => value);
      expect(error).toMatchObject({ kind: 'retryable', retryAfterSeconds: 60 });
      expect(String(error)).not.toContain('private-database-detail');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['', ' ', '.', '..', 'bad\u0000id', 'bad\u007fid', 'x'.repeat(1025)])('rejects unsafe IDs without reserving %#', async id => {
    const { provider, beforeRequest, fetch } = adapter();
    await expect(provider.getTask('access', id, remote.id)).rejects.toMatchObject({ reason: 'invalid_resource' });
    await expect(provider.getTask('access', remoteList.id, id)).rejects.toMatchObject({ reason: 'invalid_resource' });
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects injected query fields, malformed cursors and invalid dates before reserving', async () => {
    const { provider, beforeRequest } = adapter();
    await expect(provider.listTasks('access', remoteList.id, { updatedMin: 'not-a-date' })).rejects.toMatchObject({ reason: 'invalid_resource' });
    await expect(provider.listTasks('access', remoteList.id, { pageToken: '\n' })).rejects.toMatchObject({ reason: 'invalid_resource' });
    await expect(provider.listTasks('access', remoteList.id, { showAssigned: true } as never)).rejects.toMatchObject({ reason: 'invalid_resource' });
    expect(beforeRequest).not.toHaveBeenCalled();
  });

  it.each([
    [401, {}, 'reauthorization', 'authorization_expired'],
    [403, {}, 'permanent', 'permission_denied'],
    [403, { error: { errors: [{ reason: 'accessNotConfigured' }] } }, 'permanent', 'tasks_api_disabled'],
    [403, { error: { details: [{ reason: 'SERVICE_DISABLED' }] } }, 'permanent', 'tasks_api_disabled'],
    [403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }, 'reauthorization', 'permission_missing'],
    [403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 'retryable', 'rate_limited'],
    [404, {}, 'missing', 'not_found'],
    [410, { error: { errors: [{ reason: 'deleted' }] } }, 'missing', 'deleted'],
    [412, {}, 'conflict', 'precondition_failed'],
    [429, {}, 'retryable', 'rate_limited'],
    [503, {}, 'retryable', 'provider_unavailable'],
    [400, {}, 'permanent', 'request_rejected'],
  ])('classifies HTTP %s with sanitized actionable errors', async (status, body, kind, reason) => {
    const { provider, fetch } = adapter([json({ ...(body as object), message: 'private-provider-response' }, status as number)]);
    const error = await provider.getTask('access', remoteList.id, remote.id).catch(value => value);
    expect(error).toMatchObject({ kind, reason, httpStatus: status });
    expect(String(error)).not.toContain('private-provider-response');
    expect(error).not.toHaveProperty('cause');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['120', 120],
    ['Fri, 23 Oct 2026 00:03:00 GMT', 180],
  ])('honors Retry-After %s without waiting or replaying inside the adapter', async (header, seconds) => {
    const { provider, fetch } = adapter([json({}, 429, { 'Retry-After': String(header) })]);
    await expect(provider.getTask('access', remoteList.id, remote.id)).rejects.toMatchObject({ retryAfterSeconds: seconds });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects redirection without forwarding the credential', async () => {
    const { provider, fetch } = adapter([new Response(null, { status: 307, headers: { Location: 'https://attacker.test/' } })]);
    await expect(provider.getTask('access', remoteList.id, remote.id)).rejects.toMatchObject({ reason: 'redirect_rejected' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it('bounds response bytes and rejects malformed JSON and overflowing pages', async () => {
    for (const response of [new Response('x'.repeat(65_537)), new Response('not-json'), json({ items: Array.from({ length: 26 }, () => remote) })]) {
      const { provider } = adapter([response]);
      await expect(provider.listTasks('access', remoteList.id)).rejects.toMatchObject({ kind: 'unknown', reason: 'invalid_response' });
    }
  });

  it('sanitizes an uncertain transport outcome and never replays a patch', async () => {
    const { provider, fetch } = adapter();
    const error = await provider.patchTask('access', remoteList.id, remote.id, { status: 'completed' }, remote.etag).catch(value => value);
    expect(error).toMatchObject({ kind: 'unknown', reason: 'request_unknown' });
    expect(String(error)).not.toContain('synthetic-provider-secret');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('caps the request timeout at seven seconds and aborts without hidden retries', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        await new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('private-timeout-detail')), { once: true }));
        return json(remote);
      });
      const beforeRequest = vi.fn(async () => true);
      const provider = new GoogleTasksProvider({ fetch, beforeRequest, timeoutMs: 60_000 });
      const result = expect(provider.getTask('access', remoteList.id, remote.id)).rejects.toMatchObject({ kind: 'unknown', reason: 'request_unknown' });
      await vi.advanceTimersByTimeAsync(6999);
      expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(beforeRequest).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

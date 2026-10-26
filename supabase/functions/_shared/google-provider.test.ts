// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  beginAuthURL,
  buildGoogleEvent,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_TASKS_SCOPE,
  GoogleProvider,
  GoogleProviderError,
  nextCivilDate,
  type GoogleEventWrite,
  type GoogleEventPatch,
  type GoogleOperation,
  type GoogleTaskProjection,
} from './google-provider';

const credentials = {
  clientId: 'synthetic-client.apps.googleusercontent.com',
  clientSecret: 'synthetic-client-secret',
  redirectUri: 'https://tr8.example.test/api/google/callback',
};
const task: GoogleTaskProjection = {
  id: '5f7e824b-c408-49fb-88db-b58bb936f407',
  project_id: '248f9d20-4f43-41c4-a7f2-2eea141c5814',
  title: 'Preparar proyecto',
  project_title: 'Mi proyecto',
  status: 'todo',
  due_date: '2026-03-08',
};
const write: GoogleEventWrite = { ...buildGoogleEvent(task, 'https://tr8.example.test')!, id: '29fa777081cb41fa85b69814fe83bdef' };
const tokenResponse = {
  access_token: 'synthetic-access-token',
  refresh_token: 'synthetic-refresh-token',
  expires_in: 3600,
  token_type: 'Bearer',
  scope: GOOGLE_CALENDAR_SCOPE,
};
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
const incoming = {
  id: write.id,
  status: 'confirmed',
  etag: '"remote-version"',
  summary: 'Evento de Google',
  start: { date: '2026-10-24' },
  end: { date: '2026-10-25' },
  updated: '2026-10-23T12:34:56.123Z',
};

function adapter(responses: Response[] = []) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected request with synthetic-secret');
    return response;
  });
  const beforeRequest = vi.fn<(operation: GoogleOperation) => Promise<boolean>>(async () => true);
  return { provider: new GoogleProvider({ ...credentials, fetch, beforeRequest, now: () => Date.UTC(2026, 9, 23) }), fetch, beforeRequest };
}

describe('Google OAuth protocol', () => {
  it('requests exactly the agreed scope, offline access and S256 without the secret', () => {
    const url = new URL(beginAuthURL({ ...credentials, state: 's'.repeat(43), challenge: 'c'.repeat(43) }));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_CALENDAR_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent select_account');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.href).not.toContain(credentials.clientSecret);
  });

  it('exchanges codes with the verifier in the POST body and never in the URL', async () => {
    const { provider, fetch, beforeRequest } = adapter([json(tokenResponse)]);
    const result = await provider.exchange('synthetic-auth-code', 'v'.repeat(43));
    expect(result).toEqual({
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresIn: 3600,
      scopes: [GOOGLE_CALENDAR_SCOPE],
    });
    expect(fetch.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
    const init = fetch.mock.calls[0][1]!;
    expect(new URLSearchParams(String(init.body)).get('code_verifier')).toBe('v'.repeat(43));
    expect(new URLSearchParams(String(init.body)).get('client_secret')).toBe(credentials.clientSecret);
    expect(init.redirect).toBe('manual');
    expect(beforeRequest).toHaveBeenCalledExactlyOnceWith('oauth.exchange');
  });

  it('does not invent or clear a refresh token omitted on renewal', async () => {
    const { provider, fetch } = adapter([json({ access_token: 'new-access', expires_in: 3600, token_type: 'Bearer' })]);
    const result = await provider.refresh('existing-refresh');
    expect(result).not.toHaveProperty('refreshToken');
    expect(result.scopes).toEqual([GOOGLE_CALENDAR_SCOPE]);
    expect(new URLSearchParams(String(fetch.mock.calls[0][1]!.body)).get('refresh_token')).toBe('existing-refresh');
  });

  it.each(['https://www.googleapis.com/auth/calendar.readonly', '', 'openid'])('rejects a missing/partial grant %s', async scope => {
    const { provider } = adapter([json({ ...tokenResponse, scope })]);
    await expect(provider.exchange('code', 'v'.repeat(43))).rejects.toMatchObject({ kind: 'reauthorization', reason: 'permission_missing' });
  });

  it('rejects broader permissions instead of silently retaining an old combined grant', async () => {
    const { provider } = adapter([json({ ...tokenResponse, scope: `${GOOGLE_CALENDAR_SCOPE} https://www.googleapis.com/auth/calendar` })]);
    await expect(provider.exchange('code', 'v'.repeat(43))).rejects.toMatchObject({ reason: 'unexpected_permissions' });
  });

  it('revokes using a POST form and accepts the provider empty response', async () => {
    const { provider, fetch, beforeRequest } = adapter([new Response(null, { status: 200 })]);
    await provider.revoke('synthetic-refresh-token');
    expect(fetch.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/revoke');
    expect(new URLSearchParams(String(fetch.mock.calls[0][1]!.body)).get('token')).toBe('synthetic-refresh-token');
    expect(beforeRequest).toHaveBeenCalledExactlyOnceWith('oauth.revoke');
  });

  it.each([
    'http://example.com/callback',
    'https://user:pass@example.com/callback',
    'https://example.com/callback?to=evil',
    'https://example.com/callback#fragment',
  ])('rejects unsafe callback configuration %s', redirectUri => {
    expect(() => new GoogleProvider({ ...credentials, redirectUri, beforeRequest: async () => true })).toThrow(GoogleProviderError);
  });
});

describe('Optional Google Tasks OAuth grant', () => {
  it('requests exactly Calendar plus Tasks when the durable attempt enables Tasks', () => {
    const url = new URL(beginAuthURL({ ...credentials, state: 's'.repeat(43), challenge: 'c'.repeat(43), includeTasks: true }));
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE]);
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.href).not.toContain(credentials.clientSecret);
  });

  it.each([`${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_TASKS_SCOPE}`, `${GOOGLE_TASKS_SCOPE} ${GOOGLE_CALENDAR_SCOPE}`])(
    'accepts both verified permissions without depending on their order: %s',
    async scope => {
      const { provider, beforeRequest, fetch } = adapter([json({ ...tokenResponse, scope })]);
      const result = await provider.exchange('synthetic-code', 'v'.repeat(43), true);
      expect(new Set(result.scopes)).toEqual(new Set([GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE]));
      expect(result.refreshToken).toBe(tokenResponse.refresh_token);
      expect(beforeRequest).toHaveBeenCalledExactlyOnceWith('oauth.exchange');
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE, ''])('rejects an incomplete requested combined grant: %s', async scope => {
    const { provider } = adapter([json({ ...tokenResponse, scope })]);
    await expect(provider.exchange('synthetic-code', 'v'.repeat(43), true)).rejects.toMatchObject({ kind: 'reauthorization', reason: 'permission_missing' });
  });

  it.each(['openid', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/tasks.readonly'])(
    'rejects permissions beyond the two declared scopes: %s',
    async additional => {
      const { provider } = adapter([json({ ...tokenResponse, scope: `${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_TASKS_SCOPE} ${additional}` })]);
      await expect(provider.exchange('synthetic-code', 'v'.repeat(43), true)).rejects.toMatchObject({ kind: 'permanent', reason: 'unexpected_permissions' });
    },
  );

  it('returns both explicitly renewed permissions and a rotated token through one budgeted refresh', async () => {
    const { provider, fetch, beforeRequest } = adapter([
      json({ ...tokenResponse, access_token: 'renewed-access', refresh_token: 'renewed-refresh', scope: `${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_TASKS_SCOPE}` }),
    ]);
    expect(await provider.refresh('previous-refresh', true)).toEqual({
      accessToken: 'renewed-access',
      refreshToken: 'renewed-refresh',
      expiresIn: 3600,
      scopes: [GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE],
    });
    expect(new URLSearchParams(String(fetch.mock.calls[0][1]?.body)).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(String(fetch.mock.calls[0][1]?.body)).get('refresh_token')).toBe('previous-refresh');
    expect(beforeRequest).toHaveBeenCalledExactlyOnceWith('oauth.refresh');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('requires reauthorization if an explicit refresh result no longer contains Tasks', async () => {
    const { provider, fetch } = adapter([json(tokenResponse)]);
    await expect(provider.refresh('previous-refresh', true)).rejects.toMatchObject({ kind: 'reauthorization', reason: 'permission_missing' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Budget, network and error handling', () => {
  it.each(['.', '..'])('rejects dot calendar segments before URL normalization: %s', async id => {
    const { provider, fetch, beforeRequest } = adapter([json({ id })]);
    await expect(provider.getCalendar('access', id)).rejects.toMatchObject({ reason: 'invalid_resource' });
    expect(fetch).not.toHaveBeenCalled();
    expect(beforeRequest).not.toHaveBeenCalled();
  });
  it.each([undefined, '*', ' * ', '"one", "two"'])('requires one concrete version for Calendar writes: %s', async etag => {
    const { provider, fetch, beforeRequest } = adapter([json({ id: write.id }), json({ id: write.id }), new Response(null, { status: 204 })]);
    await expect(provider.updateEvent('access', 'calendar@example.test', write, etag as string)).rejects.toMatchObject({ reason: 'invalid_resource' });
    await expect(provider.patchEvent('access', 'calendar@example.test', write, etag as string)).rejects.toMatchObject({ reason: 'invalid_resource' });
    await expect(provider.deleteEvent('access', 'calendar@example.test', write.id, etag as string)).rejects.toMatchObject({ reason: 'invalid_resource' });
    expect(fetch).not.toHaveBeenCalled();
    expect(beforeRequest).not.toHaveBeenCalled();
  });
  it('reserves every external request including OAuth, reconciliation reads and deletion', async () => {
    const { provider, beforeRequest, fetch } = adapter([
      json(tokenResponse),
      json({ id: 'calendar@example.test' }),
      json({ id: write.id }),
      json({ id: write.id }),
      json({ id: write.id }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 200 }),
    ]);
    await provider.refresh('refresh');
    await provider.getCalendar('access', 'calendar@example.test');
    await provider.getEvent('access', 'calendar@example.test', write.id);
    await provider.insertEvent('access', 'calendar@example.test', write);
    await provider.updateEvent('access', 'calendar@example.test', write, '"current-version"');
    await provider.deleteEvent('access', 'calendar@example.test', write.id, '"current-version"');
    await provider.revoke('refresh');
    expect(beforeRequest.mock.calls.map(([operation]) => operation)).toEqual([
      'oauth.refresh',
      'calendar.get',
      'event.get',
      'event.insert',
      'event.update',
      'event.delete',
      'oauth.revoke',
    ]);
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it('does not send when the durable budget is exhausted or unavailable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const beforeRequest of [
      async () => false,
      async () => {
        throw new Error('database secret');
      },
    ]) {
      const provider = new GoogleProvider({ ...credentials, fetch, beforeRequest });
      const error = await provider.refresh('refresh').catch(value => value);
      expect(error).toMatchObject({ kind: 'retryable', retryAfterSeconds: 60 });
      expect(String(error)).not.toContain('database secret');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [429, {}, 'retryable', 'rate_limited'],
    [403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 'retryable', 'rate_limited'],
    [401, {}, 'reauthorization', 'authorization_expired'],
    [400, { error: 'invalid_grant' }, 'reauthorization', 'authorization_expired'],
    [400, { error: 'invalid_client' }, 'permanent', 'invalid_configuration'],
    [404, {}, 'missing', 'not_found'],
    [409, {}, 'conflict', 'already_exists'],
    [410, { error: { errors: [{ reason: 'deleted' }] } }, 'missing', 'deleted'],
    [410, { error: { errors: [{ reason: 'fullSyncRequired' }] } }, 'permanent', 'request_rejected'],
    [412, {}, 'conflict', 'precondition_failed'],
    [403, {}, 'permanent', 'permission_denied'],
    [400, {}, 'permanent', 'request_rejected'],
    [503, {}, 'retryable', 'provider_unavailable'],
  ])('classifies HTTP %s without leaking provider messages', async (status, body, kind, reason) => {
    const { provider, fetch } = adapter([json({ ...(body as object), message: 'synthetic-access-token' }, status as number)]);
    const error = await provider.getEvent('access', 'calendar@example.test', write.id).catch(value => value);
    expect(error).toMatchObject({ kind, reason, httpStatus: status });
    expect(String(error)).not.toContain('synthetic-access-token');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['120', 120],
    ['Fri, 23 Oct 2026 00:03:00 GMT', 180],
  ])('honors Retry-After %s', async (header, seconds) => {
    const { provider } = adapter([json({}, 429, { 'Retry-After': String(header) })]);
    await expect(provider.refresh('refresh')).rejects.toMatchObject({ retryAfterSeconds: seconds });
  });

  it('does not follow redirects or resend credentials to another host', async () => {
    const { provider, fetch } = adapter([new Response(null, { status: 307, headers: { Location: 'https://attacker.example/' } })]);
    await expect(provider.refresh('refresh')).rejects.toMatchObject({ kind: 'permanent', reason: 'redirect_rejected' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it('marks a lost calendar creation unknown without replaying it', async () => {
    const { provider, fetch } = adapter();
    await expect(provider.insertCalendar('access', 'America/La_Paz')).rejects.toMatchObject({ kind: 'unknown', reason: 'provisioning_unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('marks 503 calendar creation unknown because the provider may have committed', async () => {
    const { provider, fetch } = adapter([json({}, 503)]);
    await expect(provider.insertCalendar('access', 'UTC')).rejects.toMatchObject({ kind: 'unknown', reason: 'provisioning_unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds response memory and rejects malformed bodies', async () => {
    for (const response of [new Response('x'.repeat(70_000)), new Response('invalid-json'), json({ unexpected: true })]) {
      const { provider } = adapter([response]);
      await expect(provider.getCalendar('access', 'calendar@example.test')).rejects.toMatchObject({ kind: 'unknown' });
    }
  });

  it('aborts network requests before eight seconds and never exposes the thrown cause', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('synthetic-sensitive-cause')));
          }),
      );
      const provider = new GoogleProvider({ ...credentials, fetch, beforeRequest: async () => true, timeoutMs: 99_999 });
      const pending = provider.insertCalendar('access', 'UTC').catch(error => error);
      await vi.advanceTimersByTimeAsync(7000);
      const error = await pending;
      expect(error).toMatchObject({ reason: 'provisioning_unknown' });
      expect(String(error)).not.toContain('synthetic-sensitive-cause');
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Calendar and event resource boundaries', () => {
  it('uses If-Match on updates and deletions and does not replay a stale resource', async () => {
    const { provider, fetch } = adapter([json({ id: write.id }), new Response(null, { status: 204 }), json({}, 412)]);
    await provider.updateEvent('access', 'calendar@example.test', write, '"version-1"');
    await provider.deleteEvent('access', 'calendar@example.test', write.id, '"version-2"');
    await expect(provider.updateEvent('access', 'calendar@example.test', write, '"stale"')).rejects.toMatchObject({
      kind: 'conflict',
      reason: 'precondition_failed',
    });
    expect(new Headers(fetch.mock.calls[0][1]!.headers).get('If-Match')).toBe('"version-1"');
    expect(new Headers(fetch.mock.calls[1][1]!.headers).get('If-Match')).toBe('"version-2"');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('rejects invalid conditional headers before spending budget', async () => {
    const { provider, fetch, beforeRequest } = adapter();
    await expect(provider.updateEvent('access', 'calendar@example.test', write, 'invalid\r\netag')).rejects.toMatchObject({ reason: 'invalid_resource' });
    await expect(provider.deleteEvent('access', 'calendar@example.test', write.id, 'x'.repeat(513))).rejects.toMatchObject({ reason: 'invalid_resource' });
    expect(fetch).not.toHaveBeenCalled();
    expect(beforeRequest).not.toHaveBeenCalled();
  });

  it('creates only a secondary calendar named TR8 in the chosen zone', async () => {
    const { provider, fetch } = adapter([json({ id: 'new@example.test', summary: 'TR8', timeZone: 'America/La_Paz', description: 'not-returned' })]);
    expect(await provider.insertCalendar('access', 'America/La_Paz')).toEqual({ id: 'new@example.test', summary: 'TR8', timeZone: 'America/La_Paz' });
    expect(JSON.parse(String(fetch.mock.calls[0][1]!.body))).toEqual({ summary: 'TR8', timeZone: 'America/La_Paz' });
  });

  it('encodes resource paths, omits attendees and prevents mail reminders/updates', async () => {
    const { provider, fetch } = adapter([json({ id: write.id })]);
    await provider.insertEvent('access', 'calendar/id?query=value', {
      ...write,
      attendees: [{ email: 'nobody@example.test' }],
      reminders: { useDefault: true },
    } as unknown as GoogleEventWrite);
    expect(String(fetch.mock.calls[0][0])).toContain('/calendars/calendar%2Fid%3Fquery%3Dvalue/events?sendUpdates=none');
    const body = JSON.parse(String(fetch.mock.calls[0][1]!.body));
    expect(body.id).toBe(write.id);
    expect(body).not.toHaveProperty('attendees');
    expect(body).not.toHaveProperty('conferenceData');
    expect(body.reminders).toEqual({ useDefault: false });
  });

  it('retains ownership markers and excludes arbitrary remote fields', async () => {
    const { provider } = adapter([
      json({
        id: write.id,
        status: 'confirmed',
        etag: 'etag-value',
        summary: 'private title',
        extendedProperties: { private: { tr8Generation: 'generation', 'invalid key': 'discard' } },
        attendees: [{ email: 'discard' }],
      }),
    ]);
    expect(await provider.getEvent('access', 'calendar@example.test', write.id)).toEqual({
      id: write.id,
      status: 'confirmed',
      etag: 'etag-value',
      extendedProperties: { private: { tr8Generation: 'generation' } },
    });
  });

  it('rejects the primary calendar and unsafe event identifiers before spending budget', async () => {
    const { provider, fetch, beforeRequest } = adapter();
    await expect(provider.getCalendar('access', 'primary')).rejects.toMatchObject({ reason: 'invalid_resource' });
    await expect(provider.getEvent('access', 'calendar@example.test', '../bad')).rejects.toMatchObject({ reason: 'invalid_resource' });
    expect(fetch).not.toHaveBeenCalled();
    expect(beforeRequest).not.toHaveBeenCalled();
  });
});

describe('Inbound Calendar pages and conditional patches', () => {
  it('requests one minimal page with fixed synchronization parameters and no hidden pagination', async () => {
    const { provider, fetch, beforeRequest } = adapter([
      json({ items: [{ ...incoming, description: 'private details', attendees: [{ email: 'private@example.test' }] }], nextPageToken: 'page-2/+=' }),
      json({ items: [], nextSyncToken: 'new-sync/+=' }),
    ]);
    const first = await provider.listEvents('access', 'calendar@example.test');
    expect(first).toEqual({ items: [incoming], nextPageToken: 'page-2/+=' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const firstUrl = new URL(String(fetch.mock.calls[0][0]));
    expect(firstUrl.pathname).toBe('/calendar/v3/calendars/calendar%40example.test/events');
    expect(Object.fromEntries(firstUrl.searchParams)).toEqual({
      maxResults: '25',
      showDeleted: 'true',
      singleEvents: 'false',
      fields:
        'items(id,etag,status,summary,start,end,updated,recurrence,recurringEventId,originalStartTime,extendedProperties/private),nextPageToken,nextSyncToken',
    });
    expect(await provider.listEvents('access', 'calendar@example.test', { pageToken: first.nextPageToken })).toEqual({
      items: [],
      nextSyncToken: 'new-sync/+=',
    });
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('pageToken')).toBe('page-2/+=');
    expect(beforeRequest.mock.calls).toEqual([['event.list'], ['event.list']]);
  });

  it('keeps the original sync token while traversing incremental pages', async () => {
    const { provider, fetch, beforeRequest } = adapter([json({ nextSyncToken: 'replacement-sync' })]);
    expect(await provider.listEvents('access', 'calendar@example.test', { syncToken: 'prior-sync/+=', pageToken: 'page-2/+=' })).toEqual({
      items: [],
      nextSyncToken: 'replacement-sync',
    });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get('syncToken')).toBe('prior-sync/+=');
    expect(url.searchParams.get('pageToken')).toBe('page-2/+=');
    for (const forbidden of ['timeMin', 'timeMax', 'updatedMin', 'orderBy', 'q', 'privateExtendedProperty', 'sharedExtendedProperty'])
      expect(url.searchParams.has(forbidden)).toBe(false);
    expect(beforeRequest).toHaveBeenCalledExactlyOnceWith('event.list');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([json({ error: { errors: [{ reason: 'fullSyncRequired' }] } }, 410), new Response('not-json', { status: 410 })])(
    'reports an expired sync token without fetching a replacement page',
    async response => {
      const { provider, fetch, beforeRequest } = adapter([response]);
      await expect(provider.listEvents('access', 'calendar@example.test', { syncToken: 'expired' })).rejects.toMatchObject({
        kind: 'conflict',
        reason: 'sync_token_expired',
        httpStatus: 410,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(beforeRequest).toHaveBeenCalledExactlyOnceWith('event.list');
    },
  );

  it('accepts deleted resources with only their id and cancelled status, including recurring instances', async () => {
    const instanceId = `${write.id}_20261024T120000Z`;
    const { provider } = adapter([json({ items: [{ id: instanceId, status: 'cancelled', summary: 42 }], nextSyncToken: 'sync' })]);
    expect(await provider.listEvents('access', 'calendar@example.test')).toEqual({ items: [{ id: instanceId, status: 'cancelled' }], nextSyncToken: 'sync' });
  });

  it('retains bounded recurrence metadata and timestamp offsets without translating civil dates', async () => {
    const item = {
      ...incoming,
      id: `${write.id}_20261101T053000Z`,
      start: { dateTime: '2026-11-01T01:30:00-04:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-11-01T01:30:00-05:00', timeZone: 'America/New_York' },
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=2'],
      recurringEventId: write.id,
      originalStartTime: { dateTime: '2026-11-01T01:30:00-04:00', timeZone: 'America/New_York' },
      extendedProperties: { private: { tr8_link: task.id, tr8_generation: '2' }, shared: { ignored: 'value' } },
    };
    const { provider } = adapter([json({ items: [item], nextSyncToken: 'sync' })]);
    expect((await provider.listEvents('access', 'calendar@example.test')).items).toEqual([
      { ...item, extendedProperties: { private: item.extendedProperties.private } },
    ]);
  });

  it.each([
    { start: { date: '2026-02-30' } },
    { end: { date: '2026-10-24' } },
    { end: { dateTime: '2026-10-24T12:00:00Z' } },
    { start: { date: '2026-10-24', dateTime: '2026-10-24T12:00:00Z' } },
    { start: { dateTime: '2026-02-30T12:00:00Z' }, end: { dateTime: '2026-03-01T12:00:00Z' } },
    { start: { dateTime: '2026-10-24T25:00:00Z' }, end: { dateTime: '2026-10-25T12:00:00Z' } },
    { start: { dateTime: '2026-10-24T12:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-10-25T12:00:00Z' } },
    { start: { dateTime: '2026-10-24T12:00:00Z', timeZone: 'Invalid/Zone' }, end: { dateTime: '2026-10-25T12:00:00Z' } },
    { updated: '2026-02-30T12:00:00Z' },
    { id: `${write.id}/../bad` },
    { status: 'unknown' },
    { summary: 'x'.repeat(1025) },
    { recurrence: Array.from({ length: 21 }, () => 'RRULE:FREQ=DAILY') },
    { extendedProperties: { private: { tr8_link: 42 } } },
  ])('rejects an invalid inbound resource without dropping it or advancing its page %j', async change => {
    const { provider, fetch } = adapter([json({ items: [{ ...incoming, ...change }], nextSyncToken: 'must-not-be-used' })]);
    await expect(provider.listEvents('access', 'calendar@example.test')).rejects.toMatchObject({ kind: 'unknown', reason: 'invalid_response' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { items: Array.from({ length: 26 }, () => incoming), nextSyncToken: 'sync' },
    { items: {}, nextSyncToken: 'sync' },
    { items: [], nextPageToken: 'page', nextSyncToken: 'sync' },
    { items: [] },
    { items: [], nextSyncToken: '' },
    { items: [], nextPageToken: 'x'.repeat(4097) },
    { items: [{ id: '../bad', status: 'cancelled' }], nextSyncToken: 'sync' },
  ])('rejects malformed or oversized pages %j', async page => {
    const { provider } = adapter([json(page)]);
    await expect(provider.listEvents('access', 'calendar@example.test')).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('rejects unsafe cursor input and the primary calendar before reserving budget', async () => {
    const { provider, fetch, beforeRequest } = adapter();
    for (const cursor of [{ syncToken: '' }, { pageToken: 'x'.repeat(4097) }, { syncToken: 'bad\r\nvalue' }, { timeMin: '2026-01-01' }]) {
      await expect(provider.listEvents('access', 'calendar@example.test', cursor)).rejects.toMatchObject({ reason: 'invalid_resource' });
    }
    await expect(provider.listEvents('access', 'primary')).rejects.toMatchObject({ reason: 'invalid_resource' });
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not list events when the durable budget denies the request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const beforeRequest = vi.fn(async () => false);
    const provider = new GoogleProvider({ ...credentials, fetch, beforeRequest });
    await expect(provider.listEvents('access', 'calendar@example.test')).rejects.toMatchObject({ reason: 'budget_exhausted' });
    expect(beforeRequest).toHaveBeenCalledExactlyOnceWith('event.list');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('patches only managed fields conditionally, retaining remote descriptions, attendees and source', async () => {
    const instanceId = `${write.id}_20261024T120000Z`;
    const { provider, fetch, beforeRequest } = adapter([json({ id: instanceId, etag: '"next"' })]);
    const body = { ...write, id: instanceId, extendedProperties: { private: { tr8_link: task.id } }, attendees: [{ email: 'untouched@example.test' }] };
    await provider.patchEvent('access', 'calendar@example.test', body, '"remote-version"');
    const init = fetch.mock.calls[0][1]!;
    expect(init.method).toBe('PATCH');
    expect(new Headers(init.headers).get('If-Match')).toBe('"remote-version"');
    expect(new URL(String(fetch.mock.calls[0][0])).pathname).toBe(`/calendar/v3/calendars/calendar%40example.test/events/${instanceId}`);
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('sendUpdates')).toBe('none');
    expect(JSON.parse(String(init.body))).toEqual({ summary: write.summary, start: write.start, end: write.end, extendedProperties: body.extendedProperties });
    expect(beforeRequest).toHaveBeenCalledExactlyOnceWith('event.update');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('requires a valid etag and bounded patch before sending, then exposes conflicts without retry', async () => {
    const { provider, fetch, beforeRequest } = adapter([json({}, 412)]);
    await expect(provider.patchEvent('access', 'calendar@example.test', write, undefined as unknown as string)).rejects.toMatchObject({
      reason: 'invalid_resource',
    });
    await expect(provider.patchEvent('access', 'calendar@example.test', write, 'bad\r\netag')).rejects.toMatchObject({ reason: 'invalid_resource' });
    await expect(
      provider.patchEvent('access', 'calendar@example.test', { ...write, start: { date: '2026-02-30' } } as GoogleEventPatch, '"etag"'),
    ).rejects.toMatchObject({
      reason: 'invalid_projection',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(beforeRequest).not.toHaveBeenCalled();
    await expect(provider.patchEvent('access', 'calendar@example.test', write, '"etag"')).rejects.toMatchObject({ reason: 'precondition_failed' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('TR8 task projection', () => {
  it('uses the block before due/start, retaining the due date as context', () => {
    const result = buildGoogleEvent(
      {
        ...task,
        start_date: '2026-03-01',
        scheduled_start_at: '2026-03-08T01:30:00-05:00',
        scheduled_end_at: '2026-03-08T03:30:00-04:00',
        scheduled_time_zone: 'America/New_York',
      },
      'https://tr8.example.test',
    )!;
    expect(result.start).toEqual({ dateTime: '2026-03-08T06:30:00.000Z', timeZone: 'America/New_York' });
    expect(result.end).toEqual({ dateTime: '2026-03-08T07:30:00.000Z', timeZone: 'America/New_York' });
    expect(result.description).toContain('Vencimiento: 2026-03-08');
    expect(result).not.toHaveProperty('attendees');
  });

  it.each(['2026-03-08', '2026-11-01', '2026-12-31', '2028-02-29'])('keeps civil dates through DST/year boundaries %s', date => {
    const result = buildGoogleEvent({ ...task, due_date: date, start_date: '2026-01-01' }, 'https://tr8.example.test')!;
    expect(result.start).toEqual({ date });
    expect(result.end).toEqual({ date: nextCivilDate(date) });
  });

  it('falls back to start date, uses an exclusive civil end and ignores unscheduled tasks', () => {
    expect(buildGoogleEvent({ ...task, due_date: null, start_date: '2026-12-31' }, 'https://tr8.example.test')?.end).toEqual({ date: '2027-01-01' });
    expect(buildGoogleEvent({ ...task, due_date: null }, 'https://tr8.example.test')).toBeNull();
    expect(nextCivilDate('2028-02-29')).toBe('2028-03-01');
  });

  it('adds/removes the completion marker while preserving dates', () => {
    const done = buildGoogleEvent({ ...task, status: 'done' }, 'https://tr8.example.test')!;
    const open = buildGoogleEvent(task, 'https://tr8.example.test')!;
    expect(done.summary).toBe('Hecha · Preparar proyecto');
    expect(open.summary).toBe('Preparar proyecto');
    expect(done.start).toEqual(open.start);
  });

  it.each([
    [{ project_status: 'complete' as const }, 'Completado'],
    [{ project_archived: true }, 'Archivado'],
  ])('keeps events while reflecting the project state %j', (change, label) => {
    const projected = buildGoogleEvent({ ...task, ...change }, 'https://tr8.example.test')!;
    const original = buildGoogleEvent(task, 'https://tr8.example.test')!;
    expect(projected.description).toContain(`Estado del proyecto: ${label}`);
    expect(projected.start).toEqual(original.start);
    expect(projected.end).toEqual(original.end);
    expect(projected.summary).toBe(original.summary);
    expect(original.description).not.toContain('Estado del proyecto:');
  });

  it('escapes HTML in details, links only to authenticated TR8 and never copies task descriptions', () => {
    const result = buildGoogleEvent(
      { ...task, project_title: '<img src=x onerror="alert(1)"> & project', description: 'private details' } as GoogleTaskProjection,
      'https://tr8.example.test',
    )!;
    expect(result.description).not.toContain('<img');
    expect(result.description).toContain('&lt;img');
    expect(result.description).not.toContain('private details');
    expect(result.source.url).toBe(`https://tr8.example.test/projects/${task.project_id}?task=${task.id}`);
    expect(result.reminders).toEqual({ useDefault: false });
  });

  it.each([
    { due_date: '2026-02-30' },
    { scheduled_start_at: '2026-01-01T00:00:00Z' },
    { scheduled_start_at: '2026-01-01T00:00:00Z', scheduled_end_at: '2025-01-01T00:00:00Z', scheduled_time_zone: 'UTC' },
    { scheduled_start_at: '2026-01-01T00:00:00Z', scheduled_end_at: '2026-01-01T01:00:00Z', scheduled_time_zone: 'Invalid/Zone' },
  ])('rejects invalid dates/partial blocks rather than guessing %j', change => {
    expect(() => buildGoogleEvent({ ...task, ...change }, 'https://tr8.example.test')).toThrow(GoogleProviderError);
  });
});

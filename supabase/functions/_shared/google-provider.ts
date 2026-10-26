/** Google Calendar protocol adapter. Each method performs exactly one budgeted HTTP request. */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
export const GOOGLE_TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';

export type GoogleFailureKind = 'retryable' | 'permanent' | 'reauthorization' | 'missing' | 'conflict' | 'unknown';
export type GoogleOperation =
  | 'oauth.exchange'
  | 'oauth.refresh'
  | 'oauth.revoke'
  | 'calendar.get'
  | 'calendar.insert'
  | 'event.get'
  | 'event.list'
  | 'event.insert'
  | 'event.update'
  | 'event.delete';

/** Sanitized error: never retains a response body, token, request, cause or arbitrary Google message. */
export class GoogleProviderError extends Error {
  constructor(
    readonly kind: GoogleFailureKind,
    readonly reason: string,
    readonly httpStatus?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Google Calendar: ${reason}.`);
    this.name = 'GoogleProviderError';
  }
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scopes: string[];
}

export interface GoogleCalendarResource {
  id: string;
  summary?: string;
  timeZone?: string;
}

export interface GoogleEventResource {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  etag?: string;
  extendedProperties?: { private: Record<string, string> };
}

export type GoogleEventTime = { date: string } | { dateTime: string; timeZone?: string };

/** Only fields used by the inbound synchronization contract; never attendee or description data. */
export interface GoogleInboundEventResource extends GoogleEventResource {
  summary?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  updated?: string;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleEventTime;
}

export interface GoogleEventPage {
  items: GoogleInboundEventResource[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/** PATCH deliberately leaves descriptions, guests, sources and reminders untouched. */
export type GoogleEventPatch = Pick<GoogleEventProjection, 'summary' | 'start' | 'end'> & {
  id: string;
  extendedProperties?: { private: Record<string, string> };
};

export interface GoogleEventProjection {
  summary: string;
  description: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
  reminders: { useDefault: false };
  source: { title: 'TR8'; url: string };
}

export type GoogleEventWrite = GoogleEventProjection & {
  id: string;
  extendedProperties?: { private: Record<string, string> };
};

export interface GoogleTaskProjection {
  id: string;
  project_id: string;
  title: string;
  project_title: string;
  project_status?: 'planning' | 'active' | 'hold' | 'complete';
  project_archived?: boolean;
  status: string;
  start_date?: string | null;
  due_date?: string | null;
  scheduled_start_at?: string | null;
  scheduled_end_at?: string | null;
  scheduled_time_zone?: string | null;
}

export interface GoogleProviderOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
  /** Reserve one external request atomically. Returning false stops without sending. */
  beforeRequest: (operation: GoogleOperation) => Promise<boolean | void>;
  /** Capped at 7 seconds; shorter than the database lease. */
  timeoutMs?: number;
  now?: () => number;
}

const calendarBase = 'https://www.googleapis.com/calendar/v3';
const bodyLimit = 65_536;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const eventId = /^[0-9a-v]{5,1024}$/;
const returnedEventId = /^[0-9a-v]{5,1024}(?:_\d{8}(?:T\d{6}Z)?)?$/;
const eventListFields =
  'items(id,etag,status,summary,start,end,updated,recurrence,recurringEventId,originalStartTime,extendedProperties/private),nextPageToken,nextSyncToken';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function string(value: unknown, maximum = 4096): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  );
}

function redirectUri(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error();
    return url.href;
  } catch {
    throw new GoogleProviderError('permanent', 'invalid_configuration');
  }
}

export function beginAuthURL(input: { state: string; challenge: string; clientId: string; redirectUri: string; includeTasks?: boolean }): string {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(input.state) || !/^[A-Za-z0-9_-]{43}$/.test(input.challenge) || !string(input.clientId, 512))
    throw new GoogleProviderError('permanent', 'invalid_configuration');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: redirectUri(input.redirectUri),
    response_type: 'code',
    scope: input.includeTasks ? `${GOOGLE_CALENDAR_SCOPE} ${GOOGLE_TASKS_SCOPE}` : GOOGLE_CALENDAR_SCOPE,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'false',
  }).toString();
  return url.href;
}

function retryAfter(response: Response, now: number): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header || header.length > 128) return undefined;
  if (/^\d+$/.test(header)) {
    const seconds = Number(header);
    return Number.isSafeInteger(seconds) ? Math.max(1, seconds) : undefined;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - now) / 1000)) : undefined;
}

async function readBody(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > bodyLimit) {
        await reader.cancel();
        throw new GoogleProviderError('unknown', 'invalid_response');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new GoogleProviderError('unknown', 'invalid_response');
  }
}

function responseError(status: number, body: unknown, wait: number | undefined, operation?: GoogleOperation): GoogleProviderError {
  const error = object(object(body)?.error);
  const entries = Array.isArray(error?.errors) ? error.errors : [];
  const reasons = entries.map(entry => object(entry)?.reason);
  const oauthError = object(body)?.error;
  if (oauthError === 'invalid_grant' || oauthError === 'invalid_token' || status === 401) {
    return new GoogleProviderError('reauthorization', 'authorization_expired', status);
  }
  if (oauthError === 'invalid_client' || oauthError === 'unauthorized_client') {
    return new GoogleProviderError('permanent', 'invalid_configuration', status);
  }
  if (status === 429 || (status === 403 && reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(String(reason))))) {
    return new GoogleProviderError('retryable', 'rate_limited', status, wait);
  }
  if (status >= 500 || status === 408) return new GoogleProviderError('retryable', 'provider_unavailable', status, wait);
  if (status === 404) return new GoogleProviderError('missing', 'not_found', status);
  if (status === 410 && operation === 'event.list') return new GoogleProviderError('conflict', 'sync_token_expired', status);
  if (status === 410 && reasons.includes('deleted')) return new GoogleProviderError('missing', 'deleted', status);
  if (status === 409) return new GoogleProviderError('conflict', 'already_exists', status);
  if (status === 412) return new GoogleProviderError('conflict', 'precondition_failed', status);
  if (status === 403) return new GoogleProviderError('permanent', 'permission_denied', status);
  return new GoogleProviderError('permanent', 'request_rejected', status);
}

function tokens(body: unknown, requireScope: boolean, requireTasks = false): GoogleTokens {
  const data = object(body);
  if (
    !data ||
    !string(data.access_token, 16_384) ||
    data.token_type !== 'Bearer' ||
    !Number.isSafeInteger(data.expires_in) ||
    Number(data.expires_in) < 1 ||
    Number(data.expires_in) > 86_400 ||
    (data.refresh_token !== undefined && !string(data.refresh_token, 16_384))
  ) {
    throw new GoogleProviderError('unknown', 'invalid_response');
  }
  const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : [];
  if ((requireScope || scopes.length > 0) && !scopes.includes(GOOGLE_CALENDAR_SCOPE)) {
    throw new GoogleProviderError('reauthorization', 'permission_missing');
  }
  if (requireTasks && (requireScope || scopes.length > 0) && !scopes.includes(GOOGLE_TASKS_SCOPE)) {
    throw new GoogleProviderError('reauthorization', 'permission_missing');
  }
  if (scopes.some(scope => ![GOOGLE_CALENDAR_SCOPE, GOOGLE_TASKS_SCOPE].includes(scope))) {
    throw new GoogleProviderError('permanent', 'unexpected_permissions');
  }
  return {
    accessToken: data.access_token,
    ...(data.refresh_token ? { refreshToken: data.refresh_token as string } : {}),
    expiresIn: Number(data.expires_in),
    scopes: scopes.length ? scopes : [GOOGLE_CALENDAR_SCOPE],
  };
}

function calendar(body: unknown): GoogleCalendarResource {
  const data = object(body);
  if (!data || !string(data.id, 2048)) throw new GoogleProviderError('unknown', 'invalid_response');
  return {
    id: data.id,
    ...(string(data.summary, 1024) ? { summary: data.summary } : {}),
    ...(string(data.timeZone, 128) ? { timeZone: data.timeZone } : {}),
  };
}

function event(body: unknown): GoogleEventResource {
  const data = object(body);
  if (!data || !string(data.id, 1024) || !returnedEventId.test(data.id)) {
    throw new GoogleProviderError('unknown', 'invalid_response');
  }
  const properties = object(object(data.extendedProperties)?.private);
  const retained: Record<string, string> = {};
  if (properties)
    for (const [key, value] of Object.entries(properties).slice(0, 20)) {
      if (/^[A-Za-z0-9_-]{1,44}$/.test(key) && string(value, 1024)) retained[key] = value;
    }
  return {
    id: data.id,
    ...(['confirmed', 'tentative', 'cancelled'].includes(String(data.status)) ? { status: data.status as GoogleEventResource['status'] } : {}),
    ...(string(data.etag, 512) ? { etag: data.etag } : {}),
    ...(Object.keys(retained).length ? { extendedProperties: { private: retained } } : {}),
  };
}

function invalidResponse(): never {
  throw new GoogleProviderError('unknown', 'invalid_response');
}

function validCivilDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    civilDate(value);
    return true;
  } catch {
    return false;
  }
}

function validTimestamp(value: unknown): value is string {
  if (!string(value, 64)) return false;
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  return Boolean(match && validCivilDate(match[1]) && Number.isFinite(Date.parse(value)));
}

function eventTime(value: unknown): GoogleEventTime {
  const data = object(value);
  if (!data || (data.date === undefined) === (data.dateTime === undefined)) return invalidResponse();
  if (data.timeZone !== undefined && (typeof data.timeZone !== 'string' || !validTimeZone(data.timeZone))) return invalidResponse();
  if (data.date !== undefined) {
    if (!validCivilDate(data.date)) return invalidResponse();
    return { date: data.date };
  }
  if (!validTimestamp(data.dateTime)) return invalidResponse();
  return { dateTime: data.dateTime, ...(data.timeZone !== undefined ? { timeZone: data.timeZone as string } : {}) };
}

function inboundEvent(value: unknown): GoogleInboundEventResource {
  const data = object(value);
  if (!data || !string(data.id, 1024) || !returnedEventId.test(data.id)) return invalidResponse();
  if (!['confirmed', 'tentative', 'cancelled'].includes(String(data.status))) return invalidResponse();
  // Google guarantees only the id for deleted events; never require their old payload.
  if (data.status === 'cancelled') return { id: data.id, status: 'cancelled' };
  if (data.etag !== undefined && !string(data.etag, 512)) return invalidResponse();
  if (data.summary !== undefined && data.summary !== '' && !string(data.summary, 1024)) return invalidResponse();
  if (data.updated !== undefined && !validTimestamp(data.updated)) return invalidResponse();
  if (data.recurringEventId !== undefined && (!string(data.recurringEventId, 1024) || !returnedEventId.test(data.recurringEventId))) return invalidResponse();
  if (data.recurrence !== undefined && (!Array.isArray(data.recurrence) || data.recurrence.length > 20 || !data.recurrence.every(rule => string(rule, 2048))))
    return invalidResponse();
  const start = eventTime(data.start);
  const end = eventTime(data.end);
  if ('date' in start !== 'date' in end) return invalidResponse();
  if ('date' in start && 'date' in end && end.date <= start.date) return invalidResponse();
  if ('dateTime' in start && 'dateTime' in end && Date.parse(end.dateTime) < Date.parse(start.dateTime)) return invalidResponse();
  if (data.extendedProperties !== undefined) {
    const properties = object(data.extendedProperties);
    if (!properties || (properties.private !== undefined && !object(properties.private))) return invalidResponse();
    const entries = Object.entries(object(properties.private) ?? {});
    if (entries.length > 20 || entries.some(([key, property]) => !/^[A-Za-z0-9_-]{1,44}$/.test(key) || !string(property, 1024))) return invalidResponse();
  }
  return {
    ...event(data),
    ...(data.summary !== undefined ? { summary: data.summary as string } : {}),
    start,
    end,
    ...(data.updated !== undefined ? { updated: data.updated as string } : {}),
    ...(data.recurrence !== undefined ? { recurrence: [...(data.recurrence as string[])] } : {}),
    ...(data.recurringEventId !== undefined ? { recurringEventId: data.recurringEventId as string } : {}),
    ...(data.originalStartTime !== undefined ? { originalStartTime: eventTime(data.originalStartTime) } : {}),
  };
}

function eventPage(value: unknown): GoogleEventPage {
  const data = object(value);
  if (!data || (data.items !== undefined && (!Array.isArray(data.items) || data.items.length > 25))) return invalidResponse();
  for (const key of ['nextPageToken', 'nextSyncToken']) {
    if (data[key] !== undefined && !string(data[key], 4096)) return invalidResponse();
  }
  if (data.nextPageToken !== undefined && data.nextSyncToken !== undefined) return invalidResponse();
  if (data.nextPageToken === undefined && data.nextSyncToken === undefined) return invalidResponse();
  return {
    items: ((data.items ?? []) as unknown[]).map(inboundEvent),
    ...(data.nextPageToken !== undefined ? { nextPageToken: data.nextPageToken as string } : {}),
    ...(data.nextSyncToken !== undefined ? { nextSyncToken: data.nextSyncToken as string } : {}),
  };
}

function calendarPath(id: string): string {
  if (!string(id, 2048) || ['primary', '.', '..'].includes(id)) throw new GoogleProviderError('permanent', 'invalid_resource');
  return `${calendarBase}/calendars/${encodeURIComponent(id)}`;
}

/** One strong opaque version, never a wildcard, weak validator or list. */
function concreteVersion(value: unknown): value is string {
  return string(value, 512) && /^"[\x21\x23-\x7e]+"$/.test(value);
}

function eventPath(calendarId: string, id?: string): string {
  if (id !== undefined && (!string(id, 1024) || !returnedEventId.test(id))) throw new GoogleProviderError('permanent', 'invalid_resource');
  return `${calendarPath(calendarId)}/events${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;
}

function validTimeZone(zone: string): boolean {
  try {
    if (!string(zone, 128)) return false;
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** No retries, polling, redirects or hidden refresh requests are performed by this adapter. */
export class GoogleProvider {
  private readonly options: GoogleProviderOptions;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: GoogleProviderOptions) {
    if (!string(options.clientId, 512) || !string(options.clientSecret, 4096)) {
      throw new GoogleProviderError('permanent', 'invalid_configuration');
    }
    this.options = { ...options, redirectUri: redirectUri(options.redirectUri) };
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = Math.min(7000, Math.max(250, options.timeoutMs ?? 5000));
    this.now = options.now ?? Date.now;
  }

  private async request(operation: GoogleOperation, url: string, init: RequestInit): Promise<unknown> {
    try {
      if ((await this.options.beforeRequest(operation)) === false) {
        throw new GoogleProviderError('retryable', 'budget_exhausted', undefined, 60);
      }
    } catch (error) {
      if (error instanceof GoogleProviderError) throw error;
      throw new GoogleProviderError('retryable', 'budget_unavailable', undefined, 60);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const unknownReason = operation === 'calendar.insert' ? 'provisioning_unknown' : 'request_unknown';
    try {
      const response = await this.fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        throw new GoogleProviderError('permanent', 'redirect_rejected', response.status);
      }
      if (response.ok && (operation === 'event.delete' || operation === 'oauth.revoke')) {
        await response.body?.cancel();
        return null;
      }
      let body: unknown;
      try {
        body = await readBody(response);
      } catch {
        if (operation === 'calendar.insert' && (response.status >= 500 || response.status === 408)) {
          throw new GoogleProviderError('unknown', 'provisioning_unknown', response.status);
        }
        if (!response.ok) throw responseError(response.status, null, retryAfter(response, this.now()), operation);
        throw new GoogleProviderError('unknown', unknownReason, response.status);
      }
      if (!response.ok) {
        if (operation === 'calendar.insert' && (response.status >= 500 || response.status === 408)) {
          throw new GoogleProviderError('unknown', 'provisioning_unknown', response.status);
        }
        throw responseError(response.status, body, retryAfter(response, this.now()), operation);
      }
      return body;
    } catch (error) {
      if (error instanceof GoogleProviderError) throw error;
      throw new GoogleProviderError('unknown', unknownReason);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async oauth(operation: 'oauth.exchange' | 'oauth.refresh', parameters: Record<string, string>, requireTasks = false): Promise<GoogleTokens> {
    const body = await this.request(operation, 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.options.clientId, client_secret: this.options.clientSecret, ...parameters }).toString(),
    });
    return tokens(body, operation === 'oauth.exchange', requireTasks);
  }

  exchange(code: string, verifier: string, requireTasks = false): Promise<GoogleTokens> {
    if (!string(code, 4096) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      throw new GoogleProviderError('permanent', 'invalid_oauth_attempt');
    }
    return this.oauth(
      'oauth.exchange',
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: this.options.redirectUri,
      },
      requireTasks,
    );
  }

  refresh(refreshToken: string, requireTasks = false): Promise<GoogleTokens> {
    if (!string(refreshToken, 16_384)) throw new GoogleProviderError('reauthorization', 'authorization_expired');
    return this.oauth('oauth.refresh', { grant_type: 'refresh_token', refresh_token: refreshToken }, requireTasks);
  }

  async revoke(token: string): Promise<void> {
    if (!string(token, 16_384)) throw new GoogleProviderError('permanent', 'invalid_resource');
    await this.request('oauth.revoke', 'https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
  }

  private authorized(accessToken: string, method = 'GET', body?: unknown, etag?: string): RequestInit {
    if (!string(accessToken, 16_384)) throw new GoogleProviderError('reauthorization', 'authorization_expired');
    if (etag !== undefined && !concreteVersion(etag)) throw new GoogleProviderError('permanent', 'invalid_resource');
    return {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(etag !== undefined ? { 'If-Match': etag } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
  }

  async getCalendar(accessToken: string, id: string): Promise<GoogleCalendarResource> {
    return calendar(await this.request('calendar.get', calendarPath(id), this.authorized(accessToken)));
  }

  async insertCalendar(accessToken: string, timeZone: string): Promise<GoogleCalendarResource> {
    if (!validTimeZone(timeZone)) throw new GoogleProviderError('permanent', 'invalid_time_zone');
    const body = await this.request('calendar.insert', `${calendarBase}/calendars`, this.authorized(accessToken, 'POST', { summary: 'TR8', timeZone }));
    try {
      return calendar(body);
    } catch {
      throw new GoogleProviderError('unknown', 'provisioning_unknown');
    }
  }

  async getEvent(accessToken: string, calendarId: string, id: string): Promise<GoogleEventResource> {
    return event(await this.request('event.get', eventPath(calendarId, id), this.authorized(accessToken)));
  }

  /** Exactly one page and one budget reservation. Cursor persistence belongs to the worker. */
  async listEvents(accessToken: string, calendarId: string, cursor: { syncToken?: string; pageToken?: string } = {}): Promise<GoogleEventPage> {
    if (!object(cursor) || Object.keys(cursor).some(key => !['syncToken', 'pageToken'].includes(key))) {
      throw new GoogleProviderError('permanent', 'invalid_resource');
    }
    const query = new URLSearchParams({ maxResults: '25', showDeleted: 'true', singleEvents: 'false', fields: eventListFields });
    for (const key of ['syncToken', 'pageToken'] as const) {
      if (cursor[key] !== undefined) {
        if (!string(cursor[key], 4096)) throw new GoogleProviderError('permanent', 'invalid_resource');
        query.set(key, cursor[key]);
      }
    }
    return eventPage(await this.request('event.list', `${eventPath(calendarId)}?${query}`, this.authorized(accessToken)));
  }

  async insertEvent(accessToken: string, calendarId: string, body: GoogleEventWrite): Promise<GoogleEventResource> {
    if (!eventId.test(body.id)) throw new GoogleProviderError('permanent', 'invalid_resource');
    eventPath(calendarId, body.id);
    return event(await this.request('event.insert', `${eventPath(calendarId)}?sendUpdates=none`, this.authorized(accessToken, 'POST', eventBody(body))));
  }

  async updateEvent(accessToken: string, calendarId: string, body: GoogleEventWrite, etag: string): Promise<GoogleEventResource> {
    if (!concreteVersion(etag)) throw new GoogleProviderError('permanent', 'invalid_resource');
    return event(
      await this.request('event.update', `${eventPath(calendarId, body.id)}?sendUpdates=none`, this.authorized(accessToken, 'PUT', eventBody(body), etag)),
    );
  }

  async patchEvent(accessToken: string, calendarId: string, body: GoogleEventPatch, etag: string): Promise<GoogleEventResource> {
    if (!concreteVersion(etag)) throw new GoogleProviderError('permanent', 'invalid_resource');
    const projection = patchBody(body);
    return event(
      await this.request('event.update', `${eventPath(calendarId, body.id)}?sendUpdates=none`, this.authorized(accessToken, 'PATCH', projection, etag)),
    );
  }

  async deleteEvent(accessToken: string, calendarId: string, id: string, etag: string): Promise<void> {
    if (!concreteVersion(etag)) throw new GoogleProviderError('permanent', 'invalid_resource');
    await this.request('event.delete', `${eventPath(calendarId, id)}?sendUpdates=none`, this.authorized(accessToken, 'DELETE', undefined, etag));
  }
}

function patchBody(body: GoogleEventPatch): Omit<GoogleEventPatch, 'id'> {
  if (!string(body.summary, 1008)) throw new GoogleProviderError('permanent', 'invalid_projection');
  let start: GoogleEventTime;
  let end: GoogleEventTime;
  try {
    start = eventTime(body.start);
    end = eventTime(body.end);
    if ('date' in start !== 'date' in end) throw new Error();
    if ('date' in start && 'date' in end && end.date <= start.date) throw new Error();
    if ('dateTime' in start && 'dateTime' in end && Date.parse(end.dateTime) <= Date.parse(start.dateTime)) throw new Error();
  } catch {
    throw new GoogleProviderError('permanent', 'invalid_projection');
  }
  const privateProperties = object(body.extendedProperties?.private);
  if (body.extendedProperties !== undefined && (!object(body.extendedProperties) || !privateProperties)) {
    throw new GoogleProviderError('permanent', 'invalid_projection');
  }
  if (
    privateProperties &&
    (Object.keys(privateProperties).length > 20 ||
      Object.entries(privateProperties).some(([key, value]) => !/^[A-Za-z0-9_-]{1,44}$/.test(key) || !string(value, 1024)))
  )
    throw new GoogleProviderError('permanent', 'invalid_projection');
  return {
    summary: body.summary,
    start: start as GoogleEventPatch['start'],
    end: end as GoogleEventPatch['end'],
    ...(privateProperties ? { extendedProperties: { private: { ...(privateProperties as Record<string, string>) } } } : {}),
  };
}

function eventBody(body: GoogleEventWrite): GoogleEventWrite {
  return {
    id: body.id,
    summary: body.summary,
    description: body.description,
    start: body.start,
    end: body.end,
    reminders: { useDefault: false },
    source: body.source,
    ...(body.extendedProperties ? { extendedProperties: body.extendedProperties } : {}),
  };
}

function civilDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new GoogleProviderError('permanent', 'invalid_projection');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value || Number(value.slice(0, 4)) < 1) {
    throw new GoogleProviderError('permanent', 'invalid_projection');
  }
  return value;
}

/** Civil arithmetic, independent of the server/profile time zone and DST. */
export function nextCivilDate(value: string): string {
  const date = new Date(`${civilDate(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  const next = date.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next)) throw new GoogleProviderError('permanent', 'invalid_projection');
  return next;
}

function html(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

/** Takes only an already-authorized server projection; this function never decides access. */
export function buildGoogleEvent(task: GoogleTaskProjection, appOrigin: string): GoogleEventProjection | null {
  if (!uuid.test(task.id) || !uuid.test(task.project_id) || !string(task.title, 1000) || !string(task.project_title, 1000)) {
    throw new GoogleProviderError('permanent', 'invalid_projection');
  }
  let origin: URL;
  try {
    origin = new URL(redirectUri(appOrigin));
    if (origin.pathname !== '/') throw new Error();
  } catch {
    throw new GoogleProviderError('permanent', 'invalid_configuration');
  }
  const link = new URL(`/projects/${task.project_id}?task=${task.id}`, origin).href;
  const due = task.due_date ? civilDate(task.due_date) : null;
  const startDate = task.start_date ? civilDate(task.start_date) : null;
  const block = [task.scheduled_start_at, task.scheduled_end_at, task.scheduled_time_zone];
  if (block.some(Boolean) && !block.every(Boolean)) throw new GoogleProviderError('permanent', 'invalid_projection');
  let start: GoogleEventProjection['start'];
  let end: GoogleEventProjection['end'];
  if (task.scheduled_start_at && task.scheduled_end_at && task.scheduled_time_zone) {
    const first = Date.parse(task.scheduled_start_at);
    const last = Date.parse(task.scheduled_end_at);
    const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
    if (
      !rfc3339.test(task.scheduled_start_at) ||
      !rfc3339.test(task.scheduled_end_at) ||
      !Number.isFinite(first) ||
      !Number.isFinite(last) ||
      last <= first ||
      !validTimeZone(task.scheduled_time_zone)
    ) {
      throw new GoogleProviderError('permanent', 'invalid_projection');
    }
    start = { dateTime: new Date(first).toISOString(), timeZone: task.scheduled_time_zone };
    end = { dateTime: new Date(last).toISOString(), timeZone: task.scheduled_time_zone };
  } else {
    const date = due ?? startDate;
    if (!date) return null;
    start = { date };
    end = { date: nextCivilDate(date) };
  }
  const projectState = [...(task.project_status === 'complete' ? ['Completado'] : []), ...(task.project_archived === true ? ['Archivado'] : [])].join(' · ');
  return {
    summary: `${task.status === 'done' ? 'Hecha · ' : ''}${task.title}`,
    description: [
      `Proyecto: ${html(task.project_title)}`,
      ...(projectState ? [`Estado del proyecto: ${projectState}`] : []),
      ...(due ? [`Vencimiento: ${due}`] : []),
      `TR8: ${html(link)}`,
    ].join('\n'),
    start,
    end,
    reminders: { useDefault: false },
    source: { title: 'TR8', url: link },
  };
}

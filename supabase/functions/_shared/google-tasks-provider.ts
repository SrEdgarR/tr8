import { GoogleProviderError } from './google-provider.ts';

export const GOOGLE_TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';

export type TasksOperation = 'tasks.lists.list' | 'tasks.list' | 'tasks.get' | 'tasks.patch' | 'tasks.delete';
export type GoogleTasksOperation = TasksOperation;
export type GoogleTasksStatus = 'needsAction' | 'completed';

export interface GoogleTasksTaskList {
  id: string;
  title: string;
  etag: string;
  updated: string;
}

export interface GoogleTasksActiveTask {
  id: string;
  deleted: false;
  title: string;
  status: GoogleTasksStatus;
  /** A civil date, never converted to the server or profile time zone. */
  due: string | null;
  etag: string;
  updated: string;
  completed?: string;
  parent?: string;
  hidden?: boolean;
  /** Assigned Docs/Chat tasks need additional restrictions in the worker. */
  assigned: boolean;
}

export interface GoogleTasksDeletedTask {
  id: string;
  deleted: true;
}

export type GoogleTasksTask = GoogleTasksActiveTask | GoogleTasksDeletedTask;

export interface GoogleTasksPage<T> {
  items: T[];
  nextPageToken?: string;
}

export interface GoogleTasksQuery {
  pageToken?: string;
  updatedMin?: string;
}

export interface GoogleTasksPatch {
  title?: string;
  status?: GoogleTasksStatus;
  /** YYYY-MM-DD; null clears the date. Google does not expose the task's time. */
  due?: string | null;
  completed?: string | null;
}

export interface GoogleTasksProviderOptions {
  fetch?: typeof fetch;
  /** One durable reservation before every HTTP request; false prevents sending. */
  beforeRequest: (operation: TasksOperation) => Promise<boolean | void>;
  /** Capped at seven seconds, below the worker lease duration. */
  timeoutMs?: number;
  now?: () => number;
}

const base = 'https://tasks.googleapis.com/tasks/v1';
const bodyLimit = 65_536;
const pageSize = 25;
const taskFields = 'id,title,status,due,completed,etag,updated,parent,hidden,deleted,assignmentInfo';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function opaque(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
  );
}

function identifier(value: unknown): value is string {
  return opaque(value, 1024) && value !== '.' && value !== '..';
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum;
}

function civilDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1) {
    throw new GoogleProviderError('permanent', 'invalid_resource');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new GoogleProviderError('permanent', 'invalid_resource');
  }
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new GoogleProviderError('permanent', 'invalid_resource');
  }
  civilDate(value.slice(0, 10));
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new GoogleProviderError('permanent', 'invalid_resource');
  return new Date(milliseconds).toISOString();
}

function invalidResponse(): never {
  throw new GoogleProviderError('unknown', 'invalid_response');
}

function taskList(input: unknown): GoogleTasksTaskList {
  const data = object(input);
  if (!data || !identifier(data.id) || !text(data.title, 1024) || !opaque(data.etag, 512)) return invalidResponse();
  try {
    return { id: data.id, title: data.title, etag: data.etag, updated: timestamp(data.updated) };
  } catch {
    return invalidResponse();
  }
}

function task(input: unknown): GoogleTasksTask {
  const data = object(input);
  if (!data || !identifier(data.id)) return invalidResponse();
  // A tombstone does not need a title, version, status or date.
  if (data.deleted === true) return { id: data.id, deleted: true };
  if (
    (data.deleted !== undefined && data.deleted !== false) ||
    !text(data.title, 1024) ||
    !['needsAction', 'completed'].includes(String(data.status)) ||
    !opaque(data.etag, 512) ||
    (data.hidden !== undefined && typeof data.hidden !== 'boolean') ||
    (data.parent !== undefined && !identifier(data.parent)) ||
    (data.assignmentInfo !== undefined && !object(data.assignmentInfo))
  ) {
    return invalidResponse();
  }
  try {
    let due: string | null = null;
    if (data.due != null) {
      timestamp(data.due);
      due = civilDate((data.due as string).slice(0, 10));
    }
    return {
      id: data.id,
      deleted: false,
      title: data.title,
      status: data.status as GoogleTasksStatus,
      due,
      etag: data.etag,
      updated: timestamp(data.updated),
      ...(data.completed != null ? { completed: timestamp(data.completed) } : {}),
      ...(data.parent !== undefined ? { parent: data.parent as string } : {}),
      ...(data.hidden !== undefined ? { hidden: data.hidden as boolean } : {}),
      assigned: data.assignmentInfo !== undefined,
    };
  } catch {
    return invalidResponse();
  }
}

function page<T>(input: unknown, read: (item: unknown) => T): GoogleTasksPage<T> {
  const data = object(input);
  if (
    !data ||
    (data.items !== undefined && (!Array.isArray(data.items) || data.items.length > pageSize)) ||
    (data.nextPageToken !== undefined && !opaque(data.nextPageToken, 4096))
  ) {
    return invalidResponse();
  }
  return {
    items: (data.items as unknown[] | undefined)?.map(read) ?? [],
    ...(data.nextPageToken !== undefined ? { nextPageToken: data.nextPageToken as string } : {}),
  };
}

function resource(listId: string, taskId?: string): string {
  if (!identifier(listId) || (taskId !== undefined && !identifier(taskId))) {
    throw new GoogleProviderError('permanent', 'invalid_resource');
  }
  return `${base}/lists/${encodeURIComponent(listId)}/tasks${taskId === undefined ? '' : `/${encodeURIComponent(taskId)}`}`;
}

function retryAfter(response: Response, now: number): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value || value.length > 128) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? Math.max(1, seconds) : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - now) / 1000)) : undefined;
}

function responseError(status: number, input: unknown, wait?: number): GoogleProviderError {
  const data = object(object(input)?.error);
  const entries = Array.isArray(data?.errors) ? data.errors : [];
  const details = Array.isArray(data?.details) ? data.details : [];
  const reasons = [...entries, ...details].map(item => object(item)?.reason);
  if (status === 401) return new GoogleProviderError('reauthorization', 'authorization_expired', status);
  if (status === 429 || (status === 403 && reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(String(reason))))) {
    return new GoogleProviderError('retryable', 'rate_limited', status, wait);
  }
  if (status >= 500 || status === 408) return new GoogleProviderError('retryable', 'provider_unavailable', status, wait);
  if (status === 404) return new GoogleProviderError('missing', 'not_found', status);
  if (status === 410 && reasons.includes('deleted')) return new GoogleProviderError('missing', 'deleted', status);
  if (status === 409) return new GoogleProviderError('conflict', 'already_exists', status);
  if (status === 412) return new GoogleProviderError('conflict', 'precondition_failed', status);
  if (status === 403) {
    if (reasons.some(reason => ['accessNotConfigured', 'serviceDisabled', 'SERVICE_DISABLED', 'API_DISABLED'].includes(String(reason)))) {
      return new GoogleProviderError('permanent', 'tasks_api_disabled', status);
    }
    if (reasons.some(reason => ['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(String(reason)))) {
      return new GoogleProviderError('reauthorization', 'permission_missing', status);
    }
    return new GoogleProviderError('permanent', 'permission_denied', status);
  }
  return new GoogleProviderError('permanent', 'request_rejected', status);
}

async function readBody(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) break;
      length += value.value.byteLength;
      if (length > bodyLimit) {
        await reader.cancel();
        return invalidResponse();
      }
      chunks.push(value.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return invalidResponse();
  }
}

function patchBody(input: GoogleTasksPatch): Record<string, unknown> {
  const value = object(input);
  if (!value || Object.keys(value).length === 0 || Object.keys(value).some(key => !['title', 'status', 'due', 'completed'].includes(key))) {
    throw new GoogleProviderError('permanent', 'invalid_resource');
  }
  const body: Record<string, unknown> = {};
  if ('title' in value) {
    if (!text(value.title, 1024)) throw new GoogleProviderError('permanent', 'invalid_resource');
    body.title = value.title;
  }
  if ('status' in value) {
    if (!['needsAction', 'completed'].includes(String(value.status))) throw new GoogleProviderError('permanent', 'invalid_resource');
    body.status = value.status;
  }
  if ('due' in value) body.due = value.due === null ? null : `${civilDate(value.due)}T00:00:00.000Z`;
  if ('completed' in value) body.completed = value.completed === null ? null : timestamp(value.completed);
  return body;
}

/** Tasks protocol only: no hidden polling, OAuth refresh, retries or calendar copies. */
export class GoogleTasksProvider {
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: GoogleTasksProviderOptions) {
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = Math.min(7000, Math.max(250, options.timeoutMs ?? 5000));
    this.now = options.now ?? Date.now;
  }

  private authorized(token: string, method = 'GET', body?: Record<string, unknown>, etag?: string): RequestInit {
    if (!opaque(token, 16_384)) throw new GoogleProviderError('reauthorization', 'authorization_expired');
    if (etag !== undefined && (!opaque(etag, 512) || etag.trim() === '*')) throw new GoogleProviderError('permanent', 'invalid_resource');
    return {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(etag !== undefined ? { 'If-Match': etag } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
  }

  private async request(operation: TasksOperation, url: string, init: RequestInit): Promise<unknown> {
    try {
      if ((await this.options.beforeRequest(operation)) === false) {
        throw new GoogleProviderError('retryable', 'budget_exhausted', undefined, 60);
      }
    } catch (error) {
      if (error instanceof GoogleProviderError) throw error;
      throw new GoogleProviderError('retryable', 'budget_unavailable', undefined, 60);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        throw new GoogleProviderError('permanent', 'redirect_rejected', response.status);
      }
      if (response.ok && operation === 'tasks.delete') {
        await response.body?.cancel();
        return null;
      }
      let body: unknown;
      try {
        body = await readBody(response);
      } catch {
        if (!response.ok) throw responseError(response.status, null, retryAfter(response, this.now()));
        return invalidResponse();
      }
      if (!response.ok) throw responseError(response.status, body, retryAfter(response, this.now()));
      return body;
    } catch (error) {
      if (error instanceof GoogleProviderError) throw error;
      throw new GoogleProviderError('unknown', 'request_unknown');
    } finally {
      clearTimeout(timer);
    }
  }

  async listTaskLists(token: string, pageToken?: string): Promise<GoogleTasksPage<GoogleTasksTaskList>> {
    if (pageToken !== undefined && !opaque(pageToken, 4096)) throw new GoogleProviderError('permanent', 'invalid_resource');
    const query = new URLSearchParams({ maxResults: String(pageSize), fields: 'nextPageToken,items(id,title,etag,updated)', prettyPrint: 'false' });
    if (pageToken !== undefined) query.set('pageToken', pageToken);
    return page(await this.request('tasks.lists.list', `${base}/users/@me/lists?${query}`, this.authorized(token)), taskList);
  }

  async listTasks(token: string, listId: string, options: GoogleTasksQuery = {}): Promise<GoogleTasksPage<GoogleTasksTask>> {
    const path = resource(listId);
    if (
      !object(options) ||
      Object.keys(options).some(key => !['pageToken', 'updatedMin'].includes(key)) ||
      (options.pageToken !== undefined && !opaque(options.pageToken, 4096))
    ) {
      throw new GoogleProviderError('permanent', 'invalid_resource');
    }
    const query = new URLSearchParams({
      maxResults: String(pageSize),
      showCompleted: 'true',
      showHidden: 'true',
      showDeleted: 'true',
      showAssigned: 'false',
      fields: `nextPageToken,items(${taskFields})`,
      prettyPrint: 'false',
    });
    if (options.pageToken !== undefined) query.set('pageToken', options.pageToken);
    if (options.updatedMin !== undefined) query.set('updatedMin', timestamp(options.updatedMin));
    return page(await this.request('tasks.list', `${path}?${query}`, this.authorized(token)), task);
  }

  async getTask(token: string, listId: string, taskId: string): Promise<GoogleTasksTask> {
    const query = new URLSearchParams({ fields: taskFields, prettyPrint: 'false' });
    return task(await this.request('tasks.get', `${resource(listId, taskId)}?${query}`, this.authorized(token)));
  }

  async patchTask(token: string, listId: string, taskId: string, patch: GoogleTasksPatch, etag: string): Promise<GoogleTasksTask> {
    const path = resource(listId, taskId);
    if (!opaque(etag, 512) || etag.trim() === '*') throw new GoogleProviderError('permanent', 'invalid_resource');
    const query = new URLSearchParams({ fields: taskFields, prettyPrint: 'false' });
    return task(await this.request('tasks.patch', `${path}?${query}`, this.authorized(token, 'PATCH', patchBody(patch), etag)));
  }

  async deleteTask(token: string, listId: string, taskId: string, etag: string): Promise<void> {
    const path = resource(listId, taskId);
    if (!opaque(etag, 512) || etag.trim() === '*') throw new GoogleProviderError('permanent', 'invalid_resource');
    await this.request('tasks.delete', path, this.authorized(token, 'DELETE', undefined, etag));
  }
}

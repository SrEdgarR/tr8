import { GoogleProviderError, GOOGLE_TASKS_SCOPE } from './google-provider.ts';
import { GoogleTasksProvider, type GoogleTasksOperation, type GoogleTasksTask } from './google-tasks-provider.ts';
import { credentials, type GoogleCredentials } from './google-service.ts';
import { GoogleServiceError, object, text, uuid, version, type GoogleRuntime } from './google-runtime.ts';
import type { GoogleSecretEnvelope } from './google-crypto.ts';

type Kind = 'discover' | 'pull' | 'create' | 'patch' | 'delete';
interface Job {
  job_id: string;
  lease_token: string;
  kind: Kind;
}
interface Prepared {
  valid: true;
  kind: Kind;
  user_id: string;
  connection_id: string;
  generation: number;
  credential_envelope: GoogleSecretEnvelope;
  list_id?: string;
  page_token: string | null;
  link?: { id: string; remote_task_id: string | null };
  create_state?: 'ready' | 'uncertain' | 'bound';
  creation_marker?: string;
}
export interface GoogleTasksWorkerResult {
  processed: number;
  finished: number;
  deferred: number;
  timed_out: boolean;
}
class Stopped extends Error {}
const purposes: Record<GoogleTasksOperation, string> = {
  'tasks.lists.list': 'tasks_lists',
  'tasks.list': 'tasks_list',
  'tasks.get': 'tasks_get',
  'tasks.insert': 'tasks_insert',
  'tasks.patch': 'tasks_patch',
  'tasks.delete': 'tasks_delete',
};

/** This projection contains only fields managed by this integration. */
export function normalizedGoogleTask(task: GoogleTasksTask): Record<string, unknown> {
  if (task.deleted) return { id: task.id, deleted: true };
  return {
    id: task.id,
    deleted: false,
    etag: task.etag,
    title: task.title,
    completed: task.status === 'completed',
    start_date: task.due,
    assigned: task.assigned,
    ...(task.creation_marker ? { creation_marker: task.creation_marker } : {}),
  };
}

function parseJob(input: unknown): Job {
  const value = object(input);
  if (!['discover', 'pull', 'create', 'patch', 'delete'].includes(String(value.kind))) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
  return { job_id: uuid(value.job_id), lease_token: uuid(value.lease_token), kind: value.kind as Kind };
}
function prepared(input: unknown, job: Job): Prepared | null {
  const value = object(input);
  if (value.valid !== true) return null;
  if (value.kind !== job.kind) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
  const result: Prepared = {
    valid: true,
    kind: job.kind,
    user_id: uuid(value.user_id),
    connection_id: uuid(value.connection_id),
    generation: version(value.generation),
    credential_envelope: object(value.credential_envelope) as unknown as GoogleSecretEnvelope,
    page_token: value.page_token == null ? null : text(value.page_token, 4096),
  };
  if (job.kind !== 'discover') result.list_id = text(value.list_id, 1024);
  if (job.kind === 'patch' || job.kind === 'delete' || job.kind === 'create') {
    const link = object(value.link);
    result.link = { id: uuid(link.id), remote_task_id: job.kind === 'create' && link.remote_task_id == null ? null : text(link.remote_task_id, 1024) };
  }
  if (job.kind === 'create') {
    if (!['ready', 'uncertain', 'bound'].includes(String(value.create_state))) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
    result.create_state = value.create_state as 'ready' | 'uncertain' | 'bound';
    result.creation_marker = text(value.creation_marker, 40);
    if (!/^tr8:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result.creation_marker)) {
      throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
    }
  }
  return result;
}

export async function runGoogleTasksWorker(
  runtime: GoogleRuntime,
  options: { limit?: 1 | 2; deadlineMs?: number; now?: () => number } = {},
): Promise<GoogleTasksWorkerResult> {
  const limit = options.limit ?? 1;
  if (limit !== 1 && limit !== 2) throw new GoogleServiceError('INVALID_INPUT');
  const now = options.now ?? Date.now;
  const duration = Math.min(40_000, Math.max(1000, options.deadlineMs ?? 40_000));
  const deadline = now() + duration;
  let stopped = false;
  const result: GoogleTasksWorkerResult = { processed: 0, finished: 0, deferred: 0, timed_out: false };
  const active = () => {
    if (stopped || now() >= deadline) throw new Stopped();
  };
  async function checked<T>(operation: () => Promise<T>): Promise<T> {
    active();
    const value = await operation();
    active();
    return value;
  }

  async function process(job: Job): Promise<boolean> {
    const lease = { job_id: job.job_id, lease_token: job.lease_token };
    const rpc = (action: string, payload: Record<string, unknown> = {}) => checked(() => runtime.rpc(action, { ...lease, ...payload }));
    let projection: Prepared | null = null;
    let saved: GoogleCredentials;
    let refreshed = false;
    let requests = 0;
    let remote: Record<string, unknown> | undefined;
    let preparedHash: string | null | undefined;
    let confirmedWrite = false;
    let insertReserved = false;
    async function prepare(): Promise<Prepared> {
      const value = prepared(await rpc('tasks_prepare'), job);
      if (
        !value ||
        (projection &&
          (value.connection_id !== projection.connection_id ||
            value.user_id !== projection.user_id ||
            value.generation !== projection.generation ||
            value.list_id !== projection.list_id ||
            value.creation_marker !== projection.creation_marker ||
            value.link?.id !== projection.link?.id ||
            value.link?.remote_task_id !== projection.link?.remote_task_id))
      )
        throw new Stopped();
      projection = value;
      return value;
    }
    async function reserve(purpose: string): Promise<boolean> {
      active();
      if (requests >= 4 || deadline - now() < 8000) throw new GoogleProviderError('retryable', 'invocation_limit', undefined, 30);
      const reservation = object(await rpc('tasks_reserve_request', { purpose }));
      if (reservation.allowed !== true) {
        if (reservation.reason === 'budget_exhausted') return false;
        throw new GoogleProviderError('permanent', 'lease_unavailable');
      }
      requests++;
      if (deadline - now() < 8000) throw new GoogleProviderError('retryable', 'invocation_limit', undefined, 30);
      return true;
    }
    const provider = runtime.tasksProvider?.(beforeTasksRequest) ?? new GoogleTasksProvider({ beforeRequest: beforeTasksRequest });
    async function beforeTasksRequest(operation: GoogleTasksOperation): Promise<boolean> {
      if (operation !== 'tasks.insert') return reserve(purposes[operation]);
      active();
      if (!insertReserved) throw new GoogleProviderError('permanent', 'invalid_operation');
      insertReserved = false;
      return true;
    }
    const oauth = runtime.provider(operation => {
      if (operation !== 'oauth.refresh') throw new GoogleProviderError('permanent', 'invalid_operation');
      return reserve('refresh');
    });
    async function refresh(): Promise<void> {
      if (refreshed) throw new GoogleProviderError('reauthorization', 'authorization_expired');
      refreshed = true;
      const renewed = await checked(() => oauth.refresh(saved.refreshToken, true));
      saved = {
        accessToken: renewed.accessToken,
        refreshToken: renewed.refreshToken ?? saved.refreshToken,
        expiresAt: now() + renewed.expiresIn * 1000,
        scopes: saved.scopes,
      };
      const envelope = await checked(() => runtime.encrypt(JSON.stringify(saved), 'credentials', projection!.user_id, String(projection!.generation)));
      if ((await rpc('tasks_save_credentials', { credential_envelope: envelope })) !== true) throw new Stopped();
      await prepare();
    }
    async function access<T>(operation: (token: string) => Promise<T>): Promise<T> {
      try {
        return await checked(() => operation(saved.accessToken));
      } catch (cause) {
        if (!(cause instanceof GoogleProviderError) || cause.kind !== 'reauthorization' || cause.httpStatus !== 401 || refreshed) throw cause;
        await refresh();
        return checked(() => operation(saved.accessToken));
      }
    }
    try {
      await prepare();
      saved = credentials(
        await checked(() => runtime.decrypt(projection!.credential_envelope, 'credentials', projection!.user_id, String(projection!.generation))),
      );
      if (!saved.scopes?.includes(GOOGLE_TASKS_SCOPE)) throw new GoogleProviderError('reauthorization', 'permission_missing');
      if (saved.expiresAt <= now() + 30_000) await refresh();
      if (job.kind === 'discover') {
        const page = await access(token => provider.listTaskLists(token, projection!.page_token ?? undefined));
        const applied = object(
          await rpc('tasks_apply_lists', {
            items: page.items.map(item => ({ id: item.id, title: item.title })),
            page_token: projection!.page_token,
            next_page_token: page.nextPageToken ?? null,
          }),
        );
        if (applied.applied !== true) throw new Stopped();
      } else if (job.kind === 'pull') {
        const page = await access(token => provider.listTasks(token, projection!.list_id!, { pageToken: projection!.page_token ?? undefined }));
        const applied = object(
          await rpc('tasks_apply_page', {
            items: page.items.map(normalizedGoogleTask),
            page_token: projection!.page_token,
            next_page_token: page.nextPageToken ?? null,
          }),
        );
        if (applied.applied !== true) throw new Stopped();
      } else if (job.kind === 'create') {
        if (projection!.create_state === 'uncertain') {
          // An uncertain POST is never repeated, even if a scan finds nothing.
          // SQL preserves this cursor and binds only a single exact marker.
          const page = await access(token => provider.listTasks(token, projection!.list_id!, { pageToken: projection!.page_token ?? undefined }));
          const recovered = object(
            await rpc('tasks_recover_create_page', {
              page_token: projection!.page_token,
              items: page.items.map(normalizedGoogleTask),
              next_page_token: page.nextPageToken ?? null,
            }),
          );
          if (recovered.applied !== true) throw new Stopped();
        } else if (projection!.create_state === 'ready') {
          // Reserve first, then persist the exact projection and uncertainty in
          // one fenced SQL operation. No provider refresh or POST retry follows.
          if (!(await reserve('tasks_insert'))) throw new GoogleProviderError('retryable', 'budget_exhausted', undefined, 60);
          const creation = object(await rpc('tasks_begin_create'));
          if (creation.allowed !== true) throw new Stopped();
          const marker = text(creation.marker, 40);
          if (marker !== projection!.creation_marker) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
          const body = object(creation.projection);
          if (typeof body.completed !== 'boolean') throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
          const hash = text(creation.prepared_hash, 32);
          if (!/^[0-9a-f]{32}$/.test(hash)) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
          insertReserved = true;
          const written = await checked(() =>
            provider.insertTask(saved.accessToken, projection!.list_id!, {
              title: text(body.title, 500),
              status: body.completed ? 'completed' : 'needsAction',
              due: body.start_date == null ? null : text(body.start_date, 10),
              creation_marker: marker,
            }),
          );
          if (written.deleted || written.assigned || written.creation_marker !== marker) throw new GoogleProviderError('unknown', 'invalid_response');
          const bound = object(await rpc('tasks_bind_create', { remote: normalizedGoogleTask(written), prepared_hash: hash }));
          if (bound.applied !== true) throw new Stopped();
        }
      } else {
        let task: GoogleTasksTask;
        try {
          task = await access(token => provider.getTask(token, projection!.list_id!, projection!.link!.remote_task_id!));
        } catch (cause) {
          if (!(cause instanceof GoogleProviderError) || cause.kind !== 'missing') throw cause;
          task = { id: projection!.link!.remote_task_id!, deleted: true };
        }
        remote = normalizedGoogleTask(task);
        const decision = object(await rpc('tasks_compare_remote', { remote }));
        if (decision.prepared_hash === null) preparedHash = null;
        else if (typeof decision.prepared_hash === 'string') preparedHash = text(decision.prepared_hash, 128);
        if (decision.action === 'patch') {
          if (typeof preparedHash !== 'string') throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
          if (task.deleted || task.assigned) throw new GoogleProviderError('permanent', 'unsupported_task');
          const patch = object(decision.patch);
          const status = text(patch.status, 32);
          if (status !== 'completed' && status !== 'needsAction') throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
          const due = patch.due == null ? null : text(patch.due, 10);
          await prepare();
          const written = await access(token =>
            provider.patchTask(
              token,
              projection!.list_id!,
              projection!.link!.remote_task_id!,
              {
                title: text(patch.title, 500),
                status,
                due,
                ...(status === 'needsAction' ? { completed: null } : {}),
              },
              text(decision.etag, 1024),
            ),
          );
          remote = normalizedGoogleTask(written);
          if (written.id !== projection!.link!.remote_task_id || written.deleted) throw new GoogleProviderError('unknown', 'invalid_response');
          confirmedWrite = true;
        } else if (decision.action === 'delete') {
          if (preparedHash === undefined) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
          if (!task.deleted) {
            if (task.assigned) throw new GoogleProviderError('permanent', 'unsupported_task');
            await prepare();
            try {
              await access(token => provider.deleteTask(token, projection!.list_id!, projection!.link!.remote_task_id!, text(decision.etag, 1024)));
            } catch (cause) {
              if (!(cause instanceof GoogleProviderError) || cause.kind !== 'missing') throw cause;
            }
          }
          remote = { id: projection!.link!.remote_task_id, deleted: true };
          confirmedWrite = true;
        } else if (!['none', 'conflict'].includes(String(decision.action))) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
      }
      return (await rpc('tasks_finish', { outcome: 'succeeded', ...(confirmedWrite ? { remote, prepared_hash: preparedHash } : {}) })) === true;
    } catch (cause) {
      if (cause instanceof Stopped) return false;
      const providerError = cause instanceof GoogleProviderError ? cause : null;
      if (providerError?.reason === 'lease_unavailable') return false;
      const outcome = providerError?.kind === 'reauthorization' ? 'needs_reauthorization' : providerError?.kind === 'permanent' ? 'dead' : 'retry';
      const reason =
        providerError?.reason === 'budget_exhausted'
          ? 'budget_exhausted'
          : outcome === 'needs_reauthorization'
            ? 'reauthorization_required'
            : outcome === 'dead'
              ? 'permanent_failure'
              : 'temporary_failure';
      return (
        (await rpc('tasks_finish', {
          outcome,
          reason,
          ...(providerError?.retryAfterSeconds ? { retry_after_seconds: Math.min(2_147_483_647, Math.ceil(providerError.retryAfterSeconds)) } : {}),
        })) === true
      );
    }
  }

  let timer: ReturnType<typeof setTimeout>;
  const work = (async () => {
    const claimed = await checked(() => runtime.rpc('tasks_claim', { limit }));
    if (!Array.isArray(claimed) || claimed.length > limit) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
    for (const input of claimed) {
      active();
      result.processed++;
      if (await process(parseJob(input))) result.finished++;
      else result.deferred++;
    }
    return result;
  })();
  const timeout = new Promise<GoogleTasksWorkerResult>(resolve => {
    timer = setTimeout(() => {
      stopped = true;
      resolve({ ...result, deferred: Math.max(result.deferred, result.processed - result.finished), timed_out: true });
    }, duration);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (cause) {
    if (cause instanceof Stopped) return { ...result, timed_out: true };
    throw cause;
  } finally {
    stopped = true;
    clearTimeout(timer!);
  }
}

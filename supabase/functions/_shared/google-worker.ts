import { sha256Base64Url, type GoogleSecretEnvelope } from './google-crypto.ts';
import {
  buildGoogleEvent,
  GOOGLE_TASKS_SCOPE,
  GoogleProviderError,
  type GoogleEventResource,
  type GoogleEventWrite,
  type GoogleOperation,
  type GoogleProvider,
  type GoogleTaskProjection,
} from './google-provider.ts';
import { boundedJson, errorReply, GoogleServiceError, object, reply, text, uuid, version, type GoogleRuntime } from './google-runtime.ts';
import { credentials, reserveGoogleRequest, type GoogleCredentials } from './google-service.ts';
import { runGoogleTasksWorker } from './google-tasks-worker.ts';

type JobKind = 'provision' | 'reconcile_scan' | 'upsert' | 'delete' | 'revoke';
interface Job {
  job_id: string;
  lease_token: string;
  kind: JobKind;
}
interface Prepared {
  valid: true;
  kind: JobKind;
  user_id: string;
  connection_id: string;
  generation: number;
  calendar_id: string | null;
  credential_envelope?: GoogleSecretEnvelope;
  time_zone: string;
  link?: { id: string; event_id: string };
  event?: GoogleTaskProjection;
  previously_synced?: boolean;
}
type Outcome = 'succeeded' | 'retry' | 'dead' | 'unknown' | 'cancelled' | 'needs_reauthorization' | 'remote_missing';
interface Result {
  outcome: Outcome;
  reason?: string;
  calendar_id?: string;
  retry_after_seconds?: number;
}
export interface GoogleWorkerResult {
  processed: number;
  finished: number;
  deferred: number;
  timed_out: boolean;
}
export interface GoogleWorkerOptions {
  limit?: 1 | 2;
  now?: () => number;
  deadlineMs?: number;
}

class StopJob extends Error {}
class WorkerDeadline extends Error {}
const kinds: JobKind[] = ['provision', 'reconcile_scan', 'upsert', 'delete', 'revoke'];

/** A stopped invocation leaves the durable lease to expire; it never certifies a result. */
interface Control {
  stopped: boolean;
  deadline: number;
  now: () => number;
}
function active(control: Control): void {
  if (control.stopped || control.now() >= control.deadline) throw new WorkerDeadline();
}
async function checked<T>(control: Control, operation: () => Promise<T>): Promise<T> {
  active(control);
  const result = await operation();
  active(control);
  return result;
}
function lease(job: Job): Record<string, unknown> {
  return { job_id: job.job_id, lease_token: job.lease_token };
}
function parseJob(input: unknown): Job {
  const value = object(input);
  if (!kinds.includes(value.kind as JobKind)) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
  return { job_id: uuid(value.job_id), lease_token: uuid(value.lease_token), kind: value.kind as JobKind };
}
function parsePrepared(input: unknown, job: Job): Prepared | null {
  const value = object(input);
  if (value.valid !== true) return null;
  if (value.kind !== job.kind) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
  const prepared: Prepared = {
    valid: true,
    kind: job.kind,
    user_id: uuid(value.user_id),
    connection_id: uuid(value.connection_id),
    generation: version(value.generation),
    calendar_id: value.calendar_id == null ? null : text(value.calendar_id, 1024),
    time_zone: text(value.time_zone, 128),
  };
  if (job.kind !== 'reconcile_scan') prepared.credential_envelope = object(value.credential_envelope) as unknown as GoogleSecretEnvelope;
  if (job.kind === 'upsert' || job.kind === 'delete') {
    const link = object(value.link);
    prepared.link = { id: uuid(link.id), event_id: text(link.event_id, 1024) };
    if (!/^[0-9a-v]{5,1024}$/.test(prepared.link.event_id)) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
    if (!prepared.calendar_id || prepared.calendar_id === 'primary') throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
  }
  if (job.kind === 'upsert') {
    prepared.event = object(value.event) as unknown as GoogleTaskProjection;
    if (typeof value.previously_synced !== 'boolean') throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
    prepared.previously_synced = value.previously_synced;
  }
  return prepared;
}

function ownEvent(remote: GoogleEventResource, prepared: Prepared): void {
  const markers = remote.extendedProperties?.private;
  if (remote.id !== prepared.link?.event_id || markers?.tr8_link !== prepared.link.id || markers?.tr8_generation !== String(prepared.generation)) {
    throw new GoogleProviderError('permanent', 'ownership_mismatch');
  }
  if (!remote.etag) throw new GoogleProviderError('permanent', 'remote_version_missing');
}
function eventBody(prepared: Prepared, appOrigin: string): GoogleEventWrite {
  if (!prepared.event || !prepared.link) throw new GoogleProviderError('permanent', 'invalid_projection');
  const projection = buildGoogleEvent(prepared.event, appOrigin);
  if (!projection) throw new GoogleProviderError('permanent', 'invalid_projection');
  return {
    ...projection,
    id: prepared.link.event_id,
    extendedProperties: { private: { tr8_link: prepared.link.id, tr8_generation: String(prepared.generation) } },
  };
}

function classified(error: unknown, job: Job, calendarCreationReserved: boolean): Result | null {
  if (error instanceof StopJob || error instanceof WorkerDeadline) return null;
  if (!(error instanceof GoogleProviderError)) return { outcome: 'retry', reason: 'dependency_unavailable' };
  if (error.reason === 'lease_unavailable') return null;
  if (job.kind === 'revoke' && error.kind === 'reauthorization' && error.httpStatus === 400) {
    // Google reports an invalid/already revoked token as HTTP 400 invalid_token/invalid_grant.
    return { outcome: 'succeeded' };
  }
  if (error.kind === 'reauthorization') return { outcome: 'needs_reauthorization', reason: 'reauthorization_required' };
  if (error.kind === 'unknown') {
    const calendarUnknown = job.kind === 'provision' && (calendarCreationReserved || error.reason === 'provisioning_unknown');
    return { outcome: calendarUnknown ? 'unknown' : 'retry', reason: calendarUnknown ? 'provisioning_unknown' : 'outcome_unknown' };
  }
  if (error.kind === 'missing') return { outcome: 'remote_missing', reason: 'remote_missing' };
  if (error.kind === 'conflict' || error.kind === 'retryable') {
    return {
      outcome: 'retry',
      reason: error.kind === 'conflict' ? 'remote_changed' : 'temporary_failure',
      ...(error.retryAfterSeconds ? { retry_after_seconds: Math.min(2_147_483_647, Math.ceil(error.retryAfterSeconds)) } : {}),
    };
  }
  return { outcome: 'dead', reason: 'permanent_failure' };
}

async function processJob(runtime: GoogleRuntime, job: Job, control: Control): Promise<boolean> {
  let prepared: Prepared | null = null;
  let requestCount = 0;
  let calendarCreationReserved = false;
  let saved: GoogleCredentials;
  let refreshed = false;
  const rpc = (action: string, payload: Record<string, unknown> = {}) => checked(control, () => runtime.rpc(action, { ...lease(job), ...payload }));
  async function prepare(): Promise<Prepared> {
    const next = parsePrepared(await rpc('prepare'), job);
    if (!next) throw new StopJob();
    if (
      prepared &&
      (next.user_id !== prepared.user_id ||
        next.connection_id !== prepared.connection_id ||
        next.generation !== prepared.generation ||
        next.link?.id !== prepared.link?.id ||
        next.link?.event_id !== prepared.link?.event_id)
    ) {
      throw new StopJob();
    }
    prepared = next;
    return next;
  }
  async function beforeRequest(operation: GoogleOperation): Promise<boolean> {
    active(control);
    if (requestCount >= 4 || control.deadline - control.now() < 8000) {
      throw new GoogleProviderError('retryable', 'invocation_limit', undefined, 30);
    }
    const allowed = await checked(control, () => reserveGoogleRequest(runtime, operation, undefined, lease(job)));
    if (allowed) {
      requestCount++;
      if (operation === 'calendar.insert') calendarCreationReserved = true;
      if (control.deadline - control.now() < 8000) throw new GoogleProviderError('retryable', 'invocation_limit', undefined, 30);
    }
    return allowed;
  }
  let provider: GoogleProvider;
  async function refresh(): Promise<void> {
    if (refreshed) throw new GoogleProviderError('reauthorization', 'authorization_expired');
    refreshed = true;
    const renewed = await checked(control, () => provider.refresh(saved.refreshToken, saved.scopes?.includes(GOOGLE_TASKS_SCOPE)));
    saved = {
      accessToken: renewed.accessToken,
      refreshToken: renewed.refreshToken ?? saved.refreshToken,
      expiresAt: control.now() + renewed.expiresIn * 1000,
      ...(saved.scopes ? { scopes: saved.scopes } : {}),
    };
    const nextEnvelope = await checked(control, () => runtime.encrypt(JSON.stringify(saved), 'credentials', prepared!.user_id, String(prepared!.generation)));
    if ((await rpc('save_credentials', { credential_envelope: nextEnvelope })) !== true) throw new StopJob();
    await prepare();
  }
  async function access<T>(operation: (accessToken: string) => Promise<T>): Promise<T> {
    try {
      return await checked(control, () => operation(saved.accessToken));
    } catch (error) {
      if (!(error instanceof GoogleProviderError) || error.kind !== 'reauthorization' || error.httpStatus !== 401 || refreshed) throw error;
      await refresh();
      return checked(control, () => operation(saved.accessToken));
    }
  }

  let result: Result | null = null;
  try {
    await prepare();
    if (job.kind === 'reconcile_scan') result = { outcome: 'succeeded' };
    else {
      provider = runtime.provider(beforeRequest);
      saved = credentials(
        await checked(control, () => runtime.decrypt(prepared!.credential_envelope!, 'credentials', prepared!.user_id, String(prepared!.generation))),
      );
      if (job.kind === 'revoke') {
        await checked(control, () => provider.revoke(saved.refreshToken));
        result = { outcome: 'succeeded' };
      } else {
        if (saved.expiresAt <= control.now() + 30_000) await refresh();
        if (job.kind === 'provision') {
          // reserve_request persists provisioning_unknown before the one and only POST.
          const calendar = await checked(control, () => provider.insertCalendar(saved.accessToken, prepared!.time_zone));
          result = { outcome: 'succeeded', calendar_id: calendar.id };
        } else {
          let remote: GoogleEventResource | null = null;
          try {
            remote = await access(token => provider.getEvent(token, prepared!.calendar_id!, prepared!.link!.event_id));
          } catch (error) {
            if (!(error instanceof GoogleProviderError) || error.kind !== 'missing') throw error;
            if (job.kind === 'upsert' && (prepared!.previously_synced || error.reason === 'deleted')) {
              result = { outcome: 'remote_missing' };
            }
          }
          if (job.kind === 'delete') {
            if (remote && remote.status !== 'cancelled') {
              ownEvent(remote, prepared!);
              await access(async token => {
                await prepare();
                try {
                  await provider.deleteEvent(token, prepared!.calendar_id!, prepared!.link!.event_id, remote!.etag!);
                } catch (error) {
                  if (!(error instanceof GoogleProviderError) || error.kind !== 'missing') throw error;
                  // The event can disappear between GET and conditional DELETE.
                }
              });
            }
            result = { outcome: 'succeeded' };
          } else if (remote?.status === 'cancelled' || (!remote && prepared!.previously_synced)) {
            result = { outcome: 'remote_missing' };
          } else if (remote) {
            ownEvent(remote, prepared!);
            await access(async token => {
              await prepare();
              const written = await provider.updateEvent(token, prepared!.calendar_id!, eventBody(prepared!, runtime.appOrigin), remote!.etag!);
              if (written.id !== prepared!.link!.event_id) throw new GoogleProviderError('unknown', 'invalid_response');
            });
            result = { outcome: 'succeeded' };
          } else {
            // An already deleted first incarnation is not silently recreated either.
            if (result?.outcome !== 'remote_missing') {
              try {
                await access(async token => {
                  await prepare();
                  const written = await provider.insertEvent(token, prepared!.calendar_id!, eventBody(prepared!, runtime.appOrigin));
                  if (written.id !== prepared!.link!.event_id) throw new GoogleProviderError('unknown', 'invalid_response');
                });
              } catch (error) {
                if (!(error instanceof GoogleProviderError) || error.kind !== 'conflict' || error.httpStatus !== 409) throw error;
                remote = await access(token => provider.getEvent(token, prepared!.calendar_id!, prepared!.link!.event_id));
                if (remote.status === 'cancelled') throw new GoogleProviderError('missing', 'deleted', 410);
                ownEvent(remote, prepared!);
                await access(async token => {
                  await prepare();
                  const written = await provider.updateEvent(token, prepared!.calendar_id!, eventBody(prepared!, runtime.appOrigin), remote!.etag!);
                  if (written.id !== prepared!.link!.event_id) throw new GoogleProviderError('unknown', 'invalid_response');
                });
              }
              result = { outcome: 'succeeded' };
            }
          }
        }
      }
    }
  } catch (error) {
    result = classified(error, job, calendarCreationReserved);
  }
  if (!result) return false;
  // SQL owns the final lease, generation, eligibility and compensating cleanup checks.
  return (await rpc('finish', { ...result })) === true;
}

/** Claims at most two jobs; interruptions intentionally leave their fenced leases recoverable. */
export async function runGoogleWorker(runtime: GoogleRuntime, options: GoogleWorkerOptions = {}): Promise<GoogleWorkerResult> {
  const limit = options.limit ?? 2;
  if (limit !== 1 && limit !== 2) throw new GoogleServiceError('INVALID_INPUT');
  if (!runtime.configured) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
  const now = options.now ?? Date.now;
  const duration = Math.min(45_000, Math.max(1000, options.deadlineMs ?? 45_000));
  const control: Control = { stopped: false, deadline: now() + duration, now };
  const summary: GoogleWorkerResult = { processed: 0, finished: 0, deferred: 0, timed_out: false };
  let timer: ReturnType<typeof setTimeout>;
  const work = (async () => {
    const claimed = await checked(control, () => runtime.rpc('claim', { limit }));
    if (!Array.isArray(claimed) || claimed.length > limit) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
    const jobs = claimed.map(parseJob);
    for (const job of jobs) {
      active(control);
      summary.processed++;
      if (await processJob(runtime, job, control)) summary.finished++;
      else summary.deferred++;
    }
    return summary;
  })();
  const deadline = new Promise<GoogleWorkerResult>(resolve => {
    timer = setTimeout(() => {
      control.stopped = true;
      resolve({ ...summary, deferred: Math.max(summary.deferred, summary.processed - summary.finished), timed_out: true });
    }, duration);
  });
  try {
    return await Promise.race([work, deadline]);
  } catch (error) {
    if (error instanceof WorkerDeadline) return { ...summary, deferred: Math.max(summary.deferred, summary.processed - summary.finished), timed_out: true };
    throw error;
  } finally {
    control.stopped = true;
    clearTimeout(timer!);
  }
}

async function workerAuthenticated(request: Request, secret: string): Promise<boolean> {
  const supplied = request.headers.get('x-tr8-worker-secret') ?? '';
  const candidate = supplied.length <= 256 ? supplied : '';
  const [expectedHash, actualHash] = await Promise.all([sha256Base64Url(secret), sha256Base64Url(candidate)]);
  let difference = expectedHash.length ^ actualHash.length;
  for (let index = 0; index < expectedHash.length; index++) difference |= expectedHash.charCodeAt(index) ^ actualHash.charCodeAt(index);
  return difference === 0 && /^[A-Za-z0-9_-]{43,128}$/.test(secret) && supplied === candidate;
}

/** Internal endpoint. A public project key or an end-user JWT never authenticates the worker. */
export function createGoogleWorkerHandler(runtime: GoogleRuntime) {
  return async (request: Request): Promise<Response> => {
    try {
      if (!(await workerAuthenticated(request, runtime.workerSecret))) throw new GoogleServiceError('AUTH_REQUIRED', 401);
      if (!runtime.configured) throw new GoogleServiceError('DEPENDENCY_UNAVAILABLE', 503);
      if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new GoogleServiceError('INVALID_INPUT');
      }
      const body = object(await boundedJson(request, 16_384, 2000));
      if (
        Object.keys(body).some(key => !['limit', 'source'].includes(key)) ||
        (body.limit !== undefined && body.limit !== 1 && body.limit !== 2) ||
        (body.source !== undefined && body.source !== 'cron')
      ) {
        throw new GoogleServiceError('INVALID_INPUT');
      }
      const started = Date.now();
      const calendar = await runGoogleWorker(runtime, { limit: body.limit as 1 | 2 | undefined });
      if (runtime.tasksProvider && Date.now() - started < 35_000) {
        const tasks = await runGoogleTasksWorker(runtime, { limit: body.limit as 1 | 2 | undefined, deadlineMs: 45_000 - (Date.now() - started) });
        return reply({ ...calendar, tasks });
      }
      return reply(calendar);
    } catch (error) {
      return errorReply(error);
    }
  };
}

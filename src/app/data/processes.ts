import type { SupabaseClient } from '@supabase/supabase-js';
import { DataError, dataError } from './errors';

export const PROCESS_STATES = ['pending', 'leased', 'retry', 'succeeded', 'cancelled', 'unknown', 'dead'] as const;
export type ProcessState = (typeof PROCESS_STATES)[number];
export interface ProcessJob {
  id: string;
  entity_kind: 'task' | 'project' | 'authorization';
  event_kind: string;
  state: ProcessState;
  attempts: number;
  created_at: string;
  available_at: string;
  finished_at: string | null;
  reason: string | null;
}
export interface ProcessStatus {
  channels: { email: false; google: false };
  scheduler: { enabled: boolean; last_run_at: string | null };
  budget: { daily_limit: number; used_today: number; batch_limit: number; max_attempts: number; monthly_limit: number; used_month: number; blocked: boolean };
  counts: Record<ProcessState, number>;
  jobs: ProcessJob[];
  retention_days: number;
}
export interface ProcessesApi {
  scopeKey: string[];
  load: (signal?: AbortSignal) => Promise<ProcessStatus>;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 50 && Number.isFinite(Date.parse(value));
const nullableTime = (value: unknown) => value === null || timestamp(value);
const events = new Set(['task.created', 'task.changed', 'task.deleted', 'project.created', 'project.changed', 'project.deleted', 'authorization.changed']);
const reasons = new Set([
  'reconciled',
  'superseded',
  'resource_removed',
  'access_changed',
  'lease_expired',
  'temporary_failure',
  'permanent_failure',
  'outcome_unknown',
  'attempt_limit',
  'cancelled',
]);
const malformed = () => new DataError('Actualiza TR8 para consultar el estado de los procesos.', 'CLIENT_UPGRADE_REQUIRED');

function parseStatus(value: unknown): ProcessStatus {
  if (
    !record(value) ||
    !record(value.channels) ||
    value.channels.email !== false ||
    value.channels.google !== false ||
    !record(value.scheduler) ||
    typeof value.scheduler.enabled !== 'boolean' ||
    !nullableTime(value.scheduler.last_run_at) ||
    !record(value.budget) ||
    !['daily_limit', 'used_today', 'batch_limit', 'max_attempts', 'monthly_limit', 'used_month'].every(key =>
      count((value.budget as Record<string, unknown>)[key]),
    ) ||
    typeof value.budget.blocked !== 'boolean' ||
    !record(value.counts) ||
    !PROCESS_STATES.every(state => count((value.counts as Record<string, unknown>)[state])) ||
    !Array.isArray(value.jobs) ||
    value.jobs.length > 20 ||
    !count(value.retention_days) ||
    !value.retention_days
  )
    throw malformed();
  if (
    (value.budget.batch_limit as number) < 1 ||
    (value.budget.batch_limit as number) > 20 ||
    value.budget.max_attempts !== 8 ||
    (value.budget.daily_limit as number) < 1 ||
    (value.budget.monthly_limit as number) < 1
  )
    throw malformed();
  const ids = new Set<string>();
  const jobs: ProcessJob[] = value.jobs.map(job => {
    if (
      !record(job) ||
      typeof job.id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(job.id) ||
      ids.has(job.id) ||
      !['task', 'project', 'authorization'].includes(String(job.entity_kind)) ||
      !events.has(String(job.event_kind)) ||
      !PROCESS_STATES.includes(job.state as ProcessState) ||
      !count(job.attempts) ||
      job.attempts > 8 ||
      !timestamp(job.created_at) ||
      !timestamp(job.available_at) ||
      !nullableTime(job.finished_at) ||
      (job.reason !== null && !reasons.has(String(job.reason)))
    )
      throw malformed();
    ids.add(job.id);
    // Only the versioned, minimal metadata contract reaches application state.
    return {
      id: job.id,
      entity_kind: job.entity_kind as ProcessJob['entity_kind'],
      event_kind: String(job.event_kind),
      state: job.state as ProcessState,
      attempts: job.attempts,
      created_at: job.created_at,
      available_at: job.available_at,
      finished_at: job.finished_at as string | null,
      reason: job.reason as string | null,
    };
  });
  return {
    channels: { email: false, google: false },
    scheduler: { enabled: value.scheduler.enabled, last_run_at: value.scheduler.last_run_at as string | null },
    budget: {
      daily_limit: value.budget.daily_limit as number,
      used_today: value.budget.used_today as number,
      batch_limit: value.budget.batch_limit as number,
      max_attempts: value.budget.max_attempts as number,
      monthly_limit: value.budget.monthly_limit as number,
      used_month: value.budget.used_month as number,
      blocked: value.budget.blocked,
    },
    counts: Object.fromEntries(PROCESS_STATES.map(state => [state, (value.counts as Record<string, number>)[state]])) as Record<ProcessState, number>,
    jobs,
    retention_days: value.retention_days,
  };
}

export function createProcessesRepository(client: SupabaseClient) {
  return {
    async processStatus(workspaceId: string, signal?: AbortSignal): Promise<ProcessStatus> {
      if (!workspaceId) throw new DataError('Selecciona un espacio para consultar sus procesos.');
      let query = client.rpc('tr8_v2_get_process_status', { p_workspace_id: workspaceId });
      if (signal) query = query.abortSignal(signal);
      const { data, error } = await query;
      if (error) throw dataError(error);
      return parseStatus(data);
    },
  };
}

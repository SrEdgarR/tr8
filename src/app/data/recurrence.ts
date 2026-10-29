import type { SupabaseClient } from '@supabase/supabase-js';
import type { Task } from '../types';
import type { RecurrenceApi, RecurrenceRule, RecurrenceSeries, RecurrenceState, RecurrenceSummary } from '../recurrence-types';
import { validRecurrenceRule } from '../recurrence-dates';
import { validCivilDate } from '../workspace/CalendarTime';
import { DataError, dataError } from './errors';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => key in value);
const version = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const instant = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const stateNames = ['active', 'paused', 'blocked', 'finished'];
const invalid = () => new DataError('Revisa la tarea, su fecha y la regla de repetición.', '22023');
const malformed = () =>
  new DataError('No pudimos confirmar la repetición. Actualiza sus datos o reintenta la misma solicitud antes de preparar otra.', 'CLIENT_UPGRADE_REQUIRED');

function series(value: unknown, workspaceId: string, projectId: string): value is RecurrenceSeries {
  return (
    record(value) &&
    closed(value, [
      'id',
      'workspace_id',
      'project_id',
      'version',
      'rule',
      'anchor_date',
      'state',
      'reason',
      'current_task_id',
      'current_task_created_at',
      'current_occurrence_date',
    ]) &&
    id(value.id) &&
    value.workspace_id === workspaceId &&
    value.project_id === projectId &&
    version(value.version) &&
    validRecurrenceRule(value.rule) &&
    typeof value.anchor_date === 'string' &&
    validCivilDate(value.anchor_date) &&
    typeof value.current_occurrence_date === 'string' &&
    validCivilDate(value.current_occurrence_date) &&
    value.current_occurrence_date >= value.anchor_date &&
    typeof value.state === 'string' &&
    stateNames.includes(value.state) &&
    (value.reason === null || (typeof value.reason === 'string' && /^[a-z0-9_]{1,100}$/.test(value.reason))) &&
    id(value.current_task_id) &&
    instant(value.current_task_created_at)
  );
}
function state(value: unknown, workspaceId: string, task: Task): value is RecurrenceState {
  if (!record(value) || !closed(value, ['task_id', 'series', 'occurrence_date', 'successor_task_id']) || value.task_id !== task.id) return false;
  if (value.series === null) return value.occurrence_date === null && value.successor_task_id === null;
  return (
    series(value.series, workspaceId, task.project_id) &&
    typeof value.occurrence_date === 'string' &&
    validCivilDate(value.occurrence_date) &&
    (value.successor_task_id === null || id(value.successor_task_id))
  );
}
function summary(value: unknown): value is RecurrenceSummary {
  if (
    !record(value) ||
    !closed(value, ['series_id', 'task_id', 'frequency', 'interval', 'state']) ||
    !id(value.series_id) ||
    !id(value.task_id) ||
    typeof value.state !== 'string' ||
    !stateNames.includes(value.state)
  )
    return false;
  const max = value.frequency === 'daily' ? 365 : value.frequency === 'weekly' ? 52 : value.frequency === 'monthly' ? 12 : 0;
  return max > 0 && typeof value.interval === 'number' && Number.isInteger(value.interval) && value.interval > 0 && value.interval <= max;
}

export function createRecurrenceRepository(client: SupabaseClient, workspaceId: string): Omit<RecurrenceApi, 'scopeKey'> {
  if (!id(workspaceId)) throw invalid();
  function taskInput(task: Task) {
    if (task.workspace_id !== workspaceId || !id(task.id) || !id(task.project_id) || !version(task.version) || !instant(task.created_at)) throw invalid();
    return { id: task.id, project_id: task.project_id, created_at: task.created_at };
  }
  async function rpc(action: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    try {
      const query = client.rpc('tr8_v2_recurrence', { p_workspace_id: workspaceId, p_action: action, p_input: input });
      const { data, error } = await (signal ? query.abortSignal(signal) : query);
      if (error) throw dataError(error);
      return data;
    } catch (cause) {
      throw dataError(cause);
    }
  }
  return {
    async state(task, signal) {
      const data = await rpc('state', taskInput(task), signal);
      if (!state(data, workspaceId, task)) throw malformed();
      return data;
    },
    async summaries(signal) {
      const items: RecurrenceSummary[] = [],
        seen = new Set<string>(),
        tasks = new Set<string>();
      let after: string | null = null;
      for (let page = 0; page < 100; page++) {
        const data = await rpc('list', { after_id: after, limit: 100 }, signal);
        if (
          !record(data) ||
          !closed(data, ['items', 'next_cursor']) ||
          !Array.isArray(data.items) ||
          data.items.length > 100 ||
          (data.next_cursor !== null && !id(data.next_cursor))
        )
          throw malformed();
        for (const row of data.items) {
          if (!summary(row) || seen.has(row.series_id) || tasks.has(row.task_id) || (after !== null && row.series_id <= after)) throw malformed();
          seen.add(row.series_id);
          tasks.add(row.task_id);
          items.push(row);
          after = row.series_id;
        }
        if (data.next_cursor === null) return items;
        if (!data.items.length || data.next_cursor !== after) throw malformed();
      }
      throw new DataError('Hay demasiadas repeticiones para cargar sus indicadores. Puedes consultar cada tarea desde su detalle.', 'CLIENT_UPGRADE_REQUIRED');
    },
    async save(task, seriesVersion, rule, requestId) {
      const identity = taskInput(task);
      if (!id(requestId) || (seriesVersion !== null && !version(seriesVersion)) || (rule !== null && !validRecurrenceRule(rule))) throw invalid();
      if (rule && (!task.due_date || !validCivilDate(task.due_date))) throw invalid();
      const frozen: RecurrenceRule | null = rule ? { ...rule, weekdays: [...rule.weekdays] } : null;
      const data = await rpc('save', { ...identity, task_version: task.version, series_version: seriesVersion, request_id: requestId, rule: frozen });
      if (!state(data, workspaceId, task)) throw malformed();
      return data;
    },
  };
}

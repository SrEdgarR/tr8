import type { SupabaseClient } from '@supabase/supabase-js';
import type { CalendarItem, CalendarPage, CalendarPreferences, CalendarQuery, Task, TaskScheduleInput } from '../types';
import { DataError, dataError } from './errors';

type Value = Record<string, unknown>;
const record = (value: unknown): value is Value => typeof value === 'object' && value !== null && !Array.isArray(value);
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const positiveVersion = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const malformed = () => new DataError('La respuesta del calendario no corresponde a esta versión de TR8. Actualiza los datos.', 'CLIENT_UPGRADE_REQUIRED');
const statuses = new Set(['backlog', 'todo', 'progress', 'review', 'done']);
const priorities = new Set(['none', 'low', 'medium', 'high', 'urgent']);

function instantMicros(value: string): bigint | null {
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const base = Date.parse(`${parts[1]}${parts[3]}`);
  return Number.isFinite(base) ? BigInt(base) * 1000n + BigInt((parts[2] ?? '').padEnd(6, '0')) : null;
}

function validZone(zone: string) {
  if (!zone || zone.length > 100) return false;
  try {
    new Intl.DateTimeFormat('es', { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function civilDate(value: string) {
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isPreferences(value: unknown): value is CalendarPreferences {
  return (
    record(value) &&
    (value.time_zone === null || (typeof value.time_zone === 'string' && validZone(value.time_zone))) &&
    positiveVersion(value.version) &&
    nullableString(value.updated_at)
  );
}

function isItem(value: unknown): value is CalendarItem {
  return (
    record(value) &&
    ['id', 'workspace_id', 'workspace_name', 'project_id', 'project_name', 'project_color', 'task_id', 'title'].every(key => typeof value[key] === 'string') &&
    ['block', 'due', 'start', 'unscheduled'].includes(String(value.kind)) &&
    statuses.has(String(value.status)) &&
    priorities.has(String(value.priority)) &&
    positiveVersion(value.version) &&
    typeof value.can_edit === 'boolean' &&
    [
      'project_archived_at',
      'assignee_member_id',
      'assignee_name',
      'start_date',
      'due_date',
      'scheduled_start_at',
      'scheduled_end_at',
      'scheduled_time_zone',
      'date',
      'start_at',
      'end_at',
    ].every(key => nullableString(value[key]))
  );
}

function validateQuery(input: CalendarQuery) {
  if (!input.workspace_ids.length || input.workspace_ids.length > 50 || input.workspace_ids.some(id => !id))
    throw new DataError('Selecciona entre uno y cincuenta espacios para el calendario.');
  if ((input.project_ids?.length ?? 0) > 250 || (input.assignee_member_ids?.length ?? 0) > 250 || input.statuses?.some(status => !statuses.has(status)))
    throw new DataError('Revisa los filtros del calendario.');
  if (!input.unscheduled) {
    if (!civilDate(input.date_from) || !civilDate(input.date_to)) throw new DataError('Revisa las fechas del calendario.');
    const days = (Date.parse(`${input.date_to}T00:00:00Z`) - Date.parse(`${input.date_from}T00:00:00Z`)) / 86400000;
    if (days <= 0 || days > 93) throw new DataError('El calendario admite una ventana de hasta 93 días.');
    if (!validZone(input.time_zone)) throw new DataError('Elige una zona horaria IANA válida.');
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 250))
    throw new DataError('El tamaño de página debe estar entre 1 y 250.');
}

export function createCalendarRepository(client: SupabaseClient) {
  async function request(name: string, parameters: Value, signal?: AbortSignal): Promise<unknown> {
    let query = client.rpc(`tr8_v2_${name}`, parameters);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw dataError(error);
    if (data === null) throw malformed();
    return data;
  }

  return {
    async calendarPreferences(signal?: AbortSignal): Promise<CalendarPreferences> {
      const result = await request('get_calendar_preferences', {}, signal);
      if (!isPreferences(result)) throw malformed();
      return result;
    },
    async setCalendarPreferences(zone: string, version: number): Promise<CalendarPreferences> {
      if (!validZone(zone) || !positiveVersion(version)) throw new DataError('Revisa la zona horaria y vuelve a cargar tus preferencias.');
      const result = await request('set_calendar_preferences', { p_time_zone: zone, p_version: version });
      if (!isPreferences(result) || result.time_zone !== zone || result.version !== version + 1) throw malformed();
      return result;
    },
    async calendarItems(input: CalendarQuery, signal?: AbortSignal): Promise<CalendarPage> {
      validateQuery(input);
      const parameters: Value = {
        p_workspace_ids: input.workspace_ids,
        p_project_ids: input.project_ids ?? null,
        p_assignee_member_ids: input.assignee_member_ids ?? null,
        p_statuses: input.statuses ?? null,
        p_mine: input.mine ?? false,
        p_include_archived: input.include_archived ?? false,
        p_cursor: input.cursor ?? null,
        p_limit: input.limit ?? 100,
      };
      if (!input.unscheduled) Object.assign(parameters, { p_date_from: input.date_from, p_date_to: input.date_to, p_time_zone: input.time_zone });
      const result = await request(input.unscheduled ? 'list_unscheduled' : 'list_calendar', parameters, signal);
      if (!record(result) || !Array.isArray(result.items) || !result.items.every(isItem) || !nullableString(result.next_cursor)) throw malformed();
      const items = result.items as CalendarItem[];
      const seen = new Set<string>();
      for (const item of items) {
        if (!input.workspace_ids.includes(item.workspace_id) || (input.project_ids && !input.project_ids.includes(item.project_id)) || seen.has(item.id))
          throw malformed();
        if (Boolean(input.unscheduled) !== (item.kind === 'unscheduled')) throw malformed();
        seen.add(item.id);
      }
      if (result.next_cursor && (result.next_cursor === input.cursor || !items.length)) throw malformed();
      return { items, next_cursor: result.next_cursor as string | null };
    },
    async scheduleTask(task: Task, input: TaskScheduleInput): Promise<Task> {
      const values = [input.scheduled_start_at, input.scheduled_end_at, input.scheduled_time_zone];
      const empty = values.every(value => value === null);
      const instant =
        /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
      const start = typeof input.scheduled_start_at === 'string' ? instantMicros(input.scheduled_start_at) : null;
      const end = typeof input.scheduled_end_at === 'string' ? instantMicros(input.scheduled_end_at) : null;
      if (
        !empty &&
        (!values.every(value => typeof value === 'string') ||
          !validZone(input.scheduled_time_zone!) ||
          !instant.test(input.scheduled_start_at!) ||
          !instant.test(input.scheduled_end_at!) ||
          !civilDate(input.scheduled_start_at!.slice(0, 10)) ||
          !civilDate(input.scheduled_end_at!.slice(0, 10)) ||
          start === null ||
          end === null ||
          end <= start)
      )
        throw new DataError('El bloque necesita inicio, fin posterior y una zona horaria válida, o los tres campos vacíos.');
      const result = await request('schedule_task', {
        p_workspace_id: task.workspace_id,
        p_id: task.id,
        p_version: task.version,
        p_scheduled_start_at: input.scheduled_start_at,
        p_scheduled_end_at: input.scheduled_end_at,
        p_scheduled_time_zone: input.scheduled_time_zone,
      });
      const historicalFields = [
        'id',
        'workspace_id',
        'owner_id',
        'project_id',
        'assignee_member_id',
        'task_number',
        'title',
        'description',
        'status',
        'priority',
        'start_date',
        'due_date',
        'position',
        'created_at',
      ] as const;
      const sameInstant = (left: unknown, right: string | null) =>
        right === null ? left === null : typeof left === 'string' && instantMicros(left) !== null && instantMicros(left) === instantMicros(right);
      if (
        !record(result) ||
        !historicalFields.every(key => result[key] === task[key]) ||
        result.version !== task.version + 1 ||
        typeof result.updated_at !== 'string' ||
        !sameInstant(result.scheduled_start_at, input.scheduled_start_at) ||
        !sameInstant(result.scheduled_end_at, input.scheduled_end_at) ||
        result.scheduled_time_zone !== input.scheduled_time_zone
      )
        throw malformed();
      return result as unknown as Task;
    },
  };
}

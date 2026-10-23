import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarItem, CalendarQuery, Task } from '../types';
import { createCalendarRepository } from './calendar';

const input: CalendarQuery = { workspace_ids: ['team-a'], date_from: '2026-03-01', date_to: '2026-04-01', time_zone: 'America/New_York' };
const item: CalendarItem = {
  id: 'task-a:due',
  kind: 'due',
  workspace_id: 'team-a',
  workspace_name: 'Equipo',
  project_id: 'project-a',
  project_name: 'Proyecto',
  project_color: '#123456',
  project_archived_at: null,
  task_id: 'task-a',
  title: 'Trabajo',
  status: 'todo',
  priority: 'none',
  version: 1,
  assignee_member_id: null,
  assignee_name: null,
  start_date: null,
  due_date: '2026-03-08',
  scheduled_start_at: null,
  scheduled_end_at: null,
  scheduled_time_zone: null,
  date: '2026-03-08',
  start_at: null,
  end_at: null,
  can_edit: false,
};
const task: Task = {
  id: 'task-a',
  workspace_id: 'team-a',
  owner_id: 'owner-a',
  project_id: 'project-a',
  assignee_member_id: null,
  task_number: 1,
  title: 'Trabajo',
  description: 'Borrador persistido',
  status: 'todo',
  priority: 'none',
  start_date: null,
  due_date: '2026-03-08',
  position: 0,
  version: 1,
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-01T00:00:00Z',
};
const schedule = { scheduled_start_at: '2026-03-08T01:15:07-05:00', scheduled_end_at: '2026-03-08T03:45:09-04:00', scheduled_time_zone: 'America/New_York' };

function setup() {
  const rpc = vi.fn();
  return { rpc, repository: createCalendarRepository({ rpc } as unknown as SupabaseClient) };
}

describe('contrato del calendario y programación', () => {
  it('mantiene las fechas civiles y pasa la ventana, zona y filtros sin descargar otras tareas', async () => {
    const { rpc, repository } = setup();
    rpc.mockResolvedValue({ data: { items: [item], next_cursor: 'opaque' }, error: null });
    const query = { ...input, project_ids: ['project-a'], statuses: ['todo' as const], mine: true, include_archived: true, cursor: 'previous', limit: 25 };
    await expect(repository.calendarItems(query)).resolves.toEqual({ items: [item], next_cursor: 'opaque' });
    expect(rpc).toHaveBeenCalledWith('tr8_v2_list_calendar', {
      p_workspace_ids: ['team-a'],
      p_project_ids: ['project-a'],
      p_assignee_member_ids: null,
      p_statuses: ['todo'],
      p_mine: true,
      p_include_archived: true,
      p_cursor: 'previous',
      p_limit: 25,
      p_date_from: '2026-03-01',
      p_date_to: '2026-04-01',
      p_time_zone: 'America/New_York',
    });
  });

  it('consulta Sin programar sin enviar fechas ni una zona innecesaria', async () => {
    const { rpc, repository } = setup();
    const unscheduled = { ...item, kind: 'unscheduled', id: 'task-a:unscheduled', date: null, due_date: null };
    rpc.mockResolvedValue({ data: { items: [unscheduled], next_cursor: null }, error: null });
    await expect(repository.calendarItems({ ...input, unscheduled: true, date_from: '', time_zone: '' })).resolves.toMatchObject({ items: [unscheduled] });
    expect(rpc.mock.calls[0][0]).toBe('tr8_v2_list_unscheduled');
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_time_zone');
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_date_from');
  });

  it.each([
    { ...input, date_to: '2026-06-03' },
    { ...input, date_from: '2026-02-30' },
    { ...input, date_to: input.date_from },
    { ...input, time_zone: 'Mars/Unknown' },
    { ...input, workspace_ids: [] },
    { ...input, limit: 251 },
  ])('rechaza una ventana o ámbito inválidos antes de la red (%j)', async query => {
    const { rpc, repository } = setup();
    await expect(repository.calendarItems(query)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { items: [{ ...item, workspace_id: 'foreign' }], next_cursor: null },
    { items: [{ ...item, can_edit: 'yes' }], next_cursor: null },
    { items: [item, item], next_cursor: null },
    { items: [item], next_cursor: 'previous' },
    { items: [], next_cursor: 'next' },
    { items: [item], next_cursor: 12 },
  ])('no acepta respuestas fuera de ámbito, duplicadas o con cursores inválidos (%j)', async data => {
    const { rpc, repository } = setup();
    rpc.mockResolvedValue({ data, error: null });
    await expect(repository.calendarItems({ ...input, cursor: 'previous' })).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('no publica una respuesta al fallar la autorización de la página', async () => {
    const { rpc, repository } = setup();
    rpc.mockResolvedValue({ data: { items: [item] }, error: { code: 'PT404', message: 'Unavailable' } });
    await expect(repository.calendarItems(input)).rejects.toMatchObject({ code: 'PT404' });
  });

  it('propaga la cancelación a PostgREST', async () => {
    const { rpc, repository } = setup();
    const signal = new AbortController().signal;
    const abortSignal = vi.fn().mockResolvedValue({ data: { items: [], next_cursor: null }, error: null });
    rpc.mockReturnValue({ abortSignal });
    await repository.calendarItems(input, signal);
    expect(abortSignal).toHaveBeenCalledWith(signal);
  });

  it('lee preferencias sin elegir una zona y exige una confirmación versionada al guardarla', async () => {
    const { rpc, repository } = setup();
    rpc
      .mockResolvedValueOnce({ data: { time_zone: null, version: 1, updated_at: null }, error: null })
      .mockResolvedValueOnce({ data: { time_zone: 'America/La_Paz', version: 2, updated_at: '2026-03-01T00:00:00Z' }, error: null });
    await expect(repository.calendarPreferences()).resolves.toMatchObject({ time_zone: null, version: 1 });
    await expect(repository.setCalendarPreferences('America/La_Paz', 1)).resolves.toMatchObject({ time_zone: 'America/La_Paz', version: 2 });
    expect(rpc).toHaveBeenLastCalledWith('tr8_v2_set_calendar_preferences', { p_time_zone: 'America/La_Paz', p_version: 1 });
  });

  it('acepta los instantes persistidos equivalentes en UTC sin cambiar el contenido', async () => {
    const { rpc, repository } = setup();
    const saved = { ...task, ...schedule, scheduled_start_at: '2026-03-08T06:15:07+00:00', scheduled_end_at: '2026-03-08T07:45:09+00:00', version: 2 };
    rpc.mockResolvedValue({ data: saved, error: null });
    await expect(repository.scheduleTask(task, schedule)).resolves.toEqual(saved);
    expect(rpc.mock.calls[0]).toEqual([
      'tr8_v2_schedule_task',
      {
        p_workspace_id: 'team-a',
        p_id: 'task-a',
        p_version: 1,
        p_scheduled_start_at: schedule.scheduled_start_at,
        p_scheduled_end_at: schedule.scheduled_end_at,
        p_scheduled_time_zone: schedule.scheduled_time_zone,
      },
    ]);
  });

  it.each([
    { ...task, ...schedule, version: 2, scheduled_end_at: '2026-03-08T08:00:00Z' },
    { ...task, ...schedule, version: 2, title: 'Contenido inesperado' },
    { ...task, ...schedule, version: 2, scheduled_time_zone: 'UTC' },
    { ...task, ...schedule, version: 2, scheduled_start_at: null },
    { ...task, ...schedule, version: 1 },
  ])('no confirma un horario o contenido distinto del solicitado (%j)', async saved => {
    const { rpc, repository } = setup();
    rpc.mockResolvedValue({ data: saved, error: null });
    await expect(repository.scheduleTask(task, schedule)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('rechaza bloques incompletos y horas sin offset antes de enviarlos', async () => {
    const { rpc, repository } = setup();
    await expect(repository.scheduleTask(task, { ...schedule, scheduled_end_at: null })).rejects.toThrow();
    await expect(repository.scheduleTask(task, { ...schedule, scheduled_start_at: '2026-11-01T01:30:00' })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('no confunde instantes que difieren en un microsegundo', async () => {
    const { rpc, repository } = setup();
    const precise = { ...schedule, scheduled_start_at: '2026-03-08T06:15:07.123456Z' };
    rpc.mockResolvedValue({ data: { ...task, ...precise, scheduled_start_at: '2026-03-08T06:15:07.123457Z', version: 2 }, error: null });
    await expect(repository.scheduleTask(task, precise)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('conserva también un bloque cuya duración es inferior a un milisegundo', async () => {
    const { rpc, repository } = setup();
    const precise = { scheduled_start_at: '2026-03-08T06:15:07.123456Z', scheduled_end_at: '2026-03-08T06:15:07.123457Z', scheduled_time_zone: 'UTC' };
    rpc.mockResolvedValue({ data: { ...task, ...precise, version: 2 }, error: null });
    await expect(repository.scheduleTask(task, precise)).resolves.toMatchObject(precise);
  });

  it('quitar un bloque conserva el vencimiento y verifica el triple nulo', async () => {
    const { rpc, repository } = setup();
    const empty = { scheduled_start_at: null, scheduled_end_at: null, scheduled_time_zone: null };
    rpc.mockResolvedValue({ data: { ...task, ...empty, version: 2 }, error: null });
    await expect(repository.scheduleTask({ ...task, ...schedule }, empty)).resolves.toMatchObject({ ...empty, due_date: '2026-03-08' });
  });
});

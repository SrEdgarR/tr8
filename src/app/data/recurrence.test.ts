import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { createRecurrenceRepository } from './recurrence';
import type { Task } from '../types';
import type { RecurrenceRule, RecurrenceState } from '../recurrence-types';

const uid = (n: number) => `f9840000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = uid(1);
const task = { id: uid(2), workspace_id: workspace, project_id: uid(3), created_at: '2026-10-29T10:00:00.000Z', version: 7, due_date: '2026-10-29' } as Task;
const rule: RecurrenceRule = { frequency: 'weekly', interval: 2, weekdays: [1, 4], time_zone: 'America/La_Paz', until_date: null };
const empty: RecurrenceState = { task_id: task.id, series: null, occurrence_date: null, successor_task_id: null };
const saved: RecurrenceState = {
  task_id: task.id,
  occurrence_date: task.due_date,
  successor_task_id: null,
  series: {
    id: uid(4),
    workspace_id: workspace,
    project_id: task.project_id,
    version: 1,
    rule,
    anchor_date: task.due_date!,
    state: 'active',
    reason: null,
    current_task_id: task.id,
    current_task_created_at: task.created_at,
    current_occurrence_date: task.due_date!,
  },
};
function setup(data: unknown = empty) {
  const abortSignal = vi.fn().mockResolvedValue({ data, error: null });
  const rpc = vi.fn().mockReturnValue(Object.assign(Promise.resolve({ data, error: null }), { abortSignal }));
  return { rpc, abortSignal, api: createRecurrenceRepository({ rpc } as unknown as SupabaseClient, workspace) };
}
describe('recurrence browser transport', () => {
  it('reads only the exact task incarnation in the selected workspace and supports cancellation', async () => {
    const { api, rpc, abortSignal } = setup();
    const signal = new AbortController().signal;
    expect(await api.state(task, signal)).toEqual(empty);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('tr8_v2_recurrence', {
      p_workspace_id: workspace,
      p_action: 'state',
      p_input: { id: task.id, project_id: task.project_id, created_at: task.created_at },
    });
    expect(abortSignal).toHaveBeenCalledWith(signal);
  });
  it('sends task and series CAS versions plus a stable request identity without mutating the task', async () => {
    const { api, rpc } = setup(saved);
    expect(await api.save(task, null, rule, uid(5))).toEqual(saved);
    expect(rpc.mock.calls[0][1].p_input).toEqual({
      id: task.id,
      project_id: task.project_id,
      created_at: task.created_at,
      task_version: 7,
      series_version: null,
      request_id: uid(5),
      rule,
    });
    expect(task.version).toBe(7);
  });
  it('freezes weekdays while a request is pending and preserves its identity on retry', async () => {
    const { api, rpc } = setup(saved);
    rpc.mockRejectedValueOnce(new TypeError('Network unavailable'));
    const draft = { ...rule, weekdays: [...rule.weekdays] };
    const first = api.save(task, null, draft, uid(5));
    draft.weekdays.push(7);
    await expect(first).rejects.toMatchObject({ name: 'DataError' });
    await api.save(task, null, rule, uid(5));
    expect(rpc.mock.calls[0][1]).toEqual(rpc.mock.calls[1][1]);
  });
  it('allows pausing a configured task whose due date was removed', async () => {
    const { api, rpc } = setup(saved);
    await api.save({ ...task, due_date: null }, 1, null, uid(5));
    expect(rpc.mock.calls[0][1].p_input.rule).toBeNull();
  });
  it.each([
    { ...task, workspace_id: uid(9) },
    { ...task, created_at: 'yesterday' },
    { ...task, id: 'bad' },
    { ...task, version: 0 },
    { ...task, version: 2147483648 },
  ])('rejects a foreign or malformed task before transport (%#)', async value => {
    const { api, rpc } = setup();
    await expect(api.state(value)).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    { value: { ...rule, interval: 0 } },
    { value: { ...rule, weekdays: [1, 1] } },
    { value: { ...rule, time_zone: 'Dominican Republic' } },
    { value: { ...rule, until_date: '2026-02-30' } },
    { value: { ...rule, extra: true } },
  ])('rejects malformed rules before transport (%#)', async ({ value }) => {
    const { api, rpc } = setup();
    await expect(api.save(task, null, value, uid(5))).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { ...empty, task_id: uid(99) },
    { ...empty, extra: true },
    { ...empty, successor_task_id: uid(8) },
    { ...saved, series: { ...saved.series, workspace_id: uid(9) } },
    { ...saved, series: { ...saved.series, project_id: uid(9) } },
    { ...saved, series: { ...saved.series, version: 0 } },
    { ...saved, series: { ...saved.series, reason: 'secret text not a code' } },
    { ...saved, series: { ...saved.series, current_occurrence_date: '2026-02-30' } },
  ])('never accepts malformed or out-of-scope output (%#)', async value => {
    const { api } = setup(value);
    await expect(api.state(task)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });
  it('propagates server conflicts rather than reporting successful configuration', async () => {
    const { api, rpc } = setup();
    rpc.mockResolvedValue({ data: null, error: { message: 'Task changed', code: 'PT409' } });
    await expect(api.save(task, 1, rule, uid(5))).rejects.toMatchObject({ code: 'PT409' });
  });
  it('reads all cursor pages in order with the same abort signal', async () => {
    const row = { series_id: uid(4), task_id: task.id, frequency: 'daily', interval: 1, state: 'active' };
    const second = { ...row, series_id: uid(5), task_id: uid(6) };
    const { api, rpc } = setup();
    const signal = new AbortController().signal;
    const firstAbort = vi.fn().mockResolvedValue({ data: { items: [row], next_cursor: row.series_id }, error: null });
    const lastAbort = vi.fn().mockResolvedValue({ data: { items: [second], next_cursor: null }, error: null });
    rpc.mockReturnValueOnce({ abortSignal: firstAbort }).mockReturnValueOnce({ abortSignal: lastAbort });
    expect(await api.summaries(signal)).toEqual([row, second]);
    expect(rpc.mock.calls[1][1].p_input.after_id).toBe(row.series_id);
    expect(firstAbort).toHaveBeenCalledWith(signal);
    expect(lastAbort).toHaveBeenCalledWith(signal);
  });
  it.each([
    { items: [], next_cursor: uid(4) },
    { items: [], next_cursor: 'bad' },
    { items: [], next_cursor: null, extra: true },
    { items: [{ series_id: uid(4), task_id: task.id, frequency: 'monthly', interval: 13, state: 'active' }], next_cursor: null },
  ])('fails closed for malformed cursors or summaries (%#)', async value => {
    await expect(setup(value).api.summaries()).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });
  it('rejects a duplicate head task across pages', async () => {
    const row = { series_id: uid(4), task_id: task.id, frequency: 'daily', interval: 1, state: 'active' };
    const { api, rpc } = setup({ items: [{ ...row, series_id: uid(5) }], next_cursor: null });
    rpc.mockResolvedValueOnce({ data: { items: [row], next_cursor: row.series_id }, error: null });
    await expect(api.summaries()).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });
});

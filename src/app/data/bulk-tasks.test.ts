import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { createBulkTasksRepository } from './bulk-tasks';
import type { BulkTaskItem, BulkTaskOperation, BulkTaskRequest } from '../bulk-task-types';

const uid = (n: number) => `f9820000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspace = uid(1),
  items: BulkTaskItem[] = [
    { id: uid(2), project_id: uid(3), version: 7 },
    { id: uid(4), project_id: uid(5), version: 3 },
  ];
const request = { id: uid(6), requested_at: '2026-10-28T18:00:00.000Z' };
const operation: BulkTaskOperation = { kind: 'status', status: 'done' };
const result = {
  request_id: request.id,
  results: [
    { id: items[0].id, outcome: 'applied', code: null },
    { id: items[1].id, outcome: 'rejected', code: 'PT409' },
  ],
};
function setup(data: unknown = result, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { rpc, api: createBulkTasksRepository({ rpc } as unknown as SupabaseClient, workspace) };
}

describe('bulk task browser contract', () => {
  it('sends one RPC with exact project/version/time and preserves partial outcomes', async () => {
    const { rpc, api } = setup();
    expect(await api.apply(operation, items, request)).toEqual(result);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('tr8_v2_bulk_tasks', {
      p_workspace_id: workspace,
      p_request_id: request.id,
      p_requested_at: request.requested_at,
      p_operation: operation,
      p_items: items,
    });
  });
  it.each<BulkTaskOperation>([
    { kind: 'priority', priority: 'urgent' },
    { kind: 'assign', assignee_member_id: uid(9) },
    { kind: 'assign', assignee_member_id: null },
    { kind: 'archive' },
    { kind: 'delete' },
  ])('supports $kind', async next => {
    const { rpc, api } = setup();
    await api.apply(next, items, request);
    expect(rpc.mock.calls[0][1].p_operation).toEqual(next);
  });
  it('retains exact identity on explicit retry after an ambiguous transport failure', async () => {
    const { rpc, api } = setup();
    rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api.apply(operation, items, request)).rejects.toMatchObject({ name: 'DataError' });
    await expect(api.apply(operation, items, request)).resolves.toEqual(result);
    expect(rpc.mock.calls[1][1]).toEqual(rpc.mock.calls[0][1]);
  });
  it('freezes the validation baseline while transport is pending', async () => {
    let finish!: (value: unknown) => void;
    const { rpc, api } = setup();
    rpc.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const draft = items.map(item => ({ ...item }));
    const response = api.apply(operation, draft, { ...request });
    draft[0].id = uid(99);
    finish({ data: result, error: null });
    await expect(response).resolves.toEqual(result);
    expect(rpc.mock.calls[0][1].p_items[0].id).toBe(items[0].id);
  });
  it.each(
    [
      [],
      Array.from({ length: 51 }, (_, n) => ({ id: uid(n + 20), project_id: uid(3), version: 1 })),
      [items[0], items[0]],
      [{ ...items[0], version: 0 }],
      [{ ...items[0], version: 2147483648 }],
      [{ ...items[0], version: 1.2 }],
      [{ ...items[0], id: 'bad' }],
      [{ ...items[0], project_id: 'bad' }],
      [{ ...items[0], workspace_id: workspace }],
    ].map(value => ({ value })),
  )('rejects malformed item sets (%#)', async ({ value }) => {
    const { rpc, api } = setup();
    await expect(api.apply(operation, value as BulkTaskItem[], request)).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('accepts fifty distinct tasks and accounts for every result', async () => {
    const batch = Array.from({ length: 50 }, (_, n) => ({ id: uid(n + 20), project_id: uid(3), version: 1 }));
    const fifty = { request_id: request.id, results: batch.map(row => ({ id: row.id, outcome: 'applied', code: null })) };
    const { rpc, api } = setup(fifty);
    await expect(api.apply(operation, batch, request)).resolves.toEqual(fifty);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([
    { kind: 'status', status: 'bad' },
    { kind: 'status', status: ['done'] },
    { kind: 'priority', priority: 'bad' },
    { kind: 'assign' },
    { kind: 'assign', assignee_member_id: 'bad' },
    { kind: 'delete', extra: true },
    { kind: 'restore' },
  ])('rejects malformed operations (%#)', async value => {
    const { rpc, api } = setup();
    await expect(api.apply(value as BulkTaskOperation, items, request)).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    { ...request, id: 'bad' },
    { ...request, requested_at: '2026-02-30T18:00:00.000Z' },
    { ...request, requested_at: 'tomorrow' },
    { ...request, requested_at: '2026-10-28' },
    { ...request, extra: true },
  ])('rejects malformed request identity (%#)', async value => {
    const { rpc, api } = setup();
    await expect(api.apply(operation, items, value as BulkTaskRequest)).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { ...result, request_id: uid(99) },
    { ...result, results: [] },
    { ...result, results: [result.results[0], result.results[0]] },
    { ...result, results: [result.results[0], { id: uid(99), outcome: 'applied', code: null }] },
    { ...result, results: [{ ...result.results[0], code: 'PT409' }, result.results[1]] },
    { ...result, results: [result.results[0], { ...result.results[1], code: null }] },
    { ...result, results: [result.results[0], { ...result.results[1], outcome: 'success' }] },
    { ...result, title: 'No extra data' },
  ])('does not report success for malformed or foreign response (%#)', async value => {
    const { api } = setup(value);
    await expect(api.apply(operation, items, request)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });
  it.each(['PT409', '42501', 'PT410', 'PT429'])('preserves server rejection %s', async code => {
    const { api } = setup(null, { code, message: 'Do not show internals' });
    await expect(api.apply(operation, items, request)).rejects.toMatchObject({ code });
  });
  it('rejects malformed workspace before transport', () => {
    expect(() => createBulkTasksRepository({} as SupabaseClient, 'bad')).toThrow();
  });
});

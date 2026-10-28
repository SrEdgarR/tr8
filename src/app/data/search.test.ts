import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { GlobalSearchPage, GlobalSearchQuery, GlobalSearchResult } from '../search-types';
import { createGlobalSearchRepository, normalizeSearchQuery } from './search';

const uid = (n: number) => `f9810000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspaceId = uid(1),
  projectId = uid(2),
  taskId = uid(3);
const at = '2026-10-28T14:00:00.000001+00:00';
const query: GlobalSearchQuery = { query: 'Diseño', kind: 'all', include_archived: false, offset: 0, limit: 5 };
const project: GlobalSearchResult = {
  id: projectId,
  kind: 'project',
  workspace_id: workspaceId,
  project_id: projectId,
  task_id: null,
  title: 'Diseño web',
  snippet: 'Preparar la experiencia del sitio',
  project_name: 'Diseño web',
  project_color: '#6366F1',
  project_icon: 'globe',
  status: 'active',
  priority: null,
  content_type: null,
  member_id: null,
  author_name: null,
  updated_at: at,
  archived: false,
};
const task: GlobalSearchResult = { ...project, id: taskId, kind: 'task', task_id: taskId, title: 'Diseño de portada', status: 'todo', priority: 'high' };
const member: GlobalSearchResult = {
  ...project,
  id: uid(4),
  kind: 'member',
  project_id: null,
  project_name: null,
  project_color: null,
  project_icon: null,
  title: 'Diseño de producto',
  snippet: 'Miembro del equipo',
  status: 'active',
  member_id: uid(4),
};
const file: GlobalSearchResult = { ...project, id: uid(5), kind: 'file', title: 'Diseño.pdf', status: 'ready', content_type: 'application/pdf' };
const comment: GlobalSearchResult = {
  ...project,
  id: uid(6),
  kind: 'comment',
  task_id: taskId,
  title: task.title,
  snippet: 'Revisar este diseño.',
  status: 'todo',
  author_name: 'Miembro',
};
const rows = [project, task, member, file, comment];
function page(items = rows, input = query, counts?: GlobalSearchPage['counts']): GlobalSearchPage {
  const actual = { project: 0, task: 0, member: 0, file: 0, comment: 0 };
  for (const item of items) actual[item.kind]++;
  const totals = counts ?? actual;
  const next =
    input.kind !== 'all' && input.offset + input.limit < totals[input.kind] && input.offset + input.limit <= 10000 ? input.offset + input.limit : null;
  return {
    workspace_id: workspaceId,
    query: input.query,
    kind: input.kind,
    include_archived: input.include_archived,
    items,
    counts: totals,
    next_offset: next,
  };
}
function setup(data: unknown = page(), error: unknown = null, scope = workspaceId) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  const repository = createGlobalSearchRepository({ rpc } as unknown as SupabaseClient, scope);
  return { rpc, repository };
}

describe('global search browser transport', () => {
  it('uses the exact workspace RPC and sends a trimmed literal query', async () => {
    const input = { ...query, query: "  Diseño%_ '  " };
    const normalized = { ...input, query: "Diseño%_ '" };
    const { repository, rpc } = setup(page([], normalized));
    expect(await repository.search(input)).toEqual(page([], normalized));
    expect(rpc).toHaveBeenCalledExactlyOnceWith('tr8_v2_search', { p_workspace_id: workspaceId, p_input: normalized });
  });

  it('attaches cancellation to the authorized request', async () => {
    const abortSignal = vi.fn().mockResolvedValue({ data: page(), error: null });
    const rpc = vi.fn().mockReturnValue({ abortSignal });
    const repository = createGlobalSearchRepository({ rpc } as unknown as SupabaseClient, workspaceId);
    const controller = new AbortController();
    expect(await repository.search(query, controller.signal)).toEqual(page());
    expect(abortSignal).toHaveBeenCalledExactlyOnceWith(controller.signal);
  });

  it('does not throw while rendering a repository with an invalid context and never sends its RPC', async () => {
    const rpc = vi.fn();
    const repository = createGlobalSearchRepository({ rpc } as unknown as SupabaseClient, 'old-context');
    await expect(repository.search(query)).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(['', ' ', 'a', 'x'.repeat(101), '\nDiseño', 'Diseño\tweb', 'Diseño\rweb', 'Diseño\u0001', 'Diseño\u007f', 'Diseño\u0085', 'Diseño\ud800'])(
    'rejects invalid query text before any request: %j',
    async value => {
      const { rpc, repository } = setup();
      await expect(repository.search({ ...query, query: value })).rejects.toMatchObject({ code: '22023' });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it('counts Unicode codepoints instead of UTF-16 units and keeps spaces inside literal queries', async () => {
    const value = '😀'.repeat(100);
    expect(normalizeSearchQuery(` ${value} `)).toBe(value);
    expect(normalizeSearchQuery('  diseño  web  ')).toBe('diseño  web');
    expect(() => normalizeSearchQuery('😀'.repeat(101))).toThrow();
    const input = { ...query, query: value };
    expect(await setup(page([], input)).repository.search(input)).toEqual(page([], input));
  });

  it('rejects unknown input keys, category and pagination values before the RPC', async () => {
    const { rpc, repository } = setup();
    for (const input of [
      null,
      { ...query, unknown: true },
      { ...query, kind: 'finance' },
      { ...query, include_archived: 'true' },
      { ...query, offset: 1 },
      { ...query, kind: 'task', offset: -1 },
      { ...query, kind: 'task', offset: 10001 },
      { ...query, kind: 'task', offset: 0.5 },
      { ...query, limit: 0 },
      { ...query, limit: 51 },
      { ...query, limit: 1.1 },
      { ...query, limit: Number.POSITIVE_INFINITY },
      { ...query, query: null },
    ])
      await expect(repository.search(input as GlobalSearchQuery)).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns balanced category groups while keeping exact totals independent of a selected category', async () => {
    const input = { ...query, limit: 1 };
    const counts = { project: 9, task: 8, member: 7, file: 6, comment: 5 };
    const expected = page(rows, input, counts);
    expect(await setup(expected).repository.search(input)).toEqual(expected);
    const selected = { ...query, kind: 'task' as const, limit: 1 };
    expect(await setup(page([task], selected, counts)).repository.search(selected)).toMatchObject({ counts, next_offset: 1 });
  });

  it('validates category pagination and permits a complete empty page beyond its last result', async () => {
    const selected = { ...query, kind: 'task' as const, limit: 2, offset: 2 };
    const items = [
      { ...task, id: uid(40), task_id: uid(40) },
      { ...task, id: uid(30), task_id: uid(30) },
    ];
    const counts = { project: 0, task: 5, member: 0, file: 0, comment: 0 };
    expect(await setup(page(items, selected, counts)).repository.search(selected)).toMatchObject({ next_offset: 4 });
    const past = { ...selected, offset: 6 };
    expect(await setup(page([], past, counts)).repository.search(past)).toMatchObject({ items: [], next_offset: null });
  });

  it('keeps the final bounded offset page but does not request pages beyond 10000', async () => {
    const selected = { ...query, kind: 'task' as const, limit: 1, offset: 10000 };
    const counts = { project: 0, task: 10002, member: 0, file: 0, comment: 0 };
    expect(await setup(page([task], selected, counts)).repository.search(selected)).toMatchObject({ next_offset: null });
  });

  it('fails closed if a page echoes another account scope, term, category or archive selection', async () => {
    const base = page();
    for (const value of [
      null,
      { ...base, extra: true },
      { ...base, workspace_id: uid(70) },
      { ...base, query: 'Otra' },
      { ...base, kind: 'task' },
      { ...base, include_archived: true },
      { ...base, items: null },
    ])
      await expect(setup(value).repository.search(query)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('rejects duplicate result identities but allows the same UUID in separate resource types', async () => {
    const duplicate = page([project, { ...project, id: project.id.toUpperCase(), project_id: project.id.toUpperCase() }]);
    await expect(setup(duplicate).repository.search(query)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    const shared = { ...task, id: project.id, task_id: project.id };
    expect(await setup(page([project, shared])).repository.search(query)).toMatchObject({ items: [project, shared] });
  });

  it('rejects additional private fields, unknown kinds and foreign result workspaces', async () => {
    for (const patch of [
      { email: 'private@example.test' },
      { object_path: 'private/path' },
      { author_id: uid(20) },
      { id: 'invalid' },
      { kind: 'finance' },
      { workspace_id: uid(20) },
      { title: '' },
      { title: 'x'.repeat(241) },
      { snippet: 'x'.repeat(241) },
      { archived: 'false' },
    ])
      await expect(setup(page([{ ...project, ...patch } as GlobalSearchResult])).repository.search(query)).rejects.toMatchObject({
        code: 'CLIENT_UPGRADE_REQUIRED',
      });
  });

  it('checks closed result keys instead of interpreting absent nullable fields as permission', async () => {
    const missing = { ...project } as Partial<GlobalSearchResult>;
    delete missing.project_id;
    await expect(setup(page([missing as GlobalSearchResult])).repository.search(query)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('rejects task, project and member identifiers that do not identify their result', async () => {
    const values = [
      { ...project, project_id: uid(20) },
      { ...task, task_id: uid(20) },
      { ...member, member_id: uid(20) },
    ];
    for (const value of values) await expect(setup(page([value])).repository.search(query)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('keeps project presentation allowlisted and coherent', async () => {
    for (const patch of [
      { project_color: 'url(javascript:evil)' },
      { project_color: '#123' },
      { project_icon: '<svg>' },
      { project_name: '' },
      { project_name: 'x'.repeat(121) },
      { title: 'Unrelated project' },
      { status: 'todo' },
      { priority: 'high' },
      { task_id: taskId },
      { member_id: uid(20) },
      { author_name: 'Unexpected' },
    ])
      await expect(setup(page([{ ...project, ...patch } as GlobalSearchResult])).repository.search(query)).rejects.toMatchObject({
        code: 'CLIENT_UPGRADE_REQUIRED',
      });
  });

  it('accepts only task statuses, priorities and a live project identity for task results', async () => {
    for (const patch of [
      { status: 'active' },
      { priority: 'critical' },
      { priority: null },
      { project_id: null },
      { content_type: 'text/plain' },
      { member_id: uid(20) },
      { author_name: 'Unexpected' },
    ])
      await expect(setup(page([{ ...task, ...patch } as GlobalSearchResult])).repository.search(query)).rejects.toMatchObject({
        code: 'CLIENT_UPGRADE_REQUIRED',
      });
  });

  it('does not allow member results to expose projects, authors, roles or inactive accounts', async () => {
    for (const patch of [
      { status: 'removed' },
      { project_id: projectId },
      { project_name: project.title },
      { task_id: taskId },
      { priority: 'none' },
      { content_type: 'text/plain' },
      { author_name: 'Unexpected' },
      { roles: ['Admin'] },
      { title: 'x'.repeat(121) },
    ])
      await expect(setup(page([{ ...member, ...patch } as GlobalSearchResult])).repository.search(query)).rejects.toMatchObject({
        code: 'CLIENT_UPGRADE_REQUIRED',
      });
  });

  it('allows only ready files with an admitted content type and no download or author data', async () => {
    for (const patch of [
      { status: 'pending' },
      { task_id: taskId },
      { priority: 'none' },
      { content_type: 'text/html' },
      { author_name: 'Unexpected' },
      { object_path: 'bucket/path' },
    ])
      await expect(setup(page([{ ...file, ...patch } as GlobalSearchResult])).repository.search(query)).rejects.toMatchObject({
        code: 'CLIENT_UPGRADE_REQUIRED',
      });
    expect(await setup(page([file])).repository.search(query)).toMatchObject({ items: [file] });
  });

  it('requires comments to keep their task scope and a safe current author label', async () => {
    for (const patch of [
      { task_id: null },
      { priority: 'none' },
      { content_type: 'text/plain' },
      { status: 'active' },
      { author_name: null },
      { author_name: '' },
      { author_name: 'x'.repeat(121) },
      { member_id: uid(20) },
    ])
      await expect(setup(page([{ ...comment, ...patch } as GlobalSearchResult])).repository.search(query)).rejects.toMatchObject({
        code: 'CLIENT_UPGRADE_REQUIRED',
      });
    const literal = { ...comment, snippet: '<img src=x onerror=alert(1)>' };
    expect(await setup(page([literal])).repository.search(query)).toMatchObject({ items: [literal] });
  });

  it('includes archived results only after explicit selection and never treats a member as archived', async () => {
    const archived = { ...task, archived: true };
    await expect(setup(page([archived])).repository.search(query)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    const input = { ...query, include_archived: true };
    expect(await setup(page([archived], input)).repository.search(input)).toMatchObject({ items: [archived] });
    await expect(setup(page([{ ...member, archived: true }], input)).repository.search(input)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('rejects invalid civil dates and clocks instead of relying on Date normalization', async () => {
    for (const updated_at of [
      '2026-02-30T12:00:00Z',
      '0000-01-01T12:00:00Z',
      '2026-10-28T24:00:00Z',
      '2026-10-28T12:60:00Z',
      '2026-10-28T12:00:60Z',
      '2026-10-28',
      '2026-10-28T12:00:00+24:00',
      '2026-10-28T12:00:00.1234567Z',
    ])
      await expect(setup(page([{ ...project, updated_at }])).repository.search(query)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('keeps stable server ordering including timestamps within one millisecond', async () => {
    const newest = { ...project, id: uid(10), project_id: uid(10), updated_at: '2026-10-28T14:00:00.000002+00:00' };
    const older = { ...project, id: uid(20), project_id: uid(20), updated_at: '2026-10-28T14:00:00.000001+00:00' };
    expect(await setup(page([newest, older])).repository.search(query)).toMatchObject({ items: [newest, older] });
    await expect(setup(page([older, newest])).repository.search(query)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    await expect(
      setup(
        page([
          { ...newest, updated_at: at },
          { ...older, updated_at: at },
        ]),
      ).repository.search(query),
    ).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    await expect(setup(page([task, project])).repository.search(query)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('requires exact category totals and balanced page sizes without inventing inaccessible matches', async () => {
    const base = page();
    for (const counts of [
      null,
      { ...base.counts, extra: 1 },
      { ...base.counts, task: -1 },
      { ...base.counts, task: 1.5 },
      { ...base.counts, task: '1' },
      { ...base.counts, task: Number.MAX_SAFE_INTEGER + 1 },
      { ...base.counts, task: 0 },
      { ...base.counts, task: 2 },
    ])
      await expect(setup({ ...base, counts }).repository.search(query)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    const input = { ...query, limit: 1 };
    const extra = { ...task, id: uid(8), task_id: uid(8) };
    await expect(setup(page([extra, task], input)).repository.search(input)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('rejects mixed categories or ambiguous next offsets for a category page', async () => {
    const selected = { ...query, kind: 'task' as const, limit: 1 };
    const counts = { project: 9, task: 2, member: 0, file: 0, comment: 0 };
    const base = page([task], selected, counts);
    for (const next_offset of [null, 0, 2, '1', Number.NaN])
      await expect(setup({ ...base, next_offset }).repository.search(selected)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    await expect(setup({ ...base, items: [project] }).repository.search(selected)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    await expect(setup({ ...page(), next_offset: 5 }).repository.search(query)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('does not reuse an earlier query response after the user changes the term', async () => {
    await expect(setup(page()).repository.search({ ...query, query: 'Portada' })).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it.each(['PT404', '42501', 'PGRST301', 'PGRST303', 'PGRST202'])('preserves access and upgrade errors for the account wrapper: %s', async code => {
    await expect(setup(null, { code, message: 'Private server detail' }).repository.search(query)).rejects.toMatchObject({ code });
  });

  it('turns validation and connection failures into safe Spanish errors without echoing server details', async () => {
    await expect(setup(null, { code: '22023', message: 'secret SQL detail' }).repository.search(query)).rejects.toThrow('Escribe una búsqueda');
    await expect(setup(null, { message: 'network timeout secret' }).repository.search(query)).rejects.toThrow('problema de conexión');
  });
});

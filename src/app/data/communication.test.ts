import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { CommentThread, InboxNotification, TaskComment } from '../communication-types';
import type { Task } from '../types';
import { createCommunicationRepository, normalizeCommentBody } from './communication';

const uid = (n: number) => `f9700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspaceId = uid(1),
  projectId = uid(2),
  taskId = uid(3),
  commentId = uid(4),
  authorId = uid(5),
  memberId = uid(6);
const at = '2026-10-28T14:00:00.000000+00:00';
const task = { id: taskId, workspace_id: workspaceId, project_id: projectId, version: 2 } as Task;
const comment: TaskComment = {
  id: commentId,
  workspace_id: workspaceId,
  task_id: taskId,
  author_id: authorId,
  author_name: 'Tú',
  body: 'Revisemos el diseño.',
  mentions: [{ member_id: memberId, display_name: 'Ana' }],
  reactions: [],
  version: 1,
  sequence: 10,
  created_at: at,
  updated_at: at,
  can_edit: true,
  can_delete: true,
};
const thread: CommentThread = { items: [comment], next_before_id: null, participants: [{ member_id: memberId, display_name: 'Ana' }] };
const notification: InboxNotification = {
  id: uid(7),
  workspace_id: workspaceId,
  project_id: projectId,
  task_id: taskId,
  comment_id: commentId,
  kind: 'mention',
  actor_name: 'Ana',
  project_name: 'Lanzamiento',
  project_color: '#6366F1',
  project_icon: 'rocket',
  task_title: 'Preparar portada',
  created_at: at,
  read_at: null,
};
function setup(data: unknown = thread, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  const repository = createCommunicationRepository({ rpc } as unknown as SupabaseClient, workspaceId);
  return { rpc, repository };
}

describe('communication browser transport', () => {
  it('loads a thread only in its task and workspace with an abort signal', async () => {
    const abortSignal = vi.fn().mockResolvedValue({ data: thread, error: null });
    const rpc = vi.fn().mockReturnValue({ abortSignal });
    const repository = createCommunicationRepository({ rpc } as unknown as SupabaseClient, workspaceId);
    const controller = new AbortController();
    expect(await repository.thread(task, null, controller.signal)).toEqual(thread);
    expect(rpc).toHaveBeenCalledWith('tr8_v2_communication', {
      p_workspace_id: workspaceId,
      p_action: 'thread',
      p_input: { task_id: taskId, before_id: null, limit: 50 },
    });
    expect(abortSignal).toHaveBeenCalledWith(controller.signal);
  });

  it('loads prior pages with strictly decreasing sequences and the exact last cursor', async () => {
    const items = Array.from({ length: 50 }, (_, index) => ({ ...comment, id: uid(index + 100), sequence: 150 - index }));
    const { rpc, repository } = setup({ ...thread, items, next_before_id: 101 });
    expect(await repository.thread(task, 151)).toMatchObject({ next_before_id: 101 });
    expect(rpc).toHaveBeenCalledWith('tr8_v2_communication', {
      p_workspace_id: workspaceId,
      p_action: 'thread',
      p_input: { task_id: taskId, before_id: 151, limit: 50 },
    });
  });

  it('rejects foreign task scopes and invalid cursor input before requesting data', async () => {
    const { rpc, repository } = setup();
    for (const input of [
      { ...task, workspace_id: uid(20) },
      { ...task, id: 'bad' },
      { ...task, project_id: 'bad' },
      { ...task, version: 0 },
    ])
      await expect(repository.thread(input)).rejects.toMatchObject({ code: '22023' });
    for (const cursor of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      await expect(repository.thread(task, cursor)).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('fails closed for foreign, duplicate and unbounded thread results', async () => {
    for (const value of [
      null,
      { ...thread, extra: true },
      { ...thread, items: [{ ...comment, workspace_id: uid(20) }] },
      { ...thread, items: [{ ...comment, task_id: uid(20) }] },
      { ...thread, items: [comment, comment] },
      { ...thread, items: [comment, { ...comment, id: uid(20) }] },
      { ...thread, items: [{ ...comment, sequence: 0 }] },
      { ...thread, items: Array.from({ length: 51 }, (_, index) => ({ ...comment, id: uid(index + 100), sequence: 100 - index })) },
      { ...thread, items: [comment, { ...comment, id: uid(20), sequence: 11 }] },
    ])
      await expect(setup(value).repository.thread(task)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('rejects invalid pagination cursors and records crossing the requested cursor', async () => {
    for (const value of [
      { ...thread, next_before_id: 10 },
      { ...thread, items: [], next_before_id: 10 },
      { ...thread, next_before_id: '10' },
    ])
      await expect(setup(value).repository.thread(task)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    await expect(setup(thread).repository.thread(task, 10)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    const items = Array.from({ length: 50 }, (_, index) => ({ ...comment, id: uid(index + 100), sequence: 100 - index }));
    await expect(setup({ ...thread, items, next_before_id: 50 }).repository.thread(task)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('validates participant identities, names and the bounded directory', async () => {
    for (const participants of [
      [thread.participants[0], thread.participants[0]],
      [{ ...thread.participants[0], member_id: 'bad' }],
      [{ ...thread.participants[0], email: 'private@example.test' }],
      [{ ...thread.participants[0], display_name: 'x'.repeat(121) }],
      Array.from({ length: 201 }, (_, index) => ({ member_id: uid(index + 100), display_name: 'Miembro' })),
    ])
      await expect(setup({ ...thread, participants }).repository.thread(task)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('checks closed comments and nested reaction/mention records', async () => {
    for (const patch of [
      { extra: 'private' },
      { id: 'bad' },
      { author_id: 'bad' },
      { author_name: '' },
      { body: '' },
      { body: 'x'.repeat(4001) },
      { mentions: [...comment.mentions, ...comment.mentions] },
      { mentions: [{ ...comment.mentions[0], email: 'private@example.test' }] },
      { reactions: [{ emoji: '🔥', count: 1, mine: true }] },
      { reactions: [{ emoji: '👍', count: 0, mine: false }] },
      { reactions: [{ emoji: '👍', count: 20001, mine: true }] },
      { reactions: [{ emoji: '👍', count: 1.5, mine: true }] },
      { reactions: [{ emoji: '👍', count: 1, mine: 'true' }] },
      { reactions: [{ emoji: '👍', count: 1, mine: true, names: ['private'] }] },
      {
        reactions: [
          { emoji: '👍', count: 1, mine: true },
          { emoji: '👍', count: 2, mine: false },
        ],
      },
      { version: 0 },
      { version: 1000000000 },
      { can_edit: 'true' },
      { can_delete: null },
    ])
      await expect(setup({ ...thread, items: [{ ...comment, ...patch }] }).repository.thread(task)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('rejects invalid civil timestamp dates instead of accepting Date.parse rollover', async () => {
    for (const date of ['2026-02-30T14:00:00Z', '2026-13-28T14:00:00Z', '0000-10-28T14:00:00Z', '2026-10-28', '2026-10-28T24:00:00Z', 'not a date'])
      await expect(setup({ ...thread, items: [{ ...comment, created_at: date }] }).repository.thread(task)).rejects.toMatchObject({
        code: 'CLIENT_UPGRADE_REQUIRED',
      });
    await expect(setup({ ...thread, items: [{ ...comment, updated_at: '2026-10-27T14:00:00Z' }] }).repository.thread(task)).rejects.toMatchObject({
      code: 'CLIENT_UPGRADE_REQUIRED',
    });
  });

  it('normalizes body whitespace and counts Unicode characters rather than UTF16 units', () => {
    expect(normalizeCommentBody('  Bien\n\tHecho ❤️  ')).toBe('Bien\n\tHecho ❤️');
    expect(normalizeCommentBody('😀'.repeat(4000))).toHaveLength(8000);
    expect(normalizeCommentBody('<script>texto</script>')).toBe('<script>texto</script>');
    for (const body of ['', ' \n\t ', 'x'.repeat(4001), '😀'.repeat(4001), '\u0000hola', 'hola\u0007', '\u007f', '\u0085', '\ud800'])
      expect(() => normalizeCommentBody(body)).toThrow();
  });

  it('creates with stable identity, normalized body and structured member IDs', async () => {
    const { rpc, repository } = setup(comment);
    expect(await repository.create(task, commentId, `  ${comment.body}  `, [memberId])).toEqual(comment);
    expect(rpc).toHaveBeenCalledWith('tr8_v2_communication', {
      p_workspace_id: workspaceId,
      p_action: 'create',
      p_input: { id: commentId, task_id: taskId, body: comment.body, mention_member_ids: [memberId] },
    });
  });

  it('accepts an idempotent create replay after a later edit without overwriting it', async () => {
    const replay = { ...comment, body: 'Edición posterior', version: 3 };
    expect(await setup(replay).repository.create(task, commentId, comment.body, [memberId])).toEqual(replay);
  });

  it('rejects invalid create IDs, body, duplicate and oversized mentions before network access', async () => {
    const { rpc, repository } = setup(comment);
    await expect(repository.create(task, 'bad', comment.body, [])).rejects.toMatchObject({ code: '22023' });
    await expect(repository.create(task, commentId, '', [])).rejects.toMatchObject({ code: '22023' });
    await expect(repository.create(task, commentId, comment.body, ['bad'])).rejects.toMatchObject({ code: '22023' });
    await expect(repository.create(task, commentId, comment.body, [memberId, memberId])).rejects.toMatchObject({ code: '22023' });
    await expect(
      repository.create(
        task,
        commentId,
        comment.body,
        Array.from({ length: 11 }, (_, index) => uid(index + 100)),
      ),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(repository.create({ ...task, workspace_id: uid(20) }, commentId, comment.body, [])).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a create response substituted into another task, workspace, ID or mention audience', async () => {
    for (const patch of [
      { id: uid(20) },
      { task_id: uid(20) },
      { workspace_id: uid(20) },
      { mentions: [] },
      { mentions: [{ member_id: uid(20), display_name: 'Ana' }] },
    ])
      await expect(setup({ ...comment, ...patch }).repository.create(task, commentId, comment.body, [memberId])).rejects.toMatchObject({
        code: 'CLIENT_UPGRADE_REQUIRED',
      });
  });

  it('edits only text with the selected comment version, preserving mention identities', async () => {
    const updated = { ...comment, body: 'Texto actualizado', version: 2, mentions: [{ ...comment.mentions[0], display_name: 'Ana nueva' }] };
    const { rpc, repository } = setup(updated);
    expect(await repository.update(comment, '  Texto actualizado  ')).toEqual(updated);
    expect(rpc).toHaveBeenCalledWith('tr8_v2_communication', {
      p_workspace_id: workspaceId,
      p_action: 'update',
      p_input: { id: commentId, version: 1, body: 'Texto actualizado' },
    });
    expect(comment.body).toBe('Revisemos el diseño.');
    expect(comment.version).toBe(1);
  });

  it('rejects stale update results or changes to immutable comment identity', async () => {
    for (const patch of [
      { version: 1 },
      { version: 3 },
      { body: 'Otro contenido' },
      { author_id: uid(20) },
      { sequence: 11 },
      { created_at: '2026-10-28T13:00:00Z' },
      { mentions: [] },
      { id: uid(20) },
      { task_id: uid(20) },
      { workspace_id: uid(20) },
    ])
      await expect(setup({ ...comment, body: 'Actualizado', version: 2, ...patch }).repository.update(comment, 'Actualizado')).rejects.toMatchObject({
        code: 'CLIENT_UPGRADE_REQUIRED',
      });
  });

  it('removes exactly one comment with CAS, accepting the deletion receipt', async () => {
    const { rpc, repository } = setup({ id: commentId, deleted: true });
    await repository.remove(comment);
    expect(rpc).toHaveBeenCalledWith('tr8_v2_communication', {
      p_workspace_id: workspaceId,
      p_action: 'delete',
      p_input: { id: commentId, version: 1 },
    });
  });

  it('fails closed for a substituted or ambiguous deletion receipt', async () => {
    for (const result of [null, { id: uid(20), deleted: true }, { id: commentId, deleted: false }, { id: commentId, deleted: true, body: 'private' }])
      await expect(setup(result).repository.remove(comment)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('uses desired reaction state so replays do not toggle twice', async () => {
    const reacted = { ...comment, reactions: [{ emoji: '👍' as const, count: 2, mine: true }] };
    const { rpc, repository } = setup(reacted);
    expect(await repository.react(comment, '👍', true)).toEqual(reacted);
    expect(await repository.react(comment, '👍', true)).toEqual(reacted);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenLastCalledWith('tr8_v2_communication', {
      p_workspace_id: workspaceId,
      p_action: 'react',
      p_input: { id: commentId, emoji: '👍', active: true },
    });
  });

  it('allows reaction removal while keeping other users counts and a concurrent text edit', async () => {
    const updated = { ...comment, body: 'Editado en otra pestaña', version: 2, reactions: [{ emoji: '👍' as const, count: 1, mine: false }] };
    expect(await setup(updated).repository.react(comment, '👍', false)).toEqual(updated);
    expect(await setup(comment).repository.react(comment, '👍', false)).toEqual(comment);
  });

  it('rejects invalid reaction input and server responses that do not confirm the desired state', async () => {
    const { rpc, repository } = setup(comment);
    await expect(repository.react(comment, '🔥' as '👍', true)).rejects.toMatchObject({ code: '22023' });
    await expect(repository.react(comment, '👍', 'true' as unknown as boolean)).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
    await expect(repository.react(comment, '👍', true)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    await expect(setup({ ...comment, reactions: [{ emoji: '👍', count: 1, mine: true }] }).repository.react(comment, '👍', false)).rejects.toMatchObject({
      code: 'CLIENT_UPGRADE_REQUIRED',
    });
    await expect(setup({ ...comment, version: 1 }).repository.react({ ...comment, version: 2 }, '👍', false)).rejects.toMatchObject({
      code: 'CLIENT_UPGRADE_REQUIRED',
    });
  });

  it('rejects foreign comment objects before every mutation', async () => {
    const { rpc, repository } = setup(comment);
    const foreign = { ...comment, workspace_id: uid(20) };
    await expect(repository.update(foreign, 'Texto')).rejects.toMatchObject({ code: '22023' });
    await expect(repository.remove(foreign)).rejects.toMatchObject({ code: '22023' });
    await expect(repository.react(foreign, '👍', true)).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('loads the single inbox source for the current workspace with cancellation', async () => {
    const result = { items: [notification], unread_count: 1 };
    const abortSignal = vi.fn().mockResolvedValue({ data: result, error: null });
    const rpc = vi.fn().mockReturnValue({ abortSignal });
    const controller = new AbortController();
    const repository = createCommunicationRepository({ rpc } as unknown as SupabaseClient, workspaceId);
    expect(await repository.inbox(controller.signal)).toEqual(result);
    expect(rpc).toHaveBeenCalledWith('tr8_v2_communication', { p_workspace_id: workspaceId, p_action: 'inbox', p_input: {} });
    expect(abortSignal).toHaveBeenCalledWith(controller.signal);
  });

  it('accepts assignment notices without a comment and verifies unread counts exactly', async () => {
    const assignment = { ...notification, id: uid(8), kind: 'assignment' as const, comment_id: null, read_at: '2026-10-28T14:01:00Z' };
    const data = { items: [notification, assignment], unread_count: 1 };
    expect(await setup(data).repository.inbox()).toEqual(data);
    expect(await setup({ items: [], unread_count: 0 }).repository.inbox()).toEqual({ items: [], unread_count: 0 });
    await expect(setup({ ...data, unread_count: 2 }).repository.inbox()).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('rejects duplicate notifications, foreign scopes and excess retention', async () => {
    for (const data of [
      null,
      { items: [], unread_count: 0, extra: true },
      { items: [notification, notification], unread_count: 2 },
      { items: [{ ...notification, workspace_id: uid(20) }], unread_count: 1 },
      { items: Array.from({ length: 201 }, (_, index) => ({ ...notification, id: uid(index + 100) })), unread_count: 201 },
    ])
      await expect(setup(data).repository.inbox()).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('checks notification content and identities without accepting private extra fields', async () => {
    for (const patch of [
      { id: 'bad' },
      { project_id: 'bad' },
      { task_id: 'bad' },
      { comment_id: null },
      { kind: 'email' },
      { kind: 'assignment', comment_id: commentId },
      { actor_name: ' ' },
      { project_name: 'x'.repeat(121) },
      { task_title: 'x'.repeat(241) },
      { project_color: 'url(private)' },
      { project_icon: '<svg />' },
      { read_at: 'invalid' },
      { read_at: '2026-10-27T14:00:00Z' },
      { created_at: '2026-02-30T14:00:00Z' },
      { email: 'private@example.test' },
    ])
      await expect(setup({ items: [{ ...notification, ...patch }], unread_count: patch.read_at ? 0 : 1 }).repository.inbox()).rejects.toMatchObject({
        code: 'CLIENT_UPGRADE_REQUIRED',
      });
  });

  it('marks only the selected notice read or unread and validates acknowledgements', async () => {
    for (const read of [true, false]) {
      const { rpc, repository } = setup({ id: notification.id, read });
      await repository.setRead(notification.id, read);
      expect(rpc).toHaveBeenCalledWith('tr8_v2_communication', {
        p_workspace_id: workspaceId,
        p_action: 'read',
        p_input: { id: notification.id, read },
      });
    }
    for (const result of [null, { id: uid(20), read: true }, { id: notification.id, read: false }, { id: notification.id, read: true, extra: true }])
      await expect(setup(result).repository.setRead(notification.id, true)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('marks all currently accessible notices with a bounded server count', async () => {
    const { rpc, repository } = setup({ updated: 200 });
    await repository.readAll();
    expect(rpc).toHaveBeenCalledWith('tr8_v2_communication', { p_workspace_id: workspaceId, p_action: 'read_all', p_input: {} });
    for (const result of [null, { updated: -1 }, { updated: 201 }, { updated: 1.5 }, { updated: '1' }, { updated: 1, extra: true }])
      await expect(setup(result).repository.readAll()).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('dismisses only the selected notice, checking the server receipt', async () => {
    const { rpc, repository } = setup({ id: notification.id, dismissed: true });
    await repository.dismiss(notification.id);
    expect(rpc).toHaveBeenCalledWith('tr8_v2_communication', {
      p_workspace_id: workspaceId,
      p_action: 'dismiss',
      p_input: { id: notification.id },
    });
    for (const result of [
      null,
      { id: uid(20), dismissed: true },
      { id: notification.id, dismissed: false },
      { id: notification.id, dismissed: true, extra: true },
    ])
      await expect(setup(result).repository.dismiss(notification.id)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('rejects invalid notification inputs before the network', async () => {
    const { rpc, repository } = setup();
    await expect(repository.setRead('bad', true)).rejects.toMatchObject({ code: '22023' });
    await expect(repository.setRead(notification.id, 'true' as unknown as boolean)).rejects.toMatchObject({ code: '22023' });
    await expect(repository.dismiss('bad')).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
    const malformedScope = createCommunicationRepository({ rpc } as unknown as SupabaseClient, 'bad');
    await expect(malformedScope.inbox()).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('preserves permission and CAS errors, with specific archive and capacity messages', async () => {
    for (const code of ['PT409', 'PT404', '42501', 'PGRST202']) await expect(setup(null, { code }).repository.thread(task)).rejects.toMatchObject({ code });
    await expect(setup(null, { code: '55000' }).repository.create(task, commentId, comment.body, [memberId])).rejects.toMatchObject({
      code: '55000',
      message: expect.stringContaining('archivado'),
    });
    await expect(setup(null, { code: 'PT413' }).repository.create(task, commentId, comment.body, [memberId])).rejects.toMatchObject({
      code: 'PT413',
      message: expect.stringContaining('límite'),
    });
    await expect(setup(null, { code: '22023' }).repository.create(task, commentId, comment.body, [memberId])).rejects.toMatchObject({
      code: '22023',
      message: expect.stringContaining('comentario'),
    });
  });
});

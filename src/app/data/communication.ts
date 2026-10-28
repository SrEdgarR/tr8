import type { SupabaseClient } from '@supabase/supabase-js';
import {
  COMMENT_MAX_LENGTH,
  COMMENT_PAGE_SIZE,
  COMMENT_REACTIONS,
  INBOX_MAX_ITEMS,
  type CommentThread,
  type CommunicationApi,
  type InboxNotification,
  type InboxState,
  type MentionMember,
  type TaskComment,
} from '../communication-types';
import { isProjectIcon } from '../project-identity';
import type { Task } from '../types';
import { DataError, dataError } from './errors';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const version = (value: unknown): value is number => positive(value) && value <= 999999999;
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const name = (value: unknown, max = 120): value is string => typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= max;
const malformed = () => new DataError('La respuesta de comunicación no corresponde a esta versión de TR8. Actualiza los datos.', 'CLIENT_UPGRADE_REQUIRED');
const invalid = (message = 'Revisa el comentario, las menciones y la tarea seleccionada.') => new DataError(message, '22023');

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || parts[1] === '0000' || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return false;
  const civil = new Date(0);
  civil.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  if (civil.toISOString().slice(0, 10) !== value.slice(0, 10)) return false;
  return Number.isFinite(Date.parse(value));
}

function validBody(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || Array.from(value).length > COMMENT_MAX_LENGTH) return false;
  return !Array.from(value).some(character => {
    const point = character.codePointAt(0)!;
    return (point < 32 && ![9, 10, 13].includes(point)) || (point >= 127 && point <= 159) || (point >= 0xd800 && point <= 0xdfff);
  });
}

export function normalizeCommentBody(value: string): string {
  if (typeof value !== 'string') throw invalid();
  const body = value.trim();
  if (!validBody(body)) throw invalid('Escribe un comentario de entre 1 y 4.000 caracteres, sin caracteres de control.');
  return body;
}

function isMember(value: unknown): value is MentionMember {
  return record(value) && closed(value, ['member_id', 'display_name']) && id(value.member_id) && name(value.display_name);
}

function memberList(value: unknown, limit: number): value is MentionMember[] {
  return Array.isArray(value) && value.length <= limit && value.every(isMember) && new Set(value.map(item => item.member_id)).size === value.length;
}

function isComment(value: unknown, workspaceId: string): value is TaskComment {
  return (
    record(value) &&
    closed(value, [
      'id',
      'workspace_id',
      'task_id',
      'author_id',
      'author_name',
      'body',
      'mentions',
      'reactions',
      'version',
      'sequence',
      'created_at',
      'updated_at',
      'can_edit',
      'can_delete',
    ]) &&
    id(value.id) &&
    value.workspace_id === workspaceId &&
    id(value.task_id) &&
    id(value.author_id) &&
    name(value.author_name) &&
    validBody(value.body) &&
    memberList(value.mentions, 10) &&
    Array.isArray(value.reactions) &&
    value.reactions.length <= COMMENT_REACTIONS.length &&
    value.reactions.every(
      item =>
        record(item) &&
        closed(item, ['emoji', 'count', 'mine']) &&
        COMMENT_REACTIONS.some(emoji => emoji === item.emoji) &&
        positive(item.count) &&
        item.count <= 20000 &&
        typeof item.mine === 'boolean',
    ) &&
    new Set(value.reactions.map(item => item.emoji)).size === value.reactions.length &&
    version(value.version) &&
    positive(value.sequence) &&
    timestamp(value.created_at) &&
    timestamp(value.updated_at) &&
    Date.parse(value.updated_at) >= Date.parse(value.created_at) &&
    typeof value.can_edit === 'boolean' &&
    typeof value.can_delete === 'boolean'
  );
}

function isNotification(value: unknown, workspaceId: string): value is InboxNotification {
  return (
    record(value) &&
    closed(value, [
      'id',
      'workspace_id',
      'project_id',
      'task_id',
      'comment_id',
      'kind',
      'actor_name',
      'project_name',
      'project_color',
      'project_icon',
      'task_title',
      'created_at',
      'read_at',
    ]) &&
    id(value.id) &&
    value.workspace_id === workspaceId &&
    id(value.project_id) &&
    id(value.task_id) &&
    ['mention', 'comment', 'assignment'].includes(String(value.kind)) &&
    (value.kind === 'assignment' ? value.comment_id === null : id(value.comment_id)) &&
    name(value.actor_name) &&
    name(value.project_name) &&
    typeof value.project_color === 'string' &&
    /^#[0-9a-f]{6}$/i.test(value.project_color) &&
    isProjectIcon(value.project_icon) &&
    name(value.task_title, 240) &&
    timestamp(value.created_at) &&
    (value.read_at === null || (timestamp(value.read_at) && Date.parse(value.read_at) >= Date.parse(value.created_at)))
  );
}

function communicationError(cause: unknown): DataError {
  if (cause instanceof DataError) return cause;
  const code = record(cause) && typeof cause.code === 'string' ? cause.code : undefined;
  if (code === 'PT413') return new DataError('Esta conversación alcanzó su límite. Revisa los comentarios antes de añadir otro.', code);
  if (code === '22023' || code === '23514' || code === '22P02') return invalid();
  if (code === '55000') return new DataError('La tarea o el proyecto está archivado. Puedes consultar la conversación, pero no modificarla.', code);
  return dataError(cause);
}

export function createCommunicationRepository(client: SupabaseClient, workspaceId: string): Omit<CommunicationApi, 'scopeKey'> {
  async function request(action: string, input: Record<string, unknown>, signal?: AbortSignal) {
    if (!id(workspaceId)) throw invalid();
    let query = client.rpc('tr8_v2_communication', { p_workspace_id: workspaceId, p_action: action, p_input: input });
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw communicationError(error);
    return data as unknown;
  }
  function requireTask(task: Task) {
    if (!record(task) || task.workspace_id !== workspaceId || !id(task.id) || !id(task.project_id) || !version(task.version)) throw invalid();
  }
  function requireComment(comment: TaskComment) {
    if (!isComment(comment, workspaceId)) throw invalid();
  }
  function checkedComment(value: unknown, commentId: string, taskId: string): TaskComment {
    if (!isComment(value, workspaceId) || value.id !== commentId || value.task_id !== taskId) throw malformed();
    return value;
  }
  function sameIdentity(value: TaskComment, before: TaskComment) {
    if (
      value.author_id !== before.author_id ||
      value.sequence !== before.sequence ||
      Date.parse(value.created_at) !== Date.parse(before.created_at) ||
      value.mentions.length !== before.mentions.length ||
      value.mentions.some(item => !before.mentions.some(previous => previous.member_id === item.member_id))
    )
      throw malformed();
    return value;
  }
  return {
    async thread(task, beforeId = null, signal): Promise<CommentThread> {
      requireTask(task);
      if (beforeId !== null && !positive(beforeId)) throw invalid();
      const value = await request('thread', { task_id: task.id, before_id: beforeId, limit: COMMENT_PAGE_SIZE }, signal);
      if (
        !record(value) ||
        !closed(value, ['items', 'next_before_id', 'participants']) ||
        !Array.isArray(value.items) ||
        value.items.length > COMMENT_PAGE_SIZE ||
        !value.items.every(item => isComment(item, workspaceId) && item.task_id === task.id && (beforeId === null || item.sequence < beforeId)) ||
        new Set(value.items.map(item => item.id)).size !== value.items.length ||
        new Set(value.items.map(item => item.sequence)).size !== value.items.length ||
        value.items.some((item, index, items) => index > 0 && item.sequence >= items[index - 1].sequence) ||
        !memberList(value.participants, 200) ||
        (value.next_before_id !== null &&
          (!positive(value.next_before_id) ||
            value.items.length !== COMMENT_PAGE_SIZE ||
            value.next_before_id !== value.items[value.items.length - 1]?.sequence))
      )
        throw malformed();
      return value as unknown as CommentThread;
    },
    async create(task, commentId, body, mentionMemberIds) {
      requireTask(task);
      const normalized = normalizeCommentBody(body);
      if (
        !id(commentId) ||
        !Array.isArray(mentionMemberIds) ||
        mentionMemberIds.length > 10 ||
        !mentionMemberIds.every(id) ||
        new Set(mentionMemberIds).size !== mentionMemberIds.length
      )
        throw invalid();
      const value = checkedComment(
        await request('create', { id: commentId, task_id: task.id, body: normalized, mention_member_ids: [...mentionMemberIds] }),
        commentId,
        task.id,
      );
      // A lost response may be retried after the author has edited the comment.
      if (
        (value.version === 1 && value.body !== normalized) ||
        value.mentions.length !== mentionMemberIds.length ||
        value.mentions.some(item => !mentionMemberIds.includes(item.member_id))
      )
        throw malformed();
      return value;
    },
    async update(comment, body) {
      requireComment(comment);
      const normalized = normalizeCommentBody(body);
      const value = sameIdentity(
        checkedComment(await request('update', { id: comment.id, version: comment.version, body: normalized }), comment.id, comment.task_id),
        comment,
      );
      if (value.version !== comment.version + 1 || value.body !== normalized) throw malformed();
      return value;
    },
    async remove(comment) {
      requireComment(comment);
      const value = await request('delete', { id: comment.id, version: comment.version });
      if (!record(value) || !closed(value, ['id', 'deleted']) || value.id !== comment.id || value.deleted !== true) throw malformed();
    },
    async react(comment, emoji, active) {
      requireComment(comment);
      if (!COMMENT_REACTIONS.includes(emoji) || typeof active !== 'boolean') throw invalid();
      const value = sameIdentity(checkedComment(await request('react', { id: comment.id, emoji, active }), comment.id, comment.task_id), comment);
      const ownReaction = value.reactions.some(item => item.emoji === emoji && item.mine);
      if (value.version < comment.version || ownReaction !== active) throw malformed();
      return value;
    },
    async inbox(signal): Promise<InboxState> {
      const value = await request('inbox', {}, signal);
      if (
        !record(value) ||
        !closed(value, ['items', 'unread_count']) ||
        !Array.isArray(value.items) ||
        value.items.length > INBOX_MAX_ITEMS ||
        !value.items.every(item => isNotification(item, workspaceId)) ||
        new Set(value.items.map(item => item.id)).size !== value.items.length ||
        value.unread_count !== value.items.filter(item => item.read_at === null).length
      )
        throw malformed();
      return value as unknown as InboxState;
    },
    async setRead(notificationId, read) {
      if (!id(notificationId) || typeof read !== 'boolean') throw invalid();
      const value = await request('read', { id: notificationId, read });
      if (!record(value) || !closed(value, ['id', 'read']) || value.id !== notificationId || value.read !== read) throw malformed();
    },
    async readAll() {
      const value = await request('read_all', {});
      if (
        !record(value) ||
        !closed(value, ['updated']) ||
        typeof value.updated !== 'number' ||
        !Number.isInteger(value.updated) ||
        value.updated < 0 ||
        value.updated > INBOX_MAX_ITEMS
      )
        throw malformed();
    },
    async dismiss(notificationId) {
      if (!id(notificationId)) throw invalid();
      const value = await request('dismiss', { id: notificationId });
      if (!record(value) || !closed(value, ['id', 'dismissed']) || value.id !== notificationId || value.dismissed !== true) throw malformed();
    },
  };
}

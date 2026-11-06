import type { SupabaseClient } from '@supabase/supabase-js';
import {
  NOTE_BODY_LIMIT,
  NOTE_PAGE_SIZE,
  NOTE_QUERY_LIMIT,
  NOTE_TAG_LENGTH_LIMIT,
  NOTE_TAG_LIMIT,
  NOTE_TITLE_LIMIT,
  type Note,
  type NoteContent,
  type NotesApi,
} from '../notes-types';
import { DataError, dataError } from './errors';

const MAX_SQL_INTEGER = 2_147_483_647;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 50 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const integer = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= MAX_SQL_INTEGER;
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = () => new DataError('Revisa el título, el contenido y las etiquetas de la nota.', '22023');
const malformed = () => new DataError('La respuesta de Notas no corresponde a esta versión de TR8. Actualiza los datos.', 'CLIENT_UPGRADE_REQUIRED');

function textInRange(value: unknown, min: number, max: number): value is string {
  if (typeof value !== 'string' || value.includes('\u0000')) return false;
  const length = Array.from(value).length;
  return length >= min && length <= max;
}

function isContent(value: Record<string, unknown>): value is Record<string, unknown> & NoteContent {
  return (
    textInRange(value.title, 1, NOTE_TITLE_LIMIT) &&
    textInRange(value.body, 0, NOTE_BODY_LIMIT) &&
    Array.isArray(value.tags) &&
    value.tags.length <= NOTE_TAG_LIMIT &&
    value.tags.every(tag => textInRange(tag, 1, NOTE_TAG_LENGTH_LIMIT))
  );
}

function normalizeContent(value: NoteContent): NoteContent {
  if (!record(value) || typeof value.title !== 'string' || !Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== 'string')) throw invalid();
  const normalized = { title: value.title.trim(), body: value.body, tags: value.tags.map(tag => tag.trim()) };
  if (!isContent(normalized)) throw invalid();
  return normalized;
}

function isNote(value: unknown, workspaceId: string, projectId: string | null): value is Note {
  return (
    record(value) &&
    closed(value, ['id', 'workspace_id', 'project_id', 'title', 'body', 'tags', 'pinned', 'archived_at', 'created_at', 'updated_at', 'version', 'can_edit']) &&
    id(value.id) &&
    value.workspace_id === workspaceId &&
    value.project_id === projectId &&
    isContent(value) &&
    typeof value.pinned === 'boolean' &&
    (value.archived_at === null || timestamp(value.archived_at)) &&
    timestamp(value.created_at) &&
    timestamp(value.updated_at) &&
    integer(value.version, 1) &&
    typeof value.can_edit === 'boolean'
  );
}

export function createNotesRepository(client: SupabaseClient, workspaceId: string): Omit<NotesApi, 'scopeKey'> {
  function scope(projectId: string | null) {
    if (!id(workspaceId) || (projectId !== null && !id(projectId))) throw invalid();
    return { p_workspace_id: workspaceId, p_project_id: projectId };
  }

  async function request(
    action: 'list' | 'create' | 'update' | 'delete',
    projectId: string | null,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let query = client.rpc(`tr8_notes_${action}`, { ...scope(projectId), ...args });
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (!error) return data;
    if (error.code === 'PT409')
      throw new DataError('La nota cambió o esta solicitud ya se usó. Actualiza las notas y revisa el resultado antes de guardar de nuevo.', error.code);
    if (error.code === '55000')
      throw new DataError(
        action === 'delete' ? 'Archiva la nota primero y comprueba que el proyecto esté activo.' : 'Restaura el proyecto para modificar sus notas.',
        error.code,
      );
    if (['22023', '23514', '22P02'].includes(error.code)) throw invalid();
    throw dataError(error);
  }

  function checked(value: unknown, projectId: string | null, noteId: string): Note {
    if (!isNote(value, workspaceId, projectId) || value.id !== noteId) throw malformed();
    return value;
  }

  function writeArgs(content: NoteContent) {
    const normalized = normalizeContent(content);
    return { p_title: normalized.title, p_body: normalized.body, p_tags: normalized.tags };
  }

  return {
    async list(projectId, options, signal) {
      if (typeof options.archived !== 'boolean' || typeof options.query !== 'string' || !integer(options.offset, 0)) throw invalid();
      const search = options.query.trim();
      if (!textInRange(search, 0, NOTE_QUERY_LIMIT)) throw invalid();
      const value = await request('list', projectId, { p_archived: options.archived, p_query: search, p_offset: options.offset }, signal);
      if (
        !record(value) ||
        !closed(value, ['notes', 'has_more']) ||
        typeof value.has_more !== 'boolean' ||
        !Array.isArray(value.notes) ||
        value.notes.length > NOTE_PAGE_SIZE ||
        (value.has_more && value.notes.length !== NOTE_PAGE_SIZE) ||
        !value.notes.every(note => isNote(note, workspaceId, projectId) && (note.archived_at !== null) === options.archived) ||
        new Set(value.notes.map(note => note.id)).size !== value.notes.length
      )
        throw malformed();
      return { notes: value.notes, has_more: value.has_more };
    },
    async create(projectId, noteId, content) {
      if (!id(noteId)) throw invalid();
      return checked(await request('create', projectId, { p_id: noteId, ...writeArgs(content) }), projectId, noteId);
    },
    async update(projectId, note, content) {
      if (!isNote(note, workspaceId, projectId) || typeof content.pinned !== 'boolean' || typeof content.archived !== 'boolean') throw invalid();
      const value = checked(
        await request('update', projectId, {
          p_id: note.id,
          p_version: note.version,
          ...writeArgs(content),
          p_pinned: content.pinned,
          p_archived: content.archived,
        }),
        projectId,
        note.id,
      );
      if (value.version !== note.version + 1 || value.pinned !== content.pinned || (value.archived_at !== null) !== content.archived) throw malformed();
      return value;
    },
    async remove(projectId, note) {
      if (!isNote(note, workspaceId, projectId)) throw invalid();
      if (note.archived_at === null) throw new DataError('Archiva la nota antes de eliminarla definitivamente.', '55000');
      const value = await request('delete', projectId, { p_id: note.id, p_version: note.version });
      if (value !== null) throw malformed();
    },
  };
}

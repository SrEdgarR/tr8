import type { SupabaseClient } from '@supabase/supabase-js';
import {
  SEARCH_CATEGORIES,
  SEARCH_KINDS,
  SEARCH_MAX_LENGTH,
  SEARCH_MAX_LIMIT,
  SEARCH_MAX_OFFSET,
  SEARCH_MIN_LENGTH,
  type GlobalSearchApi,
  type GlobalSearchCounts,
  type GlobalSearchPage,
  type GlobalSearchQuery,
  type GlobalSearchResult,
} from '../search-types';
import { isProjectIcon } from '../project-identity';
import { FILE_FORMATS } from '../project-files-types';
import { DataError, dataError } from './errors';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max: number, required = false): value is string =>
  typeof value === 'string' && Array.from(value).length <= max && (!required || value.trim().length > 0);
const closed = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const choice = (value: unknown, options: readonly string[]) => typeof value === 'string' && options.includes(value);
const taskStatuses = ['backlog', 'todo', 'progress', 'review', 'done'];
const priorities = ['none', 'low', 'medium', 'high', 'urgent'];
const projectStatuses = ['planning', 'active', 'hold', 'complete'];
const fileTypes: readonly string[] = Object.values(FILE_FORMATS);
const invalid = () => new DataError('Escribe una búsqueda de entre 2 y 100 caracteres y revisa sus filtros.', '22023');
const malformed = () => new DataError('La respuesta de búsqueda no corresponde a esta versión de TR8. Actualiza los datos.', 'CLIENT_UPGRADE_REQUIRED');

/** Search terms are literal text; wildcard characters are never rewritten. */
export function normalizeSearchQuery(value: string): string {
  if (
    typeof value !== 'string' ||
    Array.from(value).some(character => {
      const point = character.codePointAt(0)!;
      return point < 32 || (point >= 127 && point <= 159) || (point >= 0xd800 && point <= 0xdfff);
    })
  )
    throw invalid();
  const query = value.trim();
  if (Array.from(query).length < SEARCH_MIN_LENGTH || Array.from(query).length > SEARCH_MAX_LENGTH) throw invalid();
  return query;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || parts[1] === '0000' || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return false;
  if (parts[7] !== 'Z') {
    const offset = parts[7].slice(1).split(':').map(Number);
    if (offset[0] > 23 || offset[1] > 59) return false;
  }
  const civil = new Date(0);
  civil.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return civil.toISOString().slice(0, 10) === value.slice(0, 10) && Number.isFinite(Date.parse(value));
}

function timestampCompare(left: string, right: string) {
  const millis = Date.parse(left) - Date.parse(right);
  if (millis) return Math.sign(millis);
  // Postgres returns microseconds; Date.parse alone collapses their ordering.
  const subMillis = (value: string) => Number((/\.(\d+)/.exec(value)?.[1] ?? '').padEnd(6, '0').slice(3, 6));
  return Math.sign(subMillis(left) - subMillis(right));
}

function isResult(value: unknown, workspaceId: string, includeArchived: boolean): value is GlobalSearchResult {
  if (
    !record(value) ||
    !closed(value, [
      'id',
      'kind',
      'workspace_id',
      'project_id',
      'task_id',
      'title',
      'snippet',
      'project_name',
      'project_color',
      'project_icon',
      'status',
      'priority',
      'content_type',
      'member_id',
      'author_name',
      'updated_at',
      'archived',
    ]) ||
    !id(value.id) ||
    value.workspace_id !== workspaceId ||
    !choice(value.kind, SEARCH_KINDS) ||
    !text(value.title, 240, true) ||
    !text(value.snippet, 240) ||
    !timestamp(value.updated_at) ||
    typeof value.archived !== 'boolean' ||
    (!includeArchived && value.archived)
  )
    return false;
  if (value.kind === 'member')
    return (
      value.id === value.member_id &&
      id(value.member_id) &&
      value.project_id === null &&
      value.task_id === null &&
      value.project_name === null &&
      value.project_color === null &&
      value.project_icon === null &&
      value.status === 'active' &&
      value.priority === null &&
      value.content_type === null &&
      value.author_name === null &&
      value.archived === false &&
      text(value.title, 120, true)
    );
  if (
    !id(value.project_id) ||
    !text(value.project_name, 120, true) ||
    typeof value.project_color !== 'string' ||
    !/^#[0-9a-f]{6}$/i.test(value.project_color) ||
    !isProjectIcon(value.project_icon) ||
    value.member_id !== null
  )
    return false;
  if (value.kind === 'project')
    return (
      value.id === value.project_id &&
      value.title === value.project_name &&
      value.task_id === null &&
      choice(value.status, projectStatuses) &&
      value.priority === null &&
      value.content_type === null &&
      value.author_name === null
    );
  if (value.kind === 'file')
    return value.task_id === null && value.status === 'ready' && value.priority === null && choice(value.content_type, fileTypes) && value.author_name === null;
  if (!id(value.task_id) || !choice(value.status, taskStatuses) || value.content_type !== null) return false;
  if (value.kind === 'task') return value.id === value.task_id && choice(value.priority, priorities) && value.author_name === null;
  return value.kind === 'comment' && value.priority === null && text(value.author_name, 120, true);
}

function validCounts(value: unknown): value is GlobalSearchCounts {
  return record(value) && closed(value, SEARCH_KINDS) && SEARCH_KINDS.every(kind => integer(value[kind]));
}

function ordered(items: GlobalSearchResult[]) {
  return items.every((item, index) => {
    if (index === 0) return true;
    const previous = items[index - 1];
    const kind = SEARCH_KINDS.indexOf(item.kind) - SEARCH_KINDS.indexOf(previous.kind);
    if (kind) return kind > 0;
    const time = timestampCompare(previous.updated_at, item.updated_at);
    return time > 0 || (time === 0 && previous.id.toLowerCase() > item.id.toLowerCase());
  });
}

function validateInput(input: GlobalSearchQuery): GlobalSearchQuery {
  if (
    !record(input) ||
    !closed(input, ['query', 'kind', 'include_archived', 'offset', 'limit']) ||
    !choice(input.kind, SEARCH_CATEGORIES) ||
    typeof input.include_archived !== 'boolean' ||
    !integer(input.offset) ||
    input.offset > SEARCH_MAX_OFFSET ||
    (input.kind === 'all' && input.offset !== 0) ||
    !integer(input.limit) ||
    input.limit < 1 ||
    input.limit > SEARCH_MAX_LIMIT
  )
    throw invalid();
  return { ...input, query: normalizeSearchQuery(input.query) };
}

function checkedPage(value: unknown, workspaceId: string, input: GlobalSearchQuery): GlobalSearchPage {
  if (
    !record(value) ||
    !closed(value, ['workspace_id', 'query', 'kind', 'include_archived', 'items', 'counts', 'next_offset']) ||
    value.workspace_id !== workspaceId ||
    value.query !== input.query ||
    value.kind !== input.kind ||
    value.include_archived !== input.include_archived ||
    !validCounts(value.counts) ||
    !Array.isArray(value.items) ||
    value.items.length > input.limit * (input.kind === 'all' ? SEARCH_KINDS.length : 1) ||
    !value.items.every(item => isResult(item, workspaceId, input.include_archived) && (input.kind === 'all' || item.kind === input.kind)) ||
    new Set(value.items.map(item => `${item.kind}:${item.id.toLowerCase()}`)).size !== value.items.length ||
    !ordered(value.items)
  )
    throw malformed();
  for (const kind of SEARCH_KINDS) {
    const expected =
      input.kind === 'all'
        ? Math.min(value.counts[kind], input.limit)
        : input.kind === kind
          ? Math.min(Math.max(value.counts[kind] - input.offset, 0), input.limit)
          : 0;
    if (value.items.filter(item => item.kind === kind).length !== expected) throw malformed();
  }
  const next =
    input.kind !== 'all' && input.offset + input.limit < value.counts[input.kind] && input.offset + input.limit <= SEARCH_MAX_OFFSET
      ? input.offset + input.limit
      : null;
  if (value.next_offset !== next) throw malformed();
  return value as unknown as GlobalSearchPage;
}

export function createGlobalSearchRepository(client: SupabaseClient, workspaceId: string): Omit<GlobalSearchApi, 'scopeKey'> {
  return {
    async search(input, signal) {
      if (!id(workspaceId)) throw invalid();
      const normalized = validateInput(input);
      let request = client.rpc('tr8_v2_search', { p_workspace_id: workspaceId, p_input: normalized });
      if (signal) request = request.abortSignal(signal);
      const { data, error } = await request;
      if (error) {
        if (record(error) && ['22023', '22P02', '23514'].includes(String(error.code))) throw invalid();
        throw dataError(error);
      }
      return checkedPage(data, workspaceId, normalized);
    },
  };
}

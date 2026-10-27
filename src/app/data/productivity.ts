import type { SupabaseClient } from '@supabase/supabase-js';
import type { Favorite, ProductivityApi, SavedTaskView, TaskViewConfig } from '../productivity-types';
import { DataError, dataError } from './errors';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const closed = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const version = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const choice = (value: unknown, options: string[]) => typeof value === 'string' && options.includes(value);
const list = (value: unknown, predicate: (value: unknown) => boolean, limit: number) =>
  Array.isArray(value) && value.length <= limit && value.every(predicate) && new Set(value).size === value.length;
const malformed = () => new DataError('La respuesta de productividad no corresponde a esta versión de TR8. Actualiza los datos.', 'CLIENT_UPGRADE_REQUIRED');

export function isTaskViewConfig(value: unknown): value is TaskViewConfig {
  return (
    record(value) &&
    closed(value, [
      'schemaVersion',
      'view',
      'query',
      'statuses',
      'priorities',
      'projectIds',
      'assigneeIds',
      'due',
      'sort',
      'direction',
      'group',
      'columns',
      'favoritesOnly',
    ]) &&
    value.schemaVersion === 1 &&
    choice(value.view, ['list', 'table', 'board']) &&
    typeof value.query === 'string' &&
    value.query.length <= 500 &&
    list(value.statuses, x => choice(x, ['backlog', 'todo', 'progress', 'review', 'done']), 5) &&
    list(value.priorities, x => choice(x, ['none', 'low', 'medium', 'high', 'urgent']), 5) &&
    list(value.projectIds, x => typeof x === 'string' && uuid.test(x), 100) &&
    list(value.assigneeIds, x => x === 'none' || (typeof x === 'string' && uuid.test(x)), 100) &&
    choice(value.due, ['all', 'overdue', 'today', 'next7', 'undated']) &&
    choice(value.sort, ['manual', 'title', 'status', 'priority', 'due_date', 'created_at', 'updated_at']) &&
    choice(value.direction, ['asc', 'desc']) &&
    choice(value.group, ['none', 'status', 'project', 'priority', 'assignee']) &&
    list(value.columns, x => choice(x, ['project', 'status', 'priority', 'assignee', 'start_date', 'due_date']), 6) &&
    typeof value.favoritesOnly === 'boolean' &&
    JSON.stringify(value).length <= 20000
  );
}

function isFavorite(value: unknown): value is Favorite {
  return (
    record(value) &&
    choice(value.kind, ['project', 'task']) &&
    typeof value.id === 'string' &&
    uuid.test(value.id) &&
    typeof value.project_id === 'string' &&
    uuid.test(value.project_id)
  );
}
function isSavedView(value: unknown): value is SavedTaskView {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    uuid.test(value.id) &&
    typeof value.workspace_id === 'string' &&
    uuid.test(value.workspace_id) &&
    choice(value.context, ['tasks', 'mine', 'project']) &&
    (value.context === 'project' ? typeof value.project_id === 'string' && uuid.test(value.project_id) : value.project_id === null) &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    value.name.length <= 80 &&
    isTaskViewConfig(value.config) &&
    version(value.version) &&
    typeof value.created_at === 'string' &&
    Number.isFinite(Date.parse(value.created_at)) &&
    typeof value.updated_at === 'string' &&
    Number.isFinite(Date.parse(value.updated_at))
  );
}
function validateConfig(value: TaskViewConfig) {
  if (!isTaskViewConfig(value)) throw new DataError('Revisa los filtros y las columnas de la vista.', '22023');
}
function validateName(value: string) {
  const name = value.trim();
  if (!name || name.length > 80) throw new DataError('Usa un nombre de vista de entre 1 y 80 caracteres.', '22023');
  return name;
}

export function createProductivityRepository(client: SupabaseClient, workspaceId: string): Omit<ProductivityApi, 'scopeKey'> {
  async function request(action: string, input: Record<string, unknown>, signal?: AbortSignal) {
    let query = client.rpc('tr8_v2_productivity', { p_workspace_id: workspaceId, p_action: action, p_input: input });
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query;
    if (error) throw dataError(error);
    if (data === null) throw malformed();
    return data as unknown;
  }
  function checkedView(value: unknown) {
    if (!isSavedView(value) || value.workspace_id !== workspaceId) throw malformed();
    return value;
  }
  return {
    async load(signal) {
      const value = await request('load', {}, signal);
      if (
        !record(value) ||
        !Array.isArray(value.favorites) ||
        value.favorites.length > 1000 ||
        !value.favorites.every(isFavorite) ||
        !Array.isArray(value.views) ||
        value.views.length > 50 ||
        !value.views.every(item => isSavedView(item) && item.workspace_id === workspaceId)
      )
        throw malformed();
      return { favorites: value.favorites, views: value.views as SavedTaskView[] };
    },
    async setFavorite(kind, id, favorite) {
      const value = await request('set_favorite', { kind, id, favorite });
      if (!isFavorite(value) || value.kind !== kind || value.id !== id || !record(value) || value.favorite !== favorite) throw malformed();
      return { ...value, favorite };
    },
    async createView(id, name, context, projectId, config) {
      validateConfig(config);
      const value = checkedView(await request('create_view', { id, name: validateName(name), context, project_id: projectId, config }));
      if (value.id !== id || value.context !== context || value.project_id !== projectId) throw malformed();
      return value;
    },
    async updateView(view, name, config) {
      validateConfig(config);
      const value = checkedView(await request('update_view', { id: view.id, version: view.version, name: validateName(name), config }));
      if (value.id !== view.id || value.context !== view.context || value.project_id !== view.project_id || value.version !== view.version + 1)
        throw malformed();
      return value;
    },
    async deleteView(view) {
      const value = await request('delete_view', { id: view.id, version: view.version });
      if (!record(value) || value.id !== view.id || value.deleted !== true) throw malformed();
    },
    async reorderTasks(projectId, items, requestId = crypto.randomUUID()) {
      if (
        !uuid.test(projectId) ||
        !uuid.test(requestId) ||
        !items.length ||
        items.length > 200 ||
        new Set(items.map(item => item.id)).size !== items.length ||
        new Set(items.map(item => item.position)).size !== items.length ||
        items.some(item => !uuid.test(item.id) || !version(item.version) || !Number.isSafeInteger(item.position) || item.position < 0)
      )
        throw new DataError('Actualiza la lista completa antes de cambiar el orden.', '22023');
      const value = await request('reorder_tasks', { project_id: projectId, request_id: requestId, items });
      if (
        !Array.isArray(value) ||
        value.length !== items.length ||
        new Set(value.map(item => (record(item) ? item.id : null))).size !== value.length ||
        value.some(
          item =>
            !record(item) ||
            item.workspace_id !== workspaceId ||
            item.project_id !== projectId ||
            typeof item.id !== 'string' ||
            !items.some(input => input.id === item.id) ||
            !version(item.version) ||
            typeof item.position !== 'number' ||
            !Number.isSafeInteger(item.position),
        )
      )
        throw malformed();
      return value as Awaited<ReturnType<ProductivityApi['reorderTasks']>>;
    },
  };
}

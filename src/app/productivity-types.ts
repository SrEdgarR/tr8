import type { Priority, Task, TaskStatus } from './types';

export type TaskViewColumn = 'project' | 'status' | 'priority' | 'assignee' | 'start_date' | 'due_date';
export type TaskViewContext = 'tasks' | 'mine' | 'project';
export interface TaskViewConfig {
  schemaVersion: 1;
  view: 'list' | 'table' | 'board';
  query: string;
  statuses: TaskStatus[];
  priorities: Priority[];
  projectIds: string[];
  assigneeIds: string[];
  due: 'all' | 'overdue' | 'today' | 'next7' | 'undated';
  sort: 'manual' | 'title' | 'status' | 'priority' | 'due_date' | 'created_at' | 'updated_at';
  direction: 'asc' | 'desc';
  group: 'none' | 'status' | 'project' | 'priority' | 'assignee';
  columns: TaskViewColumn[];
  favoritesOnly: boolean;
}
export interface SavedTaskView {
  id: string;
  workspace_id: string;
  context: TaskViewContext;
  project_id: string | null;
  name: string;
  config: TaskViewConfig;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface Favorite {
  kind: 'project' | 'task';
  id: string;
  project_id: string;
}
export interface ProductivityState {
  favorites: Favorite[];
  views: SavedTaskView[];
}
export interface ProductivityApi {
  scopeKey: string[];
  load: (signal?: AbortSignal) => Promise<ProductivityState>;
  setFavorite: (kind: Favorite['kind'], id: string, favorite: boolean) => Promise<Favorite & { favorite: boolean }>;
  createView: (id: string, name: string, context: TaskViewContext, projectId: string | null, config: TaskViewConfig) => Promise<SavedTaskView>;
  updateView: (view: SavedTaskView, name: string, config: TaskViewConfig) => Promise<SavedTaskView>;
  deleteView: (view: SavedTaskView) => Promise<void>;
  reorderTasks: (projectId: string, items: { id: string; version: number; position: number }[], requestId?: string) => Promise<Task[]>;
}

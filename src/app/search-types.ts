import type { ProjectIconName } from './project-identity';
import type { Priority } from './types';

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 100;
export const SEARCH_MAX_OFFSET = 10000;
export const SEARCH_MAX_LIMIT = 50;
export const SEARCH_KINDS = ['project', 'task', 'member', 'file', 'comment'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];
export const SEARCH_CATEGORIES = ['all', ...SEARCH_KINDS] as const;
export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

export interface GlobalSearchQuery {
  query: string;
  kind: SearchCategory;
  include_archived: boolean;
  offset: number;
  limit: number;
}

export interface GlobalSearchResult {
  id: string;
  kind: SearchKind;
  workspace_id: string;
  project_id: string | null;
  task_id: string | null;
  title: string;
  snippet: string;
  project_name: string | null;
  project_color: string | null;
  project_icon: ProjectIconName | null;
  status: string | null;
  priority: Priority | null;
  content_type: string | null;
  member_id: string | null;
  author_name: string | null;
  updated_at: string;
  archived: boolean;
}

export type GlobalSearchCounts = Record<SearchKind, number>;

export interface GlobalSearchPage {
  workspace_id: string;
  query: string;
  kind: SearchCategory;
  include_archived: boolean;
  items: GlobalSearchResult[];
  counts: GlobalSearchCounts;
  next_offset: number | null;
}

export interface GlobalSearchApi {
  scopeKey: string[];
  search: (input: GlobalSearchQuery, signal?: AbortSignal) => Promise<GlobalSearchPage>;
}

import type { Priority, TaskStatus } from './types';

export type BulkTaskOperation =
  | { kind: 'status'; status: TaskStatus }
  | { kind: 'priority'; priority: Priority }
  | { kind: 'assign'; assignee_member_id: string | null }
  | { kind: 'archive' }
  | { kind: 'delete' };

export interface BulkTaskItem {
  id: string;
  project_id: string;
  version: number;
}

export interface BulkTaskRequest {
  id: string;
  requested_at: string;
}

export interface BulkTaskResult {
  request_id: string;
  results: { id: string; outcome: 'applied' | 'rejected'; code: string | null }[];
}

export interface BulkTasksApi {
  scopeKey: string[];
  apply: (operation: BulkTaskOperation, items: BulkTaskItem[], request: BulkTaskRequest) => Promise<BulkTaskResult>;
}

import type { Task } from './types';

export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly';
export type RecurrenceStatus = 'active' | 'paused' | 'blocked' | 'finished';
export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval: number;
  weekdays: number[];
  time_zone: string;
  until_date: string | null;
}
export interface RecurrenceSeries {
  id: string;
  workspace_id: string;
  project_id: string;
  version: number;
  rule: RecurrenceRule;
  anchor_date: string;
  state: RecurrenceStatus;
  reason: string | null;
  current_task_id: string;
  current_task_created_at: string;
  current_occurrence_date: string;
}
export interface RecurrenceState {
  task_id: string;
  series: RecurrenceSeries | null;
  occurrence_date: string | null;
  successor_task_id: string | null;
}
export interface RecurrenceSummary {
  series_id: string;
  task_id: string;
  frequency: RecurrenceFrequency;
  interval: number;
  state: RecurrenceStatus;
}
export interface RecurrenceApi {
  scopeKey: string[];
  state: (task: Task, signal?: AbortSignal) => Promise<RecurrenceState>;
  summaries: (signal?: AbortSignal) => Promise<RecurrenceSummary[]>;
  save: (task: Task, seriesVersion: number | null, rule: RecurrenceRule | null, requestId: string) => Promise<RecurrenceState>;
}

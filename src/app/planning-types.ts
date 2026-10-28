import type { Project, Task } from './types';

export interface TaskDependency {
  id: string;
  workspace_id: string;
  task_id: string;
  blocker_task_id: string;
  version: number;
  created_at: string;
}

export interface ProjectMilestone {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  date: string;
  completed: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MilestoneInput {
  name: string;
  date: string;
  completed: boolean;
}

export interface PlanningState {
  dependencies: TaskDependency[];
  milestones: ProjectMilestone[];
}

/** Dependencies are informative: they never complete tasks or shift dates. */
export interface PlanningApi {
  scopeKey: string[];
  load(signal?: AbortSignal): Promise<PlanningState>;
  addDependency(task: Task, blocker: Task, requestId: string): Promise<TaskDependency>;
  removeDependency(edge: TaskDependency): Promise<void>;
  createMilestone(project: Project, input: MilestoneInput, requestId: string): Promise<ProjectMilestone>;
  updateMilestone(milestone: ProjectMilestone, input: MilestoneInput): Promise<ProjectMilestone>;
  deleteMilestone(milestone: ProjectMilestone): Promise<void>;
}

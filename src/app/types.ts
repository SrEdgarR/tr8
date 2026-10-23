export type TaskStatus = 'backlog' | 'todo' | 'progress' | 'review' | 'done';
export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export type ProjectStatus = 'planning' | 'active' | 'hold' | 'complete';

export interface Project {
  id: string;
  owner_id: string;
  code: string;
  name: string;
  description: string;
  color: string;
  status: ProjectStatus;
  archived_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  owner_id: string;
  project_id: string;
  task_number: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  start_date: string | null;
  due_date: string | null;
  position: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectInput {
  name: string;
  description: string;
  color: string;
  status: ProjectStatus;
}

export interface TaskInput {
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  start_date: string | null;
  due_date: string | null;
}

export type TaskPatch = Partial<Omit<TaskInput, 'project_id'>> & { position?: number };

export interface WorkspaceProps {
  projects: Project[];
  tasks: Task[];
  email: string;
  loading: boolean;
  refreshing: boolean;
  pending: boolean;
  error: string | null;
  onRetry: () => void;
  onCreateProject: (input: ProjectInput, requestId: string) => Promise<Project>;
  onUpdateProject: (project: Project, input: ProjectInput) => Promise<Project>;
  onArchiveProject: (project: Project, archived: boolean) => Promise<Project>;
  onCreateTask: (input: TaskInput, requestId: string) => Promise<Task>;
  onUpdateTask: (task: Task, patch: TaskPatch) => Promise<Task>;
  onDeleteTask: (task: Task) => Promise<void>;
  onSignOut: () => Promise<void>;
  onPasswordReset: () => Promise<void>;
}

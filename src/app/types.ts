export type TaskStatus = 'backlog' | 'todo' | 'progress' | 'review' | 'done';
export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export type ProjectStatus = 'planning' | 'active' | 'hold' | 'complete';

export interface Project {
  id: string;
  workspace_id: string;
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
  workspace_id: string;
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

export interface WorkspaceSummary {
  id: string;
  kind: 'personal' | 'team';
  name: string;
  owner_id: string;
  version: number;
  permissions: string[];
}

export interface AppContext {
  contract_version: 2;
  personal_workspace_id: string;
  workspaces: WorkspaceSummary[];
  external_invites_enabled: boolean;
}

export interface WorkspaceMember {
  id: string;
  user_id: string;
  display_name: string;
  status: string;
  version: number;
  is_owner: boolean;
  roles: { id: string; name: string; template_key: string | null }[];
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  status: string;
  expires_at: string;
  version: number;
  created_at: string;
}

export interface WorkspaceProps {
  workspace?: WorkspaceSummary;
  workspaces?: WorkspaceSummary[];
  readOnly?: boolean;
  accessUnavailable?: boolean;
  members?: WorkspaceMember[];
  invitations?: WorkspaceInvitation[];
  directoryLoading?: boolean;
  directoryError?: string | null;
  onSelectWorkspace?: (id: string) => void;
  onCreateTeam?: (name: string, requestId: string) => Promise<WorkspaceSummary>;
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

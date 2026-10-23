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
  assignee_member_id: string | null;
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
  permissions: string[];
  can_manage_roles: boolean;
  can_remove: boolean;
}

export interface WorkspaceRole {
  id: string;
  workspace_id: string;
  name: string;
  template_key: string | null;
  version: number;
  permissions: string[];
  created_at: string;
  updated_at: string;
}

export interface ProjectCapability {
  project_id: string;
  access_level: 'read' | 'write';
  permissions: string[];
}

export interface ProjectAccess {
  workspace_id: string;
  project_id: string;
  member_id: string;
  display_name: string;
  access_level: 'read' | 'write';
  version: number;
}

export interface AssignableMember {
  id: string;
  user_id: string;
  display_name: string;
  is_owner: boolean;
}

export interface ActivityEntry {
  id: number;
  project_id: string | null;
  actor_id: string;
  actor_name: string;
  action: string;
  resource_id: string | null;
  created_at: string;
}

export interface ActivityPage {
  items: ActivityEntry[];
  next_before_id: number | null;
}

export interface CollaborationApi {
  scopeKey: string[];
  roles: () => Promise<WorkspaceRole[]>;
  createRole: (id: string, name: string, permissions: string[]) => Promise<WorkspaceRole>;
  updateRole: (role: WorkspaceRole, name: string, permissions: string[]) => Promise<WorkspaceRole>;
  deleteRole: (role: WorkspaceRole) => Promise<unknown>;
  setMemberRoles: (member: WorkspaceMember, roleIds: string[]) => Promise<WorkspaceMember>;
  removeMember: (member: WorkspaceMember) => Promise<WorkspaceMember>;
  projectAccess: (projectId: string) => Promise<ProjectAccess[]>;
  setProjectAccess: (projectId: string, memberId: string, version: number, level: 'read' | 'write') => Promise<ProjectAccess>;
  removeProjectAccess: (access: ProjectAccess) => Promise<unknown>;
  assignableMembers: (projectId: string) => Promise<AssignableMember[]>;
  assignTask: (task: Task, memberId: string | null) => Promise<Task>;
  activity: (projectId: string | null, beforeId?: number | null) => Promise<ActivityPage>;
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
  currentUserId?: string;
  capabilities?: Record<string, ProjectCapability>;
  collaboration?: CollaborationApi;
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

import type { Project, Task, WorkspaceMember, WorkspaceProps } from '../types';
import { canInProject, canInWorkspace } from './permissions';

export interface ProjectSummaryModel {
  project: Project;
  tasks: Task[];
  taskReadable: boolean;
  total: number;
  open: number;
  done: number;
  overdue: number;
  progress: number;
  nextDue: string | null;
}

export function summarizeProject(project: Project, tasks: Task[], taskReadable: boolean, today: string): ProjectSummaryModel {
  const visible = taskReadable ? tasks.filter(task => task.workspace_id === project.workspace_id && task.project_id === project.id) : [];
  const open = visible.filter(task => task.status !== 'done');
  const done = visible.length - open.length;
  return {
    project,
    tasks: visible,
    taskReadable,
    total: visible.length,
    open: open.length,
    done,
    overdue: open.filter(task => task.due_date && task.due_date < today).length,
    progress: visible.length ? Math.round((done / visible.length) * 100) : 0,
    nextDue:
      open
        .map(task => task.due_date)
        .filter((date): date is string => Boolean(date))
        .sort()[0] ?? null,
  };
}

/** Derive presentation from the current authorized snapshot; never fetch or persist business data. */
export function buildDashboardModel(data: WorkspaceProps, today: string) {
  const projects = data.accessUnavailable
    ? []
    : data.projects.filter(
        project =>
          (!data.workspace || project.workspace_id === data.workspace.id) &&
          !project.archived_at &&
          (!data.capabilities || canInProject(data, project.id, 'project.read')),
      );
  const projectMap = new Map(projects.map(project => [project.id, project]));
  const tasks = data.accessUnavailable
    ? []
    : data.tasks.filter(task => {
        const project = projectMap.get(task.project_id);
        return project && task.workspace_id === project.workspace_id && (!data.capabilities || canInProject(data, project.id, 'task.read'));
      });
  const projectSummaries = projects.map(project => summarizeProject(project, tasks, !data.capabilities || canInProject(data, project.id, 'task.read'), today));
  const directoryState =
    data.accessUnavailable || data.workspace?.kind !== 'team' || !canInWorkspace(data, 'member.read')
      ? ('unavailable' as const)
      : data.directoryError
        ? ('error' as const)
        : data.directoryLoading
          ? ('loading' as const)
          : ('ready' as const);
  const members: WorkspaceMember[] = directoryState === 'ready' ? (data.members ?? []).filter(member => member.status === 'active') : [];
  const memberMap = new Map(members.map(member => [member.id, member]));
  const currentMember = members.find(member => member.user_id === data.currentUserId);
  const personal = !data.workspace || data.workspace.kind === 'personal';
  const mineAvailable = !data.accessUnavailable && (personal || Boolean(currentMember));
  const mine = !mineAvailable ? [] : personal ? tasks : tasks.filter(task => task.assignee_member_id === currentMember!.id);
  const openTasks = tasks.filter(task => task.status !== 'done');
  const done = tasks.length - openTasks.length;
  return {
    projects,
    tasks,
    projectSummaries,
    projectMap,
    members,
    memberMap,
    mine,
    mineAvailable,
    directoryState,
    directoryAvailable: directoryState === 'ready',
    directoryPending: directoryState === 'loading',
    taskCoveragePartial: projectSummaries.some(summary => !summary.taskReadable),
    unassigned: openTasks.filter(task => !task.assignee_member_id),
    unavailableAssignees: openTasks.filter(task => task.assignee_member_id && !memberMap.has(task.assignee_member_id)),
    workloads: members.map(member => ({ member, tasks: openTasks.filter(task => task.assignee_member_id === member.id) })),
    totals: {
      projects: projects.length,
      tasks: tasks.length,
      open: openTasks.length,
      done,
      overdue: openTasks.filter(task => task.due_date && task.due_date < today).length,
      progress: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    },
  };
}

/** Date-only arithmetic avoids UTC conversion and DST changing a task's calendar day. */
export function shiftDashboardDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

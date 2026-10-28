import type { PlanningState, TaskDependency } from '../planning-types';
import type { Priority, Project, Task, TaskStatus, WorkspaceProps } from '../types';
import { STATUSES } from '../constants';
import { buildDashboardModel } from './dashboard-model';
import { canInProject } from './permissions';

const DAY_MS = 86_400_000;
export type TimelineScale = 'week' | 'month';
export type TimelineGrouping = 'status' | 'project' | 'assignee' | 'none';
export interface TimelineFilters {
  query: string;
  status: TaskStatus | '';
  priority: Priority | '';
  projectId: string;
  assigneeId: string;
}
export interface TaskInterval {
  start: string;
  end: string;
}
export interface TimelineGroup {
  id: string;
  label: string;
  tasks: Task[];
  color?: string;
  status?: TaskStatus;
}
export const TIMELINE_SCALES = {
  week: { days: 91, dayWidth: 32, leadDays: 21, step: 7 },
  month: { days: 238, dayWidth: 11, leadDays: 56, step: 28 },
} as const;
export const emptyTimelineFilters = (): TimelineFilters => ({ query: '', status: '', priority: '', projectId: '', assigneeId: '' });

/** Convert a date-only value to a civil day, without the browser's time zone or DST. */
export function civilDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() / DAY_MS : null;
}
export function shiftCivilDate(value: string, days: number): string {
  const day = civilDay(value);
  if (day === null || !Number.isFinite(days)) throw new Error('Fecha no válida.');
  return new Date((day + Math.trunc(days)) * DAY_MS).toISOString().slice(0, 10);
}
export function daysBetween(start: string, end: string): number {
  const a = civilDay(start);
  const b = civilDay(end);
  if (a === null || b === null) throw new Error('Fecha no válida.');
  return b - a;
}
export function civilWeekday(value: string): number {
  const day = civilDay(value);
  if (day === null) throw new Error('Fecha no válida.');
  return new Date(day * DAY_MS).getUTCDay();
}
export function timelineWindow(anchor: string, scale: TimelineScale) {
  const settings = TIMELINE_SCALES[scale];
  const first = shiftCivilDate(anchor, -settings.leadDays);
  const start = shiftCivilDate(first, -((civilWeekday(first) + 6) % 7));
  return { ...settings, start, end: shiftCivilDate(start, settings.days - 1) };
}
export function taskInterval(task: Pick<Task, 'start_date' | 'due_date'>): TaskInterval | null {
  const start = task.start_date && civilDay(task.start_date) !== null ? task.start_date : null;
  const end = task.due_date && civilDay(task.due_date) !== null ? task.due_date : null;
  if (!start && !end) return null;
  return { start: start && (!end || start <= end) ? start : end!, end: end ?? start! };
}
export function shiftedInterval(interval: TaskInterval, days: number, mode: 'move' | 'start' | 'end'): TaskInterval {
  return mode === 'move'
    ? { start: shiftCivilDate(interval.start, days), end: shiftCivilDate(interval.end, days) }
    : mode === 'start'
      ? { start: [shiftCivilDate(interval.start, days), interval.end].sort()[0], end: interval.end }
      : { start: interval.start, end: [shiftCivilDate(interval.end, days), interval.start].sort()[1] };
}
export function dependencyConflict(blocker: TaskInterval, task: TaskInterval): boolean {
  // End dates are inclusive. A successor can start on the following civil day.
  return task.start <= blocker.end;
}
export function canRescheduleTimelineTask(data: WorkspaceProps, task: Task, project: Project | undefined): boolean {
  return Boolean(
    !data.readOnly &&
    !data.accessUnavailable &&
    !data.pending &&
    project &&
    !project.archived_at &&
    !task.archived_at &&
    task.project_id === project.id &&
    task.workspace_id === project.workspace_id &&
    canInProject(data, project.id, 'task.edit'),
  );
}

export function buildTimelineModel(
  data: WorkspaceProps,
  today: string,
  planning: PlanningState,
  filters: TimelineFilters = emptyTimelineFilters(),
  grouping: TimelineGrouping = 'status',
  selectedProject?: Project,
) {
  const dashboard = buildDashboardModel(data, today);
  // The general view excludes archived projects; a project opened explicitly may be read-only.
  const canonical = selectedProject && data.projects.find(project => project.id === selectedProject.id);
  const readableProject =
    canonical &&
    !data.accessUnavailable &&
    (!data.workspace || canonical.workspace_id === data.workspace.id) &&
    (!data.capabilities || canInProject(data, canonical.id, 'project.read'))
      ? canonical
      : undefined;
  const projects = selectedProject ? (readableProject ? [readableProject] : []) : dashboard.projects;
  const projectMap = new Map(projects.map(project => [project.id, project]));
  const source = selectedProject
    ? data.tasks.filter(
        task =>
          readableProject &&
          task.project_id === readableProject.id &&
          task.workspace_id === readableProject.workspace_id &&
          !task.archived_at &&
          (!data.capabilities || canInProject(data, readableProject.id, 'task.read')),
      )
    : dashboard.tasks;
  const query = filters.query.trim().toLocaleLowerCase();
  const tasks = source.filter(
    task =>
      (!filters.status || task.status === filters.status) &&
      (!filters.priority || task.priority === filters.priority) &&
      (!filters.projectId || task.project_id === filters.projectId) &&
      (!filters.assigneeId ||
        (dashboard.directoryAvailable &&
          (filters.assigneeId === '__unassigned' ? !task.assignee_member_id : task.assignee_member_id === filters.assigneeId))) &&
      (!query || `${task.title} ${projectMap.get(task.project_id)?.name ?? ''}`.toLocaleLowerCase().includes(query)),
  );
  const scheduled = tasks
    .filter(task => taskInterval(task))
    .sort((a, b) => taskInterval(a)!.start.localeCompare(taskInterval(b)!.start) || a.position - b.position || a.id.localeCompare(b.id));
  const undated = tasks.filter(task => !taskInterval(task));
  const effectiveGrouping = grouping === 'assignee' && !dashboard.directoryAvailable ? 'status' : grouping;
  const groups: TimelineGroup[] = [];
  const append = (id: string, label: string, task: Task, color?: string, status?: TaskStatus) => {
    let group = groups.find(item => item.id === id);
    if (!group) {
      group = { id, label, tasks: [], color, status };
      groups.push(group);
    }
    group.tasks.push(task);
  };
  for (const task of scheduled) {
    const project = projectMap.get(task.project_id)!;
    if (effectiveGrouping === 'none') append('all', 'Tareas', task);
    else if (effectiveGrouping === 'project') append(project.id, project.name, task, project.color);
    else if (effectiveGrouping === 'assignee') {
      const member = task.assignee_member_id ? dashboard.memberMap.get(task.assignee_member_id) : undefined;
      append(member?.id ?? '__unassigned', member?.display_name ?? (task.assignee_member_id ? 'Responsable no disponible' : 'Sin responsable'), task);
    } else append(task.status, STATUSES.find(status => status.id === task.status)!.name, task, undefined, task.status);
  }
  if (effectiveGrouping === 'status')
    groups.sort((a, b) => STATUSES.findIndex(status => status.id === a.id) - STATUSES.findIndex(status => status.id === b.id));
  const taskMap = new Map(scheduled.map(task => [task.id, task]));
  const dependencies = planning.dependencies.filter((edge: TaskDependency) => {
    const task = taskMap.get(edge.task_id);
    const blocker = taskMap.get(edge.blocker_task_id);
    return task && blocker && edge.workspace_id === task.workspace_id && edge.workspace_id === blocker.workspace_id;
  });
  const milestones = planning.milestones
    .filter(milestone => {
      const project = projectMap.get(milestone.project_id);
      return (
        project &&
        project.workspace_id === milestone.workspace_id &&
        (!filters.projectId || project.id === filters.projectId) &&
        civilDay(milestone.date) !== null
      );
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return {
    projects,
    projectMap,
    tasks,
    scheduled,
    undated,
    groups,
    dependencies,
    milestones,
    effectiveGrouping,
    members: dashboard.members,
    memberMap: dashboard.memberMap,
    directoryAvailable: dashboard.directoryAvailable,
  };
}

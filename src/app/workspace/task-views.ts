import type { TaskViewConfig } from '../productivity-types';
import type { Project, Task, WorkspaceMember } from '../types';
import { PRIORITIES, STATUSES } from '../constants';
import { shiftDashboardDate } from './dashboard-model';

export function defaultTaskView(): TaskViewConfig {
  return {
    schemaVersion: 1,
    view: 'list',
    query: '',
    statuses: [],
    priorities: [],
    projectIds: [],
    assigneeIds: [],
    due: 'all',
    sort: 'manual',
    direction: 'asc',
    group: 'none',
    columns: ['project', 'status', 'priority', 'assignee', 'due_date'],
    favoritesOnly: false,
  };
}

export function manualTaskOrder(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export function filterTaskView(
  tasks: readonly Task[],
  projects: readonly Project[],
  config: TaskViewConfig,
  favoriteIds: readonly string[],
  today: string,
): Task[] {
  const projectMap = new Map(projects.map(project => [project.id, project]));
  const favorites = new Set(favoriteIds);
  const query = config.query.trim().toLocaleLowerCase('es');
  const end = shiftDashboardDate(today, 7);
  const filtered = tasks.filter(task => {
    const project = projectMap.get(task.project_id);
    if (!project || task.workspace_id !== project.workspace_id) return false;
    if (config.statuses.length && !config.statuses.includes(task.status)) return false;
    if (config.priorities.length && !config.priorities.includes(task.priority)) return false;
    if (config.projectIds.length && !config.projectIds.includes(task.project_id)) return false;
    if (config.assigneeIds.length && !config.assigneeIds.includes(task.assignee_member_id ?? 'none')) return false;
    if (config.favoritesOnly && !favorites.has(task.id)) return false;
    if (query && !`${task.title} ${task.description} ${project.name} ${project.code}-${task.task_number}`.toLocaleLowerCase('es').includes(query)) return false;
    if (config.due === 'undated') return !task.due_date;
    if (config.due === 'overdue') return task.status !== 'done' && Boolean(task.due_date && task.due_date < today);
    if (config.due === 'today') return task.due_date === today;
    if (config.due === 'next7') return Boolean(task.due_date && task.due_date >= today && task.due_date <= end);
    return true;
  });
  const direction = config.direction === 'desc' ? -1 : 1;
  const statusOrder = new Map(STATUSES.map((status, index) => [status.id, index]));
  const priorities = ['urgent', 'high', 'medium', 'low', 'none'];
  return [...filtered].sort((a, b) => {
    if (config.sort === 'due_date' && (!a.due_date || !b.due_date)) return a.due_date ? -1 : b.due_date ? 1 : a.id.localeCompare(b.id);
    const compare =
      config.sort === 'manual'
        ? a.position - b.position
        : config.sort === 'title'
          ? a.title.localeCompare(b.title, 'es', { numeric: true })
          : config.sort === 'status'
            ? (statusOrder.get(a.status) ?? 0) - (statusOrder.get(b.status) ?? 0)
            : config.sort === 'priority'
              ? priorities.indexOf(a.priority) - priorities.indexOf(b.priority)
              : (a[config.sort] ?? '').localeCompare(b[config.sort] ?? '');
    return compare * direction || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  });
}

export interface TaskViewGroup {
  id: string;
  label: string;
  tasks: Task[];
}
export function groupTaskView(
  tasks: readonly Task[],
  config: TaskViewConfig,
  projects: readonly Project[],
  members: readonly WorkspaceMember[],
): TaskViewGroup[] {
  if (config.group === 'none') return [{ id: 'all', label: 'Todas las tareas', tasks: [...tasks] }];
  const groups = new Map<string, TaskViewGroup>();
  const projectMap = new Map(projects.map(project => [project.id, project.name]));
  const memberMap = new Map(members.map(member => [member.id, member.display_name]));
  for (const task of tasks) {
    const id =
      config.group === 'status'
        ? task.status
        : config.group === 'priority'
          ? task.priority
          : config.group === 'project'
            ? task.project_id
            : (task.assignee_member_id ?? 'none');
    const label =
      config.group === 'status'
        ? STATUSES.find(status => status.id === id)?.name
        : config.group === 'priority'
          ? PRIORITIES.find(priority => priority.id === id)?.name
          : config.group === 'project'
            ? projectMap.get(id)
            : id === 'none'
              ? 'Sin responsable'
              : (memberMap.get(id) ?? 'Responsable no disponible');
    const group = groups.get(id) ?? { id, label: label ?? 'No disponible', tasks: [] };
    group.tasks.push(task);
    groups.set(id, group);
  }
  return [...groups.values()];
}

/** Keep hidden/filtered rows in place; move only inside the same authorized project. */
export function reorderedProjectTasks(tasks: readonly Task[], draggedId: string, beforeId: string): Task[] | null {
  const dragged = tasks.find(task => task.id === draggedId);
  const target = tasks.find(task => task.id === beforeId);
  if (!dragged || !target || dragged.id === target.id || dragged.project_id !== target.project_id || dragged.workspace_id !== target.workspace_id) return null;
  const ordered = manualTaskOrder(tasks.filter(task => task.project_id === dragged.project_id && task.workspace_id === dragged.workspace_id));
  const without = ordered.filter(task => task.id !== draggedId);
  const index = without.findIndex(task => task.id === beforeId);
  without.splice(index, 0, dragged);
  return without;
}

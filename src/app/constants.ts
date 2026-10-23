import type { Priority, ProjectStatus, TaskStatus } from './types';

export const STATUSES: { id: TaskStatus; name: string; color: string }[] = [
  { id: 'backlog', name: 'Pendiente de planificar', color: 'var(--st-backlog)' },
  { id: 'todo', name: 'Por hacer', color: 'var(--st-todo)' },
  { id: 'progress', name: 'En progreso', color: 'var(--st-progress)' },
  { id: 'review', name: 'En revisión', color: 'var(--st-review)' },
  { id: 'done', name: 'Completada', color: 'var(--st-done)' },
];
export const PRIORITIES: { id: Priority; name: string }[] = [
  { id: 'none', name: 'Sin prioridad' },
  { id: 'low', name: 'Baja' },
  { id: 'medium', name: 'Media' },
  { id: 'high', name: 'Alta' },
  { id: 'urgent', name: 'Urgente' },
];
export const PROJECT_STATUSES: { id: ProjectStatus; name: string }[] = [
  { id: 'planning', name: 'En planificación' },
  { id: 'active', name: 'En progreso' },
  { id: 'hold', name: 'En pausa' },
  { id: 'complete', name: 'Completado' },
];
export const PROJECT_COLORS = ['#5A67D8', '#3B82C4', '#8662C9', '#23918A', '#C54B78', '#C48A1E', '#3D8E5F', '#6B7280'];

export function formatDate(value: string | null): string {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00`));
}

import { Archive, ListChecks, Repeat2, Timer } from 'lucide-react';
import type { Task } from '../types';
import './work-management.css';

const COLORS = ['purple', 'blue', 'green', 'amber', 'pink'];
export default function TaskMetadata({ task }: { task: Task }) {
  const subtasks = task.subtasks ?? [];
  const minutes = task.estimate_minutes;
  if (!task.archived_at && !task.labels?.length && !subtasks.length && !minutes && !task.recurrence) return null;
  return (
    <span className="wm-task-metadata">
      {task.recurrence && (
        <span
          className={`wm-tag ${task.recurrence.state === 'active' ? 'wm-tag-purple' : 'wm-tag-amber'}`}
          title={`Repetición ${task.recurrence.state === 'active' ? 'activa' : task.recurrence.state === 'paused' ? 'pausada' : task.recurrence.state === 'blocked' ? 'por revisar' : 'finalizada'}`}
        >
          <Repeat2 size={11} aria-hidden="true" />
          {{ daily: 'Diaria', weekly: 'Semanal', monthly: 'Mensual' }[task.recurrence.frequency]}
          {task.recurrence.interval > 1 ? ` · ${task.recurrence.interval}` : ''}
        </span>
      )}
      {task.archived_at && (
        <span className="wm-tag wm-tag-amber">
          <Archive size={11} aria-hidden="true" /> Archivada
        </span>
      )}
      {task.labels?.map(label => (
        <span key={label} className={`wm-tag wm-tag-${COLORS[[...label].reduce((sum, char) => sum + char.codePointAt(0)!, 0) % COLORS.length]}`}>
          {label}
        </span>
      ))}
      {Boolean(minutes) && (
        <span className="wm-task-hint" title="Tiempo estimado">
          <Timer size={11} aria-hidden="true" />
          {minutes! >= 60 ? `${Math.floor(minutes! / 60)} h ${minutes! % 60 ? `${minutes! % 60} min` : ''}` : `${minutes} min`}
        </span>
      )}
      {subtasks.length > 0 && (
        <span className="wm-task-hint" title="Subtareas completadas">
          <ListChecks size={12} aria-hidden="true" />
          {subtasks.filter(item => item.done).length}/{subtasks.length}
        </span>
      )}
    </span>
  );
}

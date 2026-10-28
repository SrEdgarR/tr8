import { ArrowDown, ArrowUp, Check, GripVertical, Star } from 'lucide-react';
import { formatDate, PRIORITIES, STATUSES } from '../constants';
import type { TaskTableProps } from './TaskTable';
import { PriorityIcon, ProjectGlyph } from './project-identity';
import { StatusDot } from './ui';
import TaskMetadata from './TaskMetadata';

export default function TaskList({
  tasks,
  projects,
  pending,
  today,
  mayEdit,
  onOpen,
  onMove,
  favoriteIds,
  onFavorite,
  onReorder,
  onDragStart,
  onDrop,
  selection,
}: TaskTableProps) {
  const projectMap = new Map(projects.map(project => [project.id, project]));
  return (
    <div className={`pw-task-list${selection ? ' tv-selectable-list' : ''}`} role="table" aria-label="Lista de tareas">
      <div className="pw-task-row pw-task-list-head" role="row">
        <span role="columnheader">
          <span className="sr">{selection ? 'Seleccionar y completar' : 'Completar'}</span>
        </span>
        <span role="columnheader">Tarea</span>
        <span role="columnheader">Estado</span>
        <span role="columnheader">Prioridad</span>
        <span role="columnheader">Vencimiento</span>
      </div>
      {tasks.map(task => (
        <div
          key={task.id}
          className={`pw-task-row${task.status === 'done' ? ' pw-done' : ''}${selection?.selectedIds.includes(task.id) ? ' tv-row-selected' : ''}`}
          role="row"
          draggable={Boolean(onDragStart && !pending && mayEdit(task))}
          onDragStart={event => onDragStart?.(task.id, event)}
          onDragOver={event => {
            if (onDrop) event.preventDefault();
          }}
          onDrop={event => onDrop?.(task, event)}
        >
          <span role="cell">
            {selection && (
              <label className="tv-select-task">
                <input
                  type="checkbox"
                  aria-label={`Seleccionar ${task.title}`}
                  checked={selection.selectedIds.includes(task.id)}
                  disabled={selection.disabled || !selection.canSelect(task)}
                  onChange={() => selection.toggle(task)}
                />
                <span aria-hidden="true">
                  <Check size={12} />
                </span>
              </label>
            )}
            <button
              className={`pw-complete${task.status === 'done' ? ' checked' : ''}`}
              disabled={pending || !mayEdit(task)}
              aria-label={task.status === 'done' ? `Reabrir ${task.title}` : `Completar ${task.title}`}
              onClick={() => void onMove(task, task.status === 'done' ? 'todo' : 'done')}
            >
              {task.status === 'done' && <Check size={12} aria-hidden="true" />}
            </button>
          </span>
          <span className="pw-task-title-cell" role="cell">
            <span className="tv-list-title">
              {onDragStart && <GripVertical size={12} className="tv-drag-hint" aria-hidden="true" />}
              <button className="pw-task-title" onClick={() => onOpen(task)}>
                {task.title}
              </button>
              {onFavorite && (
                <button
                  className={`ibtn ibtn-xs tv-star${favoriteIds.includes(task.id) ? ' is-favorite' : ''}`}
                  aria-pressed={favoriteIds.includes(task.id)}
                  aria-label={`${favoriteIds.includes(task.id) ? 'Quitar de favoritas' : 'Marcar favorita'} ${task.title}`}
                  disabled={pending}
                  onClick={() => onFavorite(task, !favoriteIds.includes(task.id))}
                >
                  <Star size={13} aria-hidden="true" />
                </button>
              )}
              {onReorder && (
                <span className="tv-reorder-actions">
                  <button className="ibtn ibtn-xs" aria-label={`Subir ${task.title}`} disabled={pending || !mayEdit(task)} onClick={() => onReorder(task, -1)}>
                    <ArrowUp size={11} aria-hidden="true" />
                  </button>
                  <button className="ibtn ibtn-xs" aria-label={`Bajar ${task.title}`} disabled={pending || !mayEdit(task)} onClick={() => onReorder(task, 1)}>
                    <ArrowDown size={11} aria-hidden="true" />
                  </button>
                </span>
              )}
            </span>
            <span className="pw-task-subtitle">
              <span className="mono">
                {projectMap.get(task.project_id)?.code}-{task.task_number}
              </span>
              <span className="pw-task-project-identity" style={{ color: projectMap.get(task.project_id)?.color }}>
                <ProjectGlyph icon={projectMap.get(task.project_id)?.icon} size={11} />
                {projectMap.get(task.project_id)?.name}
              </span>
            </span>
            <TaskMetadata task={task} />
          </span>
          <span role="cell" className="pw-state-cell">
            <StatusDot status={task.status} />
            <select
              className="pw-status-select"
              aria-label={`Estado de ${task.title}`}
              value={task.status}
              disabled={pending || !mayEdit(task)}
              onChange={event => void onMove(task, event.target.value as typeof task.status)}
            >
              {STATUSES.map(status => (
                <option key={status.id} value={status.id}>
                  {status.name}
                </option>
              ))}
            </select>
          </span>
          <span role="cell" className={`pw-priority pw-priority-${task.priority}`}>
            <PriorityIcon priority={task.priority} />
            {PRIORITIES.find(item => item.id === task.priority)?.name}
          </span>
          <span role="cell" className={`pw-due${task.due_date && task.due_date < today && task.status !== 'done' ? ' overdue' : ''}`}>
            {formatDate(task.due_date)}
          </span>
        </div>
      ))}
    </div>
  );
}

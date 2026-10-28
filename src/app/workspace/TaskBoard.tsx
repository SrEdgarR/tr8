import { useState } from 'react';
import { ArrowDown, ArrowUp, CalendarDays, Check, ChevronRight, Plus, RotateCcw, Star } from 'lucide-react';
import { formatDate, PRIORITIES, STATUSES } from '../constants';
import type { Task, TaskStatus } from '../types';
import type { TaskTableProps } from './TaskTable';
import { IdentityAvatar, PriorityIcon } from './project-identity';
import { StatusDot } from './ui';
import TaskMetadata from './TaskMetadata';

type Props = TaskTableProps & { readOnly: boolean; canCreate: boolean; onCreate: (status?: TaskStatus) => void };
export default function TaskBoard({
  tasks,
  projects,
  members,
  pending,
  today,
  mayEdit,
  onOpen,
  onMove,
  favoriteIds,
  onFavorite,
  onReorder,
  onDrop,
  readOnly,
  canCreate,
  onCreate,
}: Props) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const projectMap = new Map(projects.map(project => [project.id, project]));
  const memberMap = new Map(members.map(member => [member.id, member.display_name]));
  function stateSelect(task: Task) {
    return (
      <select
        className="pw-status-select"
        aria-label={`Estado de ${task.title}`}
        value={task.status}
        disabled={pending || !mayEdit(task)}
        onChange={event => void onMove(task, event.target.value as TaskStatus)}
      >
        {STATUSES.map(status => (
          <option key={status.id} value={status.id}>
            {status.name}
          </option>
        ))}
      </select>
    );
  }
  return (
    <>
      <p className="pw-board-help">
        {readOnly
          ? 'Vista de solo lectura: puedes consultar las tareas de este proyecto.'
          : 'Arrastra las tarjetas entre columnas o utiliza el selector de estado de cada tarea.'}
      </p>
      <div className="board pw-board">
        {STATUSES.map(column => {
          const items = tasks.filter(task => task.status === column.id);
          return (
            <section
              key={column.id}
              className={`bcol${over === column.id ? ' over' : ''}`}
              aria-label={`${column.name}: ${items.length} ${items.length === 1 ? 'tarea' : 'tareas'}`}
              onDragOver={event => {
                if (dragging && !pending && !readOnly) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setOver(column.id);
                }
              }}
              onDragLeave={event => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
              }}
              onDrop={event => {
                event.preventDefault();
                setOver(null);
                setDragging(null);
                if (pending || readOnly) return;
                const task = tasks.find(item => item.id === event.dataTransfer.getData('text/plain'));
                if (task && mayEdit(task) && task.status !== column.id) void onMove(task, column.id);
              }}
            >
              <div className="bcol-h">
                <StatusDot status={column.id} />
                <span>{column.name}</span>
                <span className="cnt">{items.length}</span>
                <span className="acts">
                  <button
                    className="ibtn ibtn-xs tv-column-collapse"
                    aria-label={`${collapsed[column.id] ? 'Mostrar' : 'Ocultar'} tareas: ${column.name}`}
                    aria-expanded={!collapsed[column.id]}
                    onClick={() => setCollapsed(previous => ({ ...previous, [column.id]: !previous[column.id] }))}
                  >
                    <ChevronRight className={collapsed[column.id] ? '' : 'is-open'} size={12} aria-hidden="true" />
                  </button>
                  {canCreate && (
                    <button className="ibtn ibtn-xs" aria-label={`Añadir tarea: ${column.name}`} disabled={pending} onClick={() => onCreate(column.id)}>
                      <Plus size={15} aria-hidden="true" />
                    </button>
                  )}
                </span>
              </div>
              {!collapsed[column.id] && (
                <div className="bcol-b">
                  {items.map(task => (
                    <article
                      key={task.id}
                      className={`kcard${task.status === 'done' ? ' done' : ''}${dragging === task.id ? ' dragging' : ''}`}
                      draggable={!pending && mayEdit(task)}
                      onDragStart={event => {
                        event.dataTransfer.setData('text/plain', task.id);
                        event.dataTransfer.effectAllowed = 'move';
                        setDragging(task.id);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                      onDragOver={event => {
                        if (onDrop) event.preventDefault();
                      }}
                      onDrop={event => onDrop?.(task, event)}
                    >
                      <div className="tv-card-heading">
                        <button className="title pw-card-title" onClick={() => onOpen(task)}>
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
                      </div>
                      {task.description && <p className="pw-card-description">{task.description}</p>}
                      <TaskMetadata task={task} />
                      <div className="meta">
                        <span className="key">
                          {projectMap.get(task.project_id)?.code}-{task.task_number}
                        </span>
                        <span className={`pw-priority pw-priority-${task.priority}`}>
                          <PriorityIcon priority={task.priority} />
                          {PRIORITIES.find(item => item.id === task.priority)?.name}
                        </span>
                      </div>
                      {task.due_date && (
                        <span className={`pw-card-date${task.due_date < today && task.status !== 'done' ? ' overdue' : ''}`}>
                          <CalendarDays size={12} aria-hidden="true" />
                          {formatDate(task.due_date)}
                        </span>
                      )}
                      <div className="pw-card-bottom">
                        {stateSelect(task)}
                        {task.assignee_member_id && memberMap.has(task.assignee_member_id) && (
                          <span className="pw-task-assignee">
                            <IdentityAvatar name={memberMap.get(task.assignee_member_id)!} small />
                          </span>
                        )}
                        <button
                          className="ibtn ibtn-xs"
                          disabled={pending || !mayEdit(task)}
                          aria-label={task.status === 'done' ? `Reabrir ${task.title}` : `Completar ${task.title}`}
                          onClick={() => void onMove(task, task.status === 'done' ? 'todo' : 'done')}
                        >
                          {task.status === 'done' ? <RotateCcw size={13} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                        </button>
                        {onReorder && (
                          <span className="tv-reorder-actions">
                            <button
                              className="ibtn ibtn-xs"
                              aria-label={`Subir ${task.title}`}
                              disabled={pending || !mayEdit(task)}
                              onClick={() => onReorder(task, -1)}
                            >
                              <ArrowUp size={11} aria-hidden="true" />
                            </button>
                            <button
                              className="ibtn ibtn-xs"
                              aria-label={`Bajar ${task.title}`}
                              disabled={pending || !mayEdit(task)}
                              onClick={() => onReorder(task, 1)}
                            >
                              <ArrowDown size={11} aria-hidden="true" />
                            </button>
                          </span>
                        )}
                      </div>
                    </article>
                  ))}
                  {canCreate && (
                    <button className="addcard" disabled={pending} onClick={() => onCreate(column.id)}>
                      <Plus size={14} aria-hidden="true" />
                      Añadir tarea
                    </button>
                  )}
                  {readOnly && items.length === 0 && <span className="pw-column-empty">Sin tareas</span>}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

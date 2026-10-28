import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, Check, Star } from 'lucide-react';
import type { TaskViewConfig } from '../productivity-types';
import type { Project, Task, TaskPatch, WorkspaceMember } from '../types';
import { PRIORITIES, STATUSES, formatDate } from '../constants';
import { errorMessage } from './helpers';
import { IdentityAvatar, PriorityIcon } from './project-identity';
import { ErrorNotice, StatusDot } from './ui';
import TaskMetadata from './TaskMetadata';

type Column = TaskViewConfig['columns'][number];
export interface TaskTableProps {
  tasks: Task[];
  projects: Project[];
  members: WorkspaceMember[];
  columns: Column[];
  pending: boolean;
  today: string;
  mayEdit: (task: Task) => boolean;
  onOpen: (task: Task) => void;
  onMove: (task: Task, status: Task['status']) => Promise<void>;
  onPatch?: (task: Task, patch: TaskPatch) => Promise<void>;
  favoriteIds: readonly string[];
  onFavorite?: (task: Task, value: boolean) => void;
  onReorder?: (task: Task, direction: -1 | 1) => void;
  onDragStart?: (id: string, event: DragEvent) => void;
  onDrop?: (task: Task, event: DragEvent) => void;
}

function EditableCell({
  task,
  field,
  disabled,
  onPatch,
}: {
  task: Task;
  field: 'title' | 'start_date' | 'due_date';
  disabled: boolean;
  onPatch: NonNullable<TaskTableProps['onPatch']>;
}) {
  const [value, setValue] = useState(task[field] ?? '');
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = useRef(task);
  const lock = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!focused && !error) {
      setValue(task[field] ?? '');
      base.current = task;
    }
  }, [task, field, focused, error]);
  async function save() {
    if (disabled || lock.current || value === (base.current[field] ?? '')) return;
    if (field === 'title' && !value.trim()) {
      setError('El título no puede estar vacío.');
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await onPatch(base.current, { [field]: field === 'title' ? value.trim() : value || null });
      setFocused(false);
    } catch (cause) {
      setError(errorMessage(cause));
      setFocused(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const label = field === 'title' ? `Título de ${task.title}` : `${field === 'start_date' ? 'Inicio' : 'Vencimiento'} de ${task.title}`;
  return (
    <div className="tv-inline-cell">
      <input
        type={field === 'title' ? 'text' : 'date'}
        aria-label={label}
        aria-invalid={Boolean(error)}
        value={value}
        maxLength={field === 'title' ? 240 : undefined}
        disabled={disabled || busy}
        onFocus={() => {
          if (!error) base.current = task;
          setFocused(true);
        }}
        onChange={event => setValue(event.target.value)}
        onBlur={() => {
          if (cancelled.current) {
            cancelled.current = false;
            return;
          }
          if (!lock.current) {
            if (value === (base.current[field] ?? '')) setFocused(false);
            else void save();
          }
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            void save();
          } else if (event.key === 'Escape') {
            cancelled.current = true;
            setValue(task[field] ?? '');
            setError(null);
            setFocused(false);
            event.currentTarget.blur();
          }
        }}
      />
      {error && (
        <span role="alert" className="tv-inline-error">
          {error}
          <button type="button" disabled={busy || disabled} onClick={() => void save()}>
            Reintentar
          </button>
        </span>
      )}
    </div>
  );
}

const columnLabels: Record<Column, string> = {
  project: 'Proyecto',
  status: 'Estado',
  priority: 'Prioridad',
  assignee: 'Responsable',
  start_date: 'Inicio',
  due_date: 'Vencimiento',
};
const columnWidths: Record<Column, string> = {
  project: '160px',
  status: '165px',
  priority: '120px',
  assignee: '155px',
  start_date: '145px',
  due_date: '145px',
};
export default function TaskTable({
  tasks,
  projects,
  members,
  columns,
  pending,
  today,
  mayEdit,
  onOpen,
  onMove,
  onPatch,
  favoriteIds,
  onFavorite,
  onReorder,
  onDragStart,
  onDrop,
}: TaskTableProps) {
  const [error, setError] = useState<string | null>(null);
  async function priority(task: Task, value: Task['priority']) {
    if (!onPatch) return;
    setError(null);
    try {
      await onPatch(task, { priority: value });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  const projectMap = new Map(projects.map(project => [project.id, project]));
  const memberMap = new Map(members.map(member => [member.id, member]));
  const style = { '--tv-columns': `70px minmax(230px,1fr) ${columns.map(column => columnWidths[column]).join(' ')}` } as CSSProperties;
  return (
    <>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <div className="tv-table-scroll">
        <div className="tv-table" role="table" aria-label="Tabla de tareas" style={style}>
          <div className="tv-table-row tv-table-head" role="row">
            <span role="columnheader">
              <span className="sr">Acciones</span>
            </span>
            <span role="columnheader">Tarea</span>
            {columns.map(column => (
              <span key={column} role="columnheader">
                {columnLabels[column]}
              </span>
            ))}
          </div>
          {tasks.map(task => (
            <div
              role="row"
              className={`tv-table-row${task.status === 'done' ? ' pw-done' : ''}`}
              key={task.id}
              draggable={Boolean(onDragStart && !pending && mayEdit(task))}
              onDragStart={event => onDragStart?.(task.id, event)}
              onDragOver={event => {
                if (onDrop) event.preventDefault();
              }}
              onDrop={event => onDrop?.(task, event)}
            >
              <span role="cell" className="tv-table-actions">
                <button
                  className={`pw-complete${task.status === 'done' ? ' checked' : ''}`}
                  aria-label={`${task.status === 'done' ? 'Reabrir' : 'Completar'} ${task.title}`}
                  disabled={pending || !mayEdit(task)}
                  onClick={() => void onMove(task, task.status === 'done' ? 'todo' : 'done')}
                >
                  {task.status === 'done' && <Check size={12} aria-hidden="true" />}
                </button>
                {onFavorite && (
                  <button
                    className={`ibtn ibtn-xs tv-star${favoriteIds.includes(task.id) ? ' is-favorite' : ''}`}
                    aria-pressed={favoriteIds.includes(task.id)}
                    aria-label={`${favoriteIds.includes(task.id) ? 'Quitar de favoritas' : 'Marcar favorita'} ${task.title}`}
                    disabled={pending}
                    onClick={() => onFavorite(task, !favoriteIds.includes(task.id))}
                  >
                    <Star size={14} aria-hidden="true" />
                  </button>
                )}
              </span>
              <span role="cell" className="tv-table-title">
                {onPatch ? (
                  <EditableCell task={task} field="title" onPatch={onPatch} disabled={pending || !mayEdit(task)} />
                ) : (
                  <button className="pw-task-title" onClick={() => onOpen(task)}>
                    {task.title}
                  </button>
                )}
                <button className="ibtn ibtn-xs" aria-label={`Abrir ${task.title}`} onClick={() => onOpen(task)}>
                  <ArrowUpRight size={13} aria-hidden="true" />
                </button>
                <TaskMetadata task={task} />
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
                    <button className="ibtn ibtn-xs" aria-label={`Bajar ${task.title}`} disabled={pending || !mayEdit(task)} onClick={() => onReorder(task, 1)}>
                      <ArrowDown size={11} aria-hidden="true" />
                    </button>
                  </span>
                )}
              </span>
              {columns.map(column => (
                <span
                  role="cell"
                  key={column}
                  className={`tv-table-cell tv-column-${column}${column === 'due_date' && task.due_date && task.due_date < today && task.status !== 'done' ? ' overdue' : ''}`}
                >
                  {column === 'project' ? (
                    <span className="tv-project-name">
                      <i style={{ background: projectMap.get(task.project_id)?.color }} />
                      {projectMap.get(task.project_id)?.name}
                    </span>
                  ) : column === 'status' ? (
                    <>
                      <StatusDot status={task.status} />
                      <select
                        aria-label={`Estado de ${task.title}`}
                        value={task.status}
                        disabled={pending || !mayEdit(task)}
                        onChange={event => void onMove(task, event.target.value as Task['status'])}
                      >
                        {STATUSES.map(status => (
                          <option key={status.id} value={status.id}>
                            {status.name}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : column === 'priority' ? (
                    <>
                      <PriorityIcon priority={task.priority} />
                      {onPatch ? (
                        <select
                          aria-label={`Prioridad de ${task.title}`}
                          value={task.priority}
                          disabled={pending || !mayEdit(task)}
                          onChange={event => void priority(task, event.target.value as Task['priority'])}
                        >
                          {PRIORITIES.map(priority => (
                            <option key={priority.id} value={priority.id}>
                              {priority.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        PRIORITIES.find(item => item.id === task.priority)?.name
                      )}
                    </>
                  ) : column === 'assignee' ? (
                    task.assignee_member_id ? (
                      memberMap.has(task.assignee_member_id) ? (
                        <>
                          <IdentityAvatar name={memberMap.get(task.assignee_member_id)!.display_name} small decorative />
                          {memberMap.get(task.assignee_member_id)!.display_name}
                        </>
                      ) : (
                        'Responsable no disponible'
                      )
                    ) : (
                      'Sin responsable'
                    )
                  ) : onPatch ? (
                    <EditableCell task={task} field={column} disabled={pending || !mayEdit(task)} onPatch={onPatch} />
                  ) : (
                    formatDate(task[column])
                  )}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

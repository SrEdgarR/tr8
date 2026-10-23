import { useMemo, useState } from 'react';
import { CalendarDays, Check, Columns3, List, Plus, Search, RotateCcw } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { formatDate, PRIORITIES, STATUSES } from '../constants';
import type { Priority, Project, Task, TaskStatus } from '../types';
import { EmptyState, StatusDot } from './ui';
import { localDate } from './helpers';

interface Props {
  tasks: Task[];
  projects: Project[];
  pending: boolean;
  readOnly?: boolean;
  canCreate?: boolean;
  canEditTask?: (task: Task) => boolean;
  onCreate: (status?: TaskStatus) => void;
  onOpen: (task: Task) => void;
  onMove: (task: Task, status: TaskStatus) => Promise<void>;
}

function TaskStateSelect({ task, disabled, onMove }: { task: Task; disabled: boolean; onMove: Props['onMove'] }) {
  return (
    <select
      className="pw-status-select"
      aria-label={`Estado de ${task.title}`}
      value={task.status}
      disabled={disabled}
      onChange={event => {
        void onMove(task, event.target.value as TaskStatus);
      }}
    >
      {STATUSES.map(status => (
        <option key={status.id} value={status.id}>
          {status.name}
        </option>
      ))}
    </select>
  );
}

export default function TasksView({ tasks, projects, pending, readOnly = false, canCreate = !readOnly, canEditTask, onCreate, onOpen, onMove }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view') === 'board' ? 'board' : 'list';
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<TaskStatus | ''>('');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const projectMap = useMemo(() => new Map(projects.map(project => [project.id, project])), [projects]);
  const today = localDate();
  const normalizedQuery = query.trim().toLocaleLowerCase('es');
  const visible = useMemo(
    () =>
      tasks
        .filter(
          task =>
            (!status || task.status === status) &&
            (!priority || task.priority === priority) &&
            (!normalizedQuery ||
              `${task.title} ${task.description} ${projectMap.get(task.project_id)?.name ?? ''}`.toLocaleLowerCase('es').includes(normalizedQuery)),
        )
        .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at)),
    [tasks, status, priority, normalizedQuery, projectMap],
  );
  const hasFilters = Boolean(query || status || priority);
  const mayEdit = (task: Task) => !readOnly && (canEditTask?.(task) ?? true);

  function changeView(next: string) {
    const params = new URLSearchParams(searchParams);
    if (next === 'board') params.set('view', 'board');
    else params.delete('view');
    setSearchParams(params, { replace: true });
  }

  function resetFilters() {
    setQuery('');
    setStatus('');
    setPriority('');
  }

  return (
    <div className="pw-tasks-area">
      <div className="pw-view-tabs" aria-label="Vista de tareas">
        <button className={`pw-view-tab${view === 'list' ? ' on' : ''}`} aria-pressed={view === 'list'} onClick={() => changeView('list')}>
          <List size={15} aria-hidden="true" />
          Lista
        </button>
        <button className={`pw-view-tab${view === 'board' ? ' on' : ''}`} aria-pressed={view === 'board'} onClick={() => changeView('board')}>
          <Columns3 size={15} aria-hidden="true" />
          Tablero
        </button>
      </div>
      <div className="toolbar pw-toolbar">
        <label className="pw-search">
          <Search size={14} aria-hidden="true" />
          <span className="sr">Buscar tareas</span>
          <input type="search" placeholder="Buscar tareas…" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        <label className="pw-filter">
          <span className="sr">Filtrar por estado</span>
          <select value={status} onChange={event => setStatus(event.target.value as TaskStatus | '')}>
            <option value="">Todos los estados</option>
            {STATUSES.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="pw-filter">
          <span className="sr">Filtrar por prioridad</span>
          <select value={priority} onChange={event => setPriority(event.target.value as Priority | '')}>
            <option value="">Todas las prioridades</option>
            {PRIORITIES.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {hasFilters && (
          <button className="btn btn-ghost btn-sm" onClick={resetFilters}>
            Limpiar filtros
          </button>
        )}
        <span className="pw-result-count" role="status">
          {visible.length} {visible.length === 1 ? 'tarea' : 'tareas'}
        </span>
      </div>
      {visible.length === 0 && (view === 'list' || hasFilters) ? (
        <EmptyState
          title={hasFilters ? 'No hay coincidencias' : 'Tu siguiente paso empieza aquí'}
          action={
            hasFilters ? (
              <button className="btn btn-secondary" onClick={resetFilters}>
                Limpiar filtros
              </button>
            ) : (
              canCreate && (
                <button className="btn btn-primary" disabled={pending} onClick={() => onCreate()}>
                  <Plus size={14} aria-hidden="true" />
                  Nueva tarea
                </button>
              )
            )
          }
        >
          {hasFilters
            ? 'Prueba con otra búsqueda o cambia los filtros.'
            : readOnly
              ? 'Este proyecto no tiene tareas.'
              : 'Crea una tarea y organiza su estado, prioridad y fecha.'}
        </EmptyState>
      ) : view === 'list' ? (
        <div className="pw-task-list" role="table" aria-label="Lista de tareas">
          <div className="pw-task-row pw-task-list-head" role="row">
            <span role="columnheader" className="sr">
              Completar
            </span>
            <span role="columnheader">Tarea</span>
            <span role="columnheader">Estado</span>
            <span role="columnheader">Prioridad</span>
            <span role="columnheader">Vencimiento</span>
          </div>
          {visible.map(task => (
            <div key={task.id} className={`pw-task-row${task.status === 'done' ? ' pw-done' : ''}`} role="row">
              <span role="cell">
                <button
                  className={`pw-complete${task.status === 'done' ? ' checked' : ''}`}
                  disabled={pending || !mayEdit(task)}
                  aria-label={task.status === 'done' ? `Reabrir ${task.title}` : `Completar ${task.title}`}
                  onClick={() => {
                    void onMove(task, task.status === 'done' ? 'todo' : 'done');
                  }}
                >
                  {task.status === 'done' && <Check size={12} aria-hidden="true" />}
                </button>
              </span>
              <span className="pw-task-title-cell" role="cell">
                <button className="pw-task-title" onClick={() => onOpen(task)}>
                  {task.title}
                </button>
                <span className="pw-task-subtitle">
                  <span className="mono">
                    {projectMap.get(task.project_id)?.code}-{task.task_number}
                  </span>
                  <span>{projectMap.get(task.project_id)?.name}</span>
                </span>
              </span>
              <span role="cell" className="pw-state-cell">
                <StatusDot status={task.status} />
                <TaskStateSelect task={task} disabled={pending || !mayEdit(task)} onMove={onMove} />
              </span>
              <span role="cell" className={`pw-priority pw-priority-${task.priority}`}>
                {PRIORITIES.find(item => item.id === task.priority)?.name}
              </span>
              <span role="cell" className={`pw-due${task.due_date && task.due_date < today && task.status !== 'done' ? ' overdue' : ''}`}>
                {formatDate(task.due_date)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <p className="pw-board-help">
            {readOnly
              ? 'Vista de solo lectura: puedes consultar las tareas de este proyecto.'
              : 'Arrastra las tarjetas entre columnas o utiliza el selector de estado de cada tarea.'}
          </p>
          <div className="board pw-board">
            {STATUSES.map(column => {
              const items = visible.filter(task => task.status === column.id);
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
                    {canCreate && (
                      <span className="acts">
                        <button className="ibtn ibtn-xs" aria-label={`Añadir tarea: ${column.name}`} disabled={pending} onClick={() => onCreate(column.id)}>
                          <Plus size={15} aria-hidden="true" />
                        </button>
                      </span>
                    )}
                  </div>
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
                      >
                        <button className="title pw-card-title" onClick={() => onOpen(task)}>
                          {task.title}
                        </button>
                        {task.description && <p className="pw-card-description">{task.description}</p>}
                        <div className="meta">
                          <span className="key">
                            {projectMap.get(task.project_id)?.code}-{task.task_number}
                          </span>
                          <span className={`pw-priority pw-priority-${task.priority}`}>{PRIORITIES.find(item => item.id === task.priority)?.name}</span>
                        </div>
                        {task.due_date && (
                          <span className={`pw-card-date${task.due_date < today && task.status !== 'done' ? ' overdue' : ''}`}>
                            <CalendarDays size={12} aria-hidden="true" />
                            {formatDate(task.due_date)}
                          </span>
                        )}
                        <div className="pw-card-bottom">
                          <TaskStateSelect task={task} disabled={pending || !mayEdit(task)} onMove={onMove} />
                          <button
                            className="ibtn ibtn-xs"
                            disabled={pending || !mayEdit(task)}
                            aria-label={task.status === 'done' ? `Reabrir ${task.title}` : `Completar ${task.title}`}
                            onClick={() => {
                              void onMove(task, task.status === 'done' ? 'todo' : 'done');
                            }}
                          >
                            {task.status === 'done' ? <RotateCcw size={13} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
                          </button>
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
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

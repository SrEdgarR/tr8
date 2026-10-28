import { useMemo, useRef, useState, type ReactNode, type DragEvent } from 'react';
import { Activity, Archive, CalendarDays, ChartGantt, ChevronRight, SquareKanban, LayoutDashboard, List, Paperclip, Plus, Search, Table2 } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { PRIORITIES, STATUSES } from '../constants';
import type { Priority, Project, Task, TaskPatch, TaskStatus, WorkspaceMember } from '../types';
import type { TaskViewConfig } from '../productivity-types';
import { EmptyState, ErrorNotice } from './ui';
import { errorMessage, localDate } from './helpers';
import TaskViewControls, { type SavedViewsProps } from './TaskViewControls';
import TaskTable from './TaskTable';
import TaskList from './TaskList';
import TaskBoard from './TaskBoard';
import { defaultTaskView, filterTaskView, groupTaskView, manualTaskOrder, reorderedProjectTasks } from './task-views';
import './task-views.css';

interface Props extends SavedViewsProps {
  scopeKey?: string;
  tasks: Task[];
  projects: Project[];
  members?: WorkspaceMember[];
  pending: boolean;
  readOnly?: boolean;
  canCreate?: boolean;
  canEditTask?: (task: Task) => boolean;
  onCreate: (status?: TaskStatus) => void;
  onOpen: (task: Task) => void;
  onMove: (task: Task, status: TaskStatus) => Promise<void>;
  calendarContent?: ReactNode;
  timelineContent?: ReactNode;
  filesContent?: ReactNode;
  activityContent?: ReactNode;
  summaryContent?: ReactNode;
  archivedContent?: ReactNode;
  onPatch?: (task: Task, patch: TaskPatch) => Promise<void>;
  onReorder?: (tasks: Task[]) => Promise<void>;
  favoriteTaskIds?: readonly string[];
  onFavoriteTask?: (task: Task, favorite: boolean) => Promise<void>;
}

export default function TasksView(props: Props) {
  return <ScopedTasksView key={props.scopeKey ?? 'legacy'} {...props} />;
}

const NO_FAVORITES: readonly string[] = [];
function ScopedTasksView({
  tasks,
  projects,
  members: receivedMembers = [],
  pending,
  readOnly = false,
  canCreate = !readOnly,
  canEditTask,
  onCreate,
  onOpen,
  onMove,
  calendarContent,
  timelineContent,
  filesContent,
  activityContent,
  summaryContent,
  archivedContent,
  onPatch,
  onReorder,
  favoriteTaskIds = NO_FAVORITES,
  onFavoriteTask,
  savedViews,
  onCreateView,
  onUpdateView,
  onDeleteView,
  productivityLoading,
  productivityError,
}: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const members = useMemo(() => receivedMembers.filter(member => member.status === 'active'), [receivedMembers]);
  const view =
    searchParams.get('view') === 'files' && filesContent
      ? 'files'
      : searchParams.get('view') === 'timeline' && timelineContent
        ? 'timeline'
        : searchParams.get('view') === 'archived' && archivedContent
          ? 'archived'
          : searchParams.get('view') === 'overview' && summaryContent
            ? 'overview'
            : searchParams.get('view') === 'activity' && activityContent
              ? 'activity'
              : searchParams.get('view') === 'calendar' && calendarContent
                ? 'calendar'
                : searchParams.get('view') === 'board'
                  ? 'board'
                  : searchParams.get('view') === 'table'
                    ? 'table'
                    : 'list';
  const [config, setConfig] = useState<TaskViewConfig>(() => ({
    ...defaultTaskView(),
    view: searchParams.get('view') === 'board' ? 'board' : searchParams.get('view') === 'table' ? 'table' : 'list',
  }));
  const [selectedView, setSelectedView] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const actionLock = useRef(false);
  const query = config.query;
  const status = config.statuses.length === 1 ? config.statuses[0] : '';
  const priority = config.priorities.length === 1 ? config.priorities[0] : '';
  const setQuery = (value: string) => setConfig(previous => ({ ...previous, query: value }));
  const setStatus = (value: TaskStatus | '') => setConfig(previous => ({ ...previous, statuses: value ? [value] : [] }));
  const setPriority = (value: Priority | '') => setConfig(previous => ({ ...previous, priorities: value ? [value] : [] }));
  const today = localDate();
  const visible = useMemo(() => filterTaskView(tasks, projects, config, favoriteTaskIds, today), [tasks, projects, config, favoriteTaskIds, today]);
  const groups = useMemo(
    () => groupTaskView(visible, view === 'board' && config.group === 'status' ? { ...config, group: 'none' } : config, projects, members),
    [visible, view, config, projects, members],
  );
  const hasFilters = Boolean(
    query ||
    config.statuses.length ||
    config.priorities.length ||
    config.projectIds.length ||
    config.assigneeIds.length ||
    config.due !== 'all' ||
    config.favoritesOnly,
  );
  const mayEdit = (task: Task) => !task.archived_at && !readOnly && (canEditTask?.(task) ?? true);
  const busy = pending || localBusy;
  const reorderEnabled = Boolean(onReorder && config.sort === 'manual' && config.direction === 'asc' && !readOnly);

  async function run(operation: () => Promise<void>) {
    if (pending || actionLock.current) return;
    actionLock.current = true;
    setLocalBusy(true);
    setActionError(null);
    try {
      await operation();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      actionLock.current = false;
      setLocalBusy(false);
    }
  }
  const move = (task: Task, next: TaskStatus) => run(() => onMove(task, next));
  function toggleFavorite(task: Task, favorite: boolean) {
    if (onFavoriteTask) void run(() => onFavoriteTask(task, favorite));
  }
  function reordered(ordered: Task[]) {
    if (!onReorder || !reorderEnabled || ordered.some(task => !mayEdit(task))) return;
    if (ordered.length > 200) {
      setActionError('El orden manual admite hasta 200 tareas del mismo proyecto por operación.');
      return;
    }
    void run(() => onReorder(ordered));
  }
  function moveBy(task: Task, direction: -1 | 1) {
    const order = manualTaskOrder(tasks.filter(item => item.project_id === task.project_id && item.workspace_id === task.workspace_id));
    const index = order.findIndex(item => item.id === task.id);
    if (index < 0 || index + direction < 0 || index + direction >= order.length) return;
    order.splice(index, 1);
    order.splice(index + direction, 0, task);
    reordered(order);
  }
  function beginDrag(id: string, event: DragEvent) {
    event.dataTransfer.setData('text/plain', id);
    event.dataTransfer.effectAllowed = 'move';
  }
  function dropBefore(target: Task, event: DragEvent) {
    if (!reorderEnabled || busy) return;
    const draggedId = event.dataTransfer.getData('text/plain');
    const dragged = tasks.find(task => task.id === draggedId);
    if (!dragged || !mayEdit(dragged) || !mayEdit(target)) return;
    if (view === 'board' && dragged.status !== target.status) return;
    event.preventDefault();
    event.stopPropagation();
    const order = reorderedProjectTasks(tasks, draggedId, target.id);
    if (order) reordered(order);
    else if (dragged.project_id !== target.project_id) setActionError('El orden manual solo mueve tareas dentro del mismo proyecto.');
  }

  function selectSavedView(id: string) {
    setSelectedView(id);
    const saved = savedViews?.find(item => item.id === id);
    if (saved) {
      setConfig({ ...saved.config });
      setCollapsedGroups({});
      changeView(saved.config.view);
    }
  }

  function changeView(next: string) {
    const params = new URLSearchParams(searchParams);
    if (
      next === 'board' ||
      next === 'table' ||
      next === 'calendar' ||
      next === 'timeline' ||
      next === 'files' ||
      next === 'activity' ||
      next === 'overview' ||
      next === 'archived'
    )
      params.set('view', next);
    else params.delete('view');
    if (next === 'board' || next === 'table' || next === 'list') setConfig(previous => ({ ...previous, view: next }));
    setSearchParams(params, { replace: true });
  }

  function resetFilters() {
    setConfig(previous => ({
      ...defaultTaskView(),
      view: previous.view,
      sort: previous.sort,
      direction: previous.direction,
      group: previous.group,
      columns: previous.columns,
    }));
    setSelectedView('');
  }

  function renderContent(items: Task[]) {
    const rowProps = {
      tasks: items,
      projects,
      members,
      columns: config.columns,
      pending: busy,
      today,
      mayEdit,
      onOpen,
      onMove: move,
      onPatch,
      favoriteIds: favoriteTaskIds,
      onFavorite: onFavoriteTask ? toggleFavorite : undefined,
      onReorder: reorderEnabled ? moveBy : undefined,
      onDragStart: reorderEnabled ? beginDrag : undefined,
      onDrop: reorderEnabled ? dropBefore : undefined,
    };
    return view === 'table' ? (
      <TaskTable {...rowProps} />
    ) : view === 'board' ? (
      <TaskBoard {...rowProps} readOnly={readOnly} canCreate={canCreate} onCreate={onCreate} />
    ) : (
      <TaskList {...rowProps} />
    );
  }
  function renderGroups() {
    const grouped = config.group !== 'none' && !(view === 'board' && config.group === 'status');
    return (
      <>
        {groups.map(group =>
          grouped ? (
            <section className="tv-task-group" key={`${config.group}:${group.id}`} aria-label={group.label}>
              <button
                className="tv-group-heading"
                aria-label={`${group.label}: ${group.tasks.length} tareas`}
                aria-expanded={!collapsedGroups[`${config.group}:${group.id}`]}
                onClick={() => setCollapsedGroups(previous => ({ ...previous, [`${config.group}:${group.id}`]: !previous[`${config.group}:${group.id}`] }))}
              >
                <ChevronRight size={13} className={collapsedGroups[`${config.group}:${group.id}`] ? '' : 'is-open'} aria-hidden="true" />
                <strong>{group.label}</strong>
                <span>{group.tasks.length}</span>
              </button>
              {!collapsedGroups[`${config.group}:${group.id}`] && renderContent(group.tasks)}
            </section>
          ) : (
            <div key="all">{renderContent(group.tasks)}</div>
          ),
        )}
      </>
    );
  }

  return (
    <div className="pw-tasks-area">
      <div className="pw-view-tabs" aria-label="Vista de tareas">
        {summaryContent && (
          <button className={`pw-view-tab${view === 'overview' ? ' on' : ''}`} aria-pressed={view === 'overview'} onClick={() => changeView('overview')}>
            <LayoutDashboard size={15} aria-hidden="true" />
            Resumen
          </button>
        )}
        <button className={`pw-view-tab${view === 'list' ? ' on' : ''}`} aria-pressed={view === 'list'} onClick={() => changeView('list')}>
          <List size={15} aria-hidden="true" />
          Lista
        </button>
        <button className={`pw-view-tab${view === 'board' ? ' on' : ''}`} aria-pressed={view === 'board'} onClick={() => changeView('board')}>
          <SquareKanban size={15} aria-hidden="true" />
          Tablero
        </button>
        <button className={`pw-view-tab${view === 'table' ? ' on' : ''}`} aria-pressed={view === 'table'} onClick={() => changeView('table')}>
          <Table2 size={15} aria-hidden="true" />
          Tabla
        </button>
        {calendarContent && (
          <button className={`pw-view-tab${view === 'calendar' ? ' on' : ''}`} aria-pressed={view === 'calendar'} onClick={() => changeView('calendar')}>
            <CalendarDays size={15} aria-hidden="true" />
            Calendario
          </button>
        )}
        {timelineContent && (
          <button className={`pw-view-tab${view === 'timeline' ? ' on' : ''}`} aria-pressed={view === 'timeline'} onClick={() => changeView('timeline')}>
            <ChartGantt size={15} aria-hidden="true" />
            Timeline
          </button>
        )}
        {filesContent && (
          <button className={`pw-view-tab${view === 'files' ? ' on' : ''}`} aria-pressed={view === 'files'} onClick={() => changeView('files')}>
            <Paperclip size={15} aria-hidden="true" /> Archivos
          </button>
        )}
        {activityContent && (
          <button className={`pw-view-tab${view === 'activity' ? ' on' : ''}`} aria-pressed={view === 'activity'} onClick={() => changeView('activity')}>
            <Activity size={15} aria-hidden="true" />
            Actividad
          </button>
        )}
        {archivedContent && (
          <button
            className={`pw-view-tab wm-archive-tab${view === 'archived' ? ' on' : ''}`}
            aria-pressed={view === 'archived'}
            onClick={() => changeView('archived')}
          >
            <Archive size={14} aria-hidden="true" />
            Archivadas
          </button>
        )}
      </div>
      {view === 'files' ? (
        filesContent
      ) : view === 'timeline' ? (
        timelineContent
      ) : view === 'archived' ? (
        archivedContent
      ) : view === 'overview' ? (
        summaryContent
      ) : view === 'activity' ? (
        activityContent
      ) : view === 'calendar' ? (
        calendarContent
      ) : (
        <>
          {actionError && <ErrorNotice>{actionError}</ErrorNotice>}
          <div className="toolbar pw-toolbar">
            <label className="pw-search">
              <Search size={14} aria-hidden="true" />
              <span className="sr">Buscar tareas</span>
              <input type="search" placeholder="Buscar tareas…" maxLength={500} value={query} onChange={event => setQuery(event.target.value)} />
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
          <TaskViewControls
            config={{ ...config, view: view === 'table' ? 'table' : view === 'board' ? 'board' : 'list' }}
            onChange={setConfig}
            projects={projects}
            members={members}
            pending={busy}
            selected={selectedView}
            onSelect={selectSavedView}
            savedViews={savedViews}
            onCreateView={onCreateView}
            onUpdateView={onUpdateView}
            onDeleteView={onDeleteView}
            productivityLoading={productivityLoading}
            productivityError={productivityError}
          />
          {onReorder && (
            <p className="tv-order-note">
              {readOnly
                ? 'El orden de las tareas se conserva en esta vista de solo lectura.'
                : reorderEnabled
                  ? 'Orden manual: arrastra una tarea sobre otra o usa las flechas para cambiar su posición dentro del mismo proyecto.'
                  : 'Selecciona orden manual ascendente para reordenar las tareas.'}
            </p>
          )}
          {visible.length === 0 && (view === 'list' || view === 'table' || hasFilters) ? (
            <EmptyState
              title={hasFilters ? 'No hay coincidencias' : 'Tu siguiente paso empieza aquí'}
              action={
                hasFilters ? (
                  <button className="btn btn-secondary" onClick={resetFilters}>
                    Limpiar filtros
                  </button>
                ) : (
                  canCreate && (
                    <button className="btn btn-primary" disabled={busy} onClick={() => onCreate()}>
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
          ) : (
            renderGroups()
          )}
        </>
      )}
    </div>
  );
}

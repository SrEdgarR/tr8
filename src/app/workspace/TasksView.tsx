import { useMemo, useRef, useState, type ReactNode, type DragEvent } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import type { Project, Task, TaskPatch, TaskStatus, WorkspaceMember } from '../types';
import type { TaskViewConfig } from '../productivity-types';
import { EmptyState, ErrorNotice } from './ui';
import { errorMessage, localDate } from './helpers';
import TaskViewNavigation from './TaskViewNavigation';
import TaskViewControls, { type SavedViewsProps } from './TaskViewControls';
import TaskTable from './TaskTable';
import TaskList from './TaskList';
import TaskBoard from './TaskBoard';
import { defaultTaskView, filterTaskView, groupTaskView, manualTaskOrder, reorderedProjectTasks } from './task-views';
import './task-views.css';
import type { BulkTaskOperation, BulkTasksApi } from '../bulk-task-types';
import BulkTaskActions, { type TaskSelection } from './BulkTaskActions';

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
  bulkTasks?: BulkTasksApi;
  canBulkTask?: (task: Task, kind: BulkTaskOperation['kind']) => boolean;
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
  bulkTasks,
  canBulkTask,
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
  const [bulkBusy, setBulkBusy] = useState(false);
  const actionLock = useRef(false);
  const query = config.query;
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
  const busy = pending || localBusy || bulkBusy;
  const reorderEnabled = Boolean(onReorder && config.sort === 'manual' && config.direction === 'asc' && !readOnly);
  const orderHelp = onReorder
    ? readOnly
      ? 'El orden de las tareas se conserva en esta vista de solo lectura.'
      : reorderEnabled
        ? 'Orden manual: arrastra una tarea sobre otra o usa las flechas para cambiar su posición dentro del mismo proyecto.'
        : 'Selecciona orden manual ascendente para reordenar las tareas.'
    : undefined;

  async function run(operation: () => Promise<void>) {
    if (pending || bulkBusy || actionLock.current) return;
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
    if (bulkBusy) return;
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

  function renderContent(items: Task[], selection?: TaskSelection) {
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
      selection,
    };
    return view === 'table' ? (
      <TaskTable {...rowProps} />
    ) : view === 'board' ? (
      <TaskBoard {...rowProps} readOnly={readOnly} canCreate={canCreate} onCreate={onCreate} />
    ) : (
      <TaskList {...rowProps} />
    );
  }
  function renderGroups(selection?: TaskSelection) {
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
                disabled={bulkBusy}
                onClick={() => setCollapsedGroups(previous => ({ ...previous, [`${config.group}:${group.id}`]: !previous[`${config.group}:${group.id}`] }))}
              >
                <ChevronRight size={13} className={collapsedGroups[`${config.group}:${group.id}`] ? '' : 'is-open'} aria-hidden="true" />
                <strong>{group.label}</strong>
                <span>{group.tasks.length}</span>
              </button>
              {!collapsedGroups[`${config.group}:${group.id}`] && renderContent(group.tasks, selection)}
            </section>
          ) : (
            <div key="all">{renderContent(group.tasks, selection)}</div>
          ),
        )}
      </>
    );
  }

  function renderTaskResults(selection?: TaskSelection) {
    return visible.length === 0 && (view === 'list' || view === 'table' || hasFilters) ? (
      <EmptyState
        title={hasFilters ? 'No hay coincidencias' : 'Tu siguiente paso empieza aquí'}
        action={
          hasFilters ? (
            <button className="btn btn-secondary" disabled={bulkBusy} onClick={resetFilters}>
              Limpiar filtros
            </button>
          ) : (
            canCreate && (
              <button className="btn btn-primary" disabled={busy} onClick={() => onCreate()}>
                <Plus size={14} aria-hidden="true" /> Nueva tarea
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
      renderGroups(selection)
    );
  }

  return (
    <div className="pw-tasks-area">
      <TaskViewNavigation
        view={view}
        disabled={bulkBusy}
        onChange={changeView}
        summary={Boolean(summaryContent)}
        calendar={Boolean(calendarContent)}
        timeline={Boolean(timelineContent)}
        files={Boolean(filesContent)}
        activity={Boolean(activityContent)}
        archived={Boolean(archivedContent)}
      />
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
          <fieldset className="tv-bulk-controls-lock" disabled={bulkBusy}>
            <legend className="sr">Filtros y organización de tareas</legend>
            <TaskViewControls
              config={{ ...config, view: view === 'table' ? 'table' : view === 'board' ? 'board' : 'list' }}
              onChange={next => {
                if (!bulkBusy) setConfig(next);
              }}
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
              resultCount={visible.length}
              hasFilters={hasFilters}
              onResetFilters={resetFilters}
              orderHelp={orderHelp}
            />
          </fieldset>
          {orderHelp && <p className="tv-order-note">{orderHelp}</p>}
          {bulkTasks && canBulkTask && !readOnly && (view === 'list' || view === 'table') ? (
            <BulkTaskActions
              key={JSON.stringify([view, config, collapsedGroups, bulkTasks.scopeKey])}
              tasks={groups.filter(group => config.group === 'none' || !collapsedGroups[`${config.group}:${group.id}`]).flatMap(group => group.tasks)}
              projects={projects}
              members={members}
              api={bulkTasks}
              can={canBulkTask}
              pending={pending || localBusy}
              onBusyChange={setBulkBusy}
            >
              {selection => renderTaskResults(selection)}
            </BulkTaskActions>
          ) : (
            renderTaskResults()
          )}
        </>
      )}
    </div>
  );
}

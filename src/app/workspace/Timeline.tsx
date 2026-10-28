import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { AlertTriangle, CalendarClock, ChevronDown, ChevronLeft, ChevronRight, Crosshair, Diamond, GripVertical, Search, X } from 'lucide-react';
import type { Project, Task, TaskPatch, WorkspaceProps } from '../types';
import { formatDate, PRIORITIES, STATUSES } from '../constants';
import type { PlanningController } from './usePlanning';
import { Dialog, EmptyState, ErrorNotice, ProjectIcon } from './ui';
import { PriorityIcon, TaskStatusIcon } from './project-identity';
import { errorMessage, localDate } from './helpers';
import {
  buildTimelineModel,
  canRescheduleTimelineTask,
  civilWeekday,
  daysBetween,
  dependencyConflict,
  emptyTimelineFilters,
  shiftedInterval,
  shiftCivilDate,
  taskInterval,
  timelineWindow,
  type TaskInterval,
  type TimelineFilters,
  type TimelineGrouping,
  type TimelineScale,
} from './timeline-model';
import './timeline.css';

interface Props {
  data: WorkspaceProps;
  planning: PlanningController;
  project?: Project;
  onOpen: (task: Task) => void;
  onReschedule: (task: Task, patch: Pick<TaskPatch, 'start_date' | 'due_date'>) => Promise<void>;
  milestoneContent?: ReactNode;
}
interface ScheduleDraft {
  task: Task;
  start: string;
  end: string;
}
interface DragPreview {
  task: Task;
  interval: TaskInterval;
  original: TaskInterval;
  x: number;
  mode: 'move' | 'start' | 'end';
  moved: boolean;
}
type ChartRow =
  | { kind: 'milestones'; id: string }
  | { kind: 'group'; id: string; group: ReturnType<typeof buildTimelineModel>['groups'][number] }
  | { kind: 'task'; id: string; task: Task };
const ROW_HEIGHT = 40;
const MONTH_NAMES = new Intl.DateTimeFormat('es', { month: 'long', year: 'numeric', timeZone: 'UTC' });
function monthName(date: string) {
  return MONTH_NAMES.format(new Date(`${date}T12:00:00Z`));
}
function timelineViewportSize(viewport: HTMLDivElement) {
  const label = viewport.querySelector<HTMLElement>('.pwt-corner');
  const labelWidth = label?.getBoundingClientRect().width || Number.parseFloat(getComputedStyle(viewport).getPropertyValue('--pwt-label-width')) || 290;
  return { width: viewport.clientWidth, labelWidth };
}
function centerTimelineDate(viewport: HTMLDivElement, start: string, date: string, dayWidth: number) {
  const { width, labelWidth } = timelineViewportSize(viewport);
  const plotWidth = Math.max(1, width - labelWidth);
  const dayCenter = (daysBetween(start, date) + 0.5) * dayWidth;
  viewport.scrollLeft = Math.max(0, dayCenter - plotWidth / 2);
}

export default function Timeline(props: Props) {
  const scope = `${props.data.currentUserId ?? ''}:${props.data.workspace?.id ?? 'personal'}:${props.project?.id ?? 'all'}:${props.data.planning?.scopeKey.join(':') ?? ''}`;
  return <ScopedTimeline key={scope} {...props} />;
}

function ScopedTimeline({ data, planning, project, onOpen, onReschedule, milestoneContent }: Props) {
  const today = localDate();
  const [anchor, setAnchor] = useState(today);
  const [scale, setScale] = useState<TimelineScale>('week');
  const [grouping, setGrouping] = useState<TimelineGrouping>('status');
  const [filters, setFilters] = useState<TimelineFilters>(emptyTimelineFilters);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [showMilestones, setShowMilestones] = useState(false);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const drag = useRef<DragPreview | null>(null);
  const suppressClick = useRef(false);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const alive = useRef(true);
  const scroll = useRef<HTMLDivElement>(null);
  const model = useMemo(
    () => buildTimelineModel(data, today, planning.state, filters, grouping, project),
    [data, today, planning.state, filters, grouping, project],
  );
  const window = useMemo(() => timelineWindow(anchor, scale), [anchor, scale]);
  const chartWidth = window.days * window.dayWidth;
  const dates = useMemo(() => Array.from({ length: window.days }, (_, index) => shiftCivilDate(window.start, index)), [window.days, window.start]);
  const monthSegments = useMemo(() => {
    const segments: { date: string; days: number }[] = [];
    for (const date of dates) {
      const last = segments.at(-1);
      if (last?.date.slice(0, 7) === date.slice(0, 7)) last.days++;
      else segments.push({ date, days: 1 });
    }
    return segments;
  }, [dates]);
  const rows = useMemo(() => {
    const result: ChartRow[] = [];
    if (model.milestones.length) result.push({ kind: 'milestones', id: '__milestones' });
    for (const group of model.groups) {
      if (model.effectiveGrouping !== 'none') result.push({ kind: 'group', id: `group:${group.id}`, group });
      if (!collapsed.has(group.id) || model.effectiveGrouping === 'none') for (const task of group.tasks) result.push({ kind: 'task', id: task.id, task });
    }
    return result;
  }, [model.groups, model.milestones.length, model.effectiveGrouping, collapsed]);
  const rowPositions = useMemo(
    () => new Map(rows.flatMap((row, index) => (row.kind === 'task' ? [[row.task.id, index * ROW_HEIGHT + ROW_HEIGHT / 2] as const] : []))),
    [rows],
  );
  const visibleDependencies = model.dependencies.filter(edge => rowPositions.has(edge.task_id) && rowPositions.has(edge.blocker_task_id));
  const taskMap = new Map(model.scheduled.map(task => [task.id, task]));
  const intervalOf = (task: Task) => (preview?.task.id === task.id ? preview.interval : taskInterval(task)!);
  const conflicts = visibleDependencies.filter(edge =>
    dependencyConflict(intervalOf(taskMap.get(edge.blocker_task_id)!), intervalOf(taskMap.get(edge.task_id)!)),
  );
  const milestoneDates = new Map<string, typeof model.milestones>();
  for (const milestone of model.milestones) {
    if (milestone.date < window.start || milestone.date > window.end) continue;
    const collection = milestoneDates.get(milestone.date) ?? [];
    collection.push(milestone);
    milestoneDates.set(milestone.date, collection);
  }
  const milestoneEntries = [...milestoneDates];
  const editable = (task: Task) => canRescheduleTimelineTask(data, task, model.projectMap.get(task.project_id));
  const updateFilter = <K extends keyof TimelineFilters>(key: K, value: TimelineFilters[K]) => setFilters(previous => ({ ...previous, [key]: value }));
  const canEditDraft = draft
    ? canRescheduleTimelineTask(
        { ...data, pending: false },
        data.tasks.find(task => task.id === draft.task.id) ?? { ...draft.task, archived_at: 'unavailable' },
        model.projectMap.get(draft.task.project_id),
      )
    : false;
  const hasRows = rows.length > 0;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const viewport = scroll.current;
    if (!viewport) return;
    centerTimelineDate(viewport, window.start, anchor, window.dayWidth);
    if (typeof ResizeObserver === 'undefined') return;
    let size = timelineViewportSize(viewport);
    const observer = new ResizeObserver(() => {
      const next = timelineViewportSize(viewport);
      if (next.width === size.width && next.labelWidth === size.labelWidth) return;
      size = next;
      centerTimelineDate(viewport, window.start, anchor, window.dayWidth);
    });
    observer.observe(viewport);
    const label = viewport.querySelector<HTMLElement>('.pwt-corner');
    if (label) observer.observe(label);
    return () => observer.disconnect();
  }, [anchor, window.dayWidth, window.start, hasRows]);

  function toggleGroup(id: string) {
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function goToday() {
    setAnchor(today);
    // Recenter even if Today is already the current anchor and only the scroll position changed.
    const period = timelineWindow(today, scale);
    if (scroll.current) centerTimelineDate(scroll.current, period.start, today, period.dayWidth);
  }
  function openSchedule(task: Task, interval = taskInterval(task)) {
    if (!editable(task)) return;
    setSaveError(null);
    setDraft({ task, start: interval?.start ?? today, end: interval?.end ?? today });
  }
  function startDrag(event: PointerEvent<HTMLDivElement>, task: Task, mode: DragPreview['mode']) {
    if (event.button !== 0 || !editable(task)) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick.current = false;
    const interval = taskInterval(task)!;
    const value: DragPreview = { task, interval, original: interval, x: event.clientX, mode, moved: false };
    drag.current = value;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const value = drag.current;
    if (!value) return;
    const delta = Math.round((event.clientX - value.x) / window.dayWidth);
    const next = { ...value, interval: shiftedInterval(value.original, delta, value.mode), moved: value.moved || Math.abs(event.clientX - value.x) >= 5 };
    drag.current = next;
    setPreview(next);
  }
  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const value = drag.current;
    drag.current = null;
    setPreview(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (value?.moved) {
      suppressClick.current = true;
      if (value.original.start !== value.interval.start || value.original.end !== value.interval.end) openSchedule(value.task, value.interval);
    }
  }
  async function saveSchedule() {
    if (!draft || saveLock.current || data.pending || !canEditDraft) return;
    if (!draft.start || !draft.end || draft.start > draft.end) {
      setSaveError('Indica un inicio y un vencimiento válidos. El vencimiento no puede ser anterior al inicio.');
      return;
    }
    saveLock.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      await onReschedule(draft.task, { start_date: draft.start, due_date: draft.end });
      if (alive.current) setDraft(null);
    } catch (error) {
      if (alive.current) setSaveError(errorMessage(error));
    } finally {
      saveLock.current = false;
      if (alive.current) setSaving(false);
    }
  }
  const dirtyDependency = draft && taskInterval({ start_date: draft.start, due_date: draft.end });
  const draftConflicts = dirtyDependency
    ? model.dependencies.filter(edge => {
        if (edge.task_id === draft!.task.id) return dependencyConflict(taskInterval(taskMap.get(edge.blocker_task_id)!)!, dirtyDependency);
        if (edge.blocker_task_id === draft!.task.id) return dependencyConflict(dirtyDependency, taskInterval(taskMap.get(edge.task_id)!)!);
        return false;
      }).length
    : 0;

  return (
    <section className="pwt-page" aria-label={project ? `Cronograma de ${project.name}` : 'Cronograma del espacio'}>
      {!project && (
        <header className="pwt-heading">
          <span className="pwt-heading-icon">
            <CalendarClock size={21} aria-hidden="true" />
          </span>
          <div>
            <h1>Cronograma</h1>
            <p>Fechas, dependencias e hitos de tus proyectos.</p>
          </div>
        </header>
      )}
      <div className="pwt-toolbar">
        <div className="pwt-period">
          <button type="button" className="ibtn" aria-label="Período anterior" onClick={() => setAnchor(shiftCivilDate(anchor, -window.step))}>
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={goToday}>
            <Crosshair size={14} aria-hidden="true" />
            Hoy
          </button>
          <button type="button" className="ibtn" aria-label="Período siguiente" onClick={() => setAnchor(shiftCivilDate(anchor, window.step))}>
            <ChevronRight size={16} aria-hidden="true" />
          </button>
          <span className="pwt-range">
            {formatDate(window.start)} — {formatDate(window.end)} {window.end.slice(0, 4)}
          </span>
        </div>
        <div className="pwt-controls">
          <div className="pwt-scale" role="group" aria-label="Escala del cronograma">
            {(['week', 'month'] as const).map(value => (
              <button type="button" key={value} className={scale === value ? 'active' : ''} aria-pressed={scale === value} onClick={() => setScale(value)}>
                {value === 'week' ? 'Semanas' : 'Meses'}
              </button>
            ))}
          </div>
          <select
            aria-label="Agrupar cronograma"
            value={grouping === 'assignee' && !model.directoryAvailable ? 'status' : grouping}
            onChange={event => {
              setGrouping(event.target.value as TimelineGrouping);
              setCollapsed(new Set());
            }}
          >
            <option value="status">Agrupar: Estado</option>
            <option value="project">Agrupar: Proyecto</option>
            {model.directoryAvailable && <option value="assignee">Agrupar: Responsable</option>}
            <option value="none">Sin agrupar</option>
          </select>
          {milestoneContent && (
            <button
              type="button"
              className={`btn btn-secondary btn-sm${showMilestones ? ' is-active' : ''}`}
              aria-expanded={showMilestones}
              aria-controls="pwt-milestone-panel"
              onClick={() => setShowMilestones(value => !value)}
            >
              <Diamond size={14} aria-hidden="true" />
              Hitos
              <ChevronDown size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      {showMilestones && milestoneContent && (
        <div className="pwt-milestone-panel" id="pwt-milestone-panel">
          {milestoneContent}
        </div>
      )}
      <div className="pwt-filters">
        <label className="pwt-search">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label="Buscar en el cronograma"
            placeholder="Buscar tareas…"
            value={filters.query}
            onChange={event => updateFilter('query', event.target.value)}
          />
        </label>
        <select
          aria-label="Estado en el cronograma"
          value={filters.status}
          onChange={event => updateFilter('status', event.target.value as TimelineFilters['status'])}
        >
          <option value="">Todos los estados</option>
          {STATUSES.map(status => (
            <option key={status.id} value={status.id}>
              {status.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Prioridad en el cronograma"
          value={filters.priority}
          onChange={event => updateFilter('priority', event.target.value as TimelineFilters['priority'])}
        >
          <option value="">Todas las prioridades</option>
          {PRIORITIES.map(priority => (
            <option key={priority.id} value={priority.id}>
              {priority.name}
            </option>
          ))}
        </select>
        {!project && (
          <select aria-label="Proyecto en el cronograma" value={filters.projectId} onChange={event => updateFilter('projectId', event.target.value)}>
            <option value="">Todos los proyectos</option>
            {model.projects.map(value => (
              <option key={value.id} value={value.id}>
                {value.name}
              </option>
            ))}
          </select>
        )}
        {model.directoryAvailable && (
          <select aria-label="Responsable en el cronograma" value={filters.assigneeId} onChange={event => updateFilter('assigneeId', event.target.value)}>
            <option value="">Todos los responsables</option>
            <option value="__unassigned">Sin responsable</option>
            {model.members.map(member => (
              <option key={member.id} value={member.id}>
                {member.display_name}
              </option>
            ))}
          </select>
        )}
        {Object.values(filters).some(Boolean) && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilters(emptyTimelineFilters())}>
            <X size={12} aria-hidden="true" />
            Limpiar filtros
          </button>
        )}
      </div>
      {planning.error && (
        <ErrorNotice>
          {planning.error}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void planning.refresh()}>
            Reintentar
          </button>
        </ErrorNotice>
      )}
      {planning.loading && (
        <p className="pwt-note" role="status">
          Cargando dependencias e hitos…
        </p>
      )}
      {conflicts.length > 0 && (
        <p className="pwt-warning" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          {conflicts.length} {conflicts.length === 1 ? 'dependencia con fechas solapadas' : 'dependencias con fechas solapadas'}. Revisa el orden; las fechas no
          se ajustan automáticamente.
        </p>
      )}
      <p className="pwt-note">
        {model.scheduled.length} {model.scheduled.length === 1 ? 'tarea programada' : 'tareas programadas'} · {model.undated.length} sin programar.{' '}
        {project?.archived_at || data.readOnly ? 'Solo lectura.' : 'Arrastra una barra o sus extremos para proponer fechas. Confirma antes de guardar.'}
      </p>
      {rows.length ? (
        <div
          ref={scroll}
          className="pwt-scroll"
          tabIndex={0}
          role="region"
          aria-label="Fechas del cronograma; desplazamiento horizontal"
          style={{ '--pwt-chart-width': `${chartWidth}px`, '--pwt-day-width': `${window.dayWidth}px` } as CSSProperties}
        >
          <div className="pwt-canvas">
            <div className="pwt-header">
              <div className="pwt-corner">Tarea</div>
              <div className="pwt-time-header">
                <div className="pwt-months">
                  {monthSegments.map(segment => (
                    <div key={segment.date} style={{ width: segment.days * window.dayWidth }}>
                      <span>{monthName(segment.date)}</span>
                    </div>
                  ))}
                </div>
                <div className="pwt-days">
                  {(scale === 'week' ? dates : dates.filter((_, index) => index % 7 === 0)).map(date => (
                    <div key={date} className={date === today ? 'is-today' : ''} style={{ width: window.dayWidth * (scale === 'week' ? 1 : 7) }}>
                      {scale === 'week' ? date.slice(8).replace(/^0/, '') : formatDate(date)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div className="pwt-body" style={{ height: rows.length * ROW_HEIGHT }}>
              <div className="pwt-backdrop" aria-hidden="true">
                {dates.map((date, index) =>
                  civilWeekday(date) === 0 || civilWeekday(date) === 6 ? (
                    <span className="pwt-weekend" key={date} style={{ left: index * window.dayWidth, width: window.dayWidth }} />
                  ) : null,
                )}
                {dates
                  .filter((_, index) => index % 7 === 0)
                  .map(date => (
                    <span key={date} className="pwt-week-line" style={{ left: daysBetween(window.start, date) * window.dayWidth }} />
                  ))}
                {today >= window.start && today <= window.end && (
                  <span className="pwt-today-line" title="Hoy" style={{ left: (daysBetween(window.start, today) + 0.5) * window.dayWidth }} />
                )}
              </div>
              {rows.map(row => {
                if (row.kind === 'group')
                  return (
                    <div key={row.id} className="pwt-row pwt-group">
                      <button type="button" className="pwt-label" aria-expanded={!collapsed.has(row.group.id)} onClick={() => toggleGroup(row.group.id)}>
                        <ChevronDown size={13} className={collapsed.has(row.group.id) ? 'is-collapsed' : ''} aria-hidden="true" />
                        {row.group.status ? (
                          <TaskStatusIcon status={row.group.status} />
                        ) : row.group.color ? (
                          <span className="pwt-color-dot" style={{ background: row.group.color }} />
                        ) : null}
                        <span>{row.group.label}</span>
                        <span className="pwt-count">{row.group.tasks.length}</span>
                      </button>
                      <div className="pwt-track" />
                    </div>
                  );
                if (row.kind === 'milestones')
                  return (
                    <div key={row.id} className="pwt-row pwt-milestones">
                      <div className="pwt-label">
                        <Diamond size={14} aria-hidden="true" />
                        <strong>Hitos</strong>
                        <span className="pwt-count">{model.milestones.length}</span>
                      </div>
                      <div className="pwt-track">
                        {milestoneEntries.map(([date, milestones], index) => {
                          const next = milestoneEntries[index + 1]?.[0];
                          const labelWidth = Math.min(112, (next ? daysBetween(date, next) : daysBetween(date, window.end) + 1) * window.dayWidth - 25);
                          const milestoneProjects = [...new Set(milestones.map(milestone => milestone.project_id))].slice(0, 3);
                          return (
                            <button
                              key={date}
                              type="button"
                              className="pwt-milestone"
                              style={
                                {
                                  left: (daysBetween(window.start, date) + 0.5) * window.dayWidth,
                                  '--pwt-color': model.projectMap.get(milestones[0].project_id)?.color,
                                } as CSSProperties
                              }
                              title={`${formatDate(date)} · ${milestones.map(milestone => `${milestone.name} · ${model.projectMap.get(milestone.project_id)!.name}${milestone.completed ? ' (completado)' : ''}`).join(' · ')}`}
                              aria-label={`${milestones.length > 1 ? `${milestones.length} hitos: ` : 'Hito: '}${milestones.map(milestone => `${milestone.name}${milestone.completed ? ' (completado)' : ''}`).join(', ')}, ${formatDate(date)}`}
                              onClick={() => setShowMilestones(true)}
                            >
                              <span className="pwt-milestone-glyphs">
                                {milestoneProjects.map(projectId => (
                                  <Diamond
                                    key={projectId}
                                    size={15}
                                    style={{ color: model.projectMap.get(projectId)!.color }}
                                    fill={
                                      milestones.filter(milestone => milestone.project_id === projectId).every(milestone => milestone.completed)
                                        ? 'currentColor'
                                        : 'var(--surface)'
                                    }
                                    aria-hidden="true"
                                  />
                                ))}
                              </span>
                              {scale === 'week' && labelWidth >= 45 && (
                                <span className="pwt-milestone-title" style={{ maxWidth: labelWidth }}>
                                  {milestones.length > 1 ? `${milestones.length} hitos` : milestones[0].name}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                const task = row.task;
                const interval = intervalOf(task);
                const inWindow = interval.end >= window.start && interval.start <= window.end;
                const clippedStart = interval.start < window.start ? window.start : interval.start;
                const clippedEnd = interval.end > window.end ? window.end : interval.end;
                const x = daysBetween(window.start, clippedStart) * window.dayWidth;
                const width = (daysBetween(clippedStart, clippedEnd) + 1) * window.dayWidth;
                const taskProject = model.projectMap.get(task.project_id)!;
                const barColor =
                  model.effectiveGrouping === 'project' || model.effectiveGrouping === 'assignee'
                    ? STATUSES.find(status => status.id === task.status)!.color
                    : taskProject.color;
                const canEdit = editable(task);
                const member = task.assignee_member_id ? model.memberMap.get(task.assignee_member_id) : undefined;
                return (
                  <div key={row.id} className="pwt-row">
                    <div className="pwt-label pwt-task-label">
                      <button className="pwt-task-open" type="button" onClick={() => onOpen(task)}>
                        <TaskStatusIcon status={task.status} />
                        <span className={task.status === 'done' ? 'is-completed' : ''}>{task.title}</span>
                      </button>
                      <PriorityIcon priority={task.priority} />
                      {member && (
                        <span className="pwt-assignee" title={member.display_name}>
                          {member.display_name.slice(0, 2).toLocaleUpperCase()}
                        </span>
                      )}
                      {canEdit && (
                        <button type="button" className="ibtn ibtn-xs pwt-schedule" aria-label={`Reprogramar ${task.title}`} onClick={() => openSchedule(task)}>
                          <CalendarClock size={14} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <div className="pwt-track">
                      {inWindow && (
                        <div
                          className={`pwt-bar${task.status === 'done' ? ' is-done' : ''}${canEdit ? ' is-editable' : ''}${preview?.task.id === task.id ? ' is-preview' : ''}`}
                          role="button"
                          tabIndex={0}
                          aria-label={`${task.title}, ${formatDate(interval.start)} a ${formatDate(interval.end)}. Abrir tarea`}
                          title={`${task.title} · ${taskProject.name} · ${interval.start} → ${interval.end}${canEdit ? ' · Arrastra para reprogramar; R para editar las fechas' : ' · Solo lectura'}`}
                          style={{ left: x, width, '--pwt-color': barColor } as CSSProperties}
                          onPointerDown={event => startDrag(event, task, 'move')}
                          onPointerMove={moveDrag}
                          onPointerUp={endDrag}
                          onPointerCancel={() => {
                            drag.current = null;
                            setPreview(null);
                          }}
                          onLostPointerCapture={() => {
                            drag.current = null;
                            setPreview(null);
                          }}
                          onClick={() => {
                            if (suppressClick.current) {
                              suppressClick.current = false;
                              return;
                            }
                            onOpen(task);
                          }}
                          onKeyDown={event => {
                            if (event.key === 'Escape' && drag.current) {
                              drag.current = null;
                              setPreview(null);
                              suppressClick.current = true;
                            } else if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              onOpen(task);
                            } else if (event.key.toLocaleLowerCase() === 'r' && canEdit) {
                              event.preventDefault();
                              openSchedule(task);
                            }
                          }}
                        >
                          {canEdit && interval.start >= window.start && (
                            <div className="pwt-resize pwt-resize-start" aria-hidden="true" onPointerDown={event => startDrag(event, task, 'start')}>
                              <GripVertical size={10} />
                            </div>
                          )}
                          {width > 85 && <span className="pwt-bar-title">{task.title}</span>}
                          {canEdit && interval.end <= window.end && (
                            <div className="pwt-resize pwt-resize-end" aria-hidden="true" onPointerDown={event => startDrag(event, task, 'end')}>
                              <GripVertical size={10} />
                            </div>
                          )}
                        </div>
                      )}
                      {inWindow && width <= 85 && (
                        <span className="pwt-short-label" style={{ left: x + width + 8 }}>
                          {task.title}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              <svg className="pwt-dependencies" width={chartWidth} height={rows.length * ROW_HEIGHT} aria-hidden="true">
                {visibleDependencies.map(edge => {
                  const predecessor = intervalOf(taskMap.get(edge.blocker_task_id)!);
                  const successor = intervalOf(taskMap.get(edge.task_id)!);
                  const x1 = (daysBetween(window.start, predecessor.end) + 1) * window.dayWidth;
                  const x2 = daysBetween(window.start, successor.start) * window.dayWidth;
                  if (x1 < 0 || x1 > chartWidth || x2 < 0 || x2 > chartWidth) return null;
                  const y1 = rowPositions.get(edge.blocker_task_id)!;
                  const y2 = rowPositions.get(edge.task_id)!;
                  const conflict = dependencyConflict(predecessor, successor);
                  const bend = Math.max(x1 + 14, x2 - 14);
                  return (
                    <g
                      key={edge.id}
                      className={conflict ? 'is-conflict' : ''}
                      data-testid={conflict ? 'timeline-conflicting-dependency' : 'timeline-dependency'}
                    >
                      <path d={`M ${x1} ${y1} C ${bend} ${y1}, ${Math.min(x1 + 14, x2 - 14)} ${y2}, ${x2 - 2} ${y2}`} />
                      <path d={`M ${x2 - 7} ${y2 - 4} L ${x2 - 2} ${y2} L ${x2 - 7} ${y2 + 4}`} />
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        </div>
      ) : (
        <EmptyState title="Sin tareas programadas">
          Asigna un inicio o un vencimiento a una tarea para verla en el cronograma. Los filtros solo muestran los proyectos a los que tienes acceso.
        </EmptyState>
      )}
      {model.undated.length > 0 && (
        <details className="pwt-undated">
          <summary>
            <CalendarClock size={14} aria-hidden="true" />
            Sin programar<span className="pwt-count">{model.undated.length}</span>
          </summary>
          <div>
            {model.undated.map(task => (
              <div className="pwt-undated-task" key={task.id}>
                <ProjectIcon color={model.projectMap.get(task.project_id)!.color} icon={model.projectMap.get(task.project_id)!.icon} />
                <button type="button" className="pwt-task-open" onClick={() => onOpen(task)}>
                  <TaskStatusIcon status={task.status} />
                  <span>{task.title}</span>
                </button>
                {editable(task) && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => openSchedule(task)}>
                    Programar
                  </button>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      {draft && (
        <Dialog
          title={`Reprogramar: ${draft.task.title}`}
          onClose={() => {
            if (!saving) setDraft(null);
          }}
          busy={saving}
        >
          <form
            className="pw-form"
            onSubmit={event => {
              event.preventDefault();
              void saveSchedule();
            }}
          >
            <div className="pw-form-body">
              <p className="pwt-note">Solo cambiarán las fechas de esta tarea. Los bloques horarios y las tareas relacionadas se conservan.</p>
              <div className="pwt-date-fields">
                <div className="pw-field">
                  <label htmlFor="pwt-start">Fecha de inicio</label>
                  <input
                    id="pwt-start"
                    data-initial-focus
                    type="date"
                    required
                    value={draft.start}
                    disabled={saving || !canEditDraft}
                    onChange={event => setDraft({ ...draft, start: event.target.value })}
                  />
                </div>
                <div className="pw-field">
                  <label htmlFor="pwt-end">Fecha de vencimiento</label>
                  <input
                    id="pwt-end"
                    type="date"
                    required
                    min={draft.start}
                    value={draft.end}
                    disabled={saving || !canEditDraft}
                    onChange={event => setDraft({ ...draft, end: event.target.value })}
                  />
                </div>
              </div>
              {draftConflicts > 0 && (
                <p className="pwt-warning">
                  <AlertTriangle size={15} aria-hidden="true" />
                  Estas fechas se solapan con {draftConflicts} {draftConflicts === 1 ? 'dependencia' : 'dependencias'}. Puedes guardarlas; no se moverán otras
                  tareas.
                </p>
              )}
              {!canEditDraft && <ErrorNotice>Esta tarea ya no se puede editar. Comprueba tu acceso o si el proyecto está archivado.</ErrorNotice>}
              {saveError && <ErrorNotice>{saveError}</ErrorNotice>}
            </div>
            <div className="pw-form-footer">
              <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setDraft(null)}>
                Cancelar
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving || data.pending || !canEditDraft}>
                {saving ? 'Guardando…' : 'Confirmar fechas'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}

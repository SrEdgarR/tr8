import { useMemo, useState, type CSSProperties } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, Globe2, List, RefreshCw } from 'lucide-react';
import { STATUSES } from '../constants';
import type { CalendarApi, CalendarItem, CalendarQuery, Project, TaskStatus, WorkspaceSummary } from '../types';
import { Busy, Dialog, EmptyState, ErrorNotice, StatusDot } from './ui';
import { errorMessage } from './helpers';
import {
  addCivilDays,
  addCivilMonths,
  blockLastDate,
  dateInTimeZone,
  formatCivilDate,
  formatTime,
  monthDays,
  monthStart,
  validCivilDate,
} from './CalendarTime';
import { CalendarZoneEditor } from './CalendarZoneSettings';
import useCalendarZonePreferences from './useCalendarZonePreferences';
import PlanningViewOptions from './PlanningViewOptions';
import './calendar-visibility.css';

interface Props {
  api: CalendarApi;
  workspaces: WorkspaceSummary[];
  workspaceId?: string;
  project?: Project;
  projects: Project[];
  /** A date from an already authorized task in this project, never an extra lookup. */
  nextTaskDate?: string | null;
  onOpen: (item: CalendarItem) => void;
}

const kindLabels = { block: 'Bloque', due: 'Vencimiento', start: 'Inicio', unscheduled: 'Sin programar' };

function itemDay(item: CalendarItem, zone: string): string | null {
  return item.kind === 'block' && item.start_at ? dateInTimeZone(item.start_at, zone) : item.date;
}

function CalendarEntry({ item, zone, onOpen, compact = false }: { item: CalendarItem; zone: string; onOpen: Props['onOpen']; compact?: boolean }) {
  const time = item.kind === 'block' && item.start_at && item.end_at ? `${formatTime(item.start_at, zone)}–${formatTime(item.end_at, zone)}` : 'Todo el día';
  const spansDays =
    !compact && item.kind === 'block' && item.start_at && item.end_at && dateInTimeZone(item.start_at, zone) !== blockLastDate(item.end_at, zone);
  return (
    <button
      type="button"
      aria-label={`${kindLabels[item.kind]} de ${item.title}, ${time}, proyecto ${item.project_name}`}
      className={`pw-calendar-entry${compact ? ' compact' : ''}${item.status === 'done' ? ' completed' : ''}`}
      style={{ '--project-color': item.project_color } as CSSProperties}
      onClick={() => onOpen(item)}
    >
      <span className="pw-calendar-entry-top">
        <span className={`pw-calendar-kind ${item.kind}`}>{kindLabels[item.kind]}</span>
        <span>{item.kind === 'unscheduled' ? '' : time}</span>
        <StatusDot status={item.status} />
      </span>
      <strong>{item.title}</strong>
      <span className="pw-calendar-entry-project">
        {item.project_name}
        {item.project_archived_at ? ' · Archivado' : ''}
      </span>
      {!compact && (
        <span className="faint">
          {item.workspace_name}
          {item.assignee_name ? ` · ${item.assignee_name}` : ''}
          {!item.can_edit ? ' · Solo lectura' : ''}
        </span>
      )}
      {!compact && spansDays && (
        <span>
          {formatCivilDate(dateInTimeZone(item.start_at!, zone))} – {formatCivilDate(dateInTimeZone(item.end_at!, zone))}
        </span>
      )}
      {!compact && item.kind === 'block' && item.scheduled_time_zone !== zone && <span className="faint">Programado en {item.scheduled_time_zone}</span>}
    </button>
  );
}

function CalendarAgenda({ items, zone, from, onOpen }: { items: CalendarItem[]; zone: string; from: string; onOpen: Props['onOpen'] }) {
  const groups = new Map<string, CalendarItem[]>();
  for (const item of items) {
    const day = itemDay(item, zone);
    if (!day) continue;
    const key = day < from ? from : day;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return (
    <div className="pw-calendar-agenda" aria-label="Agenda del período">
      {[...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, group]) => (
          <section key={day} className="pw-calendar-agenda-day">
            <h3>{formatCivilDate(day, { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
            <div>
              {group.map(item => (
                <CalendarEntry key={item.id} item={item} zone={zone} onOpen={onOpen} />
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}

export default function Calendar({ api, workspaces, workspaceId, project, projects, nextTaskDate, onOpen }: Props) {
  const zoneState = useCalendarZonePreferences(api, true);
  const { profile, zone } = zoneState;
  const [month, setMonth] = useState<string | null>(null);
  const currentMonth = month ?? monthStart(dateInTimeZone(new Date(), zone ?? 'America/La_Paz'));
  const [view, setView] = useState<'month' | 'agenda'>('month');
  const [selectedWorkspace, setSelectedWorkspace] = useState(project ? (workspaceId ?? project.workspace_id) : 'all');
  const [selectedProject, setSelectedProject] = useState(project?.id ?? '');
  const [status, setStatus] = useState<TaskStatus | ''>('');
  const [assignee, setAssignee] = useState('');
  const [mine, setMine] = useState(false);
  const [archived, setArchived] = useState(Boolean(project?.archived_at));
  const [showUnscheduled, setShowUnscheduled] = useState(false);
  const [dayDialog, setDayDialog] = useState<string | null>(null);
  const [mobileDay, setMobileDay] = useState<string | null>(null);
  const selectedMobileDay = mobileDay?.slice(0, 7) === currentMonth.slice(0, 7) ? mobileDay : null;
  const eligibleWorkspaces = workspaces.filter(space => space.permissions.includes('project.read') && space.permissions.includes('task.read'));
  const workspaceIds = project ? [project.workspace_id] : selectedWorkspace === 'all' ? eligibleWorkspaces.map(space => space.id) : [selectedWorkspace];
  const grid = monthDays(currentMonth);
  const from = view === 'month' ? grid[0] : currentMonth;
  const to = view === 'month' ? addCivilDays(grid.at(-1)!, 1) : addCivilMonths(currentMonth, 1);
  const input: CalendarQuery = {
    workspace_ids: workspaceIds,
    date_from: from,
    date_to: to,
    time_zone: zone ?? 'America/La_Paz',
    ...(selectedProject ? { project_ids: [selectedProject] } : {}),
    ...(status ? { statuses: [status] } : {}),
    ...(assignee ? { assignee_member_ids: [assignee] } : {}),
    mine,
    include_archived: archived,
    limit: 100,
  };
  const enabled = !!zone && !profile.error && !api.accessError && workspaceIds.length > 0;
  const query = useInfiniteQuery({
    queryKey: [...api.scopeKey, 'items', input],
    queryFn: ({ pageParam, signal }) => api.items({ ...input, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor ?? undefined,
    enabled,
    retry: false,
    refetchInterval: 30000,
  });
  const unscheduled = useInfiniteQuery({
    queryKey: [...api.scopeKey, 'items', { ...input, unscheduled: true }],
    queryFn: ({ pageParam, signal }) => api.items({ ...input, unscheduled: true, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor ?? undefined,
    enabled: enabled && showUnscheduled,
    retry: false,
    refetchInterval: 30000,
  });
  // A failed refresh must not leave cached private names visible after revocation.
  const items = useMemo(
    () => (!enabled || query.error ? [] : [...new Map((query.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()]),
    [enabled, query.error, query.data],
  );
  const unplanned = useMemo(
    () =>
      !enabled || unscheduled.error || !showUnscheduled
        ? []
        : [...new Map((unscheduled.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()],
    [enabled, unscheduled.error, unscheduled.data, showUnscheduled],
  );
  const daysByItem = useMemo(() => {
    const days = new Map<string, CalendarItem[]>();
    for (const day of monthDays(currentMonth)) days.set(day, []);
    for (const item of items) {
      if (item.kind === 'block' && item.start_at && item.end_at) {
        const first = dateInTimeZone(item.start_at, zone ?? 'America/La_Paz');
        const last = blockLastDate(item.end_at, zone ?? 'America/La_Paz');
        for (const [day, entries] of days) if (first <= day && last >= day) entries.push(item);
      } else if (item.date) days.get(item.date)?.push(item);
    }
    return days;
  }, [items, currentMonth, zone]);
  const projectOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const item of [...items, ...unplanned]) options.set(item.project_id, item.project_name);
    for (const item of projects)
      if ((selectedWorkspace === 'all' || item.workspace_id === selectedWorkspace) && (archived || !item.archived_at)) options.set(item.id, item.name);
    return [...options].sort(([, a], [, b]) => a.localeCompare(b));
  }, [items, unplanned, projects, selectedWorkspace, archived]);
  const assigneeOptions = useMemo(
    () =>
      [
        ...new Map(
          [...items, ...unplanned].filter(item => item.assignee_member_id && item.assignee_name).map(item => [item.assignee_member_id!, item.assignee_name!]),
        ).entries(),
      ].sort(([, a], [, b]) => a.localeCompare(b)),
    [items, unplanned],
  );
  const currentItems = items.filter(item => {
    const date = itemDay(item, zone ?? 'America/La_Paz');
    return date
      ? date.slice(0, 7) === currentMonth.slice(0, 7) ||
          (item.kind === 'block' && item.end_at && date < currentMonth && blockLastDate(item.end_at, zone ?? 'America/La_Paz') >= currentMonth)
      : false;
  });
  const nextTaskMonth = nextTaskDate && validCivilDate(nextTaskDate) ? monthStart(nextTaskDate) : null;
  const showNearbyDate = Boolean(
    project &&
    enabled &&
    query.isSuccess &&
    !query.isFetching &&
    !query.hasNextPage &&
    !currentItems.length &&
    !status &&
    !assignee &&
    !mine &&
    nextTaskMonth &&
    nextTaskMonth !== currentMonth,
  );

  if (api.accessError)
    return (
      <ErrorNotice>
        {api.accessError}
        <button className="btn btn-secondary btn-sm" onClick={() => void api.retryAccess?.()}>
          Revisar acceso al calendario
        </button>
      </ErrorNotice>
    );

  return (
    <div className={`pw-calendar${project ? ' in-project' : ''}`}>
      {!project && (
        <div className="ph">
          <div>
            <h1>Calendario</h1>
            <p>Las fechas y los bloques de trabajo de tus proyectos autorizados.</p>
          </div>
        </div>
      )}
      {!zone && <CalendarZoneEditor state={zoneState} initial />}
      {zone && (
        <>
          <div className="pw-calendar-controls">
            <div className="pw-calendar-navigation">
              <button className="ibtn" aria-label="Mes anterior" onClick={() => setMonth(addCivilMonths(currentMonth, -1))}>
                <ChevronLeft size={17} />
              </button>
              <h2>{formatCivilDate(currentMonth, { month: 'long', year: 'numeric' })}</h2>
              <button className="ibtn" aria-label="Mes siguiente" onClick={() => setMonth(addCivilMonths(currentMonth, 1))}>
                <ChevronRight size={17} />
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => setMonth(monthStart(dateInTimeZone(new Date(), zone)))}>
                Hoy
              </button>
            </div>
            <div className="pw-segment" aria-label="Presentación del calendario">
              <button className={view === 'month' ? 'on' : ''} aria-pressed={view === 'month'} onClick={() => setView('month')}>
                <CalendarDays size={14} />
                Mes
              </button>
              <button className={view === 'agenda' ? 'on' : ''} aria-pressed={view === 'agenda'} onClick={() => setView('agenda')}>
                <List size={14} />
                Agenda
              </button>
            </div>
          </div>
          {showNearbyDate && nextTaskDate && nextTaskMonth && (
            <aside className="pw-calendar-nearby" aria-label="Próxima fecha del proyecto">
              <CalendarDays size={17} aria-hidden="true" />
              <p>
                <strong>La próxima tarea con fecha está en otro mes.</strong>
                <span>{formatCivilDate(nextTaskDate, { day: 'numeric', month: 'long', year: 'numeric' })}. Sus fechas se conservan.</span>
              </p>
              <button className="btn btn-secondary btn-sm" onClick={() => setMonth(nextTaskMonth)}>
                Ir a {formatCivilDate(nextTaskMonth, { month: 'long' })}
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </aside>
          )}
          <PlanningViewOptions
            label="Filtros del calendario"
            activeCount={
              Number(selectedWorkspace !== 'all' && !project) +
              Number(Boolean(selectedProject) && !project) +
              Number(Boolean(status)) +
              Number(Boolean(assignee)) +
              Number(mine) +
              Number(archived)
            }
          >
            <div className="pw-calendar-filters">
              {!project && (
                <label className="pw-field">
                  Espacios del calendario
                  <select
                    value={selectedWorkspace}
                    onChange={event => {
                      setSelectedWorkspace(event.target.value);
                      setSelectedProject('');
                      setAssignee('');
                    }}
                  >
                    <option value="all">Todos mis espacios</option>
                    {eligibleWorkspaces.map(space => (
                      <option key={space.id} value={space.id}>
                        {space.kind === 'personal' ? 'Mi espacio personal' : space.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!project && (
                <label className="pw-field">
                  Proyecto
                  <select
                    value={selectedProject}
                    onChange={event => {
                      setSelectedProject(event.target.value);
                      setAssignee('');
                    }}
                  >
                    <option value="">Todos los proyectos</option>
                    {selectedProject && !projectOptions.some(([id]) => id === selectedProject) && (
                      <option value={selectedProject}>Proyecto seleccionado</option>
                    )}
                    {projectOptions.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="pw-field">
                Estado
                <select value={status} onChange={event => setStatus(event.target.value as TaskStatus | '')}>
                  <option value="">Todos los estados</option>
                  {STATUSES.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pw-field">
                Responsable
                <select value={assignee} onChange={event => setAssignee(event.target.value)}>
                  <option value="">Todos los responsables</option>
                  {assignee && !assigneeOptions.some(([id]) => id === assignee) && <option value={assignee}>Responsable seleccionado</option>}
                  {assigneeOptions.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="pw-calendar-check">
                <input type="checkbox" checked={mine} onChange={event => setMine(event.target.checked)} />
                Solo mías
              </label>
              <label className="pw-calendar-check">
                <input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />
                Incluir proyectos archivados
              </label>
            </div>
            <p className="pw-calendar-caption">
              {project
                ? 'Solo se muestran las tareas de este proyecto con fechas en el período seleccionado.'
                : 'Los filtros ofrecen proyectos del espacio abierto y proyectos y responsables de los elementos cargados. Para elegir otro proyecto, ábrelo desde la navegación o cambia de espacio.'}
            </p>
            <p className="pw-calendar-caption pw-calendar-zone-caption">
              <Globe2 size={12} aria-hidden="true" />
              <span>Horas en {zone}. Puedes cambiar la zona en Configuración.</span>
            </p>
            <p className="pw-calendar-caption">
              Bloque y vencimiento pueden aparecer por separado para una misma tarea. Las fechas sin hora son de día completo.
            </p>
          </PlanningViewOptions>
          {!workspaceIds.length ? (
            <EmptyState title="Sin proyectos con acceso al calendario">Necesitas permisos de lectura de proyectos y tareas en algún espacio.</EmptyState>
          ) : query.isPending ? (
            <Busy>Cargando el calendario…</Busy>
          ) : query.error ? (
            <ErrorNotice>
              {errorMessage(query.error)}{' '}
              <button className="btn btn-secondary btn-sm" onClick={() => void query.refetch()}>
                Reintentar calendario
              </button>
            </ErrorNotice>
          ) : (
            <>
              {view === 'month' ? (
                <>
                  <div className="pw-calendar-grid pw-calendar-responsive-month" aria-label="Mes de proyectos">
                    <div className="pw-calendar-weekdays" aria-hidden="true">
                      {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(day => (
                        <span key={day}>{day}</span>
                      ))}
                    </div>
                    <div className="pw-calendar-days">
                      {grid.map(day => {
                        const entries = daysByItem.get(day) ?? [];
                        return (
                          <section
                            key={day}
                            className={`pw-calendar-day${entries.length ? ' has-entries' : ''}${day.slice(0, 7) !== currentMonth.slice(0, 7) ? ' outside' : ''}${day === dateInTimeZone(new Date(), zone) ? ' today' : ''}`}
                            aria-label={formatCivilDate(day)}
                          >
                            <span className="pw-calendar-day-number" aria-hidden="true">
                              {Number(day.slice(8))}
                            </span>
                            <button
                              type="button"
                              className="pw-calendar-mobile-day"
                              aria-label={`Ver el ${formatCivilDate(day)}, ${entries.length} ${entries.length === 1 ? 'elemento' : 'elementos'}${query.hasNextPage ? (entries.length === 1 ? ' cargado' : ' cargados') : ''}`}
                              aria-pressed={selectedMobileDay === day}
                              aria-current={day === dateInTimeZone(new Date(), zone) ? 'date' : undefined}
                              onClick={() => {
                                setMonth(monthStart(day));
                                setMobileDay(day);
                              }}
                            >
                              <span>{Number(day.slice(8))}</span>
                              {entries.length > 0 && <span className="pw-calendar-mobile-day-dot" aria-hidden="true" />}
                            </button>
                            {entries.slice(0, 3).map(item => (
                              <CalendarEntry compact key={item.id} item={item} zone={zone} onOpen={onOpen} />
                            ))}
                            {entries.length > 3 && (
                              <button className="pw-text-link" onClick={() => setDayDialog(day)}>
                                Ver {entries.length - 3} más<span className="sr"> el {formatCivilDate(day)}</span>
                              </button>
                            )}
                          </section>
                        );
                      })}
                    </div>
                  </div>
                  <div className="pw-calendar-mobile-agenda" role="region" aria-label="Agenda móvil del mes">
                    <div className="pw-calendar-mobile-agenda-heading">
                      <h3>{selectedMobileDay ? formatCivilDate(selectedMobileDay, { day: 'numeric', month: 'long' }) : 'Agenda del mes'}</h3>
                      {selectedMobileDay && (
                        <button className="btn btn-ghost btn-sm" onClick={() => setMobileDay(null)}>
                          Ver todo el mes
                        </button>
                      )}
                    </div>
                    <CalendarAgenda
                      items={selectedMobileDay ? (daysByItem.get(selectedMobileDay) ?? []) : currentItems}
                      zone={zone}
                      from={selectedMobileDay ?? currentMonth}
                      onOpen={onOpen}
                    />
                    {selectedMobileDay && !daysByItem.get(selectedMobileDay)?.length && (currentItems.length > 0 || query.hasNextPage) && (
                      <p className="pw-calendar-caption" role="status">
                        {query.hasNextPage
                          ? 'Aún no hay elementos cargados para este día. Carga el resto del período para comprobarlo.'
                          : 'No hay fechas para este día.'}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <CalendarAgenda items={items} zone={zone} from={from} onOpen={onOpen} />
              )}
              {(view === 'agenda' ? !items.length : !currentItems.length) &&
                (query.hasNextPage ? (
                  <p className="pw-calendar-caption" role="status">
                    Aún no hay fechas cargadas para este período. Carga más elementos para completar la consulta.
                  </p>
                ) : (
                  <EmptyState title="Sin fechas en este período">
                    No hay fechas en {formatCivilDate(currentMonth, { month: 'long', year: 'numeric' })} con estos filtros. Usa las flechas para ver otros
                    meses. Las tareas sin fecha están en «Sin programar».
                  </EmptyState>
                ))}
              {query.hasNextPage && (
                <div className="pw-calendar-pagination">
                  <p>Hay más elementos en este período.</p>
                  <button className="btn btn-secondary" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                    {query.isFetchingNextPage ? 'Cargando…' : 'Cargar más elementos'}
                  </button>
                </div>
              )}
              <div className="pw-calendar-refresh">
                <span role="status">{query.isFetching ? 'Actualizando calendario…' : `${items.length} elementos cargados`}</span>
                <button className="btn btn-ghost btn-sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
                  <RefreshCw size={13} />
                  Actualizar calendario
                </button>
              </div>
            </>
          )}
          <section className="pw-calendar-unscheduled">
            <h2>Sin programar</h2>
            <p className="faint">Tareas sin bloque, vencimiento ni fecha de inicio; se consultan por separado.</p>
            <button className="btn btn-secondary btn-sm" aria-expanded={showUnscheduled} onClick={() => setShowUnscheduled(value => !value)}>
              {showUnscheduled ? 'Ocultar tareas sin programar' : 'Ver tareas sin programar'}
            </button>
            {showUnscheduled && (
              <>
                {unscheduled.isPending && enabled ? (
                  <Busy>Cargando tareas sin programar…</Busy>
                ) : unscheduled.error ? (
                  <ErrorNotice>
                    {errorMessage(unscheduled.error)}{' '}
                    <button className="btn btn-secondary btn-sm" onClick={() => void unscheduled.refetch()}>
                      Reintentar sin programar
                    </button>
                  </ErrorNotice>
                ) : (
                  <div className="pw-calendar-unplanned-list">
                    {unplanned.map(item => (
                      <CalendarEntry key={item.id} item={item} zone={zone} onOpen={onOpen} />
                    ))}
                    {!unplanned.length && (
                      <p>
                        {unscheduled.hasNextPage
                          ? 'Aún no hay tareas cargadas. Carga más para completar la consulta.'
                          : 'No hay tareas sin programar con estos filtros.'}
                      </p>
                    )}
                  </div>
                )}
                {unscheduled.hasNextPage && (
                  <button className="btn btn-secondary btn-sm" disabled={unscheduled.isFetchingNextPage} onClick={() => void unscheduled.fetchNextPage()}>
                    Cargar más tareas sin programar
                  </button>
                )}
              </>
            )}
          </section>
          {dayDialog && (
            <Dialog title={formatCivilDate(dayDialog)} onClose={() => setDayDialog(null)}>
              <div className="pw-form-body pw-calendar-unplanned-list">
                {(daysByItem.get(dayDialog) ?? []).map(item => (
                  <CalendarEntry
                    key={item.id}
                    item={item}
                    zone={zone}
                    onOpen={item => {
                      setDayDialog(null);
                      onOpen(item);
                    }}
                  />
                ))}
              </div>
            </Dialog>
          )}
        </>
      )}
    </div>
  );
}

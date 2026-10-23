import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, List, RefreshCw } from 'lucide-react';
import { STATUSES } from '../constants';
import type { CalendarApi, CalendarItem, CalendarQuery, Project, TaskStatus, WorkspaceSummary } from '../types';
import { Busy, Dialog, EmptyState, ErrorNotice, StatusDot } from './ui';
import { errorMessage } from './helpers';
import {
  addCivilDays,
  addCivilMonths,
  blockLastDate,
  dateInTimeZone,
  detectDeviceTimeZone,
  formatCivilDate,
  formatTime,
  monthDays,
  monthStart,
  validTimeZone,
} from './CalendarTime';
import TimeZonePicker from './TimeZonePicker';

interface Props {
  api: CalendarApi;
  workspaces: WorkspaceSummary[];
  workspaceId?: string;
  project?: Project;
  projects: Project[];
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

export default function Calendar({ api, workspaces, workspaceId, project, projects, onOpen }: Props) {
  const client = useQueryClient();
  const profileKey = useMemo(() => [...api.scopeKey, 'profile'], [api.scopeKey]);
  const profile = useQuery({ queryKey: profileKey, queryFn: ({ signal }) => api.profile(signal), retry: false });
  const [detectedZone] = useState(detectDeviceTimeZone);
  const automaticAttempt = useRef(false);
  const [zoneInput, setZoneInput] = useState<string | null>(null);
  const [zoneError, setZoneError] = useState<string | null>(null);
  const [zoneNotice, setZoneNotice] = useState('');
  const zone = profile.error ? null : (profile.data?.time_zone ?? null);
  const zoneDraft = zoneInput ?? zone ?? detectedZone ?? '';
  const { mutate: persistZone, isPending: savingZone } = useMutation({
    mutationFn: ({ nextZone, version }: { nextZone: string; version: number; automatic: boolean; key: string[] }) => api.saveProfile(nextZone, version),
    onMutate: async variables => {
      setZoneError(null);
      setZoneNotice('');
      await client.cancelQueries({ queryKey: variables.key, exact: true });
    },
    onSuccess: (saved, variables) => {
      client.setQueryData(variables.key, saved);
      if (!variables.automatic) setZoneInput(null);
      setZoneNotice(
        variables.automatic
          ? `Detectamos y guardamos la zona de tu dispositivo: ${saved.time_zone}. Puedes cambiarla cuando quieras.`
          : 'Zona horaria guardada. Los vencimientos conservan su fecha y los bloques conservan sus instantes.',
      );
    },
    onError: async cause => {
      setZoneError(errorMessage(cause));
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'PT409') {
        // Another tab may have initialized the preference. Adopt it; never overwrite it.
        const current = await profile.refetch();
        if (current.data?.time_zone) setZoneNotice('Se cargó la zona guardada desde otra sesión. Revisa la hora antes de cambiarla.');
      }
    },
    retry: false,
  });

  useEffect(() => {
    if (automaticAttempt.current || !detectedZone || !profile.data || profile.data.time_zone !== null || profile.error || api.accessError || zoneInput !== null)
      return;
    automaticAttempt.current = true;
    persistZone({ nextZone: detectedZone, version: profile.data.version, automatic: true, key: profileKey });
  }, [detectedZone, profile.data, profile.error, api.accessError, zoneInput, persistZone, profileKey]);
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

  async function saveZone() {
    if (savingZone || !profile.data || profile.error) return;
    setZoneError(null);
    setZoneNotice('');
    if (!validTimeZone(zoneDraft)) {
      setZoneError('Selecciona una zona de los resultados o escribe una zona IANA válida.');
      return;
    }
    persistZone({ nextZone: zoneDraft, version: profile.data.version, automatic: false, key: profileKey });
  }

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
      <section className="pw-calendar-zone" aria-label="Zona horaria del calendario">
        <div>
          <h2>Zona horaria</h2>
          <p className="faint">
            {zone
              ? `Visualización en ${zone}.`
              : detectedZone
                ? 'Usamos la zona de tu dispositivo en el primer acceso.'
                : 'No pudimos detectar la zona del dispositivo. Elige una para empezar.'}{' '}
            Esta preferencia es personal.
          </p>
        </div>
        <TimeZonePicker
          label="Zona horaria de visualización"
          value={zoneDraft}
          onChange={setZoneInput}
          disabled={savingZone || profile.isPending || !!profile.error}
        />
        <button
          className="btn btn-secondary btn-sm"
          disabled={savingZone || profile.isPending || !!profile.error || zoneDraft === zone || !validTimeZone(zoneDraft)}
          onClick={() => void saveZone()}
        >
          {savingZone ? 'Guardando…' : zone ? 'Guardar zona' : 'Confirmar zona'}
        </button>
      </section>
      {profile.error && (
        <ErrorNotice>
          {errorMessage(profile.error)}{' '}
          <button className="btn btn-secondary btn-sm" onClick={() => void profile.refetch()}>
            Reintentar zona
          </button>
        </ErrorNotice>
      )}
      {zoneError && <ErrorNotice>{zoneError}</ErrorNotice>}
      {zoneNotice && (
        <p className="pw-calendar-notice" role="status">
          {zoneNotice}
        </p>
      )}
      {profile.isPending && <Busy>Cargando tu preferencia horaria…</Busy>}
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
                  {selectedProject && !projectOptions.some(([id]) => id === selectedProject) && <option value={selectedProject}>Proyecto seleccionado</option>}
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
            Los filtros ofrecen proyectos del espacio abierto y proyectos y responsables de los elementos cargados. Para elegir otro proyecto, ábrelo desde la
            navegación o cambia de espacio.
          </p>
          <p className="pw-calendar-caption">
            Bloque y vencimiento pueden aparecer por separado para una misma tarea. Las fechas sin hora son de día completo.
          </p>
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
                  <div className="pw-calendar-grid" aria-label="Mes de proyectos">
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
                            className={`pw-calendar-day${day.slice(0, 7) !== currentMonth.slice(0, 7) ? ' outside' : ''}${day === dateInTimeZone(new Date(), zone) ? ' today' : ''}`}
                            aria-label={formatCivilDate(day)}
                          >
                            <span className="pw-calendar-day-number" aria-hidden="true">
                              {Number(day.slice(8))}
                            </span>
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
                  <div className="pw-calendar-mobile-agenda">
                    <CalendarAgenda items={currentItems} zone={zone} from={currentMonth} onOpen={onOpen} />
                  </div>
                </>
              ) : (
                <CalendarAgenda items={items} zone={zone} from={from} onOpen={onOpen} />
              )}
              {(view === 'agenda' ? !items.length : !currentItems.length) && (
                <EmptyState title="Sin fechas en este período">Cambia el mes o los filtros. Las tareas sin fecha están en «Sin programar».</EmptyState>
              )}
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
                    {!unplanned.length && <p>No hay tareas sin programar con estos filtros.</p>}
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

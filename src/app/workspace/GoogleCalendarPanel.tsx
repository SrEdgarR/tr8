import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronRight, CircleCheck, ExternalLink, Link2, LoaderCircle, RefreshCw, ShieldCheck, TriangleAlert, Unplug } from 'lucide-react';
import type { GoogleCalendarApi, GoogleCalendarStatus, GoogleChangeInput, GoogleReason, GoogleState } from '../data/google-calendar';
import { DataError } from '../data/errors';
import { Dialog, ErrorNotice } from './ui';
import { errorMessage } from './helpers';
import { browserSecret, openGooglePopup, type GooglePopup } from './google-oauth';
import './google-calendar.css';
import GoogleTasksPanel from './GoogleTasksPanel';
import type { GoogleTasksApi, GoogleTasksStatus } from '../data/google-tasks';
import GoogleBrandIcon from './GoogleBrandIcon';

const stateLabels: Record<GoogleState, string> = {
  disconnected: 'Desconectado',
  authorizing: 'Esperando autorización',
  provisioning: 'Preparando tu calendario',
  provisioning_unknown: 'Calendario por comprobar',
  connected: 'Conectado',
  needs_reauthorization: 'Necesita reconexión',
  disconnecting: 'Desconectando',
  cleanup_failed: 'Limpieza pendiente',
  error: 'Necesita revisión',
};
const reasonLabels: Record<GoogleReason, string> = {
  config_pending: 'Falta completar la configuración de Google. La integración permanece desactivada.',
  oauth_denied: 'No autorizaste la conexión. Puedes intentarlo de nuevo cuando quieras.',
  oauth_expired: 'La autorización caducó. Vuelve a conectar Google.',
  oauth_exchange_failed: 'No se pudo confirmar la autorización con Google. Revisa el estado antes de volver a conectar.',
  scope_missing: 'No se concedieron todos los permisos solicitados a Google. Vuelve a conectar para revisarlos.',
  refresh_missing: 'Google no entregó una autorización renovable. Vuelve a conectar para permitir la sincronización en segundo plano.',
  reauthorization_required: 'Google retiró o venció la autorización. Vuelve a conectar; tus tareas siguen en TR8.',
  different_google_account: 'Esta conexión pertenece a otra cuenta de Google. Utiliza la cuenta conectada o desconecta primero.',
  provisioning_unknown: 'Google no confirmó la creación del calendario. Comprueba si existe antes de continuar; no crearemos otra copia automáticamente.',
  remote_missing: 'Un calendario o evento de Google ya no está disponible. Revisa Google antes de solicitar otra sincronización.',
  temporary_failure: 'Google no está disponible temporalmente. Los cambios pendientes siguen guardados.',
  permanent_failure: 'La sincronización necesita revisión. Puedes actualizar el estado o desconectar sin modificar tus tareas.',
  cleanup_failed: 'No pudimos retirar todas las copias. Puedes reintentar la limpieza o conservar las restantes y desconectar.',
  budget_exhausted: 'Se alcanzó el presupuesto de sincronización. Los cambios siguen pendientes hasta que se renueve la cuota.',
};
type DialogKind = 'connect' | 'disconnect' | 'abandon' | 'recover' | 'rebuild';
type Operation = 'connect' | 'reconcile' | 'disconnect' | 'retry_cleanup' | 'abandon_cleanup' | 'recover_calendar' | 'rebuild_missing';

function statusDate(value: string | null) {
  return value
    ? new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
    : 'Aún no hay una sincronización confirmada';
}

export default function GoogleCalendarPanel({
  api,
  tasksApi,
  collapsible = false,
}: {
  api: GoogleCalendarApi;
  tasksApi?: GoogleTasksApi;
  collapsible?: boolean;
}) {
  const client = useQueryClient();
  const statusKey = [...api.scopeKey, 'status'];
  const scope = api.scopeKey.join(':');
  const active = useRef(true);
  const busyRef = useRef(false);
  const tasksBusyRef = useRef(false);
  const popup = useRef<GooglePopup | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [tasksBusy, setTasksBusy] = useState(false);
  const onTasksBusyChange = useCallback((value: boolean) => {
    tasksBusyRef.current = value;
    setTasksBusy(value);
  }, []);
  const [dialog, setDialog] = useState<{ kind: DialogKind; generation: number; version: number } | null>(null);
  const [mode, setMode] = useState<'keep' | 'delete'>('keep');
  const [calendarId, setCalendarId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const bodyId = useId();
  const query = useQuery({
    queryKey: statusKey,
    queryFn: ({ signal }) => api.load(signal),
    retry: false,
    refetchInterval: current =>
      !current.state.error && current.state.data?.configured && ['authorizing', 'provisioning', 'disconnecting'].includes(current.state.data.state)
        ? 3000
        : 30000,
    refetchIntervalInBackground: false,
  });
  const tasksQuery = useQuery({
    queryKey: tasksApi ? [...tasksApi.scopeKey, 'status'] : [...api.scopeKey, 'tasks-unavailable'],
    queryFn: tasksApi ? ({ signal }) => tasksApi.load(signal) : undefined,
    enabled: Boolean(tasksApi),
    retry: false,
  });
  const tasksStatus = tasksQuery.error ? null : tasksQuery.data;
  const status = query.error ? null : query.data;
  const busy = operation !== null || tasksBusy;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      popup.current?.cancel();
      popup.current = null;
      controller.current?.abort();
    };
  }, [scope]);

  async function run(kind: Operation, action: (signal: AbortSignal) => Promise<GoogleCalendarStatus>, expected: GoogleCalendarStatus) {
    if (!active.current || busyRef.current || tasksBusyRef.current) return;
    const latest = client.getQueryData<GoogleCalendarStatus>(statusKey);
    if (!latest || latest.generation !== expected.generation || latest.version !== expected.version) {
      setDialog(null);
      setError('La conexión cambió. Revisa su estado antes de continuar.');
      return;
    }
    busyRef.current = true;
    setOperation(kind);
    setError(null);
    setNotice(null);
    const request = new AbortController();
    controller.current = request;
    try {
      await client.cancelQueries({ queryKey: statusKey, exact: true });
      if (!active.current || request.signal.aborted) return;
      const result = await action(request.signal);
      if (!active.current || request.signal.aborted) return;
      // A newer connection or disconnect observed during this request wins over its response.
      const live = client.getQueryData<GoogleCalendarStatus>(statusKey);
      if (live && (live.generation > result.generation || (live.generation === result.generation && live.version > result.version))) return;
      client.setQueryData(statusKey, result);
      setDialog(null);
      setNotice(
        kind === 'reconcile'
          ? 'Revisión solicitada. Los cambios pendientes se procesarán en segundo plano.'
          : kind === 'connect' && result.state === 'connected'
            ? 'Autorización de Google confirmada. Actualizando calendario y tareas.'
            : null,
      );
      void client.invalidateQueries({ queryKey: api.scopeKey });
      if (tasksApi) void client.invalidateQueries({ queryKey: tasksApi.scopeKey });
    } catch (cause) {
      if (active.current && !request.signal.aborted) {
        setError(errorMessage(cause));
        if (cause instanceof DataError && ['STALE_VERSION', 'AUTH_REQUIRED', 'APP_ACCESS_DENIED'].includes(cause.code ?? '')) setDialog(null);
        void query.refetch();
        if (tasksApi) void client.invalidateQueries({ queryKey: tasksApi.scopeKey });
      }
    } finally {
      if (controller.current === request) controller.current = null;
      if (active.current) {
        busyRef.current = false;
        setOperation(null);
      }
    }
  }
  function change(input: GoogleChangeInput, expected: GoogleCalendarStatus) {
    return run(input.action, signal => api.change({ ...input, request_id: crypto.randomUUID(), expected_version: expected.version }, signal), expected);
  }
  function synchronize(expected: GoogleCalendarStatus) {
    return run(
      'reconcile',
      async signal => {
        const result = await api.change({ action: 'reconcile', request_id: crypto.randomUUID(), expected_version: expected.version }, signal);
        if (tasksApi && active.current && !signal.aborted) {
          // Re-read before writing: a pause from another device must remain a pause.
          const current = await tasksApi.load(signal);
          if (!active.current || signal.aborted) return result;
          if (current.configured && current.enabled && current.state === 'connected') {
            const updated = await tasksApi.change({ action: 'tasks_reconcile', request_id: crypto.randomUUID(), expected_version: current.version }, signal);
            const latest = client.getQueryData<GoogleTasksStatus>([...tasksApi.scopeKey, 'status']);
            if (active.current && !signal.aborted && (!latest || latest.version <= updated.version))
              client.setQueryData([...tasksApi.scopeKey, 'status'], updated);
          }
        }
        return result;
      },
      expected,
    );
  }
  function connect(expected: GoogleCalendarStatus) {
    if (busyRef.current || tasksBusyRef.current) return;
    let opened: GooglePopup;
    let secret: string;
    try {
      secret = browserSecret();
      opened = openGooglePopup(api.callbackOrigin, secret);
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    popup.current = opened;
    // Attach a rejection handler before begin can fail or the component can unmount.
    void opened.result.catch(() => {});
    void run(
      'connect',
      async signal => {
        const authorization = await api.begin(
          { request_id: crypto.randomUUID(), expected_version: expected.version, browser_secret: secret, ...(tasksApi ? { tasks_requested: true } : {}) },
          signal,
        );
        if (!active.current || signal.aborted) throw new DataError('La sesión cambió durante la autorización.');
        opened.authorize(authorization);
        const completion = await opened.result;
        if (!active.current || signal.aborted) throw new DataError('La sesión cambió durante la autorización.');
        return await api.complete(completion, signal);
      },
      expected,
    ).finally(() => {
      opened.cancel();
      if (popup.current === opened) popup.current = null;
    });
  }
  function showDialog(kind: DialogKind, value: GoogleCalendarStatus) {
    setMode('keep');
    setCalendarId('');
    setError(null);
    setNotice(null);
    setDialog({ kind, generation: value.generation, version: value.version });
  }
  const dialogCurrent = dialog && status && dialog.generation === status.generation && dialog.version === status.version ? dialog : null;
  const canConnect = status?.configured && ['disconnected', 'needs_reauthorization', 'error', 'authorizing'].includes(status.state);
  const needsTasksPermission = Boolean(
    tasksApi &&
    status?.state === 'connected' &&
    tasksStatus?.configured &&
    (!tasksStatus.enabled || ['needs_reauthorization', 'error'].includes(tasksStatus.state)),
  );
  const canDisconnect = status && status.state !== 'disconnected' && status.state !== 'disconnecting';
  const headerStatus = !status
    ? 'Por comprobar'
    : !status.configured
      ? 'Configuración pendiente'
      : needsTasksPermission
        ? 'Permisos pendientes'
        : status.state === 'connected' && tasksApi && !tasksStatus
          ? 'Comprobando permisos'
          : stateLabels[status.state];
  const badge = (
    <span id={`${bodyId}-status`} className={`pw-google-badge${needsTasksPermission ? ' is-pending' : status?.state === 'connected' ? ' is-connected' : ''}`}>
      {headerStatus}
    </span>
  );
  return (
    <section className={`pw-google${collapsible ? ' is-collapsible' : ''}`} aria-label="Integración con Google">
      <header className={`pw-google-heading${collapsible ? ' is-collapsible' : ''}`}>
        {collapsible ? (
          <h2 className="pw-google-disclosure-heading">
            <button
              type="button"
              className="pw-google-disclosure"
              aria-label="Google"
              aria-expanded={expanded}
              aria-controls={bodyId}
              aria-describedby={`${bodyId}-status`}
              onClick={() => setExpanded(value => !value)}
            >
              <span className="pw-google-brand">
                <GoogleBrandIcon />
              </span>
              <span className="pw-google-disclosure-copy">
                <span className="pw-google-disclosure-title">Google</span>
                <span className="pw-google-disclosure-caption">Calendario y tareas en una sola conexión.</span>
              </span>
              {badge}
              <ChevronRight className={`pw-google-chevron${expanded ? ' is-expanded' : ''}`} size={17} aria-hidden="true" />
            </button>
          </h2>
        ) : (
          <>
            <span className="pw-google-brand">
              <GoogleBrandIcon />
            </span>
            <div>
              <h2>Google</h2>
              <p>Calendario y tareas en una sola conexión.</p>
            </div>
            {badge}
          </>
        )}
      </header>
      <div id={bodyId} className="pw-google-body" hidden={collapsible && !expanded}>
        <p className="pw-google-personal">
          <ShieldCheck size={14} aria-hidden="true" />
          Una conexión personal para Google Calendar y Google Tasks.
        </p>
        {query.error ? (
          <ErrorNotice>
            {errorMessage(query.error)}{' '}
            <button className="btn btn-secondary btn-sm" onClick={() => void query.refetch()}>
              Reintentar conexión
            </button>
          </ErrorNotice>
        ) : !status ? (
          <p role="status">Consultando tu conexión con Google…</p>
        ) : (
          <>
            <div className="pw-google-service" role="group" aria-label="Eventos de Google Calendar">
              <h3 className="pw-google-service-heading">
                <CalendarDays size={16} aria-hidden="true" />
                Eventos del calendario
              </h3>
              <div className="pw-google-details">
                <Link2 size={16} aria-hidden="true" />
                <p>
                  TR8 → Google Calendar. Se copian tus tareas personales y las asignadas a ti en equipos, con fecha u horario y acceso vigente, a un calendario
                  independiente llamado <strong>TR8</strong>.
                </p>
              </div>
              <p className="pw-google-caption">
                Los eventos se envían de TR8 a Google Calendar. Al completar una tarea conservaremos su evento con la marca «Hecha».
              </p>
              {status.reason && (
                <p className="pw-google-reason" role="status">
                  <TriangleAlert size={15} aria-hidden="true" />
                  {reasonLabels[status.reason]}
                </p>
              )}
              {!status.configured && status.reason !== 'config_pending' && (
                <p role="status">Falta completar la configuración de Google. La integración permanece desactivada.</p>
              )}
              {status.state !== 'disconnected' && (
                <div className="pw-google-stats" key={`${scope}:${status.generation}`}>
                  <div>
                    <span>Última sincronización</span>
                    <strong>{statusDate(status.last_sync_at)}</strong>
                  </div>
                  <div>
                    <strong>{status.pending}</strong>
                    <span>Pendientes</span>
                  </div>
                  <div>
                    <strong>{status.failed}</strong>
                    <span>Por revisar</span>
                  </div>
                </div>
              )}
            </div>
            {tasksApi && (
              <GoogleTasksPanel api={tasksApi} embedded connectionBusy={operation !== null || status.state !== 'connected'} onBusyChange={onTasksBusyChange} />
            )}
            {['authorizing', 'provisioning', 'disconnecting'].includes(status.state) && (
              <p className="pw-google-wait" role="status">
                <LoaderCircle className="pw-spin" size={14} aria-hidden="true" />
                {status.state === 'disconnecting'
                  ? 'Terminando la opción de desconexión elegida. No se crearán nuevas copias.'
                  : status.state === 'provisioning'
                    ? 'Preparando el calendario y las primeras tareas. Puedes seguir usando TR8.'
                    : 'Completa la autorización en la ventana de Google.'}
              </p>
            )}
            <div className="pw-google-actions">
              {(canConnect || needsTasksPermission) && (
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => showDialog('connect', status)}>
                  <Link2 size={14} aria-hidden="true" />
                  {needsTasksPermission
                    ? 'Completar conexión con Google'
                    : status.state === 'needs_reauthorization'
                      ? 'Volver a conectar Google'
                      : 'Conectar Google'}
                </button>
              )}
              {status.configured && status.state === 'connected' && (
                <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void synchronize(status)}>
                  <RefreshCw size={14} aria-hidden="true" />
                  Sincronizar ahora
                </button>
              )}
              {status.configured && status.state === 'provisioning_unknown' && (
                <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => showDialog('recover', status)}>
                  Recuperar calendario existente
                </button>
              )}
              {status.configured && status.state === 'connected' && status.reason === 'remote_missing' && (
                <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => showDialog('rebuild', status)}>
                  Reconstruir eventos ausentes
                </button>
              )}
              {status.state === 'cleanup_failed' && (
                <>
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={busy || !status.configured}
                    onClick={() => void change({ action: 'retry_cleanup' }, status)}
                  >
                    Reintentar limpieza
                  </button>
                  <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => showDialog('abandon', status)}>
                    Conservar restantes y desconectar
                  </button>
                </>
              )}
              {canDisconnect && status.state !== 'cleanup_failed' && (
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => showDialog('disconnect', status)}>
                  <Unplug size={14} aria-hidden="true" />
                  Desconectar
                </button>
              )}
            </div>
          </>
        )}
        {error && !dialogCurrent && <ErrorNotice>{error}</ErrorNotice>}
        {status && notice && (
          <p className="pw-google-notice" role="status">
            <CircleCheck size={15} aria-hidden="true" />
            {notice}
          </p>
        )}
        {busy && !dialogCurrent && (
          <p className="pw-google-wait" role="status">
            <LoaderCircle size={14} className="pw-spin" aria-hidden="true" />
            {operation === 'connect' ? 'Esperando tu autorización en Google…' : 'Confirmando la solicitud…'}
          </p>
        )}
        <footer>
          <span>Correo opcional y altas externas siguen desactivados.</span>
          <button
            className="btn btn-ghost btn-sm"
            disabled={query.isFetching || busy}
            onClick={() => {
              setError(null);
              void query.refetch();
              if (tasksApi) void tasksQuery.refetch();
            }}
          >
            <RefreshCw size={13} aria-hidden="true" />
            Actualizar conexión
          </button>
        </footer>
      </div>
      {dialogCurrent && status && (
        <Dialog
          title={
            dialogCurrent.kind === 'connect'
              ? 'Conectar Google'
              : dialogCurrent.kind === 'recover'
                ? 'Recuperar calendario TR8'
                : dialogCurrent.kind === 'abandon'
                  ? 'Conservar las copias restantes'
                  : dialogCurrent.kind === 'rebuild'
                    ? 'Reconstruir eventos ausentes'
                    : 'Desconectar Google'
          }
          busy={busy}
          onClose={() => setDialog(null)}
        >
          <div className="pw-google-dialog">
            {error && <ErrorNotice>{error}</ErrorNotice>}
            {busy && (
              <p role="status" className="pw-google-wait">
                <LoaderCircle size={14} className="pw-spin" aria-hidden="true" />
                {operation === 'connect' ? 'Completa la autorización en la ventana de Google.' : 'Confirmando la solicitud…'}
              </p>
            )}
            {dialogCurrent.kind === 'connect' ? (
              <>
                {tasksApi ? (
                  <>
                    <p>
                      Conectarás Google Calendar y Google Tasks con una misma cuenta y autorización. Google pedirá permiso para crear el calendario secundario
                      TR8 y gestionar sus eventos.
                    </p>
                    <p>
                      Google pedirá permiso para gestionar tus tareas de Google Tasks. Google no permite limitar ese permiso a una lista; en TR8 elegirás las
                      listas activas. Al conectar se importará automáticamente la primera lista; después podrás desactivarla o elegir otras. Se conserva el
                      acceso a tu calendario TR8 si ya estaba conectado.
                    </p>
                    <p>
                      Se importarán título, día y estado al proyecto personal Google Tasks. Las ediciones, finalización y eliminación de tareas vinculadas se
                      sincronizarán en ambos sentidos. No se creará otro evento de Calendar para ellas. Los conflictos requerirán tu elección.
                    </p>
                    <p>Google Tasks solo expone la fecha a su API; no podemos leer ni modificar la hora que muestra en tu teléfono.</p>
                  </>
                ) : (
                  <>
                    <p>
                      Google pedirá permiso para crear el calendario secundario TR8 y gestionar sus eventos. Puedes usar una cuenta de Google distinta de la que
                      utilizas para entrar a TR8.
                    </p>
                    <p>Si ya activaste Google Tasks, al reconectar conservaremos el permiso que ya autorizaste.</p>
                  </>
                )}
                {dialogCurrent.kind === 'connect' && (
                  <p>
                    Para los eventos del calendario solo enviaremos el título de la tarea, proyecto, fechas y enlace a TR8. No enviaremos descripciones
                    completas, finanzas ni invitaciones a otras personas.
                  </p>
                )}
                <p className="pw-google-privacy">
                  Una copia ya enviada puede permanecer en Google si revocas el acceso antes de retirarla. Podrás elegir conservar o intentar eliminar los
                  eventos al desconectar.
                </p>
                <p className="pw-google-links">
                  <a href="/privacy" target="_blank" rel="noopener noreferrer">
                    Privacidad en TR8
                  </a>
                  <span aria-hidden="true"> · </span>
                  <a href="/about" target="_blank" rel="noopener noreferrer">
                    Acerca de TR8
                  </a>
                </p>
                <div className="pw-google-actions">
                  <button className="btn btn-secondary" disabled={busy} onClick={() => setDialog(null)}>
                    Cancelar
                  </button>
                  <button className="btn btn-primary" data-initial-focus disabled={busy} onClick={() => connect(status)}>
                    <ExternalLink size={14} aria-hidden="true" />
                    Continuar con Google
                  </button>
                </div>
              </>
            ) : dialogCurrent.kind === 'recover' ? (
              <>
                <p>
                  Si Google creó el calendario pero se perdió la confirmación, recupera su identificador en Google Calendar → Configuración → Integrar el
                  calendario. TR8 comprobará que puede gestionarlo antes de vincularlo.
                </p>
                <label className="pw-google-field">
                  Identificador del calendario
                  <input
                    value={calendarId}
                    onChange={event => setCalendarId(event.target.value)}
                    maxLength={512}
                    disabled={busy}
                    autoComplete="off"
                    data-initial-focus
                  />
                </label>
                <p>No uses el nombre «TR8» como identificador. No crearemos un segundo calendario para resolver este estado.</p>
                <div className="pw-google-actions">
                  <button className="btn btn-secondary" disabled={busy} onClick={() => setDialog(null)}>
                    Cancelar
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy || !calendarId.trim()}
                    onClick={() => void change({ action: 'recover_calendar', calendar_id: calendarId.trim() }, status)}
                  >
                    Comprobar calendario
                  </button>
                </div>
              </>
            ) : dialogCurrent.kind === 'rebuild' ? (
              <>
                <p>Volveremos a crear las copias de tareas que eliminaste de Google y que siguen cumpliendo los permisos y fechas de TR8.</p>
                <p>
                  Se utilizará la información actual de TR8. Las ediciones hechas en Google no se importan y la sincronización puede restablecer los datos de
                  TR8.
                </p>
                <p>No se borrarán tus eventos ajenos a TR8. Si hiciste copias manuales de los eventos, compruébalas para evitar duplicados visibles.</p>
                <div className="pw-google-actions">
                  <button className="btn btn-secondary" data-initial-focus disabled={busy} onClick={() => setDialog(null)}>
                    Cancelar
                  </button>
                  <button className="btn btn-primary" disabled={busy} onClick={() => void change({ action: 'rebuild_missing' }, status)}>
                    Reconstruir copias
                  </button>
                </div>
              </>
            ) : (
              <>
                {dialogCurrent.kind === 'disconnect' ? (
                  <>
                    {tasksApi && (
                      <p>
                        Desconectar Google también detendrá Google Tasks si está activo. Sus tareas se conservarán tanto en Google como en el proyecto personal
                        importado.
                      </p>
                    )}
                    <p>Se detendrá la sincronización y se retirarán las credenciales de Google. Tus proyectos y tareas permanecerán en TR8.</p>
                    <fieldset disabled={busy}>
                      <legend>¿Qué hacemos con los eventos de TR8?</legend>
                      <label>
                        <input type="radio" name="google-disconnect" checked={mode === 'keep'} onChange={() => setMode('keep')} data-initial-focus />
                        <span>
                          <strong>Conservar los eventos</strong>
                          <small>Las copias permanecerán en Google sin recibir nuevos cambios.</small>
                        </span>
                      </label>
                      <label>
                        <input type="radio" name="google-disconnect" checked={mode === 'delete'} onChange={() => setMode('delete')} />
                        <span>
                          <strong>Intentar eliminar los eventos</strong>
                          <small>Solo se retirarán los eventos registrados por TR8. Conservaremos el calendario y sus demás eventos.</small>
                        </span>
                      </label>
                    </fieldset>
                    <p>Si Google ya retiró el permiso, puede que no podamos borrar todas las copias. Cualquier limpieza pendiente aparecerá aquí.</p>
                  </>
                ) : (
                  <>
                    <p>Los eventos que no se pudieron retirar permanecerán en Google. Finalizaremos la desconexión y eliminaremos las credenciales locales.</p>
                    <p>Podrás borrar esas copias desde Google Calendar. Tus proyectos y tareas no cambiarán.</p>
                  </>
                )}
                <div className="pw-google-actions">
                  <button className="btn btn-secondary" disabled={busy} onClick={() => setDialog(null)}>
                    Cancelar
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => void change(dialogCurrent.kind === 'abandon' ? { action: 'abandon_cleanup' } : { action: 'disconnect', mode }, status)}
                  >
                    {dialogCurrent.kind === 'abandon'
                      ? 'Conservar y finalizar'
                      : mode === 'delete'
                        ? 'Eliminar copias y desconectar'
                        : 'Conservar y desconectar'}
                  </button>
                </div>
              </>
            )}
          </div>
        </Dialog>
      )}
    </section>
  );
}

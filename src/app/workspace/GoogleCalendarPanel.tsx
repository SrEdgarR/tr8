import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CircleCheck, ExternalLink, Link2, LoaderCircle, RefreshCw, ShieldCheck, TriangleAlert, Unplug } from 'lucide-react';
import type { GoogleCalendarApi, GoogleCalendarStatus, GoogleChangeInput, GoogleReason, GoogleState } from '../data/google-calendar';
import { DataError } from '../data/errors';
import { Dialog, ErrorNotice } from './ui';
import { errorMessage } from './helpers';
import { browserSecret, openGooglePopup, type GooglePopup } from './google-oauth';
import './google-calendar.css';

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
  oauth_expired: 'La autorización caducó. Vuelve a conectar Google Calendar.',
  oauth_exchange_failed: 'No se pudo confirmar la autorización con Google. Revisa el estado antes de volver a conectar.',
  scope_missing: 'No se concedió el permiso necesario para el calendario TR8. Vuelve a conectar para revisarlo.',
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

export default function GoogleCalendarPanel({ api }: { api: GoogleCalendarApi }) {
  const client = useQueryClient();
  const statusKey = [...api.scopeKey, 'status'];
  const scope = api.scopeKey.join(':');
  const active = useRef(true);
  const busyRef = useRef(false);
  const popup = useRef<GooglePopup | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [dialog, setDialog] = useState<{ kind: DialogKind; generation: number; version: number } | null>(null);
  const [mode, setMode] = useState<'keep' | 'delete'>('keep');
  const [calendarId, setCalendarId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const status = query.error ? null : query.data;
  const busy = operation !== null;
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
    if (!active.current || busyRef.current) return;
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
            ? 'Google Calendar está conectado.'
            : null,
      );
      void client.invalidateQueries({ queryKey: api.scopeKey });
    } catch (cause) {
      if (active.current && !request.signal.aborted) {
        setError(errorMessage(cause));
        if (cause instanceof DataError && ['STALE_VERSION', 'AUTH_REQUIRED', 'APP_ACCESS_DENIED'].includes(cause.code ?? '')) setDialog(null);
        void query.refetch();
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
  function connect(expected: GoogleCalendarStatus) {
    if (busyRef.current) return;
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
        const authorization = await api.begin({ request_id: crypto.randomUUID(), expected_version: expected.version, browser_secret: secret }, signal);
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
  const canDisconnect = status && status.state !== 'disconnected' && status.state !== 'disconnecting';
  return (
    <section className="pw-google" aria-label="Integración con Google Calendar">
      <header className="pw-google-heading">
        <span className="pw-calendar-zone-icon">
          <CalendarDays size={19} aria-hidden="true" />
        </span>
        <div>
          <h2>Google Calendar</h2>
          <p>Tu planificación de TR8, también en tu calendario.</p>
        </div>
        <span className={`pw-google-badge${status?.state === 'connected' ? ' is-connected' : ''}`}>
          {!status ? 'Por comprobar' : !status.configured ? 'Configuración pendiente' : stateLabels[status.state]}
        </span>
      </header>
      <p className="pw-google-personal">
        <ShieldCheck size={14} aria-hidden="true" />
        Conexión personal · Se aplica a tus tareas de todos los espacios.
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
          <div className="pw-google-details">
            <Link2 size={16} aria-hidden="true" />
            <p>
              TR8 → Google Calendar. Se copian tus tareas personales y las asignadas a ti en equipos, con fecha u horario y acceso vigente, a un calendario
              independiente llamado <strong>TR8</strong>.
            </p>
          </div>
          <p className="pw-google-caption">Google no modifica tus tareas en TR8. Al completar una tarea conservaremos su evento con la marca «Hecha».</p>
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
            {canConnect && (
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => showDialog('connect', status)}>
                <Link2 size={14} aria-hidden="true" />
                {status.state === 'needs_reauthorization' ? 'Volver a conectar' : 'Conectar Google Calendar'}
              </button>
            )}
            {status.configured && status.state === 'connected' && (
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void change({ action: 'reconcile' }, status)}>
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
          }}
        >
          <RefreshCw size={13} aria-hidden="true" />
          Actualizar conexión
        </button>
      </footer>
      {dialogCurrent && status && (
        <Dialog
          title={
            dialogCurrent.kind === 'connect'
              ? 'Conectar Google Calendar'
              : dialogCurrent.kind === 'recover'
                ? 'Recuperar calendario TR8'
                : dialogCurrent.kind === 'abandon'
                  ? 'Conservar las copias restantes'
                  : dialogCurrent.kind === 'rebuild'
                    ? 'Reconstruir eventos ausentes'
                    : 'Desconectar Google Calendar'
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
                <p>
                  Google pedirá permiso para crear el calendario secundario TR8 y gestionar sus eventos. Puedes usar una cuenta de Google distinta de la que
                  utilizas para entrar a TR8.
                </p>
                <p>
                  Solo enviaremos el título de la tarea, proyecto, fechas y enlace a TR8. No enviaremos descripciones completas, finanzas ni invitaciones a
                  otras personas.
                </p>
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

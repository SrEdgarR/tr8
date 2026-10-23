import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, CircleCheck, ListChecks, LoaderCircle, Pause, Play, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { DataError } from '../data/errors';
import type { GoogleTasksApi, GoogleTasksChangeInput, GoogleTasksState, GoogleTasksStatus } from '../data/google-tasks';
import { errorMessage } from './helpers';
import { Dialog, ErrorNotice } from './ui';
import './google-tasks.css';

const stateLabels: Record<GoogleTasksState, string> = {
  disconnected: 'Desconectado',
  connected: 'Conectado',
  paused: 'En pausa',
  needs_reauthorization: 'Necesita autorización',
  error: 'Necesita revisión',
};
const reasonLabels: Record<string, string> = {
  config_pending: 'Falta completar la configuración de Google Tasks.',
  scope_missing: 'Autoriza el permiso de Google Tasks para sincronizar tus listas.',
  reauthorization_required: 'Google retiró o venció la autorización. Vuelve a conectar tu cuenta.',
  authorization_expired: 'Google retiró o venció la autorización. Vuelve a conectar tu cuenta.',
  temporary_failure: 'Google no está disponible temporalmente. Los cambios pendientes siguen guardados.',
  budget_exhausted: 'Se alcanzó el presupuesto de sincronización. Los cambios esperarán a que se renueve la cuota.',
  list_missing: 'Una lista seleccionada ya no está disponible en Google. Revisa las listas que quieres sincronizar.',
};
type Conflict = GoogleTasksStatus['conflict_items'][number];
type Resolution = { item: Conflict; resolution: 'local' | 'google'; version: number };

function statusDate(value: string | null, fallback: string) {
  return value ? new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : fallback;
}

/** Remount local forms when identity changes, even if the parent omits a React key. */
export default function GoogleTasksPanel({ api, onConnect }: { api: GoogleTasksApi; onConnect: () => void }) {
  return <PersonalGoogleTasksPanel key={api.scopeKey.join(':')} api={api} onConnect={onConnect} />;
}

function PersonalGoogleTasksPanel({ api, onConnect }: { api: GoogleTasksApi; onConnect: () => void }) {
  const client = useQueryClient();
  const statusKey = [...api.scopeKey, 'status'];
  const active = useRef(true);
  const busyRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const pendingSince = useRef<number | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const query = useQuery({
    queryKey: statusKey,
    queryFn: ({ signal }) => api.load(signal),
    retry: false,
    refetchInterval: current => {
      const status = current.state.data;
      if (current.state.error || !status?.enabled || status.state !== 'connected' || status.pending === 0 || status.failed > 0) {
        pendingSince.current = null;
        return 30000;
      }
      pendingSince.current ??= Date.now();
      // Pending work may be blocked by quotas; fast polling must not continue indefinitely.
      return Date.now() - pendingSince.current < 60000 ? 3000 : 30000;
    },
    refetchIntervalInBackground: false,
  });
  const status = query.error ? null : query.data;
  const busy = operation !== null;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);

  async function change(input: GoogleTasksChangeInput, expected: GoogleTasksStatus) {
    if (!active.current || busyRef.current) return;
    const latest = client.getQueryData<GoogleTasksStatus>(statusKey);
    if (!latest || latest.version !== expected.version) {
      setResolution(null);
      setError('La conexión cambió. Revisa su estado antes de continuar.');
      return;
    }
    busyRef.current = true;
    setOperation(input.action);
    setError(null);
    setNotice(null);
    const request = new AbortController();
    controller.current = request;
    try {
      await client.cancelQueries({ queryKey: statusKey, exact: true });
      if (!active.current || request.signal.aborted) return;
      const result = await api.change({ ...input, request_id: crypto.randomUUID(), expected_version: expected.version }, request.signal);
      if (!active.current || request.signal.aborted) return;
      const live = client.getQueryData<GoogleTasksStatus>(statusKey);
      if (live && live.version > result.version) return;
      client.setQueryData(statusKey, result);
      setResolution(null);
      setNotice(
        input.action === 'tasks_pause'
          ? 'Sincronización en pausa. Conservamos las tareas en ambas aplicaciones.'
          : input.action === 'tasks_select_list'
            ? 'Selección guardada. Los próximos cambios solo se sincronizarán en las listas activas.'
            : input.action === 'tasks_resolve'
              ? 'Elección guardada. El cambio pendiente se procesará en segundo plano.'
              : 'Revisión solicitada. Los cambios pendientes se procesarán en segundo plano.',
      );
      void client.invalidateQueries({ queryKey: api.scopeKey });
    } catch (cause) {
      if (active.current && !request.signal.aborted) {
        setError(errorMessage(cause));
        if (cause instanceof DataError && ['STALE_VERSION', 'AUTH_REQUIRED', 'APP_ACCESS_DENIED'].includes(cause.code ?? '')) setResolution(null);
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

  const canConfigure = Boolean(status?.configured && status.enabled && ['connected', 'paused'].includes(status.state));
  const currentResolution =
    resolution && status && resolution.version === status.version && status.conflict_items.some(item => item.id === resolution.item.id) ? resolution : null;
  return (
    <section className="pw-google-tasks" aria-label="Integración con Google Tasks">
      <header className="pw-google-tasks-heading">
        <span className="pw-calendar-zone-icon">
          <ListChecks size={19} aria-hidden="true" />
        </span>
        <div>
          <h2>Google Tasks</h2>
          <p>Tus tareas del teléfono, también en TR8.</p>
        </div>
        <span className={`pw-google-tasks-badge${status?.state === 'connected' ? ' is-connected' : ''}`}>
          {!status ? 'Por comprobar' : !status.configured ? 'Configuración pendiente' : !status.enabled ? 'Sin activar' : stateLabels[status.state]}
        </span>
      </header>
      <p className="pw-google-tasks-personal">
        <ShieldCheck size={14} aria-hidden="true" />
        Conexión personal · Tus listas permanecen en tu espacio personal.
      </p>
      <div className="pw-google-tasks-details">
        <ArrowLeftRight size={17} aria-hidden="true" />
        <p>
          Google Tasks ↔ TR8. Las tareas de las listas elegidas se importan al proyecto personal <strong>Google Tasks</strong>. Se sincronizan el título, la
          fecha y el estado de completado.
        </p>
      </div>
      <p className="pw-google-tasks-caption">
        Google solicita acceso a todas tus tareas; TR8 solo sincroniza las listas que actives. Las tareas creadas desde Google Calendar en el teléfono
        pertenecen a Google Tasks.
      </p>
      <p className="pw-google-tasks-caption">
        La fecha de Google se guarda como fecha de inicio, sin hora. No crearemos eventos duplicados en el calendario TR8 de Google para estas tareas.
      </p>
      {query.error ? (
        <ErrorNotice>
          {errorMessage(query.error)}{' '}
          <button className="btn btn-secondary btn-sm" onClick={() => void query.refetch()}>
            Reintentar Google Tasks
          </button>
        </ErrorNotice>
      ) : !status ? (
        <p role="status">Consultando tus listas de Google Tasks…</p>
      ) : (
        <>
          {status.reason && (
            <p className="pw-google-tasks-reason" role="status">
              <TriangleAlert size={15} aria-hidden="true" />
              {reasonLabels[status.reason] ?? 'La sincronización necesita revisión. Actualiza el estado antes de continuar.'}
            </p>
          )}
          {status.enabled && (
            <div className="pw-google-tasks-stats">
              <div>
                <span>Última sincronización</span>
                <strong>{statusDate(status.last_sync_at, 'Aún no hay una sincronización confirmada')}</strong>
              </div>
              <div>
                <strong>{status.pending}</strong>
                <span>Pendientes</span>
              </div>
              <div>
                <strong>{status.failed}</strong>
                <span>Por revisar</span>
              </div>
              <div>
                <strong>{status.conflicts}</strong>
                <span>Conflictos</span>
              </div>
            </div>
          )}
          {status.enabled && (
            <p className="pw-google-tasks-caption">
              Próxima revisión: {status.state === 'paused' ? 'en pausa' : statusDate(status.next_sync_at, 'se programará cuando haya cambios')}.
            </p>
          )}
          {status.enabled && (
            <fieldset className="pw-google-tasks-lists" disabled={busy || !canConfigure}>
              <legend>Listas que quieres sincronizar</legend>
              {status.lists.length === 0 ? (
                <p>No hay listas disponibles todavía. Solicita una revisión para consultar tus listas.</p>
              ) : (
                status.lists.map(list => (
                  <label key={list.id}>
                    <input
                      type="checkbox"
                      checked={list.selected}
                      onChange={event => void change({ action: 'tasks_select_list', list_id: list.id, selected: event.currentTarget.checked }, status)}
                    />
                    <span>
                      <strong>{list.title || 'Lista sin título'}</strong>
                      <small>{list.selected ? 'Sincronización activa' : 'Sin sincronizar'}</small>
                    </span>
                  </label>
                ))
              )}
              <p>Desactivar una lista detiene sus próximos cambios y conserva las tareas existentes.</p>
            </fieldset>
          )}
          {status.conflict_items.length > 0 && (
            <div className="pw-google-tasks-conflicts">
              <h3>Cambios que necesitan tu elección</h3>
              <p>La tarea cambió en ambas aplicaciones. Revisa qué versión conservar antes de reemplazar sus datos.</p>
              {status.conflict_items.map(item => (
                <article key={item.id}>
                  <strong>{item.title || 'Tarea sin título'}</strong>
                  <dl>
                    <div>
                      <dt>TR8</dt>
                      <dd>{item.title || 'Sin título'}</dd>
                    </div>
                    <div>
                      <dt>Google</dt>
                      <dd>{item.google_title ?? 'Tarea eliminada en Google'}</dd>
                    </div>
                  </dl>
                  <div className="pw-google-tasks-actions">
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={busy || !canConfigure}
                      onClick={() => setResolution({ item, resolution: 'local', version: status.version })}
                    >
                      Elegir TR8
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={busy || !canConfigure}
                      onClick={() => setResolution({ item, resolution: 'google', version: status.version })}
                    >
                      Elegir Google
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
          <div className="pw-google-tasks-actions">
            {status.configured && (!status.enabled || ['disconnected', 'needs_reauthorization', 'error'].includes(status.state)) && (
              <button className="btn btn-primary" disabled={busy} onClick={onConnect}>
                <ListChecks size={14} aria-hidden="true" />
                {status.enabled ? 'Volver a autorizar Google Tasks' : 'Conectar Google Tasks'}
              </button>
            )}
            {canConfigure && (
              <>
                {status.state === 'connected' && (
                  <button className="btn btn-secondary" disabled={busy} onClick={() => void change({ action: 'tasks_reconcile' }, status)}>
                    <RefreshCw size={14} aria-hidden="true" />
                    Sincronizar tareas ahora
                  </button>
                )}
                <button
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={() => void change({ action: status.state === 'paused' ? 'tasks_resume' : 'tasks_pause' }, status)}
                >
                  {status.state === 'paused' ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
                  {status.state === 'paused' ? 'Reanudar tareas' : 'Pausar tareas'}
                </button>
              </>
            )}
            <button className="btn btn-ghost btn-sm" disabled={busy || query.isFetching} onClick={() => void query.refetch()}>
              Actualizar estado de tareas
            </button>
          </div>
        </>
      )}
      {busy && (
        <p className="pw-google-tasks-wait" role="status">
          <LoaderCircle className="pw-spin" size={14} aria-hidden="true" />
          Guardando tu elección…
        </p>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {notice && (
        <p className="pw-google-tasks-notice" role="status">
          <CircleCheck size={14} aria-hidden="true" />
          {notice}
        </p>
      )}
      <footer>Pausar Google Tasks no revoca el permiso de Google ni modifica la conexión con Google Calendar.</footer>
      {currentResolution && status && (
        <Dialog title="Revisar versión de la tarea" onClose={() => setResolution(null)} busy={busy}>
          <div className="pw-google-tasks-dialog">
            <p>
              Vas a conservar la versión de <strong>{currentResolution.resolution === 'local' ? 'TR8' : 'Google Tasks'}</strong> para «
              {currentResolution.item.title || 'Tarea sin título'}».
            </p>
            <dl>
              <div>
                <dt>TR8</dt>
                <dd>{currentResolution.item.title || 'Sin título'}</dd>
              </div>
              <div>
                <dt>Google</dt>
                <dd>{currentResolution.item.google_title ?? 'Tarea eliminada en Google'}</dd>
              </div>
            </dl>
            <p>
              Esta elección puede reemplazar el título, la fecha y el estado de la otra versión.{' '}
              {currentResolution.resolution === 'google' && currentResolution.item.google_title === null
                ? 'Elegir la eliminación de Google puede retirar la tarea vinculada de TR8.'
                : 'Los cambios de la otra versión se descartarán.'}
            </p>
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <div className="pw-google-tasks-actions">
              <button className="btn btn-secondary" disabled={busy} data-initial-focus onClick={() => setResolution(null)}>
                Cancelar
              </button>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void change({ action: 'tasks_resolve', link_id: currentResolution.item.id, resolution: currentResolution.resolution }, status)}
              >
                Conservar versión de {currentResolution.resolution === 'local' ? 'TR8' : 'Google'}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Activity, Check, CheckCheck, CircleHelp, Clock3, Inbox, Mail, Pause, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ProcessesApi, ProcessJob, ProcessState } from '../data/processes';
import { errorMessage } from './helpers';
import { ErrorNotice } from './ui';
import './processes.css';

const labels: Record<ProcessState, string> = {
  pending: 'En cola',
  leased: 'En curso',
  retry: 'Reintentando',
  succeeded: 'Preparado',
  cancelled: 'Cancelado',
  unknown: 'Por comprobar',
  dead: 'Necesita revisión',
};
const actions: Record<string, string> = {
  'task.created': 'Nueva tarea',
  'task.changed': 'Cambio de tarea',
  'task.deleted': 'Tarea eliminada',
  'project.created': 'Nuevo proyecto',
  'project.changed': 'Cambio de proyecto',
  'project.deleted': 'Proyecto eliminado',
  'authorization.changed': 'Cambio de permisos',
};
const reasons: Record<string, string> = {
  superseded: 'Sustituido por un cambio más reciente',
  resource_removed: 'El recurso ya no está disponible',
  access_changed: 'El acceso cambió',
  lease_expired: 'Retomado tras una interrupción',
  temporary_failure: 'Esperando para volver a intentar',
  permanent_failure: 'No se pudo completar',
  outcome_unknown: 'El resultado necesita comprobarse',
  attempt_limit: 'Se alcanzó el límite de reintentos',
  cancelled: 'El proceso se canceló',
};
function statusIcon(state: ProcessState) {
  if (state === 'succeeded') return <Check size={13} aria-hidden="true" />;
  if (state === 'dead' || state === 'unknown') return <TriangleAlert size={13} aria-hidden="true" />;
  if (state === 'cancelled') return <Pause size={13} aria-hidden="true" />;
  return <Clock3 size={13} aria-hidden="true" />;
}
function JobRow({ job }: { job: ProcessJob }) {
  return (
    <li className="pw-process-job">
      <span className="pw-process-job-icon">
        <Activity size={15} aria-hidden="true" />
      </span>
      <div>
        <strong>{actions[job.event_kind]}</strong>
        <span>{job.reason && job.reason !== 'reconciled' ? reasons[job.reason] : 'Preparación interna del cambio'}</span>
      </div>
      <span className={`pw-process-state ${job.state}`}>
        {statusIcon(job.state)}
        {labels[job.state]}
      </span>
    </li>
  );
}

export default function ProcessesPanel({
  api,
  disabled = false,
  workspaceName,
  embedded = false,
}: {
  api: ProcessesApi;
  disabled?: boolean;
  workspaceName: string;
  embedded?: boolean;
}) {
  const query = useQuery({ queryKey: api.scopeKey, queryFn: ({ signal }) => api.load(signal), enabled: !disabled, retry: false, refetchInterval: 30000 });
  const status = disabled || query.error ? null : query.data;
  return (
    <section className="pw-processes" aria-label="Procesos e integraciones">
      {embedded ? (
        <p className="pw-processes-context">
          <span>Tus cambios se preparan aunque cierres TR8.</span>
          <span className="pw-processes-scope">{workspaceName}</span>
        </p>
      ) : (
        <header className="pw-processes-heading">
          <span className="pw-calendar-zone-icon">
            <Activity size={18} aria-hidden="true" />
          </span>
          <div>
            <h2>Procesos e integraciones</h2>
            <p>Tus cambios se preparan en segundo plano, aunque cierres TR8.</p>
          </div>
          <span className="pw-processes-scope">{workspaceName}</span>
        </header>
      )}
      <div className="pw-processes-channels">
        <div>
          <Mail size={16} aria-hidden="true" />
          <span>Correo opcional</span>
          <span className="pw-processes-off">Desactivado</span>
        </div>
      </div>
      <p className="pw-processes-explanation">
        <ShieldCheck size={14} aria-hidden="true" />
        Este panel confirma la preparación interna de tus cambios. El estado de Google Calendar se consulta en su propia sección.
      </p>
      {disabled ? (
        <p>No se pudo comprobar el acceso a este espacio.</p>
      ) : query.error ? (
        <ErrorNotice>
          {errorMessage(query.error)}{' '}
          <button className="btn btn-secondary btn-sm" onClick={() => void query.refetch()}>
            Reintentar procesos
          </button>
        </ErrorNotice>
      ) : !status ? (
        <p role="status">Cargando el estado de los procesos…</p>
      ) : (
        <>
          <div className="pw-process-stats">
            <div>
              <Inbox size={15} aria-hidden="true" />
              <strong>{status.counts.pending + status.counts.retry}</strong>
              <span>En cola</span>
            </div>
            <div>
              <Clock3 size={15} aria-hidden="true" />
              <strong>{status.counts.leased}</strong>
              <span>En curso</span>
            </div>
            <div>
              <CheckCheck size={15} aria-hidden="true" />
              <strong>{status.counts.succeeded}</strong>
              <span>Preparados</span>
            </div>
            <div>
              <CircleHelp size={15} aria-hidden="true" />
              <strong>{status.counts.unknown + status.counts.dead}</strong>
              <span>Por revisar</span>
            </div>
          </div>
          <div className="pw-process-runtime">
            <span className={status.scheduler.enabled ? 'active' : ''}>
              <Activity size={13} aria-hidden="true" />
              {status.scheduler.enabled ? 'Procesamiento automático activo' : 'Procesamiento automático pendiente'}
            </span>
            <span>
              {status.budget.used_today} intentos tuyos hoy · límite compartido de {status.budget.daily_limit}/día
            </span>
          </div>
          {status.budget.blocked && (
            <p className="pw-process-budget" role="status">
              Se alcanzó el presupuesto de procesamiento. Los trabajos siguen guardados y se retomarán cuando se renueve la cuota. Tus proyectos y tareas se
              pueden seguir guardando.
            </p>
          )}
          {status.jobs.length ? (
            <ul className="pw-process-jobs" aria-label="Tus procesos recientes">
              {status.jobs.map(job => (
                <JobRow key={job.id} job={job} />
              ))}
            </ul>
          ) : (
            <div className="pw-process-empty">
              <CheckCheck size={18} aria-hidden="true" />
              <span>Sin procesos recientes que mostrar.</span>
              <p>Los nuevos cambios de este espacio aparecerán aquí. No se generan trabajos a partir de tus datos antiguos.</p>
            </div>
          )}
          <p className="pw-process-footnote">
            Se muestran hasta 20 procesos propios con acceso vigente. «Preparado» confirma el trabajo interno, no una entrega externa.
          </p>
        </>
      )}
      <footer>
        <span>Los correos opcionales siguen desactivados.</span>
        <button className="btn btn-ghost btn-sm" disabled={disabled || query.isFetching} onClick={() => void query.refetch()}>
          <RefreshCw size={13} aria-hidden="true" className={query.isFetching ? 'pw-spin' : ''} />
          Actualizar procesos
        </button>
      </footer>
    </section>
  );
}

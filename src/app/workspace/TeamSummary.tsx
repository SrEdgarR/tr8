import { ArrowRight, ChartNoAxesCombined, CheckCheck, FolderKanban, ListTodo, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PROJECT_STATUSES, STATUSES } from '../constants';
import type { WorkspaceProps } from '../types';
import { buildDashboardModel } from './dashboard-model';
import { localDate } from './helpers';
import { IdentityAvatar, ProjectStatusDot } from './project-identity';
import { ProjectIcon } from './ui';
import './summary-panels.css';

export default function TeamSummary({ data }: { data: WorkspaceProps }) {
  const model = buildDashboardModel(data, localDate());
  if (data.workspace?.kind !== 'team' || data.accessUnavailable) return null;
  const scope = new URLSearchParams({ workspace: data.workspace.id });
  const maxWorkload = Math.max(1, ...model.workloads.map(item => item.tasks.length));
  const directoryLabel = model.directoryState === 'loading' ? 'Cargando…' : model.directoryState === 'error' ? 'No disponible' : 'Sin acceso';
  return (
    <section className="pw-team-summary" aria-labelledby="team-summary-title">
      <div className="pw-summary-section-head">
        <div>
          <h2 id="team-summary-title">Resumen del equipo</h2>
          <p>Solo los proyectos y las tareas a los que tienes acceso.</p>
        </div>
        <Link to={`/overview?${scope}`} className="pw-summary-link">
          Vista general
          <ArrowRight size={13} aria-hidden="true" />
        </Link>
      </div>
      <div className="pw-summary-metrics">
        <div>
          <span>
            <FolderKanban size={14} aria-hidden="true" />
            Proyectos visibles
          </span>
          <strong className="num">{model.totals.projects}</strong>
        </div>
        <div>
          <span>
            <ListTodo size={14} aria-hidden="true" />
            Tareas abiertas visibles
          </span>
          <strong className="num">{model.totals.open}</strong>
          {model.taskCoveragePartial && <small>Cobertura parcial por permisos</small>}
        </div>
        <div>
          <span>
            <CheckCheck size={14} aria-hidden="true" />
            Tareas completadas
          </span>
          <strong className="num">{model.totals.progress}%</strong>
          <small>
            {model.totals.done} de {model.totals.tasks} visibles
          </small>
        </div>
        <div>
          <span>
            <Users size={14} aria-hidden="true" />
            Miembros activos
          </span>
          <strong className={model.directoryAvailable ? 'num' : 'pw-summary-unavailable'}>
            {model.directoryAvailable ? model.members.length : directoryLabel}
          </strong>
        </div>
      </div>
      <div className="pw-summary-grid">
        <section className="pw-summary-panel" aria-labelledby="team-summary-projects">
          <div className="pw-summary-panel-head">
            <h3 id="team-summary-projects">
              <FolderKanban size={15} aria-hidden="true" />
              Proyectos del equipo
            </h3>
            <Link to={`/projects?${scope}`} className="pw-summary-link">
              Ver todos
              <ArrowRight size={13} aria-hidden="true" />
            </Link>
          </div>
          {model.projectSummaries.length ? (
            <ul className="pw-summary-project-list">
              {model.projectSummaries.map(summary => (
                <li key={summary.project.id}>
                  <Link to={`/projects/${summary.project.id}?${scope}&view=overview`}>
                    <ProjectIcon color={summary.project.color} icon={summary.project.icon} />
                    <span className="pw-summary-project-name">
                      <strong>{summary.project.name}</strong>
                      <small>
                        <ProjectStatusDot status={summary.project.status} />
                        {PROJECT_STATUSES.find(status => status.id === summary.project.status)?.name}
                      </small>
                    </span>
                    {summary.taskReadable ? (
                      <span className="pw-summary-project-progress">
                        <span className="pw-summary-progress-track">
                          <span style={{ width: `${summary.progress}%`, background: summary.project.color }} />
                        </span>
                        <span className="num">{summary.progress}%</span>
                      </span>
                    ) : (
                      <span className="faint">Tareas sin acceso</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pw-summary-notice">Todavía no hay proyectos activos visibles en este equipo.</p>
          )}
        </section>
        <section className="pw-summary-panel" aria-labelledby="team-summary-workloads">
          <div className="pw-summary-panel-head">
            <h3 id="team-summary-workloads">
              <ChartNoAxesCombined size={15} aria-hidden="true" />
              Carga de trabajo
            </h3>
            <span className="faint">Tareas abiertas visibles</span>
          </div>
          {model.directoryAvailable ? (
            <>
              {model.workloads.length ? (
                <ul className="pw-summary-workloads">
                  {model.workloads.map(({ member, tasks }) => (
                    <li key={member.id}>
                      <IdentityAvatar name={member.display_name} decorative small />
                      <span className="pw-summary-member-name">{member.display_name}</span>
                      <span className="pw-summary-load-track">
                        <span style={{ width: `${(tasks.length / maxWorkload) * 100}%` }}>
                          {STATUSES.filter(status => status.id !== 'done').map(status => (
                            <i key={status.id} style={{ flex: tasks.filter(task => task.status === status.id).length, background: status.color }} />
                          ))}
                        </span>
                      </span>
                      <strong className="num">{tasks.length}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pw-summary-notice">No hay miembros activos disponibles para mostrar.</p>
              )}
              {model.unavailableAssignees.length > 0 && (
                <p className="pw-summary-workload-total">
                  <span>Responsable no disponible</span>
                  <strong className="num">{model.unavailableAssignees.length}</strong>
                </p>
              )}
            </>
          ) : (
            <p className="pw-summary-notice">
              {model.directoryState === 'loading'
                ? 'Cargando el directorio del equipo…'
                : model.directoryState === 'error'
                  ? 'No se pudo cargar el directorio del equipo.'
                  : 'El directorio del equipo no está disponible con tu acceso actual.'}
            </p>
          )}
          {model.unassigned.length > 0 && (
            <p className="pw-summary-workload-total">
              <span>Sin responsable</span>
              <strong className="num">{model.unassigned.length}</strong>
            </p>
          )}
          <p className="pw-summary-caption">La carga muestra asignaciones visibles, sin incluir proyectos privados a los que no tienes acceso.</p>
        </section>
      </div>
    </section>
  );
}

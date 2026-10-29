import { ArrowRight, CalendarDays, ChartNoAxesCombined, CircleCheck, Clock3, FileText, ListTodo, LockKeyhole, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PRIORITIES, PROJECT_STATUSES, STATUSES, formatDate } from '../constants';
import type { Project, Task, WorkspaceProps } from '../types';
import { ActivityPanel } from './Collaboration';
import { buildDashboardModel, summarizeProject } from './dashboard-model';
import { localDate } from './helpers';
import { canInProject } from './permissions';
import { IdentityAvatar, PriorityIcon, ProjectStatusDot, TaskStatusIcon } from './project-identity';
import { EmptyState } from './ui';
import './summary-panels.css';

function timestamp(value: string) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date(value));
}

export default function ProjectSummary({ project, data, onOpen }: { project: Project; data: WorkspaceProps; onOpen: (task: Task) => void }) {
  const today = localDate();
  const model = buildDashboardModel(data, today);
  const authorized =
    !data.accessUnavailable &&
    (!data.workspace || project.workspace_id === data.workspace.id) &&
    data.projects.some(item => item.id === project.id) &&
    (!data.capabilities || Boolean(data.capabilities[project.id]?.permissions.includes('project.read')));
  if (!authorized) return <EmptyState title="Resumen no disponible">Este proyecto no está disponible en el espacio actual.</EmptyState>;
  const taskReadable = !data.capabilities || Boolean(data.capabilities[project.id]?.permissions.includes('task.read'));
  const summary = summarizeProject(
    project,
    data.tasks.filter(task => task.project_id === project.id && task.workspace_id === project.workspace_id),
    taskReadable,
    today,
  );
  const upcoming = summary.tasks
    .filter(task => task.status !== 'done' && task.due_date)
    .sort((left, right) => left.due_date!.localeCompare(right.due_date!) || left.id.localeCompare(right.id))
    .slice(0, 6);
  const assigned = summary.tasks.filter(task => task.status !== 'done' && task.assignee_member_id);
  const members = model.members
    .map(member => ({ member, count: assigned.filter(task => task.assignee_member_id === member.id).length }))
    .filter(item => item.count > 0)
    .sort((left, right) => right.count - left.count || left.member.display_name.localeCompare(right.member.display_name, 'es'));
  const unassigned = summary.tasks.filter(task => task.status !== 'done' && !task.assignee_member_id).length;
  const unavailableAssignees = assigned.filter(task => !model.memberMap.has(task.assignee_member_id!)).length;
  const listHref = `/projects/${project.id}?${new URLSearchParams({ workspace: project.workspace_id, view: 'list' })}`;
  const activityHref = `/projects/${project.id}?${new URLSearchParams({ workspace: project.workspace_id, view: 'activity' })}`;
  const lead = project.lead_member_id ? model.memberMap.get(project.lead_member_id) : undefined;
  return (
    <div className="pw-project-summary pw-summary-grid" aria-label={`Resumen de ${project.name}`}>
      <div className="pw-summary-stack">
        <section className="pw-summary-panel" aria-labelledby={`project-about-${project.id}`}>
          <div className="pw-summary-panel-head">
            <h2 id={`project-about-${project.id}`}>
              <FileText size={15} aria-hidden="true" /> Acerca del proyecto
            </h2>
          </div>
          <p className="pw-summary-description">{project.description || 'Este proyecto aún no tiene una descripción.'}</p>
        </section>
        <section className="pw-summary-panel" aria-labelledby={`project-progress-${project.id}`}>
          <div className="pw-summary-panel-head">
            <h2 id={`project-progress-${project.id}`}>
              <ChartNoAxesCombined size={15} aria-hidden="true" /> Progreso
            </h2>
            {taskReadable && (
              <span className="faint">
                {summary.done} de {summary.total} completadas
              </span>
            )}
          </div>
          {taskReadable ? (
            <div className="pw-summary-panel-body">
              <div className="pw-summary-progress-heading">
                <strong className="num">{summary.progress}%</strong>
                <span className="muted">de tareas completadas</span>
                {summary.overdue > 0 && (
                  <span className="pw-summary-alert">
                    <Clock3 size={12} aria-hidden="true" />
                    {summary.overdue} vencidas
                  </span>
                )}
              </div>
              <div className="pw-summary-stackbar" role="img" aria-label={`${summary.done} de ${summary.total} tareas completadas`}>
                {STATUSES.map(status => (
                  <span
                    key={status.id}
                    title={`${status.name}: ${summary.tasks.filter(task => task.status === status.id).length}`}
                    style={{
                      width: `${summary.total ? (summary.tasks.filter(task => task.status === status.id).length / summary.total) * 100 : 0}%`,
                      background: status.color,
                    }}
                  />
                ))}
              </div>
              <dl className="pw-summary-status-list">
                {STATUSES.map(status => (
                  <div key={status.id}>
                    <dt>
                      <TaskStatusIcon status={status.id} />
                      {status.name}
                    </dt>
                    <dd className="num">{summary.tasks.filter(task => task.status === status.id).length}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : (
            <p className="pw-summary-notice">
              <LockKeyhole size={16} aria-hidden="true" />
              No tienes acceso a las tareas de este proyecto.
            </p>
          )}
        </section>
        {taskReadable && (
          <section className="pw-summary-panel" aria-labelledby={`project-upcoming-${project.id}`}>
            <div className="pw-summary-panel-head">
              <h2 id={`project-upcoming-${project.id}`}>
                <CalendarDays size={15} aria-hidden="true" /> Pendientes con fecha
              </h2>
              <Link to={listHref} className="pw-summary-link">
                Ver lista
                <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </div>
            {upcoming.length ? (
              <ul className="pw-summary-task-list">
                {upcoming.map(task => (
                  <li key={task.id}>
                    <button type="button" onClick={() => onOpen(task)} className="pw-summary-task" aria-label={`Abrir tarea ${task.title}`}>
                      <TaskStatusIcon status={task.status} />
                      <span className="pw-summary-task-name">{task.title}</span>
                      <span title={PRIORITIES.find(priority => priority.id === task.priority)?.name}>
                        <PriorityIcon priority={task.priority} />
                      </span>
                      <time dateTime={task.due_date!} className={task.due_date! < today ? 'overdue' : 'muted'}>
                        {formatDate(task.due_date)}
                      </time>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pw-summary-notice">
                <CircleCheck size={17} aria-hidden="true" />
                No hay tareas pendientes con fecha de vencimiento.
              </p>
            )}
          </section>
        )}
      </div>
      <div className="pw-summary-stack">
        <section className="pw-summary-panel" aria-labelledby={`project-details-${project.id}`}>
          <div className="pw-summary-panel-head">
            <h2 id={`project-details-${project.id}`}>
              <ListTodo size={15} aria-hidden="true" /> Detalles
            </h2>
          </div>
          <dl className="pw-summary-details">
            <div>
              <dt>Estado</dt>
              <dd>
                <ProjectStatusDot status={project.status} />
                {PROJECT_STATUSES.find(status => status.id === project.status)?.name}
              </dd>
            </div>
            <div>
              <dt>Espacio</dt>
              <dd>{data.workspace?.kind === 'personal' ? 'Mi espacio personal' : (data.workspace?.name ?? 'Espacio actual')}</dd>
            </div>
            {project.start_date && (
              <div>
                <dt>Inicio del proyecto</dt>
                <dd>
                  <time dateTime={project.start_date}>{formatDate(project.start_date)}</time>
                </dd>
              </div>
            )}
            {project.due_date && (
              <div>
                <dt>Fecha objetivo</dt>
                <dd>
                  <time dateTime={project.due_date}>{formatDate(project.due_date)}</time>
                </dd>
              </div>
            )}
            {project.lead_member_id !== undefined && (
              <div>
                <dt>Responsable del proyecto</dt>
                <dd>
                  {lead ? (
                    <>
                      <IdentityAvatar name={lead.display_name} small decorative />
                      {lead.display_name}
                    </>
                  ) : !project.lead_member_id ? (
                    'Sin responsable'
                  ) : data.workspace?.kind === 'personal' && project.owner_id === data.currentUserId ? (
                    'Tu cuenta'
                  ) : (
                    'Responsable no disponible'
                  )}
                </dd>
              </div>
            )}
            <div>
              <dt>Creado</dt>
              <dd>
                <time dateTime={project.created_at}>{timestamp(project.created_at)}</time>
              </dd>
            </div>
            <div>
              <dt>Actualizado</dt>
              <dd>
                <time dateTime={project.updated_at}>{timestamp(project.updated_at)}</time>
              </dd>
            </div>
            {summary.nextDue && (
              <div>
                <dt>Próxima tarea con vencimiento</dt>
                <dd>
                  <time dateTime={summary.nextDue}>{formatDate(summary.nextDue)}</time>
                </dd>
              </div>
            )}
            {project.archived_at && (
              <div>
                <dt>Archivo</dt>
                <dd>Proyecto archivado · solo lectura</dd>
              </div>
            )}
          </dl>
        </section>
        {taskReadable && (
          <section className="pw-summary-panel" aria-labelledby={`project-workload-${project.id}`}>
            <div className="pw-summary-panel-head">
              <h2 id={`project-workload-${project.id}`}>
                <Users size={15} aria-hidden="true" /> Tareas abiertas por responsable
              </h2>
            </div>
            {!model.directoryAvailable && data.workspace?.kind === 'team' ? (
              <p className="pw-summary-notice">
                {model.directoryState === 'loading'
                  ? 'Cargando el directorio del equipo…'
                  : model.directoryState === 'error'
                    ? 'No se pudo cargar el directorio del equipo.'
                    : 'El directorio del equipo no está disponible con tu acceso actual.'}
              </p>
            ) : (
              <ul className="pw-summary-workloads">
                {members.map(({ member, count }) => (
                  <li key={member.id}>
                    <IdentityAvatar name={member.display_name} small decorative />
                    <span>{member.display_name}</span>
                    <strong className="num">{count}</strong>
                  </li>
                ))}
              </ul>
            )}
            {unassigned > 0 && (
              <p className="pw-summary-workload-total">
                <span>Sin responsable</span>
                <strong className="num">{unassigned}</strong>
              </p>
            )}
            {(model.directoryAvailable || data.workspace?.kind !== 'team') && unavailableAssignees > 0 && (
              <p className="pw-summary-workload-total">
                <span>Responsable no disponible</span>
                <strong className="num">{unavailableAssignees}</strong>
              </p>
            )}
            {!summary.open && <p className="pw-summary-notice">No hay tareas abiertas.</p>}
            <p className="pw-summary-caption">La asignación de tareas no representa la lista de miembros del proyecto.</p>
          </section>
        )}
        {data.collaboration && canInProject(data, project.id, 'audit.read') && (
          <section className="pw-summary-panel pw-summary-activity" aria-label="Actividad reciente del proyecto">
            <ActivityPanel api={data.collaboration} projectId={project.id} compact title="Actividad reciente" currentUserId={data.currentUserId} />
            <Link to={activityHref} className="pw-summary-link pw-summary-footer-link">
              Ver toda la actividad
              <ArrowRight size={13} aria-hidden="true" />
            </Link>
          </section>
        )}
      </div>
    </div>
  );
}

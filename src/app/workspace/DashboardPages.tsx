import { useState, type ReactNode } from 'react';
import { ArrowRight, CalendarDays, Check, CircleCheck, CircleDashed, ClockAlert, FolderKanban, Plus, TrendingUp, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatDate, PROJECT_STATUSES, STATUSES } from '../constants';
import type { Task, TaskStatus, WorkspaceProps } from '../types';
import { ActivityPanel } from './Collaboration';
import { buildDashboardModel, shiftDashboardDate } from './dashboard-model';
import { localDate } from './helpers';
import { canInProject, canInWorkspace } from './permissions';
import { IdentityAvatar, PriorityIcon, ProjectStatusDot, TaskStatusIcon } from './project-identity';
import { ProjectIcon } from './ui';
import './dashboard-pages.css';

type Model = ReturnType<typeof buildDashboardModel>;
type ProjectSummary = Model['projectSummaries'][number];
interface DashboardProps {
  data: WorkspaceProps;
  onNewProject: () => void;
  onNewTask: () => void;
  onOpen: (task: Task) => void;
  onMove: (task: Task, status: TaskStatus) => Promise<void>;
}

function scoped(data: WorkspaceProps, path: string, values: Record<string, string> = {}) {
  const params = new URLSearchParams();
  if (data.workspace) params.set('workspace', data.workspace.id);
  for (const [key, value] of Object.entries(values)) params.set(key, value);
  return `${path}${params.size ? `?${params}` : ''}`;
}

function byDue(left: Task, right: Task) {
  return (left.due_date ?? '9999').localeCompare(right.due_date ?? '9999') || left.position - right.position || left.id.localeCompare(right.id);
}

function ScopeNote({ partial = false }: { partial?: boolean }) {
  return (
    <p className="dp-scope-note">
      {partial
        ? 'Algunos proyectos no permiten consultar sus tareas. Los totales incluyen únicamente las tareas visibles.'
        : 'Solo se incluyen los proyectos y las tareas que puedes consultar en este espacio.'}
    </p>
  );
}

function Stat({
  title,
  value,
  detail,
  icon,
  href,
  tone,
}: {
  title: string;
  value: string | number;
  detail: string;
  icon: ReactNode;
  href?: string;
  tone?: string;
}) {
  const body = (
    <>
      <span className="k">
        {icon}
        {title}
      </span>
      <strong className={`v${tone ? ` ${tone}` : ''}`}>{value}</strong>
      <span className="d">{detail}</span>
    </>
  );
  return href ? (
    <Link className="stat dp-stat" to={href}>
      {body}
    </Link>
  ) : (
    <div className="stat dp-stat">{body}</div>
  );
}

function DashboardActions({ data, onNewProject, onNewTask }: Pick<DashboardProps, 'data' | 'onNewProject' | 'onNewTask'>) {
  const canCreateTask =
    !data.accessUnavailable &&
    !data.readOnly &&
    data.projects.some(
      project => (!data.workspace || project.workspace_id === data.workspace.id) && !project.archived_at && canInProject(data, project.id, 'task.create'),
    );
  return (
    <div className="acts dp-actions">
      <button
        className="btn btn-secondary"
        disabled={data.pending || data.readOnly || data.accessUnavailable || !canInWorkspace(data, 'project.create')}
        onClick={onNewProject}
      >
        <FolderKanban size={14} aria-hidden="true" />
        Nuevo proyecto
      </button>
      <button className="btn btn-primary" disabled={data.pending || !canCreateTask} onClick={onNewTask}>
        <Plus size={14} aria-hidden="true" />
        Nueva tarea
      </button>
    </div>
  );
}

function TaskLine({
  task,
  model,
  data,
  onOpen,
  onMove,
  showProject = true,
}: Pick<DashboardProps, 'data' | 'onOpen' | 'onMove'> & { task: Task; model: Model; showProject?: boolean }) {
  const project = model.projectMap.get(task.project_id);
  const member = task.assignee_member_id ? model.memberMap.get(task.assignee_member_id) : undefined;
  return (
    <li className="dp-task-row">
      <button
        type="button"
        className="dp-task-check"
        aria-label={`${task.status === 'done' ? 'Reabrir' : 'Completar'} ${task.title}`}
        disabled={data.pending || data.readOnly || !canInProject(data, task.project_id, 'task.edit')}
        onClick={() => void onMove(task, task.status === 'done' ? 'todo' : 'done')}
      >
        {task.status === 'done' ? <Check size={14} aria-hidden="true" /> : <span />}
      </button>
      <button className="dp-task-open" type="button" aria-label={`Abrir ${task.title}`} onClick={() => onOpen(task)}>
        <TaskStatusIcon status={task.status} />
        <span className={`dp-task-title${task.status === 'done' ? ' is-done' : ''}`}>{task.title}</span>
        {showProject && project && (
          <span className="dp-task-project">
            <i style={{ background: project.color }} />
            {project.name}
          </span>
        )}
        <PriorityIcon priority={task.priority} />
        {task.due_date && (
          <time className={task.status !== 'done' && task.due_date < localDate() ? 'overdue' : 'faint'} dateTime={task.due_date}>
            {formatDate(task.due_date)}
          </time>
        )}
        {member && <IdentityAvatar name={member.display_name} small />}
      </button>
    </li>
  );
}

function HomeTasks({ model, data, onOpen, onMove }: Pick<DashboardProps, 'data' | 'onOpen' | 'onMove'> & { model: Model }) {
  const [tab, setTab] = useState<'upcoming' | 'overdue' | 'done'>('upcoming');
  const today = localDate();
  const lists = {
    upcoming: model.mine.filter(task => task.status !== 'done' && (!task.due_date || task.due_date >= today)).sort(byDue),
    overdue: model.mine.filter(task => task.status !== 'done' && task.due_date && task.due_date < today).sort(byDue),
    done: model.mine.filter(task => task.status === 'done').sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)),
  };
  const tabs = [
    { id: 'upcoming', name: 'Próximas' },
    { id: 'overdue', name: 'Vencidas' },
    { id: 'done', name: 'Completadas' },
  ] as const;
  const list = lists[tab];
  return (
    <section className="panel dp-personal-tasks" aria-label="Mis tareas">
      <div className="panel-h dp-task-panel-heading">
        <h2>Mis tareas</h2>
        <div className="acts">
          <div className="seg dp-task-tabs" aria-label="Filtrar mis tareas">
            {tabs.map(item => (
              <button
                key={item.id}
                className={tab === item.id ? 'on' : ''}
                aria-pressed={tab === item.id}
                aria-label={`${item.name} ${model.mineAvailable ? lists[item.id].length : '—'}`}
                onClick={() => setTab(item.id)}
              >
                {item.name}
                <span>{model.mineAvailable ? lists[item.id].length : '—'}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {!model.mineAvailable ? (
        <p className="dp-panel-empty">
          {model.directoryPending
            ? 'Cargando tu identidad en el equipo…'
            : 'No se pudo identificar tu miembro en el directorio autorizado. Tus tareas no se mezclan con las de otras personas.'}
        </p>
      ) : list.length ? (
        <ul className="dp-task-list">
          {list.slice(0, 7).map(task => (
            <TaskLine key={task.id} task={task} data={data} model={model} onOpen={onOpen} onMove={onMove} />
          ))}
        </ul>
      ) : (
        <p className="dp-panel-empty">
          {tab === 'overdue'
            ? 'No tienes tareas vencidas.'
            : tab === 'done'
              ? 'Todavía no hay tareas completadas.'
              : 'No tienes tareas próximas. Las tareas sin fecha también aparecerán aquí.'}
        </p>
      )}
      {model.mineAvailable && (
        <Link className="dp-panel-footer" to={scoped(data, '/tasks', { filter: 'mine' })}>
          Ver todas mis tareas
          <ArrowRight size={13} aria-hidden="true" />
        </Link>
      )}
    </section>
  );
}

function ProjectProgress({ summary }: { summary: ProjectSummary }) {
  return summary.taskReadable ? (
    <span className="dp-progress">
      <span className="dp-progress-track">
        <i style={{ width: `${summary.progress}%`, background: summary.project.color }} />
      </span>
      <span className="num">{summary.progress}%</span>
    </span>
  ) : (
    <span className="faint dp-unavailable">Sin acceso a tareas</span>
  );
}

function Portfolio({ model, data, detailed = false }: { model: Model; data: WorkspaceProps; detailed?: boolean }) {
  const summaries = detailed ? model.projectSummaries : model.projectSummaries.filter(row => row.project.status !== 'complete');
  const visible = detailed ? summaries : summaries.slice(0, 6);
  return (
    <section className="panel dp-portfolio" aria-label={detailed ? 'Cartera de proyectos' : 'Progreso de proyectos'}>
      <div className="panel-h">
        <h2>{detailed ? 'Cartera de proyectos' : 'Progreso de proyectos'}</h2>
        <Link className="btn btn-sm btn-ghost" to={scoped(data, '/projects')}>
          Todos los proyectos
        </Link>
      </div>
      {visible.length ? (
        <div className="dp-table-scroll">
          <table className="dp-table">
            <thead>
              <tr>
                <th>Proyecto</th>
                <th>Estado</th>
                <th>Progreso</th>
                {detailed && (
                  <>
                    <th>Abiertas</th>
                    <th>Vencidas</th>
                  </>
                )}
                <th>Próxima tarea con fecha</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(row => (
                <tr key={row.project.id}>
                  <td>
                    <Link className="dp-project-link" to={scoped(data, `/projects/${row.project.id}`, { view: 'overview' })}>
                      <ProjectIcon icon={row.project.icon} color={row.project.color} />
                      <span>{row.project.name}</span>
                    </Link>
                  </td>
                  <td>
                    <span className="pstatus pw-project-status">
                      <ProjectStatusDot status={row.project.status} />
                      {PROJECT_STATUSES.find(item => item.id === row.project.status)?.name}
                    </span>
                  </td>
                  <td>
                    <ProjectProgress summary={row} />
                  </td>
                  {detailed && (
                    <>
                      <td>{row.taskReadable ? row.open : '—'}</td>
                      <td className={row.overdue ? 'overdue' : 'faint'}>{row.taskReadable ? row.overdue : '—'}</td>
                    </>
                  )}
                  <td>{row.taskReadable ? formatDate(row.nextDue) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="dp-panel-empty">{model.projects.length ? 'Todos tus proyectos visibles están completados.' : 'Todavía no hay proyectos para mostrar.'}</p>
      )}
      {!detailed && summaries.length > visible.length && (
        <Link className="dp-panel-footer" to={scoped(data, '/overview')}>
          Ver los {summaries.length} proyectos
          <ArrowRight size={13} aria-hidden="true" />
        </Link>
      )}
    </section>
  );
}

function Deadlines({ model, data, onOpen }: Pick<DashboardProps, 'data' | 'onOpen'> & { model: Model }) {
  const today = localDate();
  const tomorrow = shiftDashboardDate(today, 1);
  const horizon = shiftDashboardDate(today, 7);
  const dated = model.tasks.filter(task => task.status !== 'done' && task.due_date && task.due_date >= today && task.due_date <= horizon).sort(byDue);
  const groups = [
    { label: 'Hoy', tasks: dated.filter(task => task.due_date === today) },
    { label: 'Mañana', tasks: dated.filter(task => task.due_date === tomorrow) },
    { label: 'Después · próximos 7 días', tasks: dated.filter(task => task.due_date! > tomorrow) },
  ];
  return (
    <section className="panel dp-deadlines" aria-label="Próximos vencimientos">
      <div className="panel-h">
        <h2>Próximos vencimientos</h2>
        <Link className="btn btn-sm btn-ghost" to={scoped(data, data.calendar ? '/calendar' : '/tasks')}>
          <CalendarDays size={13} aria-hidden="true" />
          {data.calendar ? 'Calendario' : 'Ver tareas'}
        </Link>
      </div>
      <div className="panel-b">
        {groups.map(group => (
          <div className="dp-deadline-group" key={group.label}>
            <h3>
              {group.label}
              <span className="num faint">{group.tasks.length}</span>
            </h3>
            {group.tasks.length ? (
              <>
                <ul className="dp-task-list">
                  {group.tasks.slice(0, 4).map(task => (
                    <li key={task.id}>
                      <button className="dp-deadline-row" onClick={() => onOpen(task)}>
                        <i style={{ background: model.projectMap.get(task.project_id)?.color }} />
                        <span>{task.title}</span>
                        <PriorityIcon priority={task.priority} />
                        {task.assignee_member_id && model.memberMap.get(task.assignee_member_id) && (
                          <IdentityAvatar name={model.memberMap.get(task.assignee_member_id)!.display_name} small />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
                {group.tasks.length > 4 && (
                  <Link className="dp-more" to={scoped(data, data.calendar ? '/calendar' : '/tasks')}>
                    Ver {group.tasks.length - 4} más
                  </Link>
                )}
              </>
            ) : (
              <p className="faint">Sin vencimientos</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function TaskDistribution({ model }: { model: Model }) {
  return (
    <section className="panel dp-distribution" aria-label="Tareas por estado">
      <div className="panel-h">
        <h2>Tareas por estado</h2>
      </div>
      <div className="panel-b">
        <div className="dp-status-bar" aria-hidden="true">
          {STATUSES.map(status => (
            <i
              key={status.id}
              style={{
                width: `${model.tasks.length ? (model.tasks.filter(task => task.status === status.id).length / model.tasks.length) * 100 : 0}%`,
                background: status.color,
              }}
            />
          ))}
        </div>
        <ul className="dp-status-list">
          {STATUSES.map(status => {
            const count = model.tasks.filter(task => task.status === status.id).length;
            return (
              <li key={status.id}>
                <TaskStatusIcon status={status.id} />
                <span>{status.name}</span>
                <strong className="num">{count}</strong>
                <span className="num faint">{model.tasks.length ? Math.round((count / model.tasks.length) * 100) : 0}%</span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function Workload({ model }: { model: Model }) {
  const max = Math.max(1, ...model.workloads.map(row => row.tasks.length));
  return (
    <section className="panel dp-workload" aria-label="Carga de trabajo visible">
      <div className="panel-h">
        <h2>Carga de trabajo</h2>
      </div>
      <div className="panel-b">
        <p className="dp-panel-caption">Tareas abiertas visibles por persona; no mide horas ni capacidad.</p>
        {!model.directoryAvailable ? (
          <p className="dp-panel-empty">
            {model.directoryPending
              ? 'Cargando miembros…'
              : model.directoryState === 'error'
                ? 'El directorio no está disponible. No se muestran nombres ni recuentos anteriores.'
                : 'No tienes acceso al directorio de este equipo.'}
          </p>
        ) : (
          <ul className="dp-workload-list">
            {model.workloads.map(row => (
              <li key={row.member.id}>
                <IdentityAvatar name={row.member.display_name} small decorative />
                <span className="dp-workload-name">{row.member.display_name}</span>
                <span className="dp-workload-track" aria-hidden="true">
                  <span style={{ width: `${(row.tasks.length / max) * 100}%` }}>
                    {STATUSES.filter(status => status.id !== 'done').map(status => {
                      const count = row.tasks.filter(task => task.status === status.id).length;
                      return count ? <i key={status.id} style={{ flex: count, background: status.color }} /> : null;
                    })}
                  </span>
                </span>
                <strong className="num">{row.tasks.length}</strong>
                <span className="sr">tareas abiertas</span>
              </li>
            ))}
          </ul>
        )}
        <div className="dp-workload-extra">
          <span>Sin responsable</span>
          <strong className="num">{model.unassigned.length}</strong>
        </div>
        {model.directoryAvailable && !!model.unavailableAssignees.length && (
          <div className="dp-workload-extra">
            <span>Responsable fuera del directorio visible</span>
            <strong className="num">{model.unavailableAssignees.length}</strong>
          </div>
        )}
      </div>
    </section>
  );
}

export function HomeDashboard({ data, onNewProject, onNewTask, onOpen, onMove }: DashboardProps) {
  const today = localDate();
  const model = buildDashboardModel(data, today);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches';
  const ownMember = model.members.find(member => member.user_id === data.currentUserId);
  const activeProjects = model.projects.filter(project => project.status !== 'complete');
  const activityAvailable = data.collaboration && !data.accessUnavailable && canInWorkspace(data, 'audit.read');
  return (
    <div className="page dp-page dp-home">
      <div className="ph">
        <div>
          <h1>
            {greeting}
            {ownMember ? `, ${ownMember.display_name.split(' ')[0]}` : ''}
          </h1>
          <p>
            <time dateTime={today}>
              {new Intl.DateTimeFormat('es', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${today}T12:00:00`))}
            </time>{' '}
            · Así va tu espacio de trabajo.
          </p>
        </div>
        <DashboardActions data={data} onNewProject={onNewProject} onNewTask={onNewTask} />
      </div>
      <div className="stats dp-stats" aria-label="Resumen del espacio">
        <Stat
          title="Proyectos activos"
          value={activeProjects.length}
          detail={`${activeProjects.filter(project => project.status === 'hold').length} en pausa`}
          icon={<FolderKanban size={15} aria-hidden="true" />}
          href={scoped(data, '/projects')}
        />
        <Stat
          title="Tareas abiertas"
          value={model.totals.open}
          detail={model.mineAvailable ? `${model.mine.filter(task => task.status !== 'done').length} en tus tareas` : 'Solo tareas visibles'}
          icon={<CircleDashed size={15} aria-hidden="true" />}
          href={scoped(data, '/tasks', { filter: 'open' })}
        />
        <Stat
          title="Completadas"
          value={model.totals.done}
          detail="Total actual de tareas completadas"
          icon={<CircleCheck size={15} aria-hidden="true" />}
          href={scoped(data, '/tasks', { filter: 'done' })}
        />
        <Stat
          title="Vencidas"
          value={model.totals.overdue}
          detail={model.totals.overdue ? 'Necesitan atención' : 'Todo al día'}
          icon={<ClockAlert size={15} aria-hidden="true" />}
          href={scoped(data, '/tasks', { filter: 'overdue' })}
          tone={model.totals.overdue ? 'overdue' : undefined}
        />
      </div>
      <ScopeNote partial={model.taskCoveragePartial} />
      <div className="grid2 dp-columns">
        <div className="stack">
          <HomeTasks key={data.workspace?.id ?? 'personal'} model={model} data={data} onOpen={onOpen} onMove={onMove} />
          <Portfolio model={model} data={data} />
        </div>
        <div className="stack">
          <Deadlines model={model} data={data} onOpen={onOpen} />
          {activityAvailable && (
            <div className="dp-activity">
              <ActivityPanel api={data.collaboration!} compact title="Actividad reciente" />
              <Link className="dp-panel-footer" to={scoped(data, '/activity')}>
                Ver toda la actividad
                <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </div>
          )}
        </div>
      </div>
      {!model.projects.length && (
        <div className="dp-first-project">
          <FolderKanban size={20} aria-hidden="true" />
          <div>
            <h2>Dale espacio a tu primer proyecto</h2>
            <p>Crea un proyecto para empezar a organizar tus tareas.</p>
          </div>
          <button
            className="btn btn-primary"
            disabled={data.pending || data.readOnly || data.accessUnavailable || !canInWorkspace(data, 'project.create')}
            onClick={onNewProject}
          >
            Crear proyecto
          </button>
        </div>
      )}
    </div>
  );
}

export function OverviewDashboard({ data, onNewProject, onNewTask, onOpen }: DashboardProps) {
  const model = buildDashboardModel(data, localDate());
  const isTeam = data.workspace?.kind === 'team';
  return (
    <div className="page dp-page dp-overview">
      <div className="ph">
        <div>
          <h1>Vista general</h1>
          <p>El estado de tus proyectos en {isTeam ? data.workspace!.name : 'tu espacio personal'}.</p>
        </div>
        <DashboardActions data={data} onNewProject={onNewProject} onNewTask={onNewTask} />
      </div>
      <div className="stats dp-stats" aria-label="Métricas de vista general">
        <Stat
          title="Proyectos"
          value={model.totals.projects}
          detail={`${model.projects.filter(project => project.status === 'complete').length} completados`}
          icon={<FolderKanban size={15} aria-hidden="true" />}
          href={scoped(data, '/projects')}
        />
        <Stat
          title="Tareas"
          value={model.totals.tasks}
          detail={`${model.totals.open} abiertas`}
          icon={<CircleDashed size={15} aria-hidden="true" />}
          href={scoped(data, '/tasks')}
        />
        <Stat
          title="Progreso"
          value={`${model.totals.progress}%`}
          detail="Tareas completadas / tareas visibles"
          icon={<TrendingUp size={15} aria-hidden="true" />}
        />
        {isTeam ? (
          <Stat
            title="Miembros activos"
            value={model.directoryAvailable ? model.members.length : '—'}
            detail={model.directoryAvailable ? 'En el directorio autorizado' : model.directoryPending ? 'Cargando directorio' : 'Directorio no disponible'}
            icon={<Users size={15} aria-hidden="true" />}
            href={scoped(data, '/team')}
          />
        ) : (
          <Stat
            title="Vencidas"
            value={model.totals.overdue}
            detail="Tareas abiertas fuera de fecha"
            icon={<ClockAlert size={15} aria-hidden="true" />}
            href={scoped(data, '/tasks', { filter: 'overdue' })}
            tone={model.totals.overdue ? 'overdue' : undefined}
          />
        )}
      </div>
      <ScopeNote partial={model.taskCoveragePartial} />
      <div className="grid2 dp-columns">
        <div className="stack">
          <Portfolio model={model} data={data} detailed />
          <Deadlines model={model} data={data} onOpen={onOpen} />
        </div>
        <div className="stack">
          <TaskDistribution model={model} />
          {isTeam && <Workload model={model} />}
        </div>
      </div>
    </div>
  );
}

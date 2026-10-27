import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, Archive, ChevronRight, LogOut, Menu, Pencil, Plus, RefreshCw, Search, Settings2, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import { Link, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PROJECT_STATUSES } from '../constants';
import type { CalendarApi, CalendarItem, CollaborationApi, Project, Task, TaskStatus, WorkspaceMember, WorkspaceProps, WorkspaceSummary } from '../types';
import Calendar from './Calendar';
import CalendarSettings from './CalendarZoneSettings';
import ProjectForm from './ProjectForm';
import ProjectDeleteDialog from './ProjectDeleteDialog';
import TaskForm from './TaskForm';
import TasksView from './TasksView';
import { Busy, Dialog, EmptyState, ErrorNotice, ProjectIcon } from './ui';
import { errorMessage, localDate } from './helpers';
import { ActivityPanel, ProjectAccessDialog, TeamAdministration } from './Collaboration';
import { canInProject, canInWorkspace } from './permissions';
import SyncStatus from './SyncStatus';
import WorkspaceSidebar from './WorkspaceSidebar';
import WorkspaceCreateMenu from './WorkspaceCreateMenu';
import { IdentityAvatar, ProjectGlyph, ProjectStatusDot } from './project-identity';
import useAppearance from './useAppearance';
import { HomeDashboard, OverviewDashboard } from './DashboardPages';
import ProjectSummary from './ProjectSummary';
import { buildDashboardModel } from './dashboard-model';
import './workspace.css';
import './visual-navigation.css';

type ProjectActions = {
  onEdit: (project: Project) => void;
  onArchive: (project: Project) => void;
  onDelete: (project: Project) => void;
  onAccess: (project: Project) => void;
  pending: boolean;
  can: (projectId: string, permission: string) => boolean;
  canCreateProject: boolean;
  canCreateTask: boolean;
  collaboration?: CollaborationApi;
  calendar?: CalendarApi;
  calendarWorkspaces?: WorkspaceSummary[];
  members?: WorkspaceMember[];
  onOpenCalendar?: (item: CalendarItem) => void;
  scopeSearch?: string;
};

function ProjectCard({ project, tasks, pending, can, scopeSearch = '', onEdit, onArchive, onDelete }: ProjectActions & { project: Project; tasks: Task[] }) {
  const complete = tasks.filter(task => task.status === 'done').length;
  const progress = tasks.length ? Math.round((complete / tasks.length) * 100) : 0;
  return (
    <article className="pcard pw-project-card">
      <Link to={`/projects/${project.id}${scopeSearch}`} className="pw-project-main">
        <div className="row">
          <ProjectIcon color={project.color} icon={project.icon} />
          <h2>{project.name}</h2>
        </div>
        <p className="desc">{project.description || 'Un espacio para organizar tus ideas y avanzar, tarea a tarea.'}</p>
        <div className="row">
          <span className="pstatus pw-project-status">
            <ProjectStatusDot status={project.status} />
            {PROJECT_STATUSES.find(item => item.id === project.status)?.name}
          </span>
          {project.archived_at && (
            <span className="pw-archived-tag">
              <Archive size={12} aria-hidden="true" />
              Archivado
            </span>
          )}
        </div>
        <div className="pw-project-progress" aria-label={`${progress}% de tareas completadas`}>
          <span style={{ width: `${progress}%`, background: project.color }} />
        </div>
      </Link>
      <div className="foot">
        <span>
          {complete}/{tasks.length} tareas
        </span>
        <div className="sp" />
        <button
          className="ibtn ibtn-xs"
          aria-label={`Editar ${project.name}`}
          disabled={pending || !can(project.id, 'project.edit')}
          onClick={() => onEdit(project)}
        >
          <Pencil size={13} aria-hidden="true" />
        </button>
        <button
          className="ibtn ibtn-xs"
          aria-label={`${project.archived_at ? 'Restaurar' : 'Archivar'} ${project.name}`}
          disabled={pending || !can(project.id, 'project.archive')}
          onClick={() => onArchive(project)}
        >
          {project.archived_at ? <RefreshCw size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}
        </button>
        {can(project.id, 'project.delete') && (
          <button className="ibtn ibtn-xs btn-danger-ghost" aria-label={`Eliminar ${project.name}`} disabled={pending} onClick={() => onDelete(project)}>
            <Trash2 size={13} aria-hidden="true" />
          </button>
        )}
      </div>
    </article>
  );
}

function ProjectsPage({ projects, tasks, onNew, ...actions }: ProjectActions & { projects: Project[]; tasks: Task[]; onNew: () => void }) {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const visible = projects.filter(
    project =>
      Boolean(project.archived_at) === archived &&
      `${project.name} ${project.description}`.toLocaleLowerCase('es').includes(query.trim().toLocaleLowerCase('es')),
  );
  return (
    <div className="page">
      <div className="ph">
        <div>
          <h1>Proyectos</h1>
          <p>Un lugar para cada idea y cada objetivo.</p>
        </div>
        <div className="acts">
          <button className="btn btn-primary" disabled={actions.pending || !actions.canCreateProject} onClick={onNew}>
            <Plus size={14} aria-hidden="true" />
            Nuevo proyecto
          </button>
        </div>
      </div>
      <div className="pw-project-filters">
        <div className="pw-segment">
          <button className={archived ? '' : 'on'} aria-pressed={!archived} onClick={() => setArchived(false)}>
            Activos <span>{projects.filter(project => !project.archived_at).length}</span>
          </button>
          <button className={archived ? 'on' : ''} aria-pressed={archived} onClick={() => setArchived(true)}>
            Archivados <span>{projects.filter(project => project.archived_at).length}</span>
          </button>
        </div>
        <label className="pw-search">
          <Search size={14} aria-hidden="true" />
          <span className="sr">Buscar proyectos</span>
          <input type="search" placeholder="Buscar proyectos…" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
      </div>
      {visible.length ? (
        <div className="pgrid">
          {visible.map(project => (
            <ProjectCard key={project.id} project={project} tasks={tasks.filter(task => task.project_id === project.id)} {...actions} />
          ))}
        </div>
      ) : (
        <EmptyState
          title={query ? 'No encontramos ese proyecto' : archived ? 'No hay proyectos archivados' : 'Crea tu primer proyecto'}
          action={
            query ? (
              <button className="btn btn-secondary" onClick={() => setQuery('')}>
                Limpiar búsqueda
              </button>
            ) : (
              !archived && (
                <button className="btn btn-primary" disabled={actions.pending || !actions.canCreateProject} onClick={onNew}>
                  Crear proyecto
                </button>
              )
            )
          }
        >
          {query
            ? 'Prueba con otro nombre.'
            : archived
              ? 'Los proyectos que archives aparecerán aquí. Puedes restaurarlos cuando los necesites.'
              : 'Empieza por un nombre y organiza tus tareas alrededor de él.'}
        </EmptyState>
      )}
    </div>
  );
}

function ProjectPage({
  data,
  projects,
  tasks,
  onNewTask,
  onOpen,
  onMove,
  ...actions
}: ProjectActions & {
  data: WorkspaceProps;
  projects: Project[];
  tasks: Task[];
  onNewTask: (project: Project, status?: TaskStatus) => void;
  onOpen: (task: Task) => void;
  onMove: (task: Task, status: TaskStatus) => Promise<void>;
}) {
  const { id } = useParams();
  const [settingsProject, setSettingsProject] = useState<string | null>(null);
  const project = projects.find(item => item.id === id);
  if (!project)
    return (
      <div className="page">
        <EmptyState
          title="Proyecto no encontrado"
          action={
            <Link to={`/projects${actions.scopeSearch ?? ''}`} className="btn btn-primary">
              Ver mis proyectos
            </Link>
          }
        >
          Este proyecto no está disponible en tu cuenta.
        </EmptyState>
      </div>
    );
  const projectTasks = tasks.filter(task => task.project_id === project.id);
  return (
    <div className="page flush pw-project-page">
      <div className="proj-h">
        <div className="t">
          <ProjectIcon color={project.color} icon={project.icon} large />
          <div className="grow">
            <h1>{project.name}</h1>
            <p className="pw-project-description">{project.description || 'Organiza las tareas de este proyecto.'}</p>
          </div>
          {!project.archived_at && (
            <button className="btn btn-primary" disabled={actions.pending || !actions.can(project.id, 'task.create')} onClick={() => onNewTask(project)}>
              <Plus size={14} aria-hidden="true" />
              Nueva tarea
            </button>
          )}
          <button className="btn btn-secondary" onClick={() => setSettingsProject(project.id)}>
            <Settings2 size={14} aria-hidden="true" />
            Configuración del proyecto
          </button>
        </div>
        <div className="row pw-project-meta">
          <span className="pstatus pw-project-status">
            <ProjectStatusDot status={project.status} />
            {PROJECT_STATUSES.find(item => item.id === project.status)?.name}
          </span>
          <span>
            {projectTasks.length} {projectTasks.length === 1 ? 'tarea' : 'tareas'}
          </span>
          {project.archived_at && (
            <span className="pw-archived-tag">
              <Archive size={12} aria-hidden="true" />
              Proyecto archivado · solo lectura
            </span>
          )}
        </div>
      </div>
      {settingsProject === project.id && (
        <Dialog title="Configuración del proyecto" onClose={() => setSettingsProject(null)} busy={actions.pending}>
          <p className="muted">{project.name}</p>
          <div className="pw-project-settings-actions">
            <button
              className="btn btn-secondary"
              disabled={actions.pending || !actions.can(project.id, 'project.edit')}
              onClick={() => {
                setSettingsProject(null);
                actions.onEdit(project);
              }}
            >
              <Pencil size={13} aria-hidden="true" />
              Editar
            </button>
            <button
              className="btn btn-ghost"
              disabled={actions.pending || !actions.can(project.id, 'project.archive')}
              onClick={() => {
                setSettingsProject(null);
                actions.onArchive(project);
              }}
            >
              <Archive size={14} aria-hidden="true" />
              {project.archived_at ? 'Restaurar' : 'Archivar'}
            </button>
            {actions.can(project.id, 'project.delete') && (
              <button
                className="btn btn-danger-ghost"
                disabled={actions.pending}
                onClick={() => {
                  setSettingsProject(null);
                  actions.onDelete(project);
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
                Eliminar proyecto
              </button>
            )}
            {actions.collaboration && actions.can(project.id, 'project.access.manage') && (
              <button
                className="btn btn-secondary"
                disabled={actions.pending}
                onClick={() => {
                  setSettingsProject(null);
                  actions.onAccess(project);
                }}
              >
                <Users size={14} aria-hidden="true" />
                Acceso
              </button>
            )}
          </div>
        </Dialog>
      )}
      <TasksView
        key={project.id}
        tasks={projectTasks}
        projects={projects}
        members={actions.members}
        pending={actions.pending}
        readOnly={Boolean(project.archived_at)}
        canCreate={actions.can(project.id, 'task.create') && !project.archived_at}
        canEditTask={task => actions.can(task.project_id, 'task.edit') && !project.archived_at}
        onCreate={status => onNewTask(project, status)}
        onOpen={onOpen}
        onMove={onMove}
        summaryContent={<ProjectSummary project={project} data={data} onOpen={onOpen} />}
        activityContent={
          actions.collaboration && actions.can(project.id, 'audit.read') ? (
            <ActivityPanel key={`activity:${project.id}`} api={actions.collaboration} projectId={project.id} />
          ) : undefined
        }
        calendarContent={
          actions.calendar && actions.onOpenCalendar ? (
            <Calendar
              key={`${project.id}:${actions.calendar.scopeKey.join(':')}`}
              api={actions.calendar}
              project={project}
              workspaceId={project.workspace_id}
              workspaces={actions.calendarWorkspaces ?? []}
              projects={projects}
              onOpen={actions.onOpenCalendar}
            />
          ) : undefined
        }
      />
    </div>
  );
}

function CreateTeamDialog({ onCreate, onClose }: { onCreate: NonNullable<WorkspaceProps['onCreateTeam']>; onClose: () => void }) {
  const [name, setName] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current || !name.trim()) return;
    locked.current = true;
    setPending(true);
    setError(null);
    try {
      await onCreate(name.trim(), requestId);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      locked.current = false;
      setPending(false);
    }
  }
  return (
    <Dialog title="Crear equipo" busy={pending} onClose={onClose}>
      <form className="pw-form" onSubmit={event => void submit(event)}>
        <div className="pw-form-body">
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <label className="pw-field" htmlFor="team-name">
            Nombre del equipo
            <input
              id="team-name"
              data-initial-focus
              required
              maxLength={120}
              disabled={pending}
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="Por ejemplo, Horizon Studios"
            />
          </label>
          <p className="faint">Tu espacio personal seguirá siendo privado. Los proyectos del equipo estarán separados de tus proyectos personales.</p>
        </div>
        <div className="pw-form-footer">
          <button type="button" className="btn btn-secondary" disabled={pending} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={pending || !name.trim()}>
            {pending ? 'Creando…' : 'Crear equipo'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AccountPage({ email, pending, onSignOut, onPasswordReset }: Pick<WorkspaceProps, 'email' | 'pending' | 'onSignOut' | 'onPasswordReset'>) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function run(action: 'reset' | 'signout') {
    if (pending || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (action === 'reset') {
        await onPasswordReset();
        setNotice('Solicitamos el correo para cambiar tu contraseña. Revisa tu bandeja de entrada y spam.');
      } else await onSignOut();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="page pw-account">
      <div className="ph">
        <div>
          <h1>Mi cuenta</h1>
          <p>Tu espacio, conectado a tu cuenta personal.</p>
        </div>
      </div>
      <div className="pw-account-card">
        <div className="row">
          <span className="pw-avatar">{email.charAt(0).toUpperCase()}</span>
          <div>
            <h2>Cuenta personal</h2>
            <p className="faint">{email}</p>
          </div>
        </div>
        <div className="pw-account-detail">
          <ShieldCheck size={17} aria-hidden="true" />
          <span>Tu espacio personal es privado. Los proyectos de equipo respetan sus permisos de acceso.</span>
        </div>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {notice && (
          <div className="pw-info" role="status">
            {notice}
          </div>
        )}
        <div className="pw-account-actions">
          <div>
            <h3>Contraseña</h3>
            <p>Recibe un enlace en tu correo para elegir una contraseña nueva.</p>
          </div>
          <button
            className="btn btn-secondary"
            disabled={pending || busy}
            onClick={() => {
              void run('reset');
            }}
          >
            Cambiar contraseña
          </button>
        </div>
        <div className="pw-account-actions">
          <div>
            <h3>Cerrar sesión</h3>
            <p>Los proyectos y tareas seguirán guardados en tu cuenta.</p>
          </div>
          <button
            className="btn btn-secondary"
            disabled={pending || busy}
            onClick={() => {
              void run('signout');
            }}
          >
            <LogOut size={14} aria-hidden="true" />
            Cerrar sesión
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Workspace(props: WorkspaceProps & { processes?: ReactNode; integrations?: ReactNode; finance?: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const financeView = location.pathname === '/finance' && Boolean(props.finance);
  const appearance = useAppearance(props.currentUserId);
  const [searchParams, setSearchParams] = useSearchParams();
  const [mobileNav, setMobileNav] = useState(false);
  const [projectEditor, setProjectEditor] = useState<{ project?: Project } | null>(null);
  const [newTask, setNewTask] = useState<{ projectId?: string; status?: TaskStatus } | null>(null);
  const [accessProject, setAccessProject] = useState<Project | null>(null);
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);
  const [creatingTeam, setCreatingTeam] = useState(false);
  useEffect(() => {
    if (props.accessUnavailable) {
      setProjectEditor(null);
      setNewTask(null);
      setCreatingTeam(false);
      setAccessProject(null);
      setDeleteProjectId(null);
    }
  }, [props.accessUnavailable]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const actionLock = useRef(false);
  const pending = props.pending || actionBusy;
  const can = (projectId: string, permission: string) => canInProject(props, projectId, permission);
  const canCreateProject = canInWorkspace(props, 'project.create');
  const workspaceName = props.workspace?.kind === 'personal' ? 'Mi espacio personal' : (props.workspace?.name ?? 'Mi espacio');
  const scopeSearch = props.workspace ? `?workspace=${props.workspace.id}` : '';
  const activeProjects = props.projects.filter(project => !project.archived_at);
  const creatableProjects = activeProjects.filter(project => can(project.id, 'task.create'));
  const dashboard = buildDashboardModel(props, localDate());
  const taskFilter = searchParams.get('filter');
  const filteredTasks =
    taskFilter === 'mine'
      ? dashboard.mine
      : dashboard.tasks.filter(task =>
          taskFilter === 'done'
            ? task.status === 'done'
            : taskFilter === 'open'
              ? task.status !== 'done'
              : taskFilter === 'overdue'
                ? task.status !== 'done' && Boolean(task.due_date && task.due_date < localDate())
                : true,
        );
  const taskFilterLabel = new Map([
    ['mine', 'Asignadas a mí'],
    ['done', 'Completadas'],
    ['open', 'Por completar'],
    ['overdue', 'Vencidas'],
  ]).get(taskFilter ?? '');
  const taskId = searchParams.get('task');
  const selectedTask = props.tasks.find(task => task.id === taskId);
  const currentProject = props.projects.find(project => location.pathname === `/projects/${project.id}`);
  const deleteProject = props.projects.find(project => project.id === deleteProjectId);
  const deleteAllowed = Boolean(deleteProject && can(deleteProject.id, 'project.delete'));
  const editorAllowed = Boolean(
    projectEditor &&
    (projectEditor.project
      ? props.projects.some(project => project.id === projectEditor.project!.id) && can(projectEditor.project.id, 'project.edit')
      : canCreateProject),
  );
  const accessAllowed = Boolean(
    accessProject && props.projects.some(project => project.id === accessProject.id) && can(accessProject.id, 'project.access.manage'),
  );
  useEffect(() => {
    if (projectEditor && !editorAllowed) setProjectEditor(null);
    if (accessProject && !accessAllowed) setAccessProject(null);
    if (deleteProjectId && !deleteAllowed) setDeleteProjectId(null);
    if (newTask && !creatableProjects.some(project => !newTask.projectId || project.id === newTask.projectId)) setNewTask(null);
  }, [projectEditor, editorAllowed, accessProject, accessAllowed, deleteProjectId, deleteAllowed, newTask, creatableProjects]);
  const pageName =
    currentProject?.name ??
    (location.pathname === '/finance'
      ? 'Finanzas'
      : location.pathname === '/projects'
        ? 'Proyectos'
        : location.pathname === '/tasks'
          ? 'Mis tareas'
          : location.pathname === '/settings'
            ? 'Configuración'
            : location.pathname === '/account'
              ? 'Mi cuenta'
              : location.pathname === '/team'
                ? 'Equipo'
                : location.pathname === '/overview'
                  ? 'Vista general'
                  : location.pathname === '/activity'
                    ? 'Actividad'
                    : location.pathname === '/calendar'
                      ? 'Calendario'
                      : 'Inicio');

  async function action(work: () => Promise<unknown>, message: string) {
    if (pending || actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    setActionError(null);
    setAnnouncement('');
    try {
      await work();
      setAnnouncement(message);
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      actionLock.current = false;
      setActionBusy(false);
    }
  }

  async function moveTask(task: Task, status: TaskStatus) {
    if (!can(task.project_id, 'task.edit') || task.status === status) return;
    await action(() => props.onUpdateTask(task, { status, position: Date.now() }), 'Estado de la tarea guardado.');
  }

  function archiveProject(project: Project) {
    void action(() => props.onArchiveProject(project, !project.archived_at), project.archived_at ? 'Proyecto restaurado.' : 'Proyecto archivado.');
  }
  function openTask(task: Task) {
    const params = new URLSearchParams(searchParams);
    params.set('task', task.id);
    setSearchParams(params);
  }
  function closeTask() {
    setNewTask(null);
    const params = new URLSearchParams(searchParams);
    params.delete('task');
    setSearchParams(params, { replace: true });
  }
  function openCalendarItem(item: CalendarItem) {
    navigate(`/projects/${item.project_id}?workspace=${item.workspace_id}&view=calendar&task=${item.task_id}`);
  }
  function createTask(project?: Project, status?: TaskStatus) {
    setNewTask({ projectId: project?.id, status });
  }
  const projectActions: ProjectActions = {
    pending,
    can,
    canCreateProject,
    canCreateTask: creatableProjects.length > 0,
    collaboration: props.collaboration,
    calendar: props.calendar,
    calendarWorkspaces: props.workspaces,
    members: props.members,
    onOpenCalendar: openCalendarItem,
    scopeSearch,
    onEdit: project => {
      if (can(project.id, 'project.edit')) setProjectEditor({ project });
    },
    onArchive: archiveProject,
    onDelete: project => setDeleteProjectId(project.id),
    onAccess: setAccessProject,
  };
  const openNewProject = () => setProjectEditor({});
  const openNewTask = () => createTask(currentProject && creatableProjects.some(project => project.id === currentProject.id) ? currentProject : undefined);

  return (
    <div
      className={`shell personal-workspace${mobileNav ? ' mnav' : ''}${appearance.preferences.sidebarCollapsed ? ' collapsed' : ''}`}
      onKeyDown={event => {
        if (event.key === 'Escape' && mobileNav) setMobileNav(false);
      }}
    >
      <a className="skip" href="#workspace-content">
        Ir al contenido
      </a>
      {mobileNav && <button className="side-scrim" aria-label="Cerrar navegación" onClick={() => setMobileNav(false)} />}
      <WorkspaceSidebar
        key={`${props.currentUserId ?? 'session'}:${props.workspace?.id ?? 'workspace'}`}
        data={props}
        collapsed={appearance.preferences.sidebarCollapsed}
        pending={pending}
        showFinance={Boolean(props.finance)}
        onToggle={() => appearance.update({ sidebarCollapsed: !appearance.preferences.sidebarCollapsed })}
        onNavigate={() => setMobileNav(false)}
        onCreateProject={openNewProject}
        onCreateTeam={() => setCreatingTeam(true)}
      />
      <div className="main">
        <header className="topbar">
          <button
            className="ibtn pw-menu"
            onClick={() => setMobileNav(!mobileNav)}
            aria-label={mobileNav ? 'Cerrar navegación' : 'Abrir navegación'}
            aria-expanded={mobileNav}
          >
            {mobileNav ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
          </button>
          <div className="crumbs">
            <Link to={`/${scopeSearch}`}>{workspaceName}</Link>
            <ChevronRight size={12} className="faint" aria-hidden="true" />
            {currentProject && (
              <span className="pw-crumb-project" style={{ color: currentProject.color }}>
                <ProjectGlyph icon={currentProject.icon} size={13} />
              </span>
            )}
            <span className="cur trunc">{pageName}</span>
          </div>
          <div className="sp" />
          <SyncStatus
            scope={financeView ? 'Finanzas' : 'Proyectos y tareas'}
            state={
              props.accessUnavailable
                ? 'error'
                : financeView
                  ? (props.financeSyncState ?? 'checking')
                  : props.error || actionError
                    ? 'error'
                    : pending
                      ? 'saving'
                      : props.loading || props.refreshing
                        ? 'checking'
                        : 'synced'
            }
          />
          <button
            className="ibtn"
            aria-label="Actualizar datos"
            disabled={
              financeView
                ? !props.onRefreshFinance || ['checking', 'saving', 'pending'].includes(props.financeSyncState ?? 'checking')
                : props.loading || props.refreshing || pending
            }
            onClick={financeView ? props.onRefreshFinance : props.onRetry}
          >
            <RefreshCw
              size={14}
              className={(financeView ? props.financeSyncState === 'checking' || props.financeSyncState === 'saving' : props.refreshing) ? 'pw-spin' : ''}
              aria-hidden="true"
            />
          </button>
          {!financeView && (
            <WorkspaceCreateMenu
              key={props.workspace?.id}
              canProject={canCreateProject && !props.accessUnavailable}
              canTask={creatableProjects.length > 0 && !props.accessUnavailable}
              pending={pending}
              onProject={openNewProject}
              onTask={openNewTask}
            />
          )}
          <Link className="pw-topbar-account" to={`/account${scopeSearch}`} aria-label="Mi cuenta" title="Mi cuenta">
            <IdentityAvatar name={props.email} small decorative />
          </Link>
        </header>
        {(props.error || actionError) && (
          <div className="pw-global-error">
            <ErrorNotice>{actionError ?? props.error}</ErrorNotice>
            <button
              className="btn btn-secondary btn-sm"
              disabled={pending || props.refreshing}
              onClick={() => {
                setActionError(null);
                props.onRetry();
              }}
            >
              Reintentar
            </button>
          </div>
        )}
        <main className={financeView ? 'content pw-content-finance' : 'content'} id="workspace-content" tabIndex={-1} aria-busy={props.loading}>
          {props.loading ? (
            <Busy />
          ) : props.error && props.projects.length === 0 ? (
            <EmptyState
              title="No pudimos cargar tu espacio"
              action={
                <button className="btn btn-primary" disabled={props.refreshing} onClick={props.onRetry}>
                  Volver a intentar
                </button>
              }
            >
              Comprueba tu conexión e inténtalo de nuevo.
            </EmptyState>
          ) : (
            <Routes>
              <Route
                path="/"
                element={
                  <HomeDashboard data={{ ...props, pending }} onNewProject={openNewProject} onNewTask={openNewTask} onOpen={openTask} onMove={moveTask} />
                }
              />
              <Route
                path="/overview"
                element={
                  <OverviewDashboard data={{ ...props, pending }} onNewProject={openNewProject} onNewTask={openNewTask} onOpen={openTask} onMove={moveTask} />
                }
              />
              <Route path="/projects" element={<ProjectsPage projects={props.projects} tasks={props.tasks} onNew={openNewProject} {...projectActions} />} />
              <Route
                path="/projects/:id"
                element={
                  <ProjectPage
                    data={{ ...props, pending }}
                    key={`${props.workspace?.id ?? ''}:${currentProject?.id ?? location.pathname}`}
                    projects={props.projects}
                    tasks={props.tasks}
                    onNewTask={createTask}
                    onOpen={openTask}
                    onMove={moveTask}
                    {...projectActions}
                  />
                }
              />
              <Route
                path="/tasks"
                element={
                  <div className="page flush">
                    <div className="ph">
                      <div>
                        <h1>Mis tareas</h1>
                        <p>Todas tus tareas, una vista clara.</p>
                      </div>
                      <div className="acts">
                        <button className="btn btn-primary" disabled={pending || !creatableProjects.length} onClick={openNewTask}>
                          <Plus size={14} aria-hidden="true" />
                          Nueva tarea
                        </button>
                      </div>
                    </div>
                    {taskFilterLabel && (
                      <div className="pw-dashboard-filter">
                        <span>Mostrando: {taskFilterLabel}</span>
                        <Link to={`/tasks${scopeSearch}`} className="pw-text-link">
                          Ver todas las tareas
                        </Link>
                      </div>
                    )}
                    {taskFilter === 'mine' && !dashboard.mineAvailable && (
                      <p className="pw-info">Tu asignación no está disponible sin acceso al directorio de miembros.</p>
                    )}
                    {activeProjects.length ? (
                      <TasksView
                        tasks={filteredTasks}
                        projects={props.projects}
                        members={props.members}
                        pending={pending}
                        canCreate={creatableProjects.length > 0}
                        canEditTask={task => can(task.project_id, 'task.edit')}
                        onCreate={status => createTask(undefined, status)}
                        onOpen={openTask}
                        onMove={moveTask}
                      />
                    ) : (
                      <EmptyState
                        title="Primero, un proyecto"
                        action={
                          <button className="btn btn-primary" disabled={pending || !canCreateProject} onClick={openNewProject}>
                            Crear proyecto
                          </button>
                        }
                      >
                        Crea un proyecto para empezar a organizar tus tareas.
                      </EmptyState>
                    )}
                  </div>
                }
              />
              <Route path="/team" element={<TeamAdministration {...props} />} />
              <Route
                path="/activity"
                element={
                  <div className="page pw-activity-page">
                    <div className="ph">
                      <div>
                        <div className="eyebrow">{workspaceName}</div>
                        <h1>
                          <Activity size={21} aria-hidden="true" /> Actividad
                        </h1>
                        <p>Los cambios de tus proyectos, en un solo lugar.</p>
                      </div>
                    </div>
                    {props.collaboration && !props.accessUnavailable && canInWorkspace(props, 'audit.read') ? (
                      <ActivityPanel key={props.collaboration.scopeKey.join(':')} api={props.collaboration} />
                    ) : (
                      <EmptyState title="Actividad no disponible">No tienes acceso al historial de este espacio.</EmptyState>
                    )}
                  </div>
                }
              />
              <Route
                path="/calendar"
                element={
                  props.calendar ? (
                    <div className="page">
                      <Calendar
                        key={props.calendar.scopeKey.join(':')}
                        api={props.calendar}
                        workspaces={props.workspaces ?? []}
                        projects={props.projects}
                        onOpen={openCalendarItem}
                      />
                    </div>
                  ) : (
                    <div className="page">
                      <EmptyState title="Calendario no disponible">Actualiza la aplicación para consultar las fechas de tus proyectos.</EmptyState>
                    </div>
                  )
                }
              />
              <Route
                path="/finance"
                element={
                  props.workspace?.kind === 'personal' && props.finance ? (
                    props.finance
                  ) : (
                    <EmptyState title="Finanzas personales">Selecciona tu espacio personal para consultar Finanzas.</EmptyState>
                  )
                }
              />
              <Route
                path="/settings"
                element={<CalendarSettings api={props.calendar} integrations={props.integrations} processes={props.processes} appearance={appearance} />}
              />
              <Route
                path="/account"
                element={<AccountPage email={props.email} pending={pending} onSignOut={props.onSignOut} onPasswordReset={props.onPasswordReset} />}
              />
              <Route
                path="*"
                element={
                  <div className="page">
                    <EmptyState
                      title="Esta página no existe"
                      action={
                        <Link to="/" className="btn btn-primary">
                          Ir al inicio
                        </Link>
                      }
                    >
                      Puedes continuar desde tu espacio personal.
                    </EmptyState>
                  </div>
                }
              />
            </Routes>
          )}
        </main>
        <span className="sr" role="status" aria-live="polite">
          {announcement}
        </span>
      </div>
      {deleteProject && deleteAllowed && !props.accessUnavailable && (
        <ProjectDeleteDialog
          key={deleteProject.id}
          project={deleteProject}
          taskCount={props.tasks.filter(task => task.project_id === deleteProject.id).length}
          pending={pending}
          onDelete={props.onDeleteProject}
          onClose={() => setDeleteProjectId(null)}
          onDeleted={() => {
            setDeleteProjectId(null);
            setProjectEditor(null);
            setAccessProject(null);
            setNewTask(null);
            setAnnouncement('Proyecto eliminado.');
            navigate(`/projects?workspace=${deleteProject.workspace_id}`, { replace: true });
          }}
        />
      )}
      {projectEditor && editorAllowed && !props.accessUnavailable && (
        <ProjectForm
          key={projectEditor.project?.id ?? 'new-project'}
          project={projectEditor.project}
          pending={pending}
          onCreate={props.onCreateProject}
          onUpdate={props.onUpdateProject}
          onClose={() => setProjectEditor(null)}
          onSaved={project => {
            const isNew = !projectEditor.project;
            setProjectEditor(null);
            setAnnouncement('Proyecto guardado.');
            if (isNew) navigate(`/projects/${project.id}${scopeSearch}`);
          }}
        />
      )}
      {(newTask || selectedTask) && !props.loading && !props.accessUnavailable && (
        <TaskForm
          key={
            selectedTask
              ? `${selectedTask.id}:${can(selectedTask.project_id, 'task.edit')}:${can(selectedTask.project_id, 'task.assign')}:${can(selectedTask.project_id, 'task.delete')}`
              : 'new-task'
          }
          task={newTask ? undefined : selectedTask}
          projectId={newTask?.projectId}
          initialStatus={newTask?.status}
          projects={newTask ? creatableProjects : props.projects}
          pending={pending}
          readOnly={selectedTask ? !can(selectedTask.project_id, 'task.edit') : false}
          canDelete={selectedTask ? can(selectedTask.project_id, 'task.delete') : false}
          canAssign={selectedTask ? can(selectedTask.project_id, 'task.assign') : false}
          collaboration={props.collaboration}
          calendar={props.calendar}
          onCreate={props.onCreateTask}
          onUpdate={props.onUpdateTask}
          onDelete={props.onDeleteTask}
          onClose={closeTask}
        />
      )}
      {taskId && !selectedTask && !newTask && !props.loading && !props.error && !props.accessUnavailable && (
        <Dialog title="Tarea no encontrada" onClose={closeTask}>
          <div className="pw-form-body">
            <p>Esta tarea no está disponible en tu cuenta o fue eliminada.</p>
            <button className="btn btn-secondary" onClick={closeTask}>
              Cerrar
            </button>
          </div>
        </Dialog>
      )}
      {creatingTeam && props.onCreateTeam && <CreateTeamDialog onClose={() => setCreatingTeam(false)} onCreate={props.onCreateTeam} />}
      {accessProject && accessAllowed && props.collaboration && !props.accessUnavailable && (
        <ProjectAccessDialog
          key={accessProject.id}
          project={accessProject}
          api={props.collaboration}
          members={props.members ?? []}
          currentUserId={props.currentUserId}
          canReadMembers={canInWorkspace(props, 'member.read')}
          onClose={() => setAccessProject(null)}
        />
      )}
    </div>
  );
}

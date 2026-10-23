import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Archive,
  ArrowRight,
  CheckCheck,
  ChevronRight,
  Clock3,
  FolderClosed,
  Home,
  LayoutGrid,
  ListTodo,
  LogOut,
  Menu,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from 'lucide-react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { formatDate, PROJECT_STATUSES } from '../constants';
import type { Project, Task, TaskStatus, WorkspaceProps } from '../types';
import ProjectForm from './ProjectForm';
import TaskForm from './TaskForm';
import TasksView from './TasksView';
import { Busy, Dialog, EmptyState, ErrorNotice, ProjectIcon, StatusDot } from './ui';
import { errorMessage, localDate } from './helpers';
import './workspace.css';

type ProjectActions = { onEdit: (project: Project) => void; onArchive: (project: Project) => void; pending: boolean };

function ProjectCard({ project, tasks, pending, onEdit, onArchive }: ProjectActions & { project: Project; tasks: Task[] }) {
  const complete = tasks.filter(task => task.status === 'done').length;
  const progress = tasks.length ? Math.round((complete / tasks.length) * 100) : 0;
  return (
    <article className="pcard pw-project-card">
      <Link to={`/projects/${project.id}`} className="pw-project-main">
        <div className="row">
          <ProjectIcon color={project.color} />
          <h2>{project.name}</h2>
        </div>
        <p className="desc">{project.description || 'Un espacio para organizar tus ideas y avanzar, tarea a tarea.'}</p>
        <div className="row">
          <span className="pstatus">{PROJECT_STATUSES.find(item => item.id === project.status)?.name}</span>
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
        <button className="ibtn ibtn-xs" aria-label={`Editar ${project.name}`} disabled={pending} onClick={() => onEdit(project)}>
          <Pencil size={13} aria-hidden="true" />
        </button>
        <button
          className="ibtn ibtn-xs"
          aria-label={`${project.archived_at ? 'Restaurar' : 'Archivar'} ${project.name}`}
          disabled={pending}
          onClick={() => onArchive(project)}
        >
          {project.archived_at ? <RefreshCw size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}
        </button>
      </div>
    </article>
  );
}

function HomePage({
  projects,
  tasks,
  onNewProject,
  onNewTask,
  onOpen,
  ...actions
}: ProjectActions & { projects: Project[]; tasks: Task[]; onNewProject: () => void; onNewTask: () => void; onOpen: (task: Task) => void }) {
  const activeProjects = projects.filter(project => !project.archived_at);
  const activeIds = new Set(activeProjects.map(project => project.id));
  const activeTasks = tasks.filter(task => activeIds.has(task.project_id));
  const outstanding = activeTasks.filter(task => task.status !== 'done');
  const today = localDate();
  const overdue = outstanding.filter(task => task.due_date && task.due_date < today).length;
  const upcoming = outstanding
    .filter(task => task.due_date)
    .sort((a, b) => a.due_date!.localeCompare(b.due_date!))
    .slice(0, 6);
  const projectMap = new Map(projects.map(project => [project.id, project]));
  return (
    <div className="page pw-home">
      <div className="ph">
        <div>
          <div className="eyebrow">Tu espacio personal</div>
          <h1>Todo en su lugar.</h1>
          <p>Una vista clara de tus proyectos y de lo que sigue.</p>
        </div>
        <div className="acts">
          <button className="btn btn-secondary" disabled={actions.pending} onClick={onNewProject}>
            <Plus size={14} aria-hidden="true" />
            Nuevo proyecto
          </button>
          <button className="btn btn-primary" disabled={actions.pending || !activeProjects.length} onClick={onNewTask}>
            <Plus size={14} aria-hidden="true" />
            Nueva tarea
          </button>
        </div>
      </div>
      <div className="pw-stats">
        <Summary title="Proyectos" value={activeProjects.length} icon={<FolderClosed size={17} />} />
        <Summary title="Por completar" value={outstanding.length} icon={<ListTodo size={17} />} />
        <Summary title="Completadas" value={activeTasks.length - outstanding.length} icon={<CheckCheck size={17} />} />
        <Summary title="Vencidas" value={overdue} icon={<Clock3 size={17} />} />
      </div>
      <section className="pw-home-section">
        <div className="pw-section-head">
          <h2 className="sec">Tus proyectos</h2>
          <Link to="/projects" className="pw-text-link">
            Ver todos
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
        </div>
        {activeProjects.length ? (
          <div className="pgrid">
            {activeProjects.slice(0, 3).map(project => (
              <ProjectCard key={project.id} project={project} tasks={tasks.filter(task => task.project_id === project.id)} {...actions} />
            ))}
          </div>
        ) : (
          <EmptyState
            title="Dale espacio a tu primer proyecto"
            action={
              <button className="btn btn-primary" disabled={actions.pending} onClick={onNewProject}>
                <Plus size={14} aria-hidden="true" />
                Crear proyecto
              </button>
            }
          >
            Agrupa tus tareas en un proyecto. Los cambios se guardarán en tu cuenta.
          </EmptyState>
        )}
      </section>
      <section className="pw-home-section">
        <div className="pw-section-head">
          <h2 className="sec">Próximos vencimientos</h2>
          <Link to="/tasks" className="pw-text-link">
            Ver tareas
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
        </div>
        {upcoming.length ? (
          <div className="pw-upcoming">
            {upcoming.map(task => (
              <button key={task.id} className="pw-upcoming-row" onClick={() => onOpen(task)}>
                <StatusDot status={task.status} />
                <span className="grow">
                  <strong>{task.title}</strong>
                  <small>{projectMap.get(task.project_id)?.name}</small>
                </span>
                <span className={task.due_date! < today ? 'overdue' : 'faint'}>{formatDate(task.due_date)}</span>
                <ChevronRight size={14} className="faint" aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : (
          <div className="pw-quiet">
            <CheckCheck size={19} aria-hidden="true" />
            <p>No tienes tareas pendientes con fecha de vencimiento.</p>
          </div>
        )}
      </section>
    </div>
  );
}

function Summary({ title, value, icon }: { title: string; value: number; icon: ReactNode }) {
  return (
    <div className="pw-stat">
      <span className="pw-stat-label">
        {title}
        {icon}
      </span>
      <strong className="num">{value}</strong>
    </div>
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
          <button className="btn btn-primary" disabled={actions.pending} onClick={onNew}>
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
                <button className="btn btn-primary" disabled={actions.pending} onClick={onNew}>
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
  projects,
  tasks,
  onNewTask,
  onOpen,
  onMove,
  ...actions
}: ProjectActions & {
  projects: Project[];
  tasks: Task[];
  onNewTask: (project: Project, status?: TaskStatus) => void;
  onOpen: (task: Task) => void;
  onMove: (task: Task, status: TaskStatus) => Promise<void>;
}) {
  const { id } = useParams();
  const project = projects.find(item => item.id === id);
  if (!project)
    return (
      <div className="page">
        <EmptyState
          title="Proyecto no encontrado"
          action={
            <Link to="/projects" className="btn btn-primary">
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
          <ProjectIcon color={project.color} large />
          <div className="grow">
            <h1>{project.name}</h1>
            <p className="pw-project-description">{project.description || 'Organiza las tareas de este proyecto.'}</p>
          </div>
          <button className="btn btn-secondary" disabled={actions.pending} onClick={() => actions.onEdit(project)}>
            <Pencil size={13} aria-hidden="true" />
            Editar
          </button>
          <button className="btn btn-ghost" disabled={actions.pending} onClick={() => actions.onArchive(project)}>
            <Archive size={14} aria-hidden="true" />
            {project.archived_at ? 'Restaurar' : 'Archivar'}
          </button>
          {!project.archived_at && (
            <button className="btn btn-primary" disabled={actions.pending} onClick={() => onNewTask(project)}>
              <Plus size={14} aria-hidden="true" />
              Nueva tarea
            </button>
          )}
        </div>
        <div className="row pw-project-meta">
          <span className="pstatus">{PROJECT_STATUSES.find(item => item.id === project.status)?.name}</span>
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
      <TasksView
        key={project.id}
        tasks={projectTasks}
        projects={projects}
        pending={actions.pending}
        readOnly={Boolean(project.archived_at)}
        onCreate={status => onNewTask(project, status)}
        onOpen={onOpen}
        onMove={onMove}
      />
    </div>
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
          <span>Solo tu cuenta puede acceder a tus proyectos y tareas.</span>
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

export default function Workspace(props: WorkspaceProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [mobileNav, setMobileNav] = useState(false);
  const [projectEditor, setProjectEditor] = useState<{ project?: Project } | null>(null);
  const [newTask, setNewTask] = useState<{ projectId?: string; status?: TaskStatus } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const actionLock = useRef(false);
  const pending = props.pending || actionBusy;
  const activeProjects = props.projects.filter(project => !project.archived_at);
  const activeProjectIds = useMemo(() => new Set(props.projects.filter(project => !project.archived_at).map(project => project.id)), [props.projects]);
  const activeTasks = props.tasks.filter(task => activeProjectIds.has(task.project_id));
  const taskId = searchParams.get('task');
  const selectedTask = props.tasks.find(task => task.id === taskId);
  const currentProject = props.projects.find(project => location.pathname === `/projects/${project.id}`);
  const pageName =
    currentProject?.name ??
    (location.pathname === '/projects'
      ? 'Proyectos'
      : location.pathname === '/tasks'
        ? 'Mis tareas'
        : location.pathname === '/account'
          ? 'Mi cuenta'
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
    if (task.status === status) return;
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
  function createTask(project?: Project, status?: TaskStatus) {
    setNewTask({ projectId: project?.id, status });
  }
  const projectActions: ProjectActions = { pending, onEdit: project => setProjectEditor({ project }), onArchive: archiveProject };
  const openNewProject = () => setProjectEditor({});
  const openNewTask = () => createTask(currentProject);
  const navClass = ({ isActive }: { isActive: boolean }) => `sitem${isActive ? ' on' : ''}`;

  return (
    <div
      className={`shell personal-workspace${mobileNav ? ' mnav' : ''}`}
      onKeyDown={event => {
        if (event.key === 'Escape' && mobileNav) setMobileNav(false);
      }}
    >
      <a className="skip" href="#workspace-content">
        Ir al contenido
      </a>
      {mobileNav && <button className="side-scrim" aria-label="Cerrar navegación" onClick={() => setMobileNav(false)} />}
      <aside className="side" aria-label="Navegación principal">
        <div className="side-top">
          <Link to="/" className="ws" aria-label="Inicio de TR8" onClick={() => setMobileNav(false)}>
            <span className="ws-logo brand">
              <img src="/favicon.svg" width="22" height="22" alt="" />
            </span>
            <span className="ws-name">TR8</span>
            <span className="pw-personal-label">Personal</span>
          </Link>
        </div>
        <div className="side-scroll">
          <nav onClick={() => setMobileNav(false)}>
            <div className="sgroup">
              <div className="sgroup-h">Mi espacio</div>
              <NavLink to="/" end className={navClass}>
                <Home className="i" size={16} aria-hidden="true" />
                <span>Inicio</span>
              </NavLink>
              <NavLink to="/projects" className={navClass}>
                <LayoutGrid className="i" size={16} aria-hidden="true" />
                <span>Proyectos</span>
                <span className="ct">{activeProjects.length}</span>
              </NavLink>
              <NavLink to="/tasks" className={navClass}>
                <ListTodo className="i" size={16} aria-hidden="true" />
                <span>Mis tareas</span>
                <span className="ct">{activeTasks.filter(task => task.status !== 'done').length}</span>
              </NavLink>
            </div>
            <div className="sgroup">
              <div className="sgroup-h">
                <span>Proyectos activos</span>
                <span className="sp" />
                <button className="ibtn ibtn-xs" aria-label="Crear proyecto" disabled={pending || props.loading} onClick={openNewProject}>
                  <Plus size={13} aria-hidden="true" />
                </button>
              </div>
              {activeProjects.slice(0, 10).map(project => (
                <NavLink key={project.id} to={`/projects/${project.id}`} className={navClass}>
                  <span className="pico" style={{ '--c': project.color } as CSSProperties}>
                    <FolderClosed size={12} aria-hidden="true" />
                  </span>
                  <span className="trunc">{project.name}</span>
                </NavLink>
              ))}
              {activeProjects.length === 0 && <p className="pw-side-empty">Tus proyectos aparecerán aquí.</p>}
            </div>
          </nav>
        </div>
        <div className="side-bot">
          <NavLink to="/account" className={navClass} onClick={() => setMobileNav(false)}>
            <span className="pw-avatar small">{props.email.charAt(0).toUpperCase()}</span>
            <span className="trunc">{props.email}</span>
            <UserRound size={13} className="faint" aria-hidden="true" />
          </NavLink>
        </div>
      </aside>
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
            <Link to="/">Mi espacio</Link>
            <ChevronRight size={12} className="faint" aria-hidden="true" />
            <span className="cur trunc">{pageName}</span>
          </div>
          <div className="sp" />
          <span className="pw-sync" role="status">
            {pending ? (
              'Guardando…'
            ) : props.refreshing ? (
              'Actualizando…'
            ) : (
              <>
                <ShieldCheck size={12} aria-hidden="true" />
                Privado
              </>
            )}
          </span>
          <button className="ibtn" aria-label="Actualizar datos" disabled={props.loading || props.refreshing || pending} onClick={props.onRetry}>
            <RefreshCw size={14} className={props.refreshing ? 'pw-spin' : ''} aria-hidden="true" />
          </button>
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
        <main className="content" id="workspace-content" tabIndex={-1} aria-busy={props.loading}>
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
                  <HomePage
                    projects={props.projects}
                    tasks={props.tasks}
                    onNewProject={openNewProject}
                    onNewTask={openNewTask}
                    onOpen={openTask}
                    {...projectActions}
                  />
                }
              />
              <Route path="/projects" element={<ProjectsPage projects={props.projects} tasks={props.tasks} onNew={openNewProject} {...projectActions} />} />
              <Route
                path="/projects/:id"
                element={
                  <ProjectPage projects={props.projects} tasks={props.tasks} onNewTask={createTask} onOpen={openTask} onMove={moveTask} {...projectActions} />
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
                        <button className="btn btn-primary" disabled={pending || !activeProjects.length} onClick={openNewTask}>
                          <Plus size={14} aria-hidden="true" />
                          Nueva tarea
                        </button>
                      </div>
                    </div>
                    {activeProjects.length ? (
                      <TasksView
                        tasks={activeTasks}
                        projects={props.projects}
                        pending={pending}
                        onCreate={status => createTask(undefined, status)}
                        onOpen={openTask}
                        onMove={moveTask}
                      />
                    ) : (
                      <EmptyState
                        title="Primero, un proyecto"
                        action={
                          <button className="btn btn-primary" disabled={pending} onClick={openNewProject}>
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
      {projectEditor && (
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
            if (isNew) navigate(`/projects/${project.id}`);
          }}
        />
      )}
      {(newTask || selectedTask) && !props.loading && (
        <TaskForm
          key={selectedTask?.id ?? 'new-task'}
          task={newTask ? undefined : selectedTask}
          projectId={newTask?.projectId}
          initialStatus={newTask?.status}
          projects={props.projects}
          pending={pending}
          onCreate={props.onCreateTask}
          onUpdate={props.onUpdateTask}
          onDelete={props.onDeleteTask}
          onClose={closeTask}
        />
      )}
      {taskId && !selectedTask && !newTask && !props.loading && !props.error && (
        <Dialog title="Tarea no encontrada" onClose={closeTask}>
          <div className="pw-form-body">
            <p>Esta tarea no está disponible en tu cuenta o fue eliminada.</p>
            <button className="btn btn-secondary" onClick={closeTask}>
              Cerrar
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

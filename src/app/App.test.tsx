import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceProps, Project, Task, CalendarPage } from './types';
import type { WorkspaceData } from './data/repository';
import { DataError } from './data/errors';
import App from './App';
import { ActivityPanel } from './workspace/Collaboration';
import Calendar from './workspace/Calendar';
import { googleFixture } from './test/google-calendar';
import type { GoogleCalendarStatus } from './data/google-calendar';
import type { PlanningState, ProjectMilestone } from './planning-types';

const mocks = vi.hoisted(() => ({
  auth: { getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn(), resetPasswordForEmail: vi.fn() },
  unsubscribe: vi.fn(),
  files: { list: vi.fn(), upload: vi.fn(), download: vi.fn(), rename: vi.fn(), remove: vi.fn() },
  planning: {
    load: vi.fn(),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    createMilestone: vi.fn(),
    updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(),
  },
  work: {
    duplicateProject: vi.fn(),
    updateTaskDetails: vi.fn(),
    duplicateTask: vi.fn(),
    moveTask: vi.fn(),
    archiveTask: vi.fn(),
  },
  repository: {
    context: vi.fn(),
    resolveProject: vi.fn(),
    createTeam: vi.fn(),
    members: vi.fn(),
    memberDirectory: vi.fn(),
    projectCapabilities: vi.fn(),
    invitations: vi.fn(),
    acceptInvitation: vi.fn(),
    load: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    archiveProject: vi.fn(),
    deleteProject: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    roles: vi.fn(),
    projectAccess: vi.fn(),
    activity: vi.fn(),
    calendarPreferences: vi.fn(),
    setCalendarPreferences: vi.fn(),
    calendarItems: vi.fn(),
    scheduleTask: vi.fn(),
    googleStatus: vi.fn(),
    beginGoogle: vi.fn(),
    completeGoogle: vi.fn(),
    changeGoogle: vi.fn(),
  },
  workspace: null as WorkspaceProps | null,
  showActivity: false,
  showCalendar: false,
  showIntegrations: false,
}));

vi.mock('./data/client', () => ({
  configuration: { ownerEmail: 'owner@example.com', url: 'https://test.supabase.co', publishableKey: 'sb_publishable_fixture' },
  supabase: { auth: mocks.auth },
  callbackRequestedRecovery: false,
}));
vi.mock('./data/repository', () => ({ createRepository: () => mocks.repository }));
vi.mock('./data/planning', () => ({ createPlanningRepository: () => mocks.planning }));
vi.mock('./data/project-files', () => ({ createProjectFilesRepository: () => mocks.files }));
vi.mock('./data/work-management', () => ({
  createWorkManagementRepository: (_client: unknown, workspaceId: string) => ({
    ...mocks.work,
    createProject: (input: unknown, id: string) => mocks.repository.createProject(workspaceId, input, id),
    updateProject: (project: Project, input: unknown) => mocks.repository.updateProject(project, input),
  }),
}));
vi.mock('./auth/AuthScreen', () => ({
  default: ({ recovery }: { recovery: boolean }) => <h1>{recovery ? 'Recuperación' : 'Inicio de sesión'}</h1>,
}));
vi.mock('./workspace/Workspace', () => ({
  default: (props: WorkspaceProps & { integrations?: ReactNode }) => {
    mocks.workspace = props;
    return (
      <section aria-label="Espacio personal">
        {props.loading ? <p role="status">Cargando proyectos</p> : null}
        {props.error ? <p role="alert">{props.error}</p> : null}
        {props.projects.map(project => (
          <p key={project.id}>{project.name}</p>
        ))}
        {props.tasks.map(task => (
          <p key={task.id}>{task.title}</p>
        ))}
        <TestNavigation />
        {mocks.showActivity && !props.loading && props.collaboration && <ActivityPanel api={props.collaboration} />}
        {mocks.showCalendar && !props.loading && props.calendar && (
          <Calendar
            key={JSON.stringify(props.calendar.scopeKey)}
            api={props.calendar}
            workspaces={props.workspaces ?? []}
            projects={props.projects}
            onOpen={() => {}}
          />
        )}
        {mocks.showIntegrations && props.integrations}
        <button onClick={props.onRetry}>Reintentar datos</button>
      </section>
    );
  },
}));

function TestNavigation() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate('/projects/project-a?workspace=personal-a')}>Abrir proyecto A</button>
      <button onClick={() => navigate('/projects/project-b?workspace=personal-a')}>Abrir proyecto B</button>
      <button onClick={() => navigate('/?workspace=team-a')}>Abrir equipo</button>
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function session(id = 'owner-a', email = 'owner@example.com') {
  return { user: { id, email } } as Session;
}

function project(name = 'Proyecto privado', id = 'project-a'): Project {
  return {
    id,
    workspace_id: 'personal-a',
    owner_id: 'owner-a',
    code: 'PRI',
    name,
    description: '',
    color: '#00aa88',
    status: 'active',
    archived_at: null,
    version: 1,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  };
}

function task(title = 'Tarea privada', version = 1): Task {
  return {
    id: 'task-a',
    workspace_id: 'personal-a',
    owner_id: 'owner-a',
    project_id: 'project-a',
    assignee_member_id: null,
    task_number: 1,
    title,
    description: '',
    status: 'todo',
    priority: 'none',
    start_date: null,
    due_date: null,
    position: 1,
    version,
    created_at: '2026-10-22T12:00:00Z',
    updated_at: '2026-10-22T12:00:00Z',
  };
}

const clients: QueryClient[] = [];
let authListener: (event: AuthChangeEvent, next: Session | null) => void;

function show(path = '/', strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        {strict ? (
          <StrictMode>
            <App />
          </StrictMode>
        ) : (
          <App />
        )}
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, ...view };
}

function workspace() {
  if (!mocks.workspace) throw new Error('El espacio todavía no está montado');
  return mocks.workspace;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace = null;
  mocks.showActivity = false;
  mocks.showCalendar = false;
  mocks.showIntegrations = false;
  mocks.planning.load.mockResolvedValue({ dependencies: [], milestones: [] });
  mocks.auth.onAuthStateChange.mockImplementation(callback => {
    authListener = callback;
    return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
  });
  mocks.auth.getSession.mockResolvedValue({ data: { session: session() }, error: null });
  mocks.auth.signOut.mockResolvedValue({ error: null });
  mocks.repository.context.mockResolvedValue({
    contract_version: 2,
    personal_workspace_id: 'personal-a',
    external_invites_enabled: false,
    workspaces: [
      { id: 'personal-a', name: 'Personal', kind: 'personal', owner_id: 'owner-a', version: 1, permissions: ['project.read'] },
      { id: 'team-a', name: 'Equipo', kind: 'team', owner_id: 'owner-a', version: 1, permissions: ['project.read'] },
    ],
  });
  mocks.repository.resolveProject.mockResolvedValue(project());
  mocks.repository.projectCapabilities.mockResolvedValue(
    ['project-a', 'project-b'].map(project_id => ({
      project_id,
      access_level: 'write',
      permissions: [
        'project.read',
        'project.edit',
        'project.archive',
        'task.read',
        'task.create',
        'task.edit',
        'task.delete',
        'task.assign',
        'project.access.manage',
        'audit.read',
      ],
    })),
  );
  mocks.repository.memberDirectory.mockResolvedValue([]);
  mocks.repository.invitations.mockResolvedValue([]);
  mocks.repository.load.mockResolvedValue({ projects: [project()], tasks: [task()] });
  mocks.repository.googleStatus.mockResolvedValue(googleFixture({ configured: false, reason: 'config_pending' }));
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('sesiones y datos del espacio personal', () => {
  it.each([
    ['/privacy', 'Privacidad en TR8'],
    ['/about', 'Un lugar para avanzar'],
  ])('abre %s como información pública antes de Auth y sin consultar cuentas', async (path, heading) => {
    show(path, true);
    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'TR8' })).toBeInTheDocument();
    expect(screen.getByText(/registro no está abierto al público/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'SrEdgarR en GitHub' })).toHaveAttribute('href', 'https://github.com/SrEdgarR');
    expect(screen.getByRole('link', { name: 'Entrar a TR8' })).toHaveAttribute('href', '/');
    expect(screen.queryByText(/sredgarpadilla@gmail\.com/)).not.toBeInTheDocument();
    expect(mocks.auth.getSession).not.toHaveBeenCalled();
    expect(mocks.auth.onAuthStateChange).not.toHaveBeenCalled();
    expect(mocks.repository.context).not.toHaveBeenCalled();
    expect(mocks.repository.googleStatus).not.toHaveBeenCalled();
  });

  it('abre el retorno público de Google sin cargar Auth ni datos y emite solo una señal sin parámetros', async () => {
    const postMessage = vi.fn();
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    const previousOpener = window.opener;
    Object.defineProperty(window, 'opener', { configurable: true, value: { postMessage } });
    try {
      show('/google-calendar/callback?code=ignored&state=ignored#access_token=ignored', true);
      expect(await screen.findByRole('heading', { name: 'Volver a TR8' })).toBeInTheDocument();
      expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'tr8-google-oauth-ready' }, window.location.origin);
      expect(close).toHaveBeenCalledTimes(1);
      expect(mocks.auth.getSession).not.toHaveBeenCalled();
      expect(mocks.auth.onAuthStateChange).not.toHaveBeenCalled();
      expect(mocks.repository.context).not.toHaveBeenCalled();
      expect(mocks.repository.completeGoogle).not.toHaveBeenCalled();
      expect(screen.getByRole('status')).not.toHaveTextContent('ignored');
    } finally {
      Object.defineProperty(window, 'opener', { configurable: true, value: previousOpener });
    }
  });

  it('explica cómo regresar si el callback se abre sin la ventana iniciadora', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    const previousOpener = window.opener;
    Object.defineProperty(window, 'opener', { configurable: true, value: null });
    try {
      show('/google-calendar/callback');
      expect(await screen.findByRole('status')).toHaveTextContent('No encontramos la ventana que inició la conexión');
      expect(close).not.toHaveBeenCalled();
      expect(mocks.auth.getSession).not.toHaveBeenCalled();
      expect(mocks.repository.context).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'opener', { configurable: true, value: previousOpener });
    }
  });

  it('consulta Google por usuario incluso en un equipo sin permiso de leer proyectos', async () => {
    mocks.showIntegrations = true;
    mocks.repository.context.mockResolvedValue({
      contract_version: 2,
      personal_workspace_id: 'personal-a',
      external_invites_enabled: false,
      workspaces: [
        { id: 'personal-a', name: 'Personal', kind: 'personal', owner_id: 'owner-a', version: 1, permissions: ['project.read'] },
        { id: 'team-a', name: 'Equipo', kind: 'team', owner_id: 'other-owner', version: 1, permissions: [] },
      ],
    });
    const { client } = show('/settings?workspace=team-a');
    await screen.findByText('Configuración pendiente');
    expect(mocks.repository.load).not.toHaveBeenCalled();
    expect(mocks.repository.googleStatus).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(client.getQueryData(['google-calendar', 'owner-a', 'status'])).toMatchObject({ configured: false });
    expect(mocks.repository.beginGoogle).not.toHaveBeenCalled();
  });

  it('retira Google al cerrar sesión e ignora su lectura tardía', async () => {
    mocks.showIntegrations = true;
    const pending = deferred<GoogleCalendarStatus>();
    let googleSignal: AbortSignal | undefined;
    mocks.repository.googleStatus.mockImplementation((signal: AbortSignal) => {
      googleSignal = signal;
      return pending.promise;
    });
    const { client } = show('/settings');
    await waitFor(() => expect(mocks.repository.googleStatus).toHaveBeenCalledOnce());
    act(() => authListener('SIGNED_OUT', null));
    await screen.findByRole('heading', { name: 'Inicio de sesión' });
    expect(googleSignal?.aborted).toBe(true);
    await act(async () => pending.resolve(googleFixture({ state: 'connected', generation: 10, version: 10, pending: 99 })));
    expect(screen.queryByText('Conectado')).not.toBeInTheDocument();
    expect(client.getQueriesData({ queryKey: ['google-calendar'] })).toHaveLength(0);
  });

  function calendarSetup() {
    mocks.showCalendar = true;
    const context = {
      contract_version: 2,
      personal_workspace_id: 'personal-a',
      external_invites_enabled: false,
      workspaces: [
        { id: 'personal-a', name: 'Personal', kind: 'personal', owner_id: 'owner-a', version: 1, permissions: ['project.read', 'task.read'] },
        { id: 'team-a', name: 'Otro equipo', kind: 'team', owner_id: 'other-owner', version: 1, permissions: ['project.read', 'task.read'] },
      ],
    };
    const date = new Date().toISOString().slice(0, 10);
    const page: CalendarPage = {
      items: [
        {
          id: 'remote-task:due',
          kind: 'due',
          workspace_id: 'team-a',
          workspace_name: 'Otro equipo',
          project_id: 'remote-project',
          project_name: 'Proyecto del otro espacio',
          project_color: '#123456',
          project_archived_at: null,
          task_id: 'remote-task',
          title: 'Evento privado de otro espacio',
          status: 'todo',
          priority: 'none',
          version: 1,
          assignee_member_id: null,
          assignee_name: null,
          start_date: null,
          due_date: date,
          scheduled_start_at: null,
          scheduled_end_at: null,
          scheduled_time_zone: null,
          date,
          start_at: null,
          end_at: null,
          can_edit: false,
        },
      ],
      next_cursor: null,
    };
    mocks.repository.context.mockResolvedValue(context);
    mocks.repository.calendarPreferences.mockResolvedValue({ time_zone: 'America/La_Paz', version: 2, updated_at: null });
    mocks.repository.calendarItems.mockResolvedValue(page);
    return context;
  }

  it('oculta el calendario global ante una denegación sin bloquear el espacio personal y permite volver a comprobar el acceso', async () => {
    calendarSetup();
    const { client } = show('/calendar');
    await screen.findAllByRole('button', { name: /Vencimiento de Evento privado de otro espacio/ });
    mocks.repository.calendarItems.mockRejectedValue(new DataError('Cambió el acceso al calendario.', 'PT404'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['calendar', 'owner-a'] });
    });
    await waitFor(() => expect(screen.queryAllByRole('button', { name: /Evento privado de otro espacio/ })).toHaveLength(0));
    expect(workspace().calendar?.accessError).toContain('Cambió el acceso');
    expect(workspace().accessUnavailable).toBe(false);
    expect(screen.getByText('Proyecto privado')).toBeInTheDocument();
    mocks.repository.calendarItems.mockResolvedValue({ items: [], next_cursor: null });
    await act(async () => {
      await workspace().calendar?.retryAccess?.();
    });
    await waitFor(() => expect(workspace().calendar?.accessError).toBeNull());
    expect(screen.getByText('Tarea privada')).toBeInTheDocument();
  });

  it('retira elementos de otro espacio al cambiar sus permisos mientras la nueva consulta todavía está pendiente', async () => {
    const context = calendarSetup();
    const { client } = show('/calendar');
    await screen.findAllByRole('button', { name: /Vencimiento de Evento privado de otro espacio/ });
    const pending = deferred<CalendarPage>();
    mocks.repository.calendarItems.mockReturnValue(pending.promise);
    mocks.repository.context.mockResolvedValue({
      ...context,
      workspaces: context.workspaces.map(space => (space.id === 'team-a' ? { ...space, permissions: [] } : space)),
    });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['context', 'owner-a'] });
    });
    await waitFor(() => expect(screen.queryAllByRole('button', { name: /Evento privado de otro espacio/ })).toHaveLength(0));
    expect(workspace().accessUnavailable).toBe(false);
    expect(screen.getByText('Proyecto privado')).toBeInTheDocument();
    await act(async () => pending.resolve({ items: [], next_cursor: null }));
    expect(screen.queryAllByRole('button', { name: /Evento privado de otro espacio/ })).toHaveLength(0);
  });

  it('retira actividad privada inmediatamente al cambiar ACL sin cambiar roles y espera la nueva lectura', async () => {
    mocks.showActivity = true;
    mocks.auth.getSession.mockResolvedValue({ data: { session: session('delegate-a') }, error: null });
    mocks.repository.context.mockResolvedValue({
      contract_version: 2,
      personal_workspace_id: 'personal-a',
      external_invites_enabled: false,
      workspaces: [{ id: 'team-a', kind: 'team', name: 'Equipo', owner_id: 'owner-a', version: 1, permissions: ['project.read', 'task.read', 'audit.read'] }],
    });
    mocks.repository.activity.mockResolvedValue({
      items: [
        {
          id: 2,
          project_id: 'project-a',
          actor_id: 'old-actor',
          actor_name: 'Participante privado',
          action: 'task.updated',
          resource_id: 'task-a',
          created_at: '2026-10-23T12:00:00Z',
        },
      ],
      next_before_id: null,
    });
    const { client } = show('/team?workspace=team-a');
    await screen.findByText('Participante privado');
    const oldScope = workspace().collaboration!.scopeKey;
    client.setQueryData([...oldScope, 'assignable', 'project-a'], [{ display_name: 'Asignable privado' }]);
    client.setQueryData([...oldScope, 'access', 'project-a'], [{ display_name: 'Acceso privado' }]);
    const oldPermissions = [...workspace().workspace!.permissions];
    const nextActivity = deferred<{ items: never[]; next_before_id: null }>();
    mocks.repository.activity.mockReturnValue(nextActivity.promise);
    mocks.repository.projectCapabilities.mockResolvedValue([
      { project_id: 'project-b', access_level: 'read', permissions: ['project.read', 'task.read', 'audit.read'] },
    ]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['workspace', 'delegate-a', 'team-a'] });
    });
    await waitFor(() => expect(screen.queryByText('Participante privado')).not.toBeInTheDocument());
    expect(workspace().workspace!.permissions).toEqual(oldPermissions);
    expect(workspace().collaboration!.scopeKey).not.toEqual(oldScope);
    expect(client.getQueriesData({ queryKey: oldScope })).toEqual([]);
    expect(screen.queryByText('Tarea privada')).not.toBeInTheDocument();
    expect(client.getQueryState([...workspace().collaboration!.scopeKey, 'activity', null])?.fetchStatus).toBe('fetching');
    await act(async () => nextActivity.resolve({ items: [], next_before_id: null }));
    expect(await screen.findByText('Todavía no hay actividad disponible.')).toBeInTheDocument();
    expect(screen.queryByText('Participante privado')).not.toBeInTheDocument();
  });

  it('no reutiliza datos frescos ni consultas de la revisión anterior al perder permisos en el contexto', async () => {
    mocks.auth.getSession.mockResolvedValue({ data: { session: session('delegate-a') }, error: null });
    const original = {
      contract_version: 2,
      personal_workspace_id: 'personal-a',
      external_invites_enabled: false,
      workspaces: [
        { id: 'team-a', kind: 'team', name: 'Equipo', owner_id: 'owner-a', version: 1, permissions: ['project.read', 'task.read', 'role.read', 'role.manage'] },
      ],
    };
    mocks.repository.context.mockResolvedValue(original);
    const { client } = show('/team?workspace=team-a');
    await screen.findByText('Tarea privada');
    const previousScope = workspace().collaboration!.scopeKey;
    client.setQueryData([...previousScope, 'roles'], [{ name: 'Rol reservado' }]);
    mocks.repository.context.mockResolvedValue({ ...original, workspaces: [{ ...original.workspaces[0], permissions: ['role.manage'] }] });
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['context', 'delegate-a'] });
    });
    await waitFor(() => expect(screen.queryByText('Proyecto privado')).not.toBeInTheDocument());
    expect(screen.queryByText('Tarea privada')).not.toBeInTheDocument();
    expect(workspace().collaboration!.scopeKey).not.toEqual(previousScope);
    expect(client.getQueriesData({ queryKey: previousScope })).toEqual([]);
    expect(mocks.repository.load).toHaveBeenCalledOnce();
    expect(mocks.repository.projectCapabilities).toHaveBeenCalledOnce();
    expect(workspace().workspace?.permissions).toEqual(['role.manage']);
  });

  it('descarta la respuesta de un guardado iniciado antes de perder acceso al proyecto', async () => {
    const pending = deferred<Task>();
    mocks.repository.updateTask.mockReturnValue(pending.promise);
    const { client } = show();
    await screen.findByText('Tarea privada');
    let save!: Promise<Task>;
    act(() => {
      save = workspace().onUpdateTask(task(), { title: 'Respuesta privada tardía' });
    });
    await waitFor(() => expect(mocks.repository.updateTask).toHaveBeenCalledOnce());
    mocks.repository.projectCapabilities.mockResolvedValue([]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['workspace', 'owner-a', 'personal-a'] });
    });
    await waitFor(() => expect(screen.queryByText('Tarea privada')).not.toBeInTheDocument());
    // Keep the next refresh pending so it cannot mask a stale optimistic insertion.
    mocks.repository.load.mockReturnValue(new Promise<WorkspaceData>(() => {}));
    const rejected = expect(save).rejects.toThrow('El acceso cambió');
    await act(async () => {
      pending.resolve(task('Respuesta privada tardía', 2));
      await rejected;
    });
    expect(workspace().tasks).toEqual([]);
    expect(screen.queryByText('Respuesta privada tardía')).not.toBeInTheDocument();
  });

  it('descarta una lectura de acceso al proyecto si sus permisos cambian durante la petición', async () => {
    const pending = deferred<never[]>();
    mocks.repository.projectAccess.mockReturnValue(pending.promise);
    const { client } = show();
    await screen.findByText('Tarea privada');
    const read = workspace().collaboration!.projectAccess('project-a');
    mocks.repository.projectCapabilities.mockResolvedValue([]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['workspace', 'owner-a', 'personal-a'] });
    });
    await waitFor(() => expect(workspace().capabilities).toEqual({}));
    const rejected = expect(read).rejects.toThrow('El acceso cambió');
    await act(async () => {
      pending.resolve([]);
      await rejected;
    });
  });

  it('permite administrar roles sin requerir acceso al contenido de proyectos', async () => {
    mocks.auth.getSession.mockResolvedValue({ data: { session: session('delegate-a') }, error: null });
    mocks.repository.context.mockResolvedValue({
      contract_version: 2,
      personal_workspace_id: 'personal-a',
      external_invites_enabled: false,
      workspaces: [{ id: 'team-a', kind: 'team', name: 'Equipo', owner_id: 'owner-a', version: 1, permissions: ['member.read', 'role.read', 'role.manage'] }],
    });
    show('/team?workspace=team-a');
    await waitFor(() => expect(workspace().loading).toBe(false));
    expect(mocks.repository.load).not.toHaveBeenCalled();
    expect(mocks.repository.projectCapabilities).not.toHaveBeenCalled();
    expect(mocks.repository.memberDirectory).toHaveBeenCalledWith('team-a');
    expect(workspace().projects).toEqual([]);
    expect(workspace().collaboration).toBeDefined();
  });

  it('deja al servidor autorizar un colaborador que puede escribir aunque no sea propietario', async () => {
    mocks.auth.getSession.mockResolvedValue({ data: { session: session('collaborator-a') }, error: null });
    mocks.repository.updateTask.mockResolvedValue({ ...task(), title: 'Cambio confirmado', version: 2 });
    show();
    await screen.findByText('Tarea privada');
    await act(async () => {
      await workspace().onUpdateTask(task(), { title: 'Cambio confirmado' });
    });
    expect(mocks.repository.updateTask).toHaveBeenCalledWith(task(), { title: 'Cambio confirmado' });
  });

  it('retira proyectos y tareas al refrescar capacidades aunque una lectura anterior aún devuelva las filas', async () => {
    const { client } = show();
    await screen.findByText('Tarea privada');
    mocks.repository.projectCapabilities.mockResolvedValue([]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['workspace', 'owner-a', 'personal-a'] });
    });
    await waitFor(() => expect(screen.queryByText('Proyecto privado')).not.toBeInTheDocument());
    expect(screen.queryByText('Tarea privada')).not.toBeInTheDocument();
    expect(workspace().capabilities).toEqual({});
    expect(client.getQueriesData<WorkspaceData>({ queryKey: ['workspace', 'owner-a', 'personal-a'] })[0]?.[1]?.tasks).toEqual([]);
  });

  it('limpia también directorios y administración en caché cuando una consulta sensible es denegada', async () => {
    const { client } = show();
    await screen.findByText('Tarea privada');
    client.setQueryData([...workspace().collaboration!.scopeKey, 'access', 'project-a'], [{ display_name: 'Dato anterior' }]);
    client.setQueryData(['directory', 'owner-a', 'personal-a', 'project.read'], { members: [{ display_name: 'Dato anterior' }] });
    mocks.repository.roles.mockRejectedValue(new DataError('Permiso retirado.', '42501'));
    await act(async () => {
      await expect(workspace().collaboration!.roles()).rejects.toMatchObject({ code: '42501' });
    });
    expect(workspace().accessUnavailable).toBe(true);
    expect(client.getQueriesData({ queryKey: ['collaboration', 'owner-a', 'personal-a'] })).toEqual([]);
    expect(client.getQueriesData({ queryKey: ['directory', 'owner-a', 'personal-a'] }).every(([, data]) => data === undefined)).toBe(true);
    expect(screen.queryByText('Tarea privada')).not.toBeInTheDocument();
  });

  it('carga datos con el ciclo doble de efectos de React StrictMode', async () => {
    show('/', true);
    expect(await screen.findByText('Proyecto privado')).toBeInTheDocument();
    expect(screen.getByText('Tarea privada')).toBeInTheDocument();
  });

  it('permite una cuenta habilitada cuyo correo difiere de la configuración inicial', async () => {
    mocks.auth.getSession.mockResolvedValue({ data: { session: session('member-a', 'member@example.com') }, error: null });
    mocks.repository.context.mockResolvedValue({
      contract_version: 2,
      personal_workspace_id: 'personal-a',
      external_invites_enabled: false,
      workspaces: [{ id: 'personal-a', kind: 'personal', name: 'Personal', owner_id: 'member-a', version: 1, permissions: ['project.read'] }],
    });
    show();
    expect(await screen.findByText('Proyecto privado')).toBeInTheDocument();
    expect(mocks.repository.context).toHaveBeenCalled();
    expect(workspace().currentUserId).toBe('member-a');
    expect(workspace().capabilities?.['project-a'].permissions).toContain('project.read');
  });
  it('no consulta proyectos antes de resolver la sesión', async () => {
    const pending = deferred<{ data: { session: Session }; error: null }>();
    mocks.auth.getSession.mockReturnValue(pending.promise);
    show();
    expect(screen.getByRole('status')).toHaveTextContent('Comprobando la sesión');
    expect(mocks.repository.load).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ data: { session: session() }, error: null }));
    expect(await screen.findByText('Proyecto privado')).toBeInTheDocument();
    expect(screen.getByText('Tarea privada')).toBeInTheDocument();
  });

  it('ignora una respuesta de sesión inicial anterior a un evento de autenticación', async () => {
    const pending = deferred<{ data: { session: null }; error: null }>();
    mocks.auth.getSession.mockReturnValue(pending.promise);
    show();
    act(() => authListener('SIGNED_IN', session()));
    expect(await screen.findByText('Proyecto privado')).toBeInTheDocument();
    await act(async () => pending.resolve({ data: { session: null }, error: null }));
    expect(screen.getByText('Proyecto privado')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Inicio de sesión' })).not.toBeInTheDocument();
  });

  it('conserva una sesión válida si la comprobación inicial rechaza tarde', async () => {
    const pending = deferred<never>();
    mocks.auth.getSession.mockReturnValue(pending.promise);
    show();
    act(() => authListener('SIGNED_IN', session()));
    expect(await screen.findByText('Proyecto privado')).toBeInTheDocument();
    await act(async () => pending.reject(new Error('Network connection failed')));
    expect(screen.getByText('Proyecto privado')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No pudimos abrir tu sesión' })).not.toBeInTheDocument();
  });

  it('exige habilitación del servidor en lugar de comparar el correo con la configuración', async () => {
    mocks.auth.getSession.mockResolvedValue({ data: { session: session('other', 'other@example.com') }, error: null });
    mocks.repository.context.mockRejectedValue(new DataError('La cuenta no está habilitada.', '42501'));
    show();
    expect(await screen.findByRole('heading', { name: 'Esta cuenta no tiene acceso' })).toBeInTheDocument();
    expect(mocks.repository.load).not.toHaveBeenCalled();
  });

  it('dirige una sesión PASSWORD_RECOVERY al cambio de contraseña antes de descargar datos', async () => {
    const pending = deferred<never>();
    mocks.auth.getSession.mockReturnValue(pending.promise);
    show();
    act(() => authListener('PASSWORD_RECOVERY', session()));
    expect(await screen.findByRole('heading', { name: 'Recuperación' })).toBeInTheDocument();
    expect(mocks.repository.load).not.toHaveBeenCalled();
  });

  it('informa un fallo de red y permite recargar los datos sin cerrar sesión', async () => {
    mocks.repository.load.mockRejectedValueOnce(new Error('Failed to fetch')).mockRejectedValueOnce(new Error('Failed to fetch'));
    show();
    expect(await screen.findByRole('alert')).toHaveTextContent('problema de conexión');
    expect(screen.queryByText('Proyecto privado')).not.toBeInTheDocument();
    await act(async () => workspace().onRetry());
    expect(await screen.findByText('Proyecto privado')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(mocks.auth.signOut).not.toHaveBeenCalled();
  });

  it('retira datos previamente cargados y su caché cuando la recarga pierde autorización', async () => {
    const { client } = show();
    await screen.findByText('Proyecto privado');
    mocks.repository.load.mockRejectedValue(new DataError('Ya no tienes acceso.', '42501'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['workspace', 'owner-a', 'personal-a'] });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Ya no tienes acceso');
    expect(screen.queryByText('Proyecto privado')).not.toBeInTheDocument();
    expect(screen.queryByText('Tarea privada')).not.toBeInTheDocument();
    expect(client.getQueryData(['workspace', 'owner-a', 'personal-a'])).toBeUndefined();
    mocks.repository.load.mockResolvedValue({ projects: [project()], tasks: [task()] });
    await act(async () => workspace().onRetry());
    expect(await screen.findByText('Proyecto privado')).toBeInTheDocument();
  });

  it('retira los datos y no conserva el borrador como guardado si una escritura es denegada', async () => {
    const { client } = show();
    await screen.findByText('Proyecto privado');
    mocks.repository.updateTask.mockRejectedValue(new DataError('Permiso retirado.', '42501'));
    await act(async () => {
      await expect(workspace().onUpdateTask(task(), { title: 'Cambio rechazado' })).rejects.toMatchObject({ code: '42501' });
    });
    expect(screen.queryByText('Proyecto privado')).not.toBeInTheDocument();
    expect(screen.queryByText('Tarea privada')).not.toBeInTheDocument();
    expect(screen.queryByText('Cambio rechazado')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Permiso retirado');
    expect(client.getQueryData(['workspace', 'owner-a', 'personal-a'])).toBeUndefined();
  });

  it('cancela la consulta anterior y limpia su caché al cambiar de usuario', async () => {
    const firstLoad = deferred<WorkspaceData>();
    let firstSignal: AbortSignal | undefined;
    mocks.repository.load
      .mockImplementationOnce((_scope: string, signal: AbortSignal) => {
        firstSignal = signal;
        return firstLoad.promise;
      })
      .mockResolvedValueOnce({ projects: [project('Proyecto de la segunda sesión', 'project-b')], tasks: [] });
    const { client } = show();
    await waitFor(() => expect(mocks.repository.load).toHaveBeenCalledOnce());
    act(() => authListener('SIGNED_IN', session('owner-b')));
    expect(await screen.findByText('Proyecto de la segunda sesión')).toBeInTheDocument();
    expect(firstSignal?.aborted).toBe(true);
    await act(async () => firstLoad.resolve({ projects: [project('Datos de la sesión anterior')], tasks: [] }));
    expect(screen.queryByText('Datos de la sesión anterior')).not.toBeInTheDocument();
    expect(client.getQueryData(['workspace', 'owner-a', 'personal-a'])).toBeUndefined();
    expect(client.getQueriesData<WorkspaceData>({ queryKey: ['workspace', 'owner-b', 'personal-a'] })[0]?.[1]?.projects[0].name).toBe(
      'Proyecto de la segunda sesión',
    );
  });

  it('no repuebla la caché con un guardado que termina después del cierre de sesión', async () => {
    const pending = deferred<Project>();
    mocks.repository.createProject.mockReturnValue(pending.promise);
    const { client } = show();
    await screen.findByText('Proyecto privado');
    let save!: Promise<Project>;
    act(() => {
      save = workspace().onCreateProject({ name: 'Nuevo', description: '', color: '#00aa88', status: 'active' }, 'request-a');
    });
    await waitFor(() => expect(mocks.repository.createProject).toHaveBeenCalledOnce());
    act(() => authListener('SIGNED_OUT', null));
    expect(await screen.findByRole('heading', { name: 'Inicio de sesión' })).toBeInTheDocument();
    await act(async () => {
      pending.resolve(project('Nuevo', 'request-a'));
      await expect(save).rejects.toThrow('El espacio cambió');
    });
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(screen.queryByText('Nuevo')).not.toBeInTheDocument();
  });

  it('cancela y retira datos al cambiar de espacio e ignora una respuesta tardía', async () => {
    const pending = deferred<WorkspaceData>();
    let signal: AbortSignal | undefined;
    mocks.repository.load
      .mockImplementationOnce((_scope: string, abort: AbortSignal) => {
        signal = abort;
        return pending.promise;
      })
      .mockResolvedValue({ projects: [{ ...project('Proyecto del equipo'), workspace_id: 'team-a' }], tasks: [] });
    const { client } = show();
    await waitFor(() => expect(mocks.repository.load).toHaveBeenCalledOnce());
    act(() => workspace().onSelectWorkspace?.('team-a'));
    expect(await screen.findByText('Proyecto del equipo')).toBeInTheDocument();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve({ projects: [project('Personal tardío')], tasks: [] }));
    expect(screen.queryByText('Personal tardío')).not.toBeInTheDocument();
    expect(client.getQueryData(['workspace', 'owner-a', 'personal-a'])).toBeUndefined();
    expect(mocks.repository.load.mock.calls.every(([scope]) => typeof scope === 'string')).toBe(true);
  });

  it('abre un enlace antiguo consultando solo su proyecto y después el espacio autorizado', async () => {
    mocks.repository.resolveProject.mockResolvedValue({ ...project('Proyecto del equipo'), workspace_id: 'team-a' });
    mocks.repository.load.mockResolvedValue({ projects: [{ ...project('Proyecto del equipo'), workspace_id: 'team-a' }], tasks: [] });
    show('/projects/project-a?view=board');
    expect(await screen.findByText('Proyecto del equipo')).toBeInTheDocument();
    expect(mocks.repository.resolveProject).toHaveBeenCalledWith('project-a', expect.any(AbortSignal));
    expect(mocks.repository.load).toHaveBeenCalledWith('team-a', expect.any(AbortSignal));
    expect(mocks.repository.load).not.toHaveBeenCalledWith('personal-a', expect.anything());
  });

  it('mantiene montado y cargado el espacio al alternar proyectos desde enlaces internos', async () => {
    mocks.repository.load.mockResolvedValue({ projects: [project(), project('Segundo proyecto', 'project-b')], tasks: [task()] });
    // A locator request would otherwise replace the whole workspace with its
    // startup screen. Internal links must not need that request at all.
    mocks.repository.resolveProject.mockReturnValue(new Promise(() => {}));
    const { client } = show();
    await screen.findByText('Proyecto privado');
    const originalShell = screen.getByRole('region', { name: 'Espacio personal' });
    for (let index = 0; index < 3; index += 1) {
      act(() => screen.getByRole('button', { name: 'Abrir proyecto A' }).click());
      expect(screen.getByRole('region', { name: 'Espacio personal' })).toBe(originalShell);
      act(() => screen.getByRole('button', { name: 'Abrir proyecto B' }).click());
      expect(screen.getByRole('region', { name: 'Espacio personal' })).toBe(originalShell);
      expect(workspace().loading).toBe(false);
    }
    expect(mocks.repository.resolveProject).not.toHaveBeenCalled();
    expect(mocks.repository.load).toHaveBeenCalledOnce();
    expect(client.getQueriesData<WorkspaceData>({ queryKey: ['workspace', 'owner-a', 'personal-a'] })[0]?.[1]?.projects).toHaveLength(2);
  });

  it('ignora un localizador anterior al abrir un espacio explícito', async () => {
    mocks.repository.load.mockImplementation((workspaceId: string) =>
      Promise.resolve({
        projects: [{ ...project(workspaceId === 'team-a' ? 'Proyecto del equipo' : 'Proyecto privado'), workspace_id: workspaceId }],
        tasks: [],
      }),
    );
    show('/projects/project-a');
    await screen.findByText('Proyecto privado');
    act(() => screen.getByRole('button', { name: 'Abrir equipo' }).click());
    expect(await screen.findByText('Proyecto del equipo')).toBeInTheDocument();
    expect(workspace().workspace?.id).toBe('team-a');
    expect(mocks.repository.load).toHaveBeenCalledWith('team-a', expect.any(AbortSignal));
    expect(mocks.repository.resolveProject).toHaveBeenCalledOnce();
  });

  it('retira solo el proyecto confirmado y sus tareas, cancela lecturas anteriores y limpia su enlace antiguo', async () => {
    const removedProject = project();
    const keptProject = project('Proyecto conservado', 'project-b');
    const keptTask = { ...task('Tarea conservada'), id: 'task-b', project_id: keptProject.id };
    const initial = { projects: [removedProject, keptProject], tasks: [task(), keptTask] };
    const after = { projects: [keptProject], tasks: [keptTask] };
    const pendingRead = deferred<WorkspaceData>();
    let readSignal: AbortSignal | undefined;
    mocks.repository.load
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce((_id: string, signal: AbortSignal) => {
        readSignal = signal;
        return pendingRead.promise;
      })
      .mockResolvedValue(after);
    mocks.repository.projectCapabilities
      .mockResolvedValueOnce([
        { project_id: removedProject.id, access_level: 'write', permissions: ['project.read', 'project.delete', 'task.read'] },
        { project_id: keptProject.id, access_level: 'write', permissions: ['project.read', 'task.read'] },
      ])
      .mockResolvedValue([{ project_id: keptProject.id, access_level: 'write', permissions: ['project.read', 'task.read'] }]);
    mocks.repository.deleteProject.mockResolvedValue(undefined);
    const { client } = show();
    await screen.findByText('Tarea privada');
    const locatorKey = ['project-location', 'owner-a', removedProject.id];
    client.setQueryData(locatorKey, { workspace_id: 'personal-a' });
    act(() => {
      void client.invalidateQueries({ queryKey: ['workspace', 'owner-a', 'personal-a'] });
    });
    await waitFor(() => expect(mocks.repository.load).toHaveBeenCalledTimes(2));
    await act(async () => {
      await workspace().onDeleteProject(removedProject, removedProject.name);
    });
    expect(mocks.repository.deleteProject).toHaveBeenCalledExactlyOnceWith(removedProject, removedProject.name);
    expect(readSignal?.aborted).toBe(true);
    expect(await screen.findByText('Proyecto conservado')).toBeInTheDocument();
    expect(screen.getByText('Tarea conservada')).toBeInTheDocument();
    expect(screen.queryByText('Proyecto privado')).not.toBeInTheDocument();
    expect(screen.queryByText('Tarea privada')).not.toBeInTheDocument();
    expect(client.getQueryData(locatorKey)).toBeUndefined();
    await act(async () => pendingRead.resolve(initial));
    expect(screen.queryByText('Proyecto privado')).not.toBeInTheDocument();
    expect(workspace().projects).toEqual([keptProject]);
    expect(workspace().tasks).toEqual([keptTask]);
    expect(workspace().capabilities?.[removedProject.id]).toBeUndefined();
  });

  it('actualiza el registro ante un conflicto de versión y conserva el error de guardado', async () => {
    const changed = task('Cambio desde otro dispositivo', 2);
    mocks.repository.load.mockResolvedValueOnce({ projects: [project()], tasks: [task()] }).mockResolvedValue({ projects: [project()], tasks: [changed] });
    mocks.repository.updateTask.mockRejectedValue(new DataError('El registro cambió en otra sesión.', 'PT409'));
    show();
    await screen.findByText('Tarea privada');
    await act(async () => {
      await expect(workspace().onUpdateTask(task(), { title: 'Mi edición' })).rejects.toMatchObject({ code: 'PT409' });
    });
    expect(await screen.findByText('Cambio desde otro dispositivo')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('El registro cambió en otra sesión.');
    expect(screen.queryByText('Mi edición')).not.toBeInTheDocument();
  });

  it('acepta los metadatos confirmados sin retirar otras tareas del snapshot', async () => {
    const kept = { ...task('Trabajo conservado'), id: 'kept-task' };
    const saved = { ...task(), version: 2, labels: ['Diseño'], estimate_minutes: 60, subtasks: [] };
    mocks.repository.load.mockResolvedValue({ projects: [project()], tasks: [task(), kept] });
    mocks.work.updateTaskDetails.mockImplementation(async () => {
      mocks.repository.load.mockResolvedValue({ projects: [project()], tasks: [saved, kept] });
      return saved;
    });
    show();
    await screen.findByText('Tarea privada');
    await act(async () => {
      await workspace().workManagement!.updateTaskDetails(task(), { labels: ['Diseño'], estimate_minutes: 60, subtasks: [] });
    });
    await waitFor(() => expect(workspace().tasks).toEqual(expect.arrayContaining([saved, kept])));
    expect(mocks.work.updateTaskDetails).toHaveBeenCalledExactlyOnceWith(task(), { labels: ['Diseño'], estimate_minutes: 60, subtasks: [] });
  });

  it('rechaza el resultado tardío de detalle después de cambiar de espacio', async () => {
    const waiting = deferred<Task>();
    mocks.work.updateTaskDetails.mockReturnValue(waiting.promise);
    mocks.repository.load.mockImplementation(async (id: string) =>
      id === 'team-a' ? { projects: [], tasks: [] } : { projects: [project()], tasks: [task()] },
    );
    show();
    await screen.findByText('Tarea privada');
    let save!: Promise<Task>;
    act(() => {
      save = workspace().workManagement!.updateTaskDetails(task(), { labels: ['Privada'], estimate_minutes: null, subtasks: [] });
    });
    const rejected = expect(save).rejects.toThrow('espacio cambió');
    await act(async () => {
      screen.getByRole('button', { name: 'Abrir equipo' }).click();
    });
    await waitFor(() => expect(workspace().workspace?.id).toBe('team-a'));
    await act(async () => {
      waiting.resolve({ ...task(), version: 2, labels: ['Privada'] });
      await rejected;
    });
    expect(workspace().tasks).toEqual([]);
    expect(screen.queryByText('Tarea privada')).not.toBeInTheDocument();
  });

  it('guarda hitos sin reemplazar los proyectos o tareas del espacio', async () => {
    const input = { name: 'Publicación', date: '2026-11-20', completed: false };
    const saved: ProjectMilestone = {
      ...input,
      id: 'milestone-a',
      workspace_id: 'personal-a',
      project_id: 'project-a',
      version: 1,
      created_at: project().created_at,
      updated_at: project().updated_at,
    };
    mocks.planning.createMilestone.mockResolvedValue(saved);
    show();
    await screen.findByText('Tarea privada');
    await act(async () => {
      expect(await workspace().planning!.createMilestone(project(), input, saved.id)).toEqual(saved);
    });
    expect(workspace().tasks).toEqual([task()]);
    expect(workspace().projects).toEqual([project()]);
    expect(mocks.repository.updateTask).not.toHaveBeenCalled();
    expect(mocks.planning.createMilestone).toHaveBeenCalledExactlyOnceWith(project(), input, saved.id);
  });

  it('rechaza la lectura de planificación del espacio abandonado', async () => {
    const waiting = deferred<PlanningState>();
    mocks.planning.load.mockReturnValue(waiting.promise);
    mocks.repository.load.mockImplementation(async (id: string) =>
      id === 'team-a' ? { projects: [], tasks: [] } : { projects: [project()], tasks: [task()] },
    );
    show();
    await screen.findByText('Tarea privada');
    const pending = workspace().planning!.load();
    const rejected = expect(pending).rejects.toThrow('espacio cambió');
    await act(async () => {
      screen.getByRole('button', { name: 'Abrir equipo' }).click();
    });
    await waitFor(() => expect(workspace().workspace?.id).toBe('team-a'));
    await act(async () => {
      waiting.resolve({ dependencies: [], milestones: [] });
      await rejected;
    });
    expect(workspace().projects).toEqual([]);
  });

  it('rechaza un segundo guardado simultáneo para evitar escrituras con la misma versión', async () => {
    const pending = deferred<Task>();
    mocks.repository.updateTask.mockReturnValue(pending.promise);
    show();
    await screen.findByText('Tarea privada');
    let save!: Promise<Task>;
    act(() => {
      save = workspace().onUpdateTask(task(), { status: 'done' });
    });
    await waitFor(() => expect(mocks.repository.updateTask).toHaveBeenCalledOnce());
    await expect(workspace().onUpdateTask(task(), { status: 'progress' })).rejects.toThrow('Espera a que termine');
    expect(mocks.repository.updateTask).toHaveBeenCalledOnce();
    await act(async () => {
      pending.resolve({ ...task(), status: 'done', version: 2 });
      await save;
    });
  });
});

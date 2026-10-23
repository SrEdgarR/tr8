import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceProps, Project, Task } from './types';
import type { WorkspaceData } from './data/repository';
import { DataError } from './data/errors';
import App from './App';
import { ActivityPanel } from './workspace/Collaboration';

const mocks = vi.hoisted(() => ({
  auth: { getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn(), resetPasswordForEmail: vi.fn() },
  unsubscribe: vi.fn(),
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
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    roles: vi.fn(),
    activity: vi.fn(),
  },
  workspace: null as WorkspaceProps | null,
  showActivity: false,
}));

vi.mock('./data/client', () => ({
  configuration: { ownerEmail: 'owner@example.com' },
  supabase: { auth: mocks.auth },
  callbackRequestedRecovery: false,
}));
vi.mock('./data/repository', () => ({ createRepository: () => mocks.repository }));
vi.mock('./auth/AuthScreen', () => ({
  default: ({ recovery }: { recovery: boolean }) => <h1>{recovery ? 'Recuperación' : 'Inicio de sesión'}</h1>,
}));
vi.mock('./workspace/Workspace', () => ({
  default: (props: WorkspaceProps) => {
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
        {mocks.showActivity && !props.loading && props.collaboration && <ActivityPanel api={props.collaboration} />}
        <button onClick={props.onRetry}>Reintentar datos</button>
      </section>
    );
  },
}));

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
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('sesiones y datos del espacio personal', () => {
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

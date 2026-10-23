import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceProps, Project, Task } from './types';
import type { WorkspaceData } from './data/repository';
import { DataError } from './data/errors';
import App from './App';

const mocks = vi.hoisted(() => ({
  auth: { getSession: vi.fn(), onAuthStateChange: vi.fn(), signOut: vi.fn(), resetPasswordForEmail: vi.fn() },
  unsubscribe: vi.fn(),
  repository: {
    load: vi.fn(),
    createProject: vi.fn(),
    updateProject: vi.fn(),
    archiveProject: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
  },
  workspace: null as WorkspaceProps | null,
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
    owner_id: 'owner-a',
    project_id: 'project-a',
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

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <App />
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
  mocks.auth.onAuthStateChange.mockImplementation(callback => {
    authListener = callback;
    return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
  });
  mocks.auth.getSession.mockResolvedValue({ data: { session: session() }, error: null });
  mocks.auth.signOut.mockResolvedValue({ error: null });
  mocks.repository.load.mockResolvedValue({ projects: [project()], tasks: [task()] });
});

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

describe('sesiones y datos del espacio personal', () => {
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

  it('no descarga datos para una cuenta diferente de la propietaria', async () => {
    mocks.auth.getSession.mockResolvedValue({ data: { session: session('other', 'other@example.com') }, error: null });
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

  it('cancela la consulta anterior y limpia su caché al cambiar de usuario', async () => {
    const firstLoad = deferred<WorkspaceData>();
    let firstSignal: AbortSignal | undefined;
    mocks.repository.load
      .mockImplementationOnce((signal: AbortSignal) => {
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
    expect(client.getQueryData(['workspace', 'owner-a'])).toBeUndefined();
    expect(client.getQueryData<WorkspaceData>(['workspace', 'owner-b'])?.projects[0].name).toBe('Proyecto de la segunda sesión');
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
      await save;
    });
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(screen.queryByText('Nuevo')).not.toBeInTheDocument();
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

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { CircleAlert, LoaderCircle, LockKeyhole } from 'lucide-react';
import AuthScreen from './auth/AuthScreen';
import Workspace from './workspace/Workspace';
import { callbackRequestedRecovery, configuration, supabase } from './data/client';
import { createRepository, type WorkspaceData } from './data/repository';
import { dataError, DataError } from './data/errors';
import type { Project, Task, WorkspaceProps, WorkspaceSummary } from './types';

function LoadingScreen() {
  return (
    <main className="app-status">
      <LoaderCircle className="app-spinner" size={24} aria-hidden="true" />
      <h1>Abriendo tu espacio…</h1>
      <p role="status">Comprobando la sesión de forma segura.</p>
    </main>
  );
}

export default function App() {
  if (!configuration || !supabase)
    return (
      <main className="app-status">
        <LockKeyhole size={32} aria-hidden="true" />
        <h1>Tu espacio está casi listo</h1>
        <p>Falta conectar la base de datos de tu cuenta para empezar a guardar proyectos y tareas.</p>
        <p className="faint">Completa la configuración inicial indicada en el README y vuelve a abrir la aplicación.</p>
      </main>
    );
  return <ConnectedApp client={supabase} />;
}

function ConnectedApp({ client }: { client: SupabaseClient }) {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(callbackRequestedRecovery);
  const [attempt, setAttempt] = useState(0);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    let observedAuth = false;
    let previousUser: string | null = null;
    const accept = (next: Session | null) => {
      if (!active) return;
      const nextUser = next?.user.id ?? null;
      if (previousUser !== nextUser || !next) {
        void queryClient.cancelQueries();
        queryClient.clear();
      }
      previousUser = nextUser;
      setSession(next);
      setChecking(false);
      setAuthError(null);
    };
    const {
      data: { subscription },
    } = client.auth.onAuthStateChange((event, next) => {
      observedAuth = true;
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      accept(next);
    });
    void client.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active || observedAuth) return;
        if (error) {
          setAuthError('No se pudo recuperar tu sesión. Vuelve a intentarlo.');
          setChecking(false);
        } else accept(data.session);
      })
      .catch(() => {
        if (active && !observedAuth) {
          setAuthError('No se pudo comprobar tu sesión. Revisa la conexión.');
          setChecking(false);
        }
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client, queryClient, attempt]);

  function completeRecovery() {
    setRecovery(false);
    navigate('/', { replace: true });
  }

  if (checking) return <LoadingScreen />;
  if (authError)
    return (
      <main className="app-status">
        <CircleAlert aria-hidden="true" />
        <h1>No pudimos abrir tu sesión</h1>
        <p role="alert">{authError}</p>
        <button
          className="btn btn-primary"
          onClick={() => {
            setChecking(true);
            setAttempt(value => value + 1);
          }}
        >
          Reintentar
        </button>
      </main>
    );
  if (recovery || !session) return <AuthScreen client={client} ownerEmail="" recovery={recovery} onRecoveryComplete={completeRecovery} />;
  return <WorkspaceContext key={session.user.id} client={client} session={session} />;
}

function WorkspaceContext({ client, session }: { client: SupabaseClient; session: Session }) {
  const repository = useMemo(() => createRepository(client), [client]);
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  // Invitation tokens stay only in memory; remove the fragment before loading any data.
  const [inviteToken, setInviteToken] = useState(() => (location.pathname === '/invite' ? new URLSearchParams(location.hash.slice(1)).get('token') : null));
  const inviteStarted = useRef(false);
  const [invitationError, setInvitationError] = useState<DataError | null>(null);
  useEffect(() => {
    if (!inviteToken || inviteStarted.current) return;
    inviteStarted.current = true;
    navigate('/invite', { replace: true });
    void repository.acceptInvitation(inviteToken).then(
      result => {
        if (!active.current) return;
        setInviteToken(null);
        void queryClient.invalidateQueries({ queryKey: ['context', session.user.id] });
        navigate(`/?workspace=${result.workspace_id}`, { replace: true });
      },
      cause => {
        if (active.current) setInvitationError(dataError(cause));
      },
    );
  }, [inviteToken, navigate, session.user.id, queryClient, repository]);
  const context = useQuery({
    queryKey: ['context', session.user.id],
    queryFn: () => repository.context(),
    enabled: !inviteToken,
    staleTime: 15000,
    refetchInterval: 30000,
    retry: false,
  });
  const projectId = /^\/projects\/([^/]+)$/.exec(location.pathname)?.[1];
  const project = useQuery({
    queryKey: ['project-location', session.user.id, projectId],
    queryFn: ({ signal }) => repository.resolveProject(projectId!, signal),
    enabled: Boolean(projectId && context.data && !inviteToken),
    staleTime: 15000,
    retry: false,
  });
  if (inviteToken)
    return (
      <main className="app-status">
        <LockKeyhole aria-hidden="true" />
        <h1>{invitationError ? 'No se pudo aceptar la invitación' : 'Comprobando invitación…'}</h1>
        <p role={invitationError ? 'alert' : 'status'}>{invitationError ? invitationError.message : 'Verificando el destinatario y el acceso al equipo.'}</p>
        {invitationError && (
          <button
            className="btn btn-secondary"
            onClick={() => {
              setInviteToken(null);
              navigate('/', { replace: true });
            }}
          >
            Volver a TR8
          </button>
        )}
      </main>
    );
  if (context.isPending || (projectId && project.isPending && !context.error)) return <LoadingScreen />;
  if (context.error || !context.data)
    return (
      <main className="app-status">
        <LockKeyhole aria-hidden="true" />
        <h1>Esta cuenta no tiene acceso</h1>
        <p role="alert">{context.error ? dataError(context.error).message : 'No se pudo comprobar el acceso.'}</p>
        <button className="btn btn-secondary" onClick={() => void context.refetch()}>
          Reintentar
        </button>
        <button
          className="btn btn-primary"
          onClick={() => {
            void client.auth.signOut({ scope: 'local' });
          }}
        >
          Volver al inicio de sesión
        </button>
      </main>
    );
  if (project.error)
    return (
      <main className="app-status">
        <CircleAlert aria-hidden="true" />
        <h1>No pudimos abrir el proyecto</h1>
        <p role="alert">{dataError(project.error).message}</p>
        <button className="btn btn-primary" onClick={() => void project.refetch()}>
          Reintentar
        </button>
        <button className="btn btn-secondary" onClick={() => navigate('/')}>
          Ir al inicio
        </button>
      </main>
    );
  const requested = project.data?.workspace_id ?? new URLSearchParams(location.search).get('workspace') ?? context.data.personal_workspace_id;
  const selected = context.data.workspaces.find(workspace => workspace.id === requested);
  if (!selected)
    return (
      <main className="app-status">
        <LockKeyhole aria-hidden="true" />
        <h1>Espacio no disponible</h1>
        <p>El espacio no existe o ya no tienes acceso.</p>
        <button className="btn btn-primary" onClick={() => navigate('/', { replace: true })}>
          Ir a mi espacio personal
        </button>
      </main>
    );
  return (
    <ScopedWorkspace
      key={`${session.user.id}:${selected.id}`}
      client={client}
      session={session}
      selected={selected}
      workspaces={context.data.workspaces}
      onSelectWorkspace={id => {
        const locatorKey = ['project-location', session.user.id];
        void queryClient.cancelQueries({ queryKey: locatorKey });
        queryClient.removeQueries({ queryKey: locatorKey });
        navigate(`/?workspace=${id}`);
      }}
      onCreateTeam={async (name, requestId) => {
        const team = await repository.createTeam(name, requestId);
        if (!active.current) throw new DataError('La sesión cambió. Vuelve a abrir tu espacio para comprobar el equipo.');
        await context.refetch();
        if (active.current) navigate(`/team?workspace=${team.id}`);
        return team;
      }}
    />
  );
}

function ScopedWorkspace({
  client,
  session,
  selected,
  workspaces,
  onSelectWorkspace,
  onCreateTeam,
}: {
  client: SupabaseClient;
  session: Session;
  selected: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  onSelectWorkspace: (id: string) => void;
  onCreateTeam: NonNullable<WorkspaceProps['onCreateTeam']>;
}) {
  const queryClient = useQueryClient();
  const repository = useMemo(() => createRepository(client), [client]);
  const location = useLocation();
  const queryKey = useMemo(() => ['workspace', session.user.id, selected.id], [session.user.id, selected.id]);
  const active = useRef(true);
  const locked = useRef(false);
  const [accessError, setAccessError] = useState<DataError | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      void queryClient.cancelQueries({ queryKey });
      queryClient.removeQueries({ queryKey });
      const directoryKey = ['directory', session.user.id, selected.id];
      void queryClient.cancelQueries({ queryKey: directoryKey });
      queryClient.removeQueries({ queryKey: directoryKey });
    };
  }, [queryClient, queryKey, session.user.id, selected.id]);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => repository.load(selected.id, signal),
    enabled: !accessError,
    staleTime: 15000,
    refetchInterval: 30000,
    retry: (count, error) => count < 1 && !(error instanceof DataError && ['42501', 'PGRST205', 'PGRST202'].includes(error.code ?? '')),
  });
  useEffect(() => {
    if (!active.current || accessError || !(query.error instanceof DataError) || !['42501', 'PGRST301', 'PGRST303', 'PT404'].includes(query.error.code ?? ''))
      return;
    setAccessError(query.error);
    void queryClient.cancelQueries({ queryKey });
    queryClient.removeQueries({ queryKey });
    const directoryKey = ['directory', session.user.id, selected.id];
    void queryClient.cancelQueries({ queryKey: directoryKey });
    queryClient.removeQueries({ queryKey: directoryKey });
    void queryClient.invalidateQueries({ queryKey: ['context', session.user.id] });
  }, [query.error, accessError, queryClient, queryKey, session.user.id, selected.id]);
  const directory = useQuery({
    queryKey: ['directory', session.user.id, selected.id],
    queryFn: async () => {
      const [members, invitations] = await Promise.all([
        repository.members(selected.id),
        selected.owner_id === session.user.id ? repository.invitations(selected.id) : Promise.resolve([]),
      ]);
      return { members, invitations };
    },
    enabled: !accessError && selected.kind === 'team' && location.pathname === '/team',
    staleTime: 15000,
    retry: false,
  });
  const mutation = useMutation({ mutationFn: async (operation: () => Promise<unknown>) => operation(), retry: false });

  async function write<T>(operation: () => Promise<T>, accept?: (data: WorkspaceData, row: T) => WorkspaceData): Promise<T> {
    if (!active.current) throw new DataError('El espacio cambió. Abre de nuevo el proyecto antes de guardar.');
    if (accessError) throw accessError;
    if (selected.owner_id !== session.user.id) throw new DataError('Tienes acceso de lectura a este espacio.', '42501');
    if (locked.current) throw new DataError('Espera a que termine el guardado en curso.');
    locked.current = true;
    try {
      const row = (await mutation.mutateAsync(operation)) as T;
      if (!active.current) throw new DataError('El espacio cambió durante el guardado. Comprueba el resultado al volver a abrirlo.');
      if (active.current) {
        if (accept) queryClient.setQueryData<WorkspaceData>(queryKey, previous => accept(previous ?? { projects: [], tasks: [] }, row));
        void queryClient.invalidateQueries({ queryKey });
      }
      return row;
    } catch (cause) {
      const error = dataError(cause);
      if (active.current && ['42501', 'PGRST301', 'PGRST303', 'PT404'].includes(error.code ?? '')) {
        setAccessError(error);
        await queryClient.cancelQueries({ queryKey });
        queryClient.removeQueries({ queryKey });
        const directoryKey = ['directory', session.user.id, selected.id];
        await queryClient.cancelQueries({ queryKey: directoryKey });
        queryClient.removeQueries({ queryKey: directoryKey });
        void queryClient.invalidateQueries({ queryKey: ['context', session.user.id] });
      }
      if (active.current && cause instanceof DataError && ['PT409', 'PT404', '23503'].includes(cause.code ?? ''))
        void queryClient.invalidateQueries({ queryKey });
      throw error;
    } finally {
      locked.current = false;
    }
  }

  const acceptProject = (data: WorkspaceData, row: Project): WorkspaceData => ({
    ...data,
    projects: [...data.projects.filter(project => project.id !== row.id), row],
  });
  const acceptTask = (data: WorkspaceData, row: Task): WorkspaceData => ({ ...data, tasks: [...data.tasks.filter(task => task.id !== row.id), row] });
  const failure = accessError ?? mutation.error ?? query.error;
  const unavailable = Boolean(accessError) || (query.error instanceof DataError && ['42501', 'PGRST301', 'PGRST303', 'PT404'].includes(query.error.code ?? ''));
  return (
    <Workspace
      workspace={selected}
      workspaces={workspaces}
      readOnly={selected.owner_id !== session.user.id}
      accessUnavailable={unavailable}
      members={unavailable || directory.error ? [] : (directory.data?.members ?? [])}
      invitations={unavailable || directory.error ? [] : (directory.data?.invitations ?? [])}
      directoryLoading={directory.isFetching}
      directoryError={directory.error ? dataError(directory.error).message : null}
      onSelectWorkspace={onSelectWorkspace}
      onCreateTeam={onCreateTeam}
      projects={unavailable ? [] : (query.data?.projects ?? [])}
      tasks={unavailable ? [] : (query.data?.tasks ?? [])}
      email={session.user.email ?? ''}
      loading={query.isPending && !accessError}
      refreshing={query.isFetching && !query.isPending}
      pending={mutation.isPending}
      error={failure ? dataError(failure).message : null}
      onRetry={() => {
        mutation.reset();
        setAccessError(null);
        void query.refetch();
      }}
      onCreateProject={(input, id) => write(() => repository.createProject(selected.id, input, id), acceptProject)}
      onUpdateProject={(project, input) => write(() => repository.updateProject(project, input), acceptProject)}
      onArchiveProject={(project, archived) => write(() => repository.archiveProject(project, archived), acceptProject)}
      onCreateTask={(input, id) => write(() => repository.createTask(selected.id, input, id), acceptTask)}
      onUpdateTask={(task, patch) => write(() => repository.updateTask(task, patch), acceptTask)}
      onDeleteTask={task =>
        write(
          () => repository.deleteTask(task),
          data => ({ ...data, tasks: data.tasks.filter(row => row.id !== task.id) }),
        )
      }
      onSignOut={async () => {
        await queryClient.cancelQueries({ queryKey });
        const { error } = await client.auth.signOut({ scope: 'local' });
        if (error) throw dataError(error);
        queryClient.clear();
      }}
      onPasswordReset={async () => {
        const { error } = await client.auth.resetPasswordForEmail(session.user.email ?? '', { redirectTo: `${window.location.origin}/?auth=recovery` });
        if (error) throw dataError(error);
      }}
    />
  );
}

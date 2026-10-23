import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { CircleAlert, LoaderCircle, LockKeyhole } from 'lucide-react';
import AuthScreen from './auth/AuthScreen';
import Workspace from './workspace/Workspace';
import { callbackRequestedRecovery, configuration, supabase } from './data/client';
import { createRepository, type WorkspaceData } from './data/repository';
import { dataError, DataError } from './data/errors';
import type { Project, Task } from './types';

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
  return <ConnectedApp client={supabase} ownerEmail={configuration.ownerEmail} />;
}

function ConnectedApp({ client, ownerEmail }: { client: SupabaseClient; ownerEmail: string }) {
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
  if (recovery || !session) return <AuthScreen client={client} ownerEmail={ownerEmail} recovery={recovery} onRecoveryComplete={completeRecovery} />;
  if (session.user.email?.toLowerCase() !== ownerEmail)
    return (
      <main className="app-status">
        <LockKeyhole aria-hidden="true" />
        <h1>Esta cuenta no tiene acceso</h1>
        <p>Entra con la cuenta propietaria de este espacio.</p>
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
  return <PersonalWorkspace key={session.user.id} client={client} session={session} />;
}

function PersonalWorkspace({ client, session }: { client: SupabaseClient; session: Session }) {
  const queryClient = useQueryClient();
  const repository = useMemo(() => createRepository(client), [client]);
  const queryKey = useMemo(() => ['workspace', session.user.id], [session.user.id]);
  const active = useRef(true);
  const locked = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => repository.load(signal),
    staleTime: 15000,
    refetchInterval: 30000,
    retry: (count, error) => count < 1 && !(error instanceof DataError && ['42501', 'PGRST205', 'PGRST202'].includes(error.code ?? '')),
  });
  const mutation = useMutation({ mutationFn: async (operation: () => Promise<unknown>) => operation(), retry: false });

  async function write<T>(operation: () => Promise<T>, accept?: (data: WorkspaceData, row: T) => WorkspaceData): Promise<T> {
    if (locked.current) throw new DataError('Espera a que termine el guardado en curso.');
    locked.current = true;
    try {
      const row = (await mutation.mutateAsync(operation)) as T;
      if (active.current) {
        if (accept) queryClient.setQueryData<WorkspaceData>(queryKey, previous => accept(previous ?? { projects: [], tasks: [] }, row));
        void queryClient.invalidateQueries({ queryKey });
      }
      return row;
    } catch (cause) {
      if (active.current && cause instanceof DataError && ['PT409', 'PT404', '23503'].includes(cause.code ?? ''))
        void queryClient.invalidateQueries({ queryKey });
      throw dataError(cause);
    } finally {
      locked.current = false;
    }
  }

  const acceptProject = (data: WorkspaceData, row: Project): WorkspaceData => ({
    ...data,
    projects: [...data.projects.filter(project => project.id !== row.id), row],
  });
  const acceptTask = (data: WorkspaceData, row: Task): WorkspaceData => ({ ...data, tasks: [...data.tasks.filter(task => task.id !== row.id), row] });
  const failure = mutation.error ?? query.error;
  return (
    <Workspace
      projects={query.data?.projects ?? []}
      tasks={query.data?.tasks ?? []}
      email={session.user.email ?? ''}
      loading={query.isPending}
      refreshing={query.isFetching && !query.isPending}
      pending={mutation.isPending}
      error={failure ? dataError(failure).message : null}
      onRetry={() => {
        mutation.reset();
        void query.refetch();
      }}
      onCreateProject={(input, id) => write(() => repository.createProject(input, id), acceptProject)}
      onUpdateProject={(project, input) => write(() => repository.updateProject(project, input), acceptProject)}
      onArchiveProject={(project, archived) => write(() => repository.archiveProject(project, archived), acceptProject)}
      onCreateTask={(input, id) => write(() => repository.createTask(input, id), acceptTask)}
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
        const { error } = await client.auth.resetPasswordForEmail(session.user.email ?? '', { redirectTo: `${location.origin}/?auth=recovery` });
        if (error) throw dataError(error);
      }}
    />
  );
}

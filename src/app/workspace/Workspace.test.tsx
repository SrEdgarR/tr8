import { act, fireEvent, render as testingRender, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Project, Task, WorkspaceProps } from '../types';
import ProjectForm from './ProjectForm';
import TaskForm from './TaskForm';
import TasksView from './TasksView';
import Workspace from './Workspace';

function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return testingRender(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}

const project: Project = {
  workspace_id: 'workspace-a',
  id: '6cefdb36-f3ea-4bf2-9897-c99ac817c875',
  owner_id: 'personal-owner',
  code: 'P-6CEFDB36F3EA',
  name: 'Mi revista',
  description: 'Organizar la siguiente edición',
  color: '#5A67D8',
  status: 'active',
  archived_at: null,
  version: 7,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};
const task: Task = {
  workspace_id: 'workspace-a',
  id: 'd4bf169b-6d3b-4a27-a14b-ed6fead520af',
  owner_id: project.owner_id,
  project_id: project.id,
  assignee_member_id: null,
  task_number: 14,
  title: 'Preparar edición',
  description: 'Revisar los textos y las imágenes',
  status: 'todo',
  priority: 'high',
  start_date: null,
  due_date: null,
  position: 1,
  version: 4,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function workspaceProps(overrides: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    projects: [project],
    tasks: [task],
    email: 'personal@example.com',
    loading: false,
    refreshing: false,
    pending: false,
    error: null,
    onRetry: vi.fn(),
    onCreateProject: vi.fn().mockResolvedValue(project),
    onUpdateProject: vi.fn().mockResolvedValue(project),
    onArchiveProject: vi.fn().mockResolvedValue(project),
    onCreateTask: vi.fn().mockResolvedValue(task),
    onUpdateTask: vi.fn().mockResolvedValue(task),
    onDeleteTask: vi.fn().mockResolvedValue(undefined),
    onSignOut: vi.fn().mockResolvedValue(undefined),
    onPasswordReset: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('espacios y equipos', () => {
  const personal = { id: 'workspace-a', kind: 'personal' as const, name: 'Personal', owner_id: 'personal-owner', version: 1, permissions: [] };
  const team = { id: 'team-a', kind: 'team' as const, name: 'Equipo editorial', owner_id: 'personal-owner', version: 1, permissions: [] };

  it('permite elegir un equipo sin mezclar los proyectos cargados', async () => {
    const onSelectWorkspace = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Workspace {...workspaceProps({ workspace: personal, workspaces: [personal, team], onSelectWorkspace })} />
      </MemoryRouter>,
    );
    await user.selectOptions(screen.getByLabelText('Espacio de trabajo'), 'team-a');
    expect(onSelectWorkspace).toHaveBeenCalledWith('team-a');
    expect(screen.getByLabelText('Espacio de trabajo')).toHaveValue('workspace-a');
  });

  it('muestra miembros sin exponer correos y mantiene las invitaciones externas desactivadas', () => {
    render(
      <MemoryRouter initialEntries={['/team?workspace=team-a']}>
        <Workspace
          {...workspaceProps({
            workspace: team,
            workspaces: [personal, team],
            projects: [],
            tasks: [],
            members: [
              {
                id: 'member-a',
                user_id: 'personal-owner',
                display_name: 'Edgar',
                status: 'active',
                version: 1,
                is_owner: true,
                roles: [],
                permissions: [],
                can_manage_roles: false,
                can_remove: false,
              },
            ],
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Edgar')).toBeInTheDocument();
    expect(screen.getByText('Propietario protegido')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invitar miembro' })).toBeDisabled();
    expect(screen.getByText(/remitente verificado/)).toBeInTheDocument();
    expect(screen.queryByText('owner@example.com')).not.toBeInTheDocument();
  });

  it('conserva el nombre e identificador de un equipo al reintentar y espera confirmación real', async () => {
    const user = userEvent.setup();
    const result = deferred<typeof team>();
    const onCreateTeam = vi
      .fn()
      .mockRejectedValueOnce(new Error('Sin conexión'))
      .mockImplementationOnce(() => result.promise);
    render(
      <MemoryRouter>
        <Workspace {...workspaceProps({ workspace: personal, workspaces: [personal], onCreateTeam })} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Crear equipo' }));
    await user.type(screen.getByLabelText('Nombre del equipo'), 'Editorial');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Crear equipo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sin conexión');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Crear equipo' }));
    expect(onCreateTeam.mock.calls[1]).toEqual(onCreateTeam.mock.calls[0]);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await act(async () => result.resolve(team));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('permite consultar una tarea de solo lectura sin editarla o borrarla', async () => {
    const props = workspaceProps({ readOnly: true });
    render(
      <MemoryRouter initialEntries={[`/projects/${project.id}?task=${task.id}`]}>
        <Workspace {...props} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Título')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });
});

describe('formularios con guardado remoto', () => {
  it('conserva el proyecto y reintenta con el mismo requestId; solo confirma al resolver el guardado', async () => {
    const user = userEvent.setup();
    const secondAttempt = deferred<Project>();
    const onCreate = vi
      .fn<WorkspaceProps['onCreateProject']>()
      .mockRejectedValueOnce(new Error('No hay conexión'))
      .mockImplementationOnce(() => secondAttempt.promise);
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<ProjectForm pending={false} onCreate={onCreate} onUpdate={vi.fn()} onSaved={onSaved} onClose={onClose} />);

    await user.type(screen.getByLabelText('Nombre del proyecto'), 'Mi nuevo proyecto');
    await user.type(screen.getByLabelText(/Descripción/), 'Conservar este contexto aunque falle la conexión');
    await user.click(screen.getByRole('button', { name: 'Crear proyecto' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No hay conexión');
    expect(screen.getByLabelText('Nombre del proyecto')).toHaveValue('Mi nuevo proyecto');
    expect(screen.getByLabelText(/Descripción/)).toHaveValue('Conservar este contexto aunque falle la conexión');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Crear proyecto' }));
    expect(onCreate).toHaveBeenCalledTimes(2);
    const firstRequestId = onCreate.mock.calls[0][1];
    expect(firstRequestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(onCreate.mock.calls[1][1]).toBe(firstRequestId);
    expect(onCreate.mock.calls[1][0]).toEqual(onCreate.mock.calls[0][0]);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardando…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cerrar ventana' })).toBeDisabled();
    expect(onSaved).not.toHaveBeenCalled();
    await act(async () => {
      secondAttempt.resolve(project);
    });
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(project);
  });

  it('conserva los datos y el requestId de una tarea fallida y mantiene abierta la edición hasta confirmar', async () => {
    const user = userEvent.setup();
    const secondAttempt = deferred<Task>();
    const onCreate = vi
      .fn<WorkspaceProps['onCreateTask']>()
      .mockRejectedValueOnce(new Error('El servidor no respondió'))
      .mockImplementationOnce(() => secondAttempt.promise);
    const onClose = vi.fn();
    render(<TaskForm projects={[project]} pending={false} onCreate={onCreate} onUpdate={vi.fn()} onDelete={vi.fn()} onClose={onClose} />);

    await user.type(screen.getByLabelText('Título'), 'Revisar el borrador');
    await user.type(screen.getByLabelText(/Descripción/), 'Mantener mis notas');
    fireEvent.change(screen.getByLabelText('Fecha de inicio'), { target: { value: '2026-10-23' } });
    fireEvent.change(screen.getByLabelText('Vencimiento'), { target: { value: '2026-10-25' } });
    await user.selectOptions(screen.getByLabelText('Prioridad'), 'urgent');
    await user.click(screen.getByRole('button', { name: 'Crear tarea' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El servidor no respondió');
    expect(screen.getByLabelText('Título')).toHaveValue('Revisar el borrador');
    expect(screen.getByLabelText(/Descripción/)).toHaveValue('Mantener mis notas');
    expect(screen.getByLabelText('Vencimiento')).toHaveValue('2026-10-25');
    expect(screen.getByLabelText('Prioridad')).toHaveValue('urgent');
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Crear tarea' }));
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate.mock.calls[1]).toEqual(onCreate.mock.calls[0]);
    expect(onCreate.mock.calls[1][0]).toMatchObject({
      project_id: project.id,
      title: 'Revisar el borrador',
      start_date: '2026-10-23',
      due_date: '2026-10-25',
      priority: 'urgent',
    });
    expect(screen.getByRole('button', { name: 'Guardando…' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      secondAttempt.resolve(task);
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('rechaza fechas invertidas antes de enviar y permite corregirlas conservando el contenido', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<WorkspaceProps['onCreateTask']>().mockResolvedValue(task);
    render(<TaskForm projects={[project]} pending={false} onCreate={onCreate} onUpdate={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText('Título'), 'Entrega con fechas');
    fireEvent.change(screen.getByLabelText('Fecha de inicio'), { target: { value: '2026-10-27' } });
    fireEvent.change(screen.getByLabelText('Vencimiento'), { target: { value: '2026-10-25' } });
    // Exercise the application guard even if a client bypasses native input validity.
    fireEvent.submit(screen.getByRole('button', { name: 'Crear tarea' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('El vencimiento debe ser igual o posterior al inicio.');
    expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Título')).toHaveValue('Entrega con fechas');
    fireEvent.change(screen.getByLabelText('Vencimiento'), { target: { value: '2026-10-28' } });
    await user.click(screen.getByRole('button', { name: 'Crear tarea' }));
    expect(onCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ start_date: '2026-10-27', due_date: '2026-10-28' }), expect.any(String));
  });

  it('requiere confirmar el borrado y conserva la tarea y la versión cuando el servidor lo rechaza', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn<WorkspaceProps['onDeleteTask']>().mockRejectedValue(new Error('La tarea cambió en otro dispositivo. Actualiza los datos.'));
    const onClose = vi.fn();
    render(<TaskForm task={task} projects={[project]} pending={false} onCreate={vi.fn()} onUpdate={vi.fn()} onDelete={onDelete} onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Eliminar' }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Conservar tarea' }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Eliminar' }));
    await user.click(screen.getByRole('button', { name: 'Sí, eliminar tarea' }));
    await waitFor(() => expect(screen.getByText('La tarea cambió en otro dispositivo. Actualiza los datos.')).toBeInTheDocument());
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(task);
    expect(onDelete.mock.calls[0][0].version).toBe(4);
    expect(screen.getByLabelText('Título')).toHaveValue(task.title);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('vistas de tareas y proyectos', () => {
  it('conserva búsqueda, estado y prioridad al pasar de lista a tablero y vuelve al mismo dataset', async () => {
    const user = userEvent.setup();
    const tasks: Task[] = [
      { ...task, status: 'progress' },
      { ...task, id: 'task-low', title: 'Editar portada', status: 'progress', priority: 'low', position: 2 },
      { ...task, id: 'task-todo', title: 'Preparar notas', status: 'todo', priority: 'high', position: 3 },
      { ...task, id: 'task-done', title: 'Publicar edición', status: 'done', priority: 'high', position: 4 },
    ];
    render(
      <MemoryRouter>
        <TasksView tasks={tasks} projects={[project]} pending={false} onCreate={vi.fn()} onOpen={vi.fn()} onMove={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getAllByRole('row')).toHaveLength(5);
    await user.type(screen.getByRole('searchbox', { name: 'Buscar tareas' }), 'edición');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filtrar por estado' }), 'progress');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filtrar por prioridad' }), 'high');
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Preparar edición' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publicar edición' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tablero' }));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(within(screen.getByRole('article')).getByRole('button', { name: 'Preparar edición' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Buscar tareas' })).toHaveValue('edición');
    expect(screen.getByRole('combobox', { name: 'Filtrar por estado' })).toHaveValue('progress');
    expect(screen.getByRole('combobox', { name: 'Filtrar por prioridad' })).toHaveValue('high');
    await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    expect(screen.getAllByRole('article')).toHaveLength(4);
    await user.click(screen.getByRole('button', { name: 'Lista' }));
    expect(screen.getAllByRole('row')).toHaveLength(5);
  });

  it('envía la fila versionada para mover de estado, bloquea envíos duplicados y no muestra éxito ante un error', async () => {
    const user = userEvent.setup();
    const save = deferred<Task>();
    const onUpdateTask = vi.fn<WorkspaceProps['onUpdateTask']>().mockImplementation(() => save.promise);
    render(
      <MemoryRouter initialEntries={['/tasks']}>
        <Workspace {...workspaceProps({ onUpdateTask })} />
      </MemoryRouter>,
    );
    const state = screen.getByRole('combobox', { name: `Estado de ${task.title}` });
    await user.selectOptions(state, 'done');
    expect(onUpdateTask).toHaveBeenCalledExactlyOnceWith(task, { status: 'done', position: expect.any(Number) });
    expect(onUpdateTask.mock.calls[0][0].version).toBe(task.version);
    expect(state).toBeDisabled();
    expect(screen.getByRole('button', { name: `Completar ${task.title}` })).toBeDisabled();
    expect(state).toHaveValue('todo');
    await act(async () => {
      save.reject(new Error('No pudimos guardar el cambio'));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos guardar el cambio');
    expect(state).toHaveValue('todo');
    expect(state).toBeEnabled();
    expect(onUpdateTask).toHaveBeenCalledOnce();
    expect(screen.queryByText('Estado de la tarea guardado.')).not.toBeInTheDocument();
  });

  it('mantiene el proyecto visible si falla el archivado y permite reintentar con la fila existente', async () => {
    const user = userEvent.setup();
    const onArchiveProject = vi.fn<WorkspaceProps['onArchiveProject']>().mockRejectedValue(new Error('No pudimos archivar el proyecto'));
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <Workspace {...workspaceProps({ onArchiveProject })} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: `Archivar ${project.name}` }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos archivar el proyecto');
    expect(onArchiveProject).toHaveBeenCalledExactlyOnceWith(project, true);
    expect(screen.getByRole('heading', { name: project.name })).toBeInTheDocument();
    expect(screen.queryByText('Proyecto archivado.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Archivar ${project.name}` })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: `Archivar ${project.name}` }));
    expect(onArchiveProject).toHaveBeenCalledTimes(2);
    expect(onArchiveProject.mock.calls[1]).toEqual([project, true]);
  });
});

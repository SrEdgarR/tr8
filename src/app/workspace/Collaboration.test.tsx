import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationApi, Project, Task, WorkspaceMember, WorkspaceProps, WorkspaceRole } from '../types';
import Workspace from './Workspace';
import TaskForm from './TaskForm';
import { TeamAdministration } from './Collaboration';
import { DataError } from '../data/errors';

const date = '2026-10-23T12:00:00Z';
const project: Project = {
  id: 'project-a',
  workspace_id: 'team-a',
  owner_id: 'owner-a',
  code: 'P-A',
  name: 'Proyecto compartido',
  description: '',
  color: '#22aa88',
  status: 'active',
  archived_at: null,
  version: 1,
  created_at: date,
  updated_at: date,
};
const task: Task = {
  id: 'task-a',
  workspace_id: 'team-a',
  owner_id: 'owner-a',
  project_id: project.id,
  assignee_member_id: null,
  task_number: 1,
  title: 'Tarea compartida',
  description: '',
  status: 'todo',
  priority: 'none',
  start_date: null,
  due_date: null,
  position: 1,
  version: 1,
  created_at: date,
  updated_at: date,
};
const role: WorkspaceRole = {
  id: 'role-a',
  workspace_id: 'team-a',
  name: 'Lectura',
  template_key: 'reader',
  version: 2,
  permissions: ['project.read', 'task.read'],
  created_at: date,
  updated_at: date,
};
const owner: WorkspaceMember = {
  id: 'member-owner',
  user_id: 'owner-a',
  display_name: 'Propietario',
  status: 'active',
  version: 1,
  is_owner: true,
  roles: [],
  permissions: [],
  can_manage_roles: false,
  can_remove: false,
};
const member: WorkspaceMember = {
  id: 'member-a',
  user_id: 'reader-a',
  display_name: 'Colaborador',
  status: 'active',
  version: 1,
  is_owner: false,
  roles: [{ id: role.id, name: role.name, template_key: role.template_key }],
  permissions: role.permissions,
  can_manage_roles: true,
  can_remove: true,
};

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}

function api(): CollaborationApi {
  return {
    scopeKey: ['collaboration', 'owner-a', 'team-a'],
    roles: vi.fn().mockResolvedValue([role]),
    createRole: vi.fn().mockResolvedValue(role),
    updateRole: vi.fn().mockResolvedValue(role),
    deleteRole: vi.fn().mockResolvedValue({ id: role.id, deleted: true }),
    setMemberRoles: vi.fn().mockResolvedValue(member),
    removeMember: vi.fn().mockResolvedValue({ ...member, status: 'removed' }),
    projectAccess: vi.fn().mockResolvedValue([]),
    setProjectAccess: vi.fn(),
    removeProjectAccess: vi.fn(),
    assignableMembers: vi.fn().mockResolvedValue([{ id: member.id, user_id: member.user_id, display_name: member.display_name, is_owner: false }]),
    assignTask: vi.fn().mockResolvedValue({ ...task, assignee_member_id: member.id, version: 2 }),
    activity: vi.fn().mockResolvedValue({ items: [], next_before_id: null }),
  };
}

function props(overrides: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    workspace: { id: 'team-a', kind: 'team', name: 'Mi equipo', owner_id: owner.user_id, version: 1, permissions: [] },
    currentUserId: owner.user_id,
    members: [owner, member],
    collaboration: api(),
    projects: [project],
    tasks: [task],
    email: 'test@example.test',
    loading: false,
    refreshing: false,
    pending: false,
    error: null,
    capabilities: {
      [project.id]: {
        project_id: project.id,
        access_level: 'write',
        permissions: [
          'project.read',
          'project.edit',
          'project.archive',
          'project.access.manage',
          'task.read',
          'task.create',
          'task.edit',
          'task.delete',
          'task.assign',
        ],
      },
    },
    onRetry: vi.fn(),
    onCreateProject: vi.fn().mockResolvedValue(project),
    onUpdateProject: vi.fn().mockResolvedValue(project),
    onArchiveProject: vi.fn().mockResolvedValue(project),
    onDeleteProject: vi.fn().mockResolvedValue(undefined),
    onCreateTask: vi.fn().mockResolvedValue(task),
    onUpdateTask: vi.fn().mockResolvedValue(task),
    onDeleteTask: vi.fn().mockResolvedValue(undefined),
    onSignOut: vi.fn(),
    onPasswordReset: vi.fn(),
    ...overrides,
  };
}

function show(ui: React.ReactNode, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </QueryClientProvider>
    ),
  });
}

describe('colaboración y permisos en la interfaz', () => {
  it('abre una tarea desde la lista real del proyecto del propietario y conserva el espacio al cerrar', async () => {
    const user = userEvent.setup();
    const settings = props();
    show(<Workspace {...settings} />, `/projects/${project.id}?workspace=team-a`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: task.title }));
    expect(await screen.findByRole('dialog', { name: 'Detalle de tarea' })).toBeInTheDocument();
    expect(screen.getByLabelText('Título')).toHaveValue(task.title);
    expect(screen.getByLabelText('Título')).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Cerrar ventana' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: project.name })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: task.title }));
    expect(await screen.findByRole('dialog', { name: 'Detalle de tarea' })).toBeInTheDocument();
  });

  it('crea un rol y espera la confirmación del servidor antes de cerrar el editor', async () => {
    const user = userEvent.setup();
    const settings = props();
    const result = deferred<WorkspaceRole>();
    vi.mocked(settings.collaboration!.createRole).mockReturnValue(result.promise);
    show(<TeamAdministration {...settings} />);
    await screen.findByText('Lectura');
    expect(screen.queryByRole('button', { name: 'Retirar a Propietario' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Crear rol' }));
    await user.type(screen.getByLabelText('Nombre del rol'), 'Editor');
    await user.click(screen.getByLabelText(/Editar tareas/));
    await user.click(screen.getByRole('button', { name: 'Guardar rol' }));
    expect(settings.collaboration!.createRole).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/), 'Editor', ['task.edit']);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardando…' })).toBeDisabled();
    await act(async () => result.resolve({ ...role, name: 'Editor' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invitar miembro' })).toBeDisabled();
  });

  it('cierra y descarta el borrador de rol al perder role.manage', async () => {
    const user = userEvent.setup();
    const initial = props({
      currentUserId: 'delegate-a',
      workspace: { id: 'team-a', kind: 'team', name: 'Mi equipo', owner_id: owner.user_id, version: 1, permissions: ['role.read', 'role.manage'] },
    });
    const view = show(<TeamAdministration {...initial} />);
    await user.click(screen.getByRole('button', { name: 'Crear rol' }));
    await user.type(screen.getByLabelText('Nombre del rol'), 'Borrador privado');
    const reduced = { ...initial, workspace: { ...initial.workspace!, permissions: ['role.read'] } };
    view.rerender(<TeamAdministration {...reduced} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    view.rerender(<TeamAdministration {...initial} />);
    await user.click(screen.getByRole('button', { name: 'Crear rol' }));
    expect(screen.getByLabelText('Nombre del rol')).toHaveValue('');
    expect(screen.getByLabelText(/Asignar roles/)).toBeDisabled();
  });

  it('retira el editor y su información al perder role.read conservando role.manage', async () => {
    const user = userEvent.setup();
    const initial = props({
      currentUserId: 'delegate-a',
      workspace: {
        id: 'team-a',
        kind: 'team',
        name: 'Mi equipo',
        owner_id: owner.user_id,
        version: 1,
        permissions: ['role.read', 'role.manage', 'project.read', 'task.read'],
      },
    });
    const view = show(<TeamAdministration {...initial} />);
    await user.click(await screen.findByRole('button', { name: 'Editar rol Lectura' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    view.rerender(<TeamAdministration {...initial} workspace={{ ...initial.workspace!, permissions: ['role.manage'] }} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Roles' })).not.toBeInTheDocument();
    expect(screen.queryByText('Lectura')).not.toBeInTheDocument();
    expect(screen.getByText('Miembro')).toBeInTheDocument();
  });

  it('aplica capacidades por proyecto y permite lectura sin editar, archivar ni crear tareas', async () => {
    const user = userEvent.setup();
    const settings = props({
      currentUserId: 'reader-a',
      capabilities: { [project.id]: { project_id: project.id, access_level: 'read', permissions: ['project.read', 'task.read'] } },
    });
    show(<Workspace {...settings} />, `/projects/${project.id}`);
    await user.click(screen.getByRole('button', { name: 'Configuración del proyecto' }));
    expect(screen.getByRole('button', { name: 'Editar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Nueva tarea' }).every(button => button.hasAttribute('disabled'))).toBe(true);
    expect(screen.getByLabelText(`Estado de ${task.title}`)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Acceso' })).not.toBeInTheDocument();
    expect(screen.getByText(task.title)).toBeInTheDocument();
  });

  it('descarta el editor de proyecto al perder escritura, conservando su lectura', async () => {
    const user = userEvent.setup();
    const initial = props();
    const view = show(<Workspace {...initial} />, `/projects/${project.id}`);
    await user.click(screen.getByRole('button', { name: 'Configuración del proyecto' }));
    await user.click(screen.getByRole('button', { name: 'Editar' }));
    await user.type(screen.getByLabelText('Nombre del proyecto'), ' borrador');
    view.rerender(
      <Workspace {...initial} capabilities={{ [project.id]: { project_id: project.id, access_level: 'read', permissions: ['project.read', 'task.read'] } }} />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: project.name })).toBeInTheDocument();
    expect(initial.onUpdateProject).not.toHaveBeenCalled();
    view.rerender(<Workspace {...initial} />);
    await user.click(screen.getByRole('button', { name: 'Configuración del proyecto' }));
    await user.click(screen.getByRole('button', { name: 'Editar' }));
    expect(screen.getByLabelText('Nombre del proyecto')).toHaveValue(project.name);
  });

  it('descarta la gestión de accesos cuando se pierde project.access.manage', async () => {
    const user = userEvent.setup();
    const initial = props();
    const view = show(<Workspace {...initial} />, `/projects/${project.id}`);
    await user.click(screen.getByRole('button', { name: 'Configuración del proyecto' }));
    await user.click(screen.getByRole('button', { name: 'Acceso' }));
    expect(await screen.findByRole('dialog')).toHaveAccessibleName(`Acceso a ${project.name}`);
    await waitFor(() => expect(initial.collaboration!.projectAccess).toHaveBeenCalledWith(project.id));
    view.rerender(
      <Workspace
        {...initial}
        capabilities={{ [project.id]: { project_id: project.id, access_level: 'write', permissions: ['project.read', 'task.read', 'task.edit'] } }}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asigna un responsable con task.assign sin permitir editar contenido ni eliminar', async () => {
    const user = userEvent.setup();
    const collaboration = api();
    const result = deferred<Task>();
    vi.mocked(collaboration.assignTask).mockReturnValue(result.promise);
    const onUpdate = vi.fn();
    show(
      <TaskForm
        task={task}
        projects={[project]}
        pending={false}
        readOnly
        canDelete={false}
        canAssign
        collaboration={collaboration}
        onCreate={vi.fn()}
        onUpdate={onUpdate}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Título')).toBeDisabled();
    await screen.findByRole('option', { name: member.display_name });
    await user.selectOptions(screen.getByLabelText('Responsable principal'), member.id);
    await user.click(screen.getByRole('button', { name: 'Guardar responsable' }));
    expect(collaboration.assignTask).toHaveBeenCalledWith(task, member.id);
    expect(screen.queryByText('Responsable guardado.')).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument();
    await act(async () => result.resolve({ ...task, assignee_member_id: member.id, version: 2 }));
    expect(await screen.findByText('Responsable guardado.')).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Guardar cambios' })).toBeDisabled();
  });

  it('conserva la versión original del borrador aunque llegue una actualización mientras se edita', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockRejectedValue(new Error('Conflicto de versión'));
    const form = { task, projects: [project], pending: false, onCreate: vi.fn(), onUpdate, onDelete: vi.fn(), onClose: vi.fn() };
    const view = show(<TaskForm {...form} />);
    await user.clear(screen.getByLabelText('Título'));
    await user.type(screen.getByLabelText('Título'), 'Mi borrador');
    view.rerender(<TaskForm {...form} task={{ ...task, title: 'Cambio remoto', version: 2 }} />);
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }), expect.objectContaining({ title: 'Mi borrador' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Conflicto de versión');
    expect(screen.getByLabelText('Título')).toHaveValue('Mi borrador');
  });

  it.each([true, false])(
    'no presenta una asignación propia como conflicto al actualizar la tarea del padre (contenido de solo lectura: %s)',
    async readOnly => {
      const user = userEvent.setup();
      const onUpdate = vi.fn().mockResolvedValue(task);
      function SavedAssignmentForm() {
        const [current, setCurrent] = useState(task);
        const collaboration = api();
        collaboration.assignTask = async (before, memberId) => {
          const saved = { ...before, assignee_member_id: memberId, version: before.version + 1 };
          setCurrent(saved);
          return saved;
        };
        return (
          <TaskForm
            task={current}
            projects={[project]}
            pending={false}
            readOnly={readOnly}
            canAssign
            collaboration={collaboration}
            onCreate={vi.fn()}
            onUpdate={onUpdate}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        );
      }
      show(<SavedAssignmentForm />);
      if (!readOnly) {
        await user.clear(screen.getByLabelText('Título'));
        await user.type(screen.getByLabelText('Título'), 'Borrador todavía sin guardar');
      }
      await screen.findByRole('option', { name: member.display_name });
      await user.selectOptions(screen.getByLabelText('Responsable principal'), member.id);
      await user.click(screen.getByRole('button', { name: 'Guardar responsable' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar responsable' })).toBeDisabled());
      expect(screen.queryByText(/La tarea cambió desde que abriste/)).not.toBeInTheDocument();
      expect(screen.getByLabelText('Responsable principal')).toHaveValue(member.id);
      if (!readOnly) {
        expect(screen.getByLabelText('Título')).toHaveValue('Borrador todavía sin guardar');
        await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
        expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }), expect.objectContaining({ title: 'Borrador todavía sin guardar' }));
      }
    },
  );

  it('no absorbe una actualización externa anterior al confirmar una asignación propia', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockRejectedValue(new Error('Conflicto real'));
    function ConcurrentAssignmentForm() {
      const [current, setCurrent] = useState(task);
      const collaboration = api();
      collaboration.assignTask = async (before, memberId) => {
        const saved = { ...before, assignee_member_id: memberId, version: before.version + 1 };
        setCurrent(saved);
        return saved;
      };
      return (
        <>
          <button onClick={() => setCurrent({ ...task, title: 'Cambio remoto', version: 2 })}>Recibir actualización externa</button>
          <TaskForm
            task={current}
            projects={[project]}
            pending={false}
            canAssign
            collaboration={collaboration}
            onCreate={vi.fn()}
            onUpdate={onUpdate}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        </>
      );
    }
    show(<ConcurrentAssignmentForm />);
    await user.clear(screen.getByLabelText('Título'));
    await user.type(screen.getByLabelText('Título'), 'Borrador original');
    // The incoming update is a server response while the form is already open.
    screen.getByRole('button', { name: 'Recibir actualización externa' }).click();
    expect(await screen.findByText(/La tarea cambió desde que abriste/)).toBeInTheDocument();
    await screen.findByRole('option', { name: member.display_name });
    await user.selectOptions(screen.getByLabelText('Responsable principal'), member.id);
    await user.click(screen.getByRole('button', { name: 'Guardar responsable' }));
    expect(screen.getByText(/La tarea cambió desde que abriste/)).toBeInTheDocument();
    expect(screen.getByLabelText('Título')).toHaveValue('Borrador original');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }), expect.objectContaining({ title: 'Borrador original' }));
  });

  it.each([true, false])(
    'conserva el conflicto si una edición remota llega alrededor de la confirmación propia (antes de resolver: %s)',
    async remoteBeforeReply => {
      const user = userEvent.setup();
      const result = deferred<Task>();
      const onUpdate = vi.fn().mockRejectedValue(new Error('Conflicto real'));
      const ownSaved = { ...task, assignee_member_id: member.id, version: 2 };
      const remoteSaved = { ...ownSaved, title: 'Edición remota posterior', version: 3 };
      let receiveServerTask!: (row: Task) => void;
      function OutOfOrderAssignmentForm() {
        const [current, setCurrent] = useState(task);
        receiveServerTask = setCurrent;
        const collaboration = api();
        collaboration.assignTask = () => result.promise;
        return (
          <TaskForm
            task={current}
            projects={[project]}
            pending={false}
            canAssign
            collaboration={collaboration}
            onCreate={vi.fn()}
            onUpdate={onUpdate}
            onDelete={vi.fn()}
            onClose={vi.fn()}
          />
        );
      }
      show(<OutOfOrderAssignmentForm />);
      await user.clear(screen.getByLabelText('Título'));
      await user.type(screen.getByLabelText('Título'), 'Borrador antes de asignar');
      await screen.findByRole('option', { name: member.display_name });
      await user.selectOptions(screen.getByLabelText('Responsable principal'), member.id);
      await user.click(screen.getByRole('button', { name: 'Guardar responsable' }));
      if (remoteBeforeReply) {
        await act(async () => receiveServerTask(remoteSaved));
        await act(async () => result.resolve(ownSaved));
      } else {
        await act(async () => {
          receiveServerTask(ownSaved);
          result.resolve(ownSaved);
        });
        expect(screen.queryByText(/La tarea cambió desde que abriste/)).not.toBeInTheDocument();
        await act(async () => receiveServerTask(remoteSaved));
      }
      expect(screen.getByText(/La tarea cambió desde que abriste/)).toBeInTheDocument();
      expect(screen.getByLabelText('Título')).toHaveValue('Borrador antes de asignar');
      await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ version: 2 }), expect.objectContaining({ title: 'Borrador antes de asignar' }));
    },
  );

  it('no avanza la versión del borrador cuando la asignación se rechaza con conflicto', async () => {
    const user = userEvent.setup();
    const collaboration = api();
    vi.mocked(collaboration.assignTask).mockRejectedValue(new DataError('La asignación cambió en otro dispositivo.', 'PT409'));
    const onUpdate = vi.fn().mockRejectedValue(new Error('Conflicto de contenido'));
    const form = {
      task,
      projects: [project],
      pending: false,
      canAssign: true,
      collaboration,
      onCreate: vi.fn(),
      onUpdate,
      onDelete: vi.fn(),
      onClose: vi.fn(),
    };
    const view = show(<TaskForm {...form} />);
    await user.clear(screen.getByLabelText('Título'));
    await user.type(screen.getByLabelText('Título'), 'Borrador pendiente');
    await screen.findByRole('option', { name: member.display_name });
    await user.selectOptions(screen.getByLabelText('Responsable principal'), member.id);
    await user.click(screen.getByRole('button', { name: 'Guardar responsable' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('La asignación cambió en otro dispositivo.');
    view.rerender(<TaskForm {...form} task={{ ...task, title: 'Otra edición', version: 2 }} />);
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }), expect.objectContaining({ title: 'Borrador pendiente' }));
  });

  it('actualiza la versión base después de retirar uno mismo al responsable', async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn().mockResolvedValue(task);
    function UnassignmentForm() {
      const [current, setCurrent] = useState({ ...task, assignee_member_id: member.id } as Task);
      const collaboration = api();
      collaboration.assignTask = async (before, memberId) => {
        const saved = { ...before, assignee_member_id: memberId, version: before.version + 1 };
        setCurrent(saved);
        return saved;
      };
      return (
        <TaskForm
          task={current}
          projects={[project]}
          pending={false}
          canAssign
          collaboration={collaboration}
          onCreate={vi.fn()}
          onUpdate={onUpdate}
          onDelete={vi.fn()}
          onClose={vi.fn()}
        />
      );
    }
    show(<UnassignmentForm />);
    await screen.findByRole('option', { name: member.display_name });
    await user.selectOptions(screen.getByLabelText('Responsable principal'), '');
    await user.click(screen.getByRole('button', { name: 'Guardar responsable' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar responsable' })).toBeDisabled());
    expect(screen.queryByText(/La tarea cambió desde que abriste/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Responsable principal')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ version: 2, assignee_member_id: null }), expect.anything());
  });
});

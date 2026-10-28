import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { BulkTaskResult, BulkTasksApi } from '../bulk-task-types';
import type { Project, Task, WorkspaceMember, WorkspaceProps } from '../types';
import Workspace from './Workspace';

const id = (suffix: number) => `60000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const userId = id(1);
const workspaceId = id(2);
const permissions = ['member.read', 'project.read', 'task.read', 'task.edit', 'task.assign', 'task.delete'];
const project: Project = {
  id: id(10),
  workspace_id: workspaceId,
  owner_id: id(3),
  code: 'QA-A',
  name: 'Proyecto Alfa QA',
  description: '',
  color: '#5A67D8',
  icon: 'folder',
  status: 'active',
  archived_at: null,
  version: 2,
  created_at: '2026-10-28T12:00:00Z',
  updated_at: '2026-10-28T12:00:00Z',
};
const otherProject: Project = { ...project, id: id(11), code: 'QA-B', name: 'Proyecto Beta QA' };
const member: WorkspaceMember = {
  id: id(4),
  user_id: userId,
  display_name: 'Integración QA',
  status: 'active',
  version: 1,
  is_owner: false,
  roles: [],
  permissions,
  can_manage_roles: false,
  can_remove: false,
};
const task: Task = {
  id: id(20),
  workspace_id: workspaceId,
  owner_id: project.owner_id,
  project_id: project.id,
  assignee_member_id: member.id,
  task_number: 1,
  title: 'Preparar Alfa QA',
  description: '',
  status: 'todo',
  priority: 'none',
  start_date: null,
  due_date: null,
  position: 1,
  version: 7,
  archived_at: null,
  created_at: project.created_at,
  updated_at: project.updated_at,
};
const unassigned: Task = { ...task, id: id(21), task_number: 2, assignee_member_id: null, title: 'Revisar Alfa QA', version: 4, position: 2 };
const otherTask: Task = { ...task, id: id(22), project_id: otherProject.id, title: 'Publicar Beta QA', assignee_member_id: id(5), version: 9 };

function fixture(overrides: Partial<WorkspaceProps> = {}): WorkspaceProps {
  const bulkTasks: BulkTasksApi = {
    scopeKey: ['bulk-qa', userId, workspaceId, 'acl-v1'],
    apply: vi.fn<BulkTasksApi['apply']>(async (_operation, items, request): Promise<BulkTaskResult> => ({
      request_id: request.id,
      results: items.map(item => ({ id: item.id, outcome: 'applied', code: null })),
    })),
  };
  return {
    workspace: { id: workspaceId, kind: 'team', name: 'Equipo QA', owner_id: project.owner_id, version: 1, permissions },
    currentUserId: userId,
    members: [member],
    projects: [project, otherProject],
    tasks: [task, unassigned, otherTask],
    bulkTasks,
    capabilities: Object.fromEntries([project, otherProject].map(row => [row.id, { project_id: row.id, access_level: 'write' as const, permissions }])),
    email: 'integration@example.invalid',
    loading: false,
    refreshing: false,
    pending: false,
    error: null,
    onRetry: vi.fn(),
    onCreateProject: vi.fn(),
    onUpdateProject: vi.fn(),
    onArchiveProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onCreateTask: vi.fn(),
    onUpdateTask: vi.fn(),
    onDeleteTask: vi.fn(),
    onSignOut: vi.fn(),
    onPasswordReset: vi.fn(),
    ...overrides,
  };
}

function mount(data: WorkspaceProps, path = `/tasks?workspace=${workspaceId}`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function view(value: WorkspaceProps) {
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Workspace {...value} />
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  const rendered = render(view(data));
  return { ...rendered, update: (next: WorkspaceProps) => rendered.rerender(view(next)) };
}

describe('bulk actions integrated with authorized workspace routes', () => {
  it('selects only tasks from the current project and sends one batch with the captured versions', async () => {
    const user = userEvent.setup();
    const data = fixture();
    mount(data, `/projects/${project.id}?workspace=${workspaceId}&view=list`);
    expect(screen.queryByRole('checkbox', { name: `Seleccionar ${otherTask.title}` })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar tareas visibles' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Acción masiva' }), 'priority');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Nueva prioridad' }), 'urgent');
    await user.click(screen.getByRole('button', { name: 'Revisar acción' }));
    const review = screen.getByRole('dialog', { name: 'Cambiar prioridad' });
    expect(within(review).getByText(task.title)).toBeInTheDocument();
    expect(within(review).getByText(unassigned.title)).toBeInTheDocument();
    expect(within(review).queryByText(otherTask.title)).not.toBeInTheDocument();
    await user.click(within(review).getByRole('button', { name: 'Confirmar acción' }));
    await screen.findByRole('dialog', { name: 'Resultado de la acción masiva' });
    expect(data.bulkTasks!.apply).toHaveBeenCalledTimes(1);
    expect(data.bulkTasks!.apply).toHaveBeenCalledWith(
      { kind: 'priority', priority: 'urgent' },
      [task, unassigned].map(({ id, project_id, version }) => ({ id, project_id, version })),
      { id: expect.any(String), requested_at: expect.any(String) },
    );
    expect(data.onUpdateTask).not.toHaveBeenCalled();
    expect(data.onDeleteTask).not.toHaveBeenCalled();
  });

  it('combines explicitly selected tasks across visible projects on the global table without adding other tasks', async () => {
    const user = userEvent.setup();
    const data = fixture();
    mount(data, `/tasks?workspace=${workspaceId}&view=table`);
    await user.click(screen.getByRole('checkbox', { name: `Seleccionar ${task.title}` }));
    await user.click(screen.getByRole('checkbox', { name: `Seleccionar ${otherTask.title}` }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Nuevo estado' }), 'done');
    await user.click(screen.getByRole('button', { name: 'Revisar acción' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Cambiar estado' })).getByRole('button', { name: 'Confirmar acción' }));
    await waitFor(() => expect(data.bulkTasks!.apply).toHaveBeenCalledOnce());
    expect(data.bulkTasks!.apply).toHaveBeenCalledWith(
      { kind: 'status', status: 'done' },
      [task, otherTask].map(({ id, project_id, version }) => ({ id, project_id, version })),
      expect.objectContaining({ id: expect.any(String), requested_at: expect.any(String) }),
    );
  });

  it('selects only the current member tasks from Mis tareas', async () => {
    const user = userEvent.setup();
    const data = fixture();
    mount(data, `/my-tasks?workspace=${workspaceId}`);
    expect(screen.queryByRole('checkbox', { name: `Seleccionar ${otherTask.title}` })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: `Seleccionar ${unassigned.title}` })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Seleccionar tareas visibles' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Nuevo estado' }), 'done');
    await user.click(screen.getByRole('button', { name: 'Revisar acción' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Cambiar estado' })).getByRole('button', { name: 'Confirmar acción' }));
    await waitFor(() => expect(data.bulkTasks!.apply).toHaveBeenCalledOnce());
    expect(data.bulkTasks!.apply).toHaveBeenCalledWith(
      { kind: 'status', status: 'done' },
      [{ id: task.id, project_id: task.project_id, version: task.version }],
      expect.any(Object),
    );
  });

  it('honors assignment permission independently from task editing', async () => {
    const user = userEvent.setup();
    const assignPermissions = ['member.read', 'project.read', 'task.read', 'task.assign'];
    const data = fixture({
      capabilities: { [project.id]: { project_id: project.id, access_level: 'write', permissions: assignPermissions } },
      projects: [project],
      tasks: [task],
    });
    mount(data);
    const selection = screen.getByRole('checkbox', { name: `Seleccionar ${task.title}` });
    expect(selection).toBeEnabled();
    expect(screen.getByRole('button', { name: `Completar ${task.title}` })).toBeDisabled();
    await user.click(selection);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Acción masiva' }), 'assign');
    await user.click(screen.getByRole('button', { name: 'Revisar acción' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Asignar responsable' })).getByRole('button', { name: 'Confirmar acción' }));
    await waitFor(() => expect(data.bulkTasks!.apply).toHaveBeenCalledOnce());
    expect(data.bulkTasks!.apply).toHaveBeenCalledWith({ kind: 'assign', assignee_member_id: null }, expect.any(Array), expect.any(Object));
  });

  it('blocks bulk mutation in a globally read-only view even with stale writable capabilities', () => {
    const data = fixture({ readOnly: true });
    mount(data);
    for (const selection of screen.queryAllByRole('checkbox', { name: /^Seleccionar / })) expect(selection).toBeDisabled();
    const review = screen.queryByRole('button', { name: 'Revisar acción' });
    if (review) expect(review).toBeDisabled();
    expect(data.bulkTasks!.apply).not.toHaveBeenCalled();
  });

  it('clears selection and review when the authorization scope changes', async () => {
    const user = userEvent.setup();
    const data = fixture();
    const view = mount(data);
    await user.click(screen.getByRole('checkbox', { name: `Seleccionar ${task.title}` }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Nuevo estado' }), 'done');
    await user.click(screen.getByRole('button', { name: 'Revisar acción' }));
    expect(screen.getByRole('dialog', { name: 'Cambiar estado' })).toBeInTheDocument();
    view.update({ ...data, bulkTasks: { ...data.bulkTasks!, scopeKey: ['bulk-qa', userId, workspaceId, 'acl-v2'] } });
    expect(screen.queryByRole('dialog', { name: 'Cambiar estado' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: `Seleccionar ${task.title}` })).not.toBeChecked();
    expect(data.bulkTasks!.apply).not.toHaveBeenCalled();
  });

  it('keeps the result when a successful batch refreshes task versions before its promise resolves', async () => {
    const user = userEvent.setup();
    const data = fixture({ projects: [project], tasks: [task] });
    const apply = vi.fn<BulkTasksApi['apply']>();
    function Harness() {
      const [tasks, setTasks] = useState(data.tasks);
      apply.mockImplementation(async (_operation, items, request) => {
        setTasks(previous => previous.map(row => ({ ...row, status: 'done', version: row.version + 1 })));
        await new Promise(resolve => setTimeout(resolve, 0));
        return { request_id: request.id, results: items.map(item => ({ id: item.id, outcome: 'applied', code: null })) };
      });
      return <Workspace {...data} tasks={tasks} bulkTasks={{ ...data.bulkTasks!, apply }} />;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/tasks?workspace=${workspaceId}`]}>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('checkbox', { name: `Seleccionar ${task.title}` }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Nuevo estado' }), 'done');
    await user.click(screen.getByRole('button', { name: 'Revisar acción' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Cambiar estado' })).getByRole('button', { name: 'Confirmar acción' }));
    expect(await screen.findByRole('dialog', { name: 'Resultado de la acción masiva' })).toBeInTheDocument();
    expect(apply).toHaveBeenCalledOnce();
    expect(screen.getByRole('checkbox', { name: `Seleccionar ${task.title}` })).not.toBeChecked();
  });

  it('keeps the result and unlocks navigation when archiving all visible tasks removes them before the response resolves', async () => {
    const user = userEvent.setup();
    const data = fixture({ projects: [project], tasks: [task] });
    const apply = vi.fn<BulkTasksApi['apply']>();
    function Harness() {
      const [tasks, setTasks] = useState(data.tasks);
      apply.mockImplementation(async (_operation, items, request) => {
        setTasks(previous => previous.map(row => ({ ...row, archived_at: '2026-10-28T13:00:00Z', version: row.version + 1 })));
        await new Promise(resolve => setTimeout(resolve, 0));
        return { request_id: request.id, results: items.map(item => ({ id: item.id, outcome: 'applied', code: null })) };
      });
      return <Workspace {...data} tasks={tasks} bulkTasks={{ ...data.bulkTasks!, apply }} />;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/tasks?workspace=${workspaceId}`]}>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('checkbox', { name: `Seleccionar ${task.title}` }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Acción masiva' }), 'archive');
    await user.click(screen.getByRole('button', { name: 'Revisar acción' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Archivar tareas' })).getByRole('button', { name: 'Confirmar acción' }));
    const result = await screen.findByRole('dialog', { name: 'Resultado de la acción masiva' });
    expect(apply).toHaveBeenCalledOnce();
    expect(result).toHaveTextContent('1 aplicadas');
    await user.click(within(result).getByRole('button', { name: 'Cerrar resultado' }));
    expect(screen.getByRole('button', { name: 'Tabla' })).toBeEnabled();
    expect(screen.getByRole('searchbox', { name: 'Buscar tareas' })).toBeEnabled();
    expect(screen.queryByRole('checkbox', { name: `Seleccionar ${task.title}` })).not.toBeInTheDocument();
  });
});

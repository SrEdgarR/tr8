import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Project, Task, WorkspaceProps } from '../types';
import type { WorkManagementApi } from '../work-management-types';
import Workspace from './Workspace';

const id = (suffix: number) => `54000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const userId = id(1);
const workspaceId = id(2);
const project: Project = {
  id: id(10),
  workspace_id: workspaceId,
  owner_id: id(3),
  code: 'P-C',
  name: 'Entrega editorial',
  description: 'Proyecto de integración',
  color: '#5A67D8',
  icon: 'globe',
  status: 'active',
  archived_at: null,
  start_date: '2026-10-28',
  due_date: '2026-12-20',
  lead_member_id: null,
  version: 4,
  created_at: '2026-10-28T10:00:00Z',
  updated_at: '2026-10-28T10:00:00Z',
};
const destination: Project = { ...project, id: id(11), code: 'P-D', name: 'Próxima edición' };
const task: Task = {
  id: id(30),
  workspace_id: workspaceId,
  owner_id: project.owner_id,
  project_id: project.id,
  task_number: 1,
  title: 'Preparar la portada',
  description: 'Contenido de la tarea',
  assignee_member_id: null,
  status: 'todo',
  priority: 'high',
  start_date: null,
  due_date: '2026-11-20',
  position: 1024,
  labels: ['Diseño'],
  estimate_minutes: 90,
  subtasks: [{ id: id(31), title: 'Revisar boceto', done: false }],
  archived_at: null,
  version: 5,
  created_at: project.created_at,
  updated_at: project.updated_at,
};
const archived: Task = { ...task, id: id(32), task_number: 2, title: 'Archivo anterior', archived_at: '2026-10-28T11:00:00Z' };
const permissions = ['project.read', 'project.edit', 'project.create', 'task.read', 'task.edit', 'task.create', 'task.delete', 'task.assign'];

function workApi(): WorkManagementApi {
  return {
    scopeKey: ['work-management', userId, workspaceId, 'authorized'],
    createProject: vi.fn(),
    updateProject: vi.fn(),
    duplicateProject: vi.fn(async (before, input) => ({ ...before, id: id(90), code: 'P-COPY', name: input.name, version: 1 })),
    updateTaskDetails: vi.fn(async (before, input) => ({ ...before, ...input, version: before.version + 1 })),
    duplicateTask: vi.fn(async (before, target) => ({
      ...before,
      id: id(91),
      project_id: target,
      task_number: 3,
      title: `${before.title} (copia)`,
      version: 1,
    })),
    moveTask: vi.fn(async (before, target, _request, clearAssignee) => ({
      ...before,
      project_id: target,
      assignee_member_id: clearAssignee ? null : before.assignee_member_id,
      version: before.version + 1,
    })),
    archiveTask: vi.fn(async (before, isArchived) => ({ ...before, archived_at: isArchived ? '2026-10-28T12:00:00Z' : null, version: before.version + 1 })),
  };
}
function fixture(overrides: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    workspace: { id: workspaceId, kind: 'team', name: 'Editorial', owner_id: project.owner_id, version: 1, permissions },
    currentUserId: userId,
    projects: [project, destination],
    tasks: [task, archived],
    workManagement: workApi(),
    capabilities: Object.fromEntries([project, destination].map(row => [row.id, { project_id: row.id, access_level: 'write' as const, permissions }])),
    email: 'example@test.invalid',
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
function Location() {
  const location = useLocation();
  return <output aria-label="Ruta de integración">{`${location.pathname}${location.search}`}</output>;
}
function Harness({ data }: { data: WorkspaceProps }) {
  const [tasks, setTasks] = useState(data.tasks);
  const [projects, setProjects] = useState(data.projects);
  const raw = data.workManagement!;
  const replace = async (promise: Promise<Task>) => {
    const saved = await promise;
    setTasks(previous => [...previous.filter(row => row.id !== saved.id), saved]);
    return saved;
  };
  const api: WorkManagementApi = {
    ...raw,
    updateTaskDetails: (before, input) => replace(raw.updateTaskDetails(before, input)),
    archiveTask: (before, value, requestId) => replace(raw.archiveTask(before, value, requestId)),
    moveTask: (before, target, requestId, clear) => replace(raw.moveTask(before, target, requestId, clear)),
    duplicateTask: (before, target, requestId) => replace(raw.duplicateTask(before, target, requestId)),
    duplicateProject: async (before, input, requestId) => {
      const saved = await raw.duplicateProject(before, input, requestId);
      setProjects(previous => [...previous, saved]);
      return saved;
    },
  };
  return <Workspace {...data} projects={projects} tasks={tasks} workManagement={api} />;
}
function mount(data = fixture(), path = `/projects/${project.id}?workspace=${workspaceId}&view=list`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Harness data={data} />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('stage 4 integrated workflows', () => {
  it('opens the detail from the list and saves metadata with the original task identity and version', async () => {
    const user = userEvent.setup();
    const data = fixture();
    mount(data);
    expect(screen.getByText('Diseño')).toBeInTheDocument();
    expect(screen.getByText('1 h 30 min')).toBeInTheDocument();
    expect(screen.getByText('0/1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: task.title }));
    const dialog = screen.getByRole('dialog', { name: 'Detalle de tarea' });
    expect(within(dialog).getByRole('heading', { name: task.title })).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: 'Nueva etiqueta' }), 'QA{Enter}');
    await user.clear(within(dialog).getByRole('spinbutton', { name: 'Estimación en minutos' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Estimación en minutos' }), '120');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Completar subtarea Revisar boceto' }));
    await user.click(within(dialog).getByRole('button', { name: 'Guardar detalle' }));
    await waitFor(() =>
      expect(data.workManagement!.updateTaskDetails).toHaveBeenCalledWith(task, {
        labels: ['Diseño', 'QA'],
        estimate_minutes: 120,
        subtasks: [{ ...task.subtasks![0], done: true }],
      }),
    );
    expect(data.onUpdateTask).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar ventana' }));
    expect(screen.getByText('QA')).toBeInTheDocument();
    expect(screen.getByText('1/1')).toBeInTheDocument();
  });

  it('keeps archived tasks out of summaries and active views, then restores the same task', async () => {
    const user = userEvent.setup();
    const data = fixture();
    mount(data, `/projects/${project.id}?workspace=${workspaceId}&view=overview`);
    const main = screen.getByRole('main');
    expect(within(main).queryByText(archived.title)).not.toBeInTheDocument();
    expect(within(main).getByText('0 de 1 completadas')).toBeInTheDocument();
    await user.click(within(main).getByRole('button', { name: 'Lista' }));
    expect(within(main).queryByRole('button', { name: archived.title })).not.toBeInTheDocument();
    await user.click(within(main).getByRole('button', { name: 'Archivadas' }));
    await user.click(within(main).getByRole('button', { name: `Abrir tarea archivada ${archived.title}` }));
    await user.click(screen.getByRole('button', { name: 'Restaurar' }));
    const dialog = screen.getByRole('dialog', { name: 'Restaurar tarea' });
    await user.click(within(dialog).getByRole('button', { name: 'Restaurar tarea' }));
    await waitFor(() => expect(data.workManagement!.archiveTask).toHaveBeenCalledWith(archived, false, expect.any(String)));
    await user.click(screen.getByRole('button', { name: 'Cerrar ventana' }));
    expect(within(screen.getByRole('region', { name: 'Tareas archivadas' })).queryByText(archived.title)).not.toBeInTheDocument();
    await user.click(within(main).getByRole('button', { name: 'Lista' }));
    expect(within(main).getByRole('button', { name: archived.title })).toBeInTheDocument();
  });

  it('archives only the selected task and preserves its content for later recovery', async () => {
    const user = userEvent.setup();
    const data = fixture();
    mount(data);
    await user.click(screen.getByRole('button', { name: task.title }));
    await user.click(screen.getByRole('button', { name: 'Archivar' }));
    await user.click(within(screen.getByRole('dialog', { name: 'Archivar tarea' })).getByRole('button', { name: 'Archivar tarea' }));
    await waitFor(() => expect(data.workManagement!.archiveTask).toHaveBeenCalledWith(task, true, expect.any(String)));
    expect(data.onDeleteTask).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Editar tarea' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restaurar' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Cerrar ventana' }));
    expect(screen.queryByRole('button', { name: task.title })).not.toBeInTheDocument();
  });

  it('duplicates a project through its scoped API and opens its new identity', async () => {
    const user = userEvent.setup();
    const data = fixture();
    mount(data, `/projects?workspace=${workspaceId}`);
    await user.click(screen.getByRole('button', { name: `Duplicar ${project.name}` }));
    const dialog = screen.getByRole('dialog', { name: 'Duplicar proyecto' });
    expect(within(dialog).getByRole('checkbox', { name: /Incluir tareas/ })).toBeChecked();
    await user.click(within(dialog).getByRole('button', { name: 'Duplicar proyecto' }));
    await waitFor(() =>
      expect(data.workManagement!.duplicateProject).toHaveBeenCalledWith(project, { name: `${project.name} (copia)`, includeTasks: true }, expect.any(String)),
    );
    await waitFor(() => expect(screen.getByLabelText('Ruta de integración')).toHaveTextContent(`/projects/${id(90)}?workspace=${workspaceId}`));
    expect(data.onDeleteProject).not.toHaveBeenCalled();
  });

  it('can copy project configuration without reading its tasks and never sends hidden tasks', async () => {
    const user = userEvent.setup();
    const data = fixture({
      tasks: [],
      capabilities: { [project.id]: { project_id: project.id, access_level: 'read', permissions: ['project.read'] } },
    });
    mount(data, `/projects?workspace=${workspaceId}`);
    await user.click(screen.getByRole('button', { name: `Duplicar ${project.name}` }));
    const dialog = screen.getByRole('dialog', { name: 'Duplicar proyecto' });
    expect(within(dialog).getByRole('checkbox', { name: /Incluir tareas/ })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: 'Duplicar proyecto' }));
    await waitFor(() =>
      expect(data.workManagement!.duplicateProject).toHaveBeenCalledWith(project, expect.objectContaining({ includeTasks: false }), expect.any(String)),
    );
  });

  it('blocks task mutations in global readonly despite a stale editable capability snapshot', async () => {
    const user = userEvent.setup();
    const data = fixture({ readOnly: true });
    mount(data);
    await user.click(screen.getByRole('button', { name: task.title }));
    expect(screen.getByRole('button', { name: 'Editar tarea' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Mover' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Guardar detalle' })).toBeDisabled();
    expect(data.workManagement!.updateTaskDetails).not.toHaveBeenCalled();
    expect(data.workManagement!.archiveTask).not.toHaveBeenCalled();
  });

  it('moves a task within the workspace while preserving its identity and other tasks', async () => {
    const user = userEvent.setup();
    const data = fixture();
    mount(data);
    await user.click(screen.getByRole('button', { name: task.title }));
    await user.click(screen.getByRole('button', { name: 'Mover' }));
    const dialog = screen.getByRole('dialog', { name: 'Mover tarea' });
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Proyecto de destino' }), destination.id);
    await user.click(within(dialog).getByRole('button', { name: 'Mover tarea' }));
    await waitFor(() => expect(data.workManagement!.moveTask).toHaveBeenCalledWith(task, destination.id, expect.any(String), false));
    await waitFor(() =>
      expect(screen.getByLabelText('Ruta de integración')).toHaveTextContent(`/projects/${destination.id}?workspace=${workspaceId}&task=${task.id}`),
    );
    expect(data.onDeleteTask).not.toHaveBeenCalled();
  });
});

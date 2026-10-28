import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Favorite, ProductivityApi, ProductivityState, SavedTaskView, TaskViewConfig } from '../productivity-types';
import type { Project, Task, WorkspaceMember, WorkspaceProps } from '../types';
import { defaultTaskView } from './task-views';
import Workspace from './Workspace';
import { summaryApi } from './summary-test-fixtures';
import { DataError } from '../data/errors';

const id = (suffix: number) => `53000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const userId = id(1);
const workspaceId = id(2);
const otherUser = id(3);
const project: Project = {
  id: id(10),
  workspace_id: workspaceId,
  owner_id: otherUser,
  code: 'P-QA',
  name: 'Revista colaborativa',
  description: '',
  icon: 'globe',
  color: '#5A67D8',
  status: 'active',
  archived_at: null,
  version: 3,
  created_at: '2026-10-27T10:00:00Z',
  updated_at: '2026-10-27T10:00:00Z',
};
const otherProject: Project = { ...project, id: id(11), code: 'P-QB', name: 'Segundo proyecto' };
const ownMember: WorkspaceMember = {
  id: id(20),
  user_id: userId,
  display_name: 'Persona principal',
  status: 'active',
  version: 2,
  is_owner: false,
  roles: [],
  permissions: ['member.read', 'project.read', 'task.read', 'task.edit'],
  can_manage_roles: false,
  can_remove: false,
};
const otherMember: WorkspaceMember = { ...ownMember, id: id(21), user_id: otherUser, display_name: 'Otra persona' };
const makeTask = (suffix: number, title: string, position: number, assignee = ownMember.id): Task => ({
  id: id(suffix),
  workspace_id: workspaceId,
  owner_id: otherUser,
  project_id: project.id,
  assignee_member_id: assignee,
  task_number: suffix,
  title,
  description: '',
  status: 'todo',
  priority: 'medium',
  start_date: null,
  due_date: null,
  position,
  version: suffix,
  created_at: project.created_at,
  updated_at: project.updated_at,
});
const first = makeTask(30, 'Mi primera tarea', 1024);
const someoneElse = makeTask(31, 'Tarea de otra persona', 2048, otherMember.id);
const last = makeTask(32, 'Mi segunda tarea', 3072);
const contextView = (suffix: number, name: string, context: SavedTaskView['context'], projectId: string | null): SavedTaskView => ({
  id: id(suffix),
  workspace_id: workspaceId,
  context,
  project_id: projectId,
  name,
  config: defaultTaskView(),
  version: 1,
  created_at: project.created_at,
  updated_at: project.updated_at,
});

function productivity(initial: Partial<ProductivityState> = {}) {
  const state: ProductivityState = { favorites: [], views: [], ...initial };
  const api: ProductivityApi = {
    scopeKey: ['productivity', userId, workspaceId, 'authorized'],
    load: vi.fn().mockImplementation(async () => structuredClone(state)),
    setFavorite: vi.fn().mockImplementation(async (kind: Favorite['kind'], favoriteId: string, favorite: boolean) => {
      const row = { kind, id: favoriteId, project_id: kind === 'project' ? favoriteId : project.id };
      state.favorites = [...state.favorites.filter(item => item.kind !== kind || item.id !== favoriteId), ...(favorite ? [row] : [])];
      return { ...row, favorite };
    }),
    createView: vi
      .fn()
      .mockImplementation(async (viewId: string, name: string, context: SavedTaskView['context'], projectId: string | null, config: TaskViewConfig) => {
        const row: SavedTaskView = {
          id: viewId,
          name,
          context,
          project_id: projectId,
          workspace_id: workspaceId,
          config,
          version: 1,
          created_at: project.created_at,
          updated_at: project.updated_at,
        };
        state.views.push(row);
        return row;
      }),
    updateView: vi
      .fn()
      .mockImplementation(async (view: SavedTaskView, name: string, config: TaskViewConfig) => ({ ...view, name, config, version: view.version + 1 })),
    deleteView: vi.fn().mockImplementation(async (view: SavedTaskView) => {
      state.views = state.views.filter(item => item.id !== view.id);
    }),
    reorderTasks: vi.fn().mockResolvedValue([]),
  };
  return { state, api };
}

function fixture(overrides: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    workspace: {
      id: workspaceId,
      kind: 'team',
      name: 'Equipo de pruebas',
      owner_id: otherUser,
      version: 1,
      permissions: ['member.read', 'project.read', 'task.read', 'task.edit'],
    },
    workspaces: [],
    currentUserId: userId,
    projects: [project, otherProject],
    tasks: [first, someoneElse, last],
    members: [ownMember, otherMember],
    capabilities: Object.fromEntries(
      [project, otherProject].map(item => [
        item.id,
        { project_id: item.id, access_level: 'write' as const, permissions: ['project.read', 'task.read', 'task.edit'] },
      ]),
    ),
    productivity: productivity().api,
    email: 'test@example.com',
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
    onUpdateTask: vi.fn().mockResolvedValue(first),
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
function mount(data: WorkspaceProps, path = `/tasks?workspace=${workspaceId}`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Workspace {...data} />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function loaded() {
  await screen.findByRole('button', { name: 'Guardar vista' });
}

describe('stage 3 integrated workflows', () => {
  it('preserves directory and role administration without requesting unauthorized productivity metadata', async () => {
    const { api } = productivity();
    vi.mocked(api.load).mockRejectedValue(new DataError('Productivity requires project.read', 'PT404'));
    const collaboration = summaryApi();
    const base = fixture();
    const data = fixture({
      workspace: { ...base.workspace!, permissions: ['member.read', 'role.read'] },
      projects: [],
      tasks: [],
      capabilities: {},
      productivity: api,
      collaboration,
    });
    mount(data, `/team?workspace=${workspaceId}`);
    await waitFor(() => expect(collaboration.roles).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('heading', { name: 'Equipo de pruebas', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Miembros', level: 2 })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Miembros' })).getByText(ownMember.display_name)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Roles', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.load).not.toHaveBeenCalled();
    expect(api.setFavorite).not.toHaveBeenCalled();
  });

  it('keeps owner productivity available even when its explicit role permission list is empty', async () => {
    const { api } = productivity();
    const base = fixture();
    mount(fixture({ workspace: { ...base.workspace!, owner_id: userId, permissions: [] }, productivity: api }));
    await loaded();
    expect(api.load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: `Marcar favorita ${first.title}` })).toBeEnabled();
  });

  it('keeps My Tasks personal in teams while Tasks contains all authorized work and preserves workspace links', async () => {
    const user = userEvent.setup();
    const data = fixture();
    mount(data, `/my-tasks?workspace=${workspaceId}`);
    await loaded();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { name: 'Mis tareas', level: 1 })).toBeInTheDocument();
    expect(within(main).getByRole('button', { name: first.title })).toBeInTheDocument();
    expect(within(main).getByRole('button', { name: last.title })).toBeInTheDocument();
    expect(within(main).queryByRole('button', { name: someoneElse.title })).not.toBeInTheDocument();
    const sidebar = screen.getByRole('complementary', { name: 'Navegación principal' });
    const tasksLink = within(sidebar).getByRole('link', { name: 'Tareas 3' });
    expect(tasksLink).toHaveAttribute('href', `/tasks?workspace=${workspaceId}`);
    await user.click(tasksLink);
    expect(within(main).getByRole('heading', { name: 'Tareas', level: 1 })).toBeInTheDocument();
    expect(within(main).getByRole('button', { name: someoneElse.title })).toBeInTheDocument();
    expect(data.onUpdateTask).not.toHaveBeenCalled();
  });

  it('keeps table edits disabled in a readonly collection while preserving access to task details', async () => {
    const user = userEvent.setup();
    const data = fixture({ readOnly: true });
    mount(data, `/tasks?workspace=${workspaceId}&view=table`);
    await loaded();
    expect(screen.getByRole('textbox', { name: `Título de ${first.title}` })).toBeDisabled();
    expect(screen.getByRole('button', { name: `Completar ${first.title}` })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: `Estado de ${first.title}` })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: `Abrir ${first.title}` }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(data.onUpdateTask).not.toHaveBeenCalled();
  });

  it('persists project and task favorites then removes only favorite metadata without deleting business records', async () => {
    const user = userEvent.setup();
    const { api, state } = productivity();
    const data = fixture({ productivity: api });
    mount(data);
    await loaded();
    const sidebar = screen.getByRole('complementary', { name: 'Navegación principal' });
    await user.click(within(sidebar).getByRole('button', { name: `Añadir ${project.name} a favoritos` }));
    await waitFor(() => expect(api.setFavorite).toHaveBeenCalledWith('project', project.id, true));
    await user.click(screen.getByRole('button', { name: `Marcar favorita ${first.title}` }));
    await waitFor(() => expect(api.setFavorite).toHaveBeenCalledWith('task', first.id, true));
    await user.click(within(sidebar).getByRole('link', { name: 'Favoritos 2' }));
    const main = screen.getByRole('main');
    expect(within(main).getByRole('link', { name: new RegExp(`${project.name}\\s*Abrir resumen`) })).toHaveAttribute(
      'href',
      `/projects/${project.id}?workspace=${workspaceId}&view=overview`,
    );
    expect(within(main).getByRole('button', { name: first.title })).toBeInTheDocument();
    await user.click(within(main).getByRole('button', { name: `Quitar ${project.name} de favoritos` }));
    await user.click(within(main).getByRole('button', { name: `Quitar de favoritas ${first.title}` }));
    await waitFor(() => expect(state.favorites).toEqual([]));
    expect(data.onDeleteProject).not.toHaveBeenCalled();
    expect(data.onDeleteTask).not.toHaveBeenCalled();
    expect(data.onUpdateProject).not.toHaveBeenCalled();
    expect(data.onUpdateTask).not.toHaveBeenCalled();
  });

  it('shows preference failures instead of pretending a favorite was saved', async () => {
    const user = userEvent.setup();
    const { api, state } = productivity();
    vi.mocked(api.setFavorite).mockRejectedValueOnce(new Error('No se pudo guardar el favorito'));
    mount(fixture({ productivity: api }));
    await loaded();
    await user.click(screen.getByRole('button', { name: `Marcar favorita ${first.title}` }));
    expect((await screen.findAllByRole('alert')).some(alert => alert.textContent?.includes('No se pudo guardar el favorito'))).toBe(true);
    expect(state.favorites).toEqual([]);
    expect(screen.getByRole('button', { name: `Marcar favorita ${first.title}` })).toHaveAttribute('aria-pressed', 'false');
  });

  it('merges a reordered personal subset into the full project without displacing another assignee slot', async () => {
    const user = userEvent.setup();
    const { api } = productivity();
    const data = fixture({ productivity: api });
    mount(data, `/my-tasks?workspace=${workspaceId}`);
    await loaded();
    await user.click(screen.getByRole('button', { name: `Bajar ${first.title}` }));
    await waitFor(() =>
      expect(api.reorderTasks).toHaveBeenCalledWith(project.id, [
        { id: last.id, version: last.version, position: 1024 },
        { id: someoneElse.id, version: someoneElse.version, position: 2048 },
        { id: first.id, version: first.version, position: 3072 },
      ]),
    );
    expect(data.onUpdateTask).not.toHaveBeenCalled();
  });

  it('keeps archived tasks out of the active ordering operation without deleting them', async () => {
    const user = userEvent.setup();
    const { api } = productivity();
    const archived = { ...someoneElse, archived_at: '2026-10-28T10:00:00Z' };
    const data = fixture({ productivity: api, tasks: [first, archived, last] });
    mount(data, `/my-tasks?workspace=${workspaceId}`);
    await loaded();
    await user.click(screen.getByRole('button', { name: `Bajar ${first.title}` }));
    await waitFor(() =>
      expect(api.reorderTasks).toHaveBeenCalledWith(project.id, [
        { id: last.id, version: last.version, position: 1024 },
        { id: first.id, version: first.version, position: 2048 },
      ]),
    );
    expect(data.onDeleteTask).not.toHaveBeenCalled();
  });

  it('rejects a reorder exceeding the full project limit even when My Tasks shows a small subset', async () => {
    const user = userEvent.setup();
    const { api } = productivity();
    const many = Array.from({ length: 199 }, (_, index) => makeTask(100 + index, `Asignada a otra persona ${index}`, (index + 4) * 1024, otherMember.id));
    mount(fixture({ productivity: api, tasks: [first, someoneElse, last, ...many] }), `/my-tasks?workspace=${workspaceId}`);
    await loaded();
    await user.click(screen.getByRole('button', { name: `Bajar ${first.title}` }));
    expect(await screen.findByRole('alert')).toHaveTextContent('hasta 200 tareas por proyecto');
    expect(api.reorderTasks).not.toHaveBeenCalled();
  });

  it('edits table cells through the existing task mutation and keeps a rejected draft intact', async () => {
    const user = userEvent.setup();
    const onUpdateTask = vi.fn().mockRejectedValue(new Error('Versión obsoleta: actualiza la tarea'));
    const data = fixture({ onUpdateTask });
    mount(data, `/tasks?workspace=${workspaceId}&view=table`);
    await loaded();
    const title = screen.getByRole('textbox', { name: `Título de ${first.title}` });
    await user.clear(title);
    await user.type(title, 'Corrección pendiente{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Versión obsoleta');
    expect(onUpdateTask).toHaveBeenCalledWith(first, { title: 'Corrección pendiente' });
    expect(title).toHaveValue('Corrección pendiente');
    expect(data.onDeleteTask).not.toHaveBeenCalled();
  });

  it('keeps project mutations disabled under global readonly even when the capability snapshot includes edit', async () => {
    const user = userEvent.setup();
    const data = fixture({ readOnly: true });
    mount(data, `/projects/${project.id}?workspace=${workspaceId}&view=board`);
    await loaded();
    expect(screen.getByRole('button', { name: `Completar ${first.title}` })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: `Estado de ${first.title}` })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Nueva tarea' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Tabla' }));
    expect(screen.getByRole('textbox', { name: `Título de ${first.title}` })).toBeDisabled();
    expect(data.onUpdateTask).not.toHaveBeenCalled();
    expect(data.productivity?.reorderTasks).not.toHaveBeenCalled();
  });

  it('separates saved views by tasks, mine and exact project context when navigating', async () => {
    const user = userEvent.setup();
    const { api } = productivity({
      views: [
        contextView(50, 'Vista de todas', 'tasks', null),
        contextView(51, 'Vista mía', 'mine', null),
        contextView(52, 'Vista del proyecto', 'project', project.id),
        contextView(53, 'Vista de otro proyecto', 'project', otherProject.id),
      ],
    });
    mount(fixture({ productivity: api }));
    await loaded();
    let select = screen.getByRole('combobox', { name: 'Vistas guardadas' });
    expect(within(select).getByRole('option', { name: 'Vista de todas' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: 'Vista mía' })).not.toBeInTheDocument();
    const sidebar = screen.getByRole('complementary', { name: 'Navegación principal' });
    await user.click(within(sidebar).getByRole('link', { name: 'Mis tareas 2' }));
    select = screen.getByRole('combobox', { name: 'Vistas guardadas' });
    expect(within(select).getByRole('option', { name: 'Vista mía' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: 'Vista de todas' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Guardar vista' }));
    const dialog = screen.getByRole('dialog', { name: 'Guardar vista' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Nombre de la vista' }), 'Mis próximas');
    await user.click(within(dialog).getByRole('button', { name: 'Guardar vista' }));
    await waitFor(() => expect(api.createView).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/), 'Mis próximas', 'mine', null, defaultTaskView()));
    await user.click(within(sidebar).getByRole('link', { name: project.name }));
    select = screen.getByRole('combobox', { name: 'Vistas guardadas' });
    expect(within(select).getByRole('option', { name: 'Vista del proyecto' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: 'Vista de otro proyecto' })).not.toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: 'Mis próximas' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Guardar vista' }));
    const projectDialog = screen.getByRole('dialog', { name: 'Guardar vista' });
    await user.type(within(projectDialog).getByRole('textbox', { name: 'Nombre de la vista' }), 'Vista privada del proyecto');
    await user.click(within(projectDialog).getByRole('button', { name: 'Guardar vista' }));
    await waitFor(() =>
      expect(api.createView).toHaveBeenLastCalledWith(
        expect.stringMatching(/^[0-9a-f-]{36}$/),
        'Vista privada del proyecto',
        'project',
        project.id,
        defaultTaskView(),
      ),
    );
  });
});

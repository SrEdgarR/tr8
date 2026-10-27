import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarApi, CollaborationApi, Project, Task, WorkspaceProps, WorkspaceSummary } from '../types';
import Workspace from './Workspace';

const ownerId = 'visual-navigation-owner';
const space: WorkspaceSummary = {
  id: 'visual-navigation-space',
  kind: 'personal',
  name: 'Personal',
  owner_id: ownerId,
  version: 1,
  permissions: ['project.read', 'task.read'],
};
const firstProject: Project = {
  id: '14087a83-84ca-463f-8cf3-9d8ec59f6601',
  workspace_id: space.id,
  owner_id: ownerId,
  code: 'P-14087A8384CA',
  name: 'Revista de prueba',
  description: 'Contenido del primer proyecto',
  color: '#8662C9',
  status: 'active',
  archived_at: null,
  version: 3,
  created_at: '2026-10-27T12:00:00Z',
  updated_at: '2026-10-27T12:00:00Z',
};
const secondProject: Project = {
  ...firstProject,
  id: '14087a83-84ca-463f-8cf3-9d8ec59f6602',
  code: 'P-14087A8384CB',
  name: 'Sitio de prueba',
  description: 'Contenido del segundo proyecto',
  color: '#23918A',
};
const firstTask: Task = {
  id: '14087a83-84ca-463f-8cf3-9d8ec59f6611',
  workspace_id: space.id,
  owner_id: ownerId,
  project_id: firstProject.id,
  assignee_member_id: null,
  task_number: 1,
  title: 'Texto de la revista',
  description: '',
  status: 'todo',
  priority: 'medium',
  start_date: null,
  due_date: null,
  position: 1,
  version: 1,
  created_at: firstProject.created_at,
  updated_at: firstProject.updated_at,
};
const secondTask: Task = { ...firstTask, id: '14087a83-84ca-463f-8cf3-9d8ec59f6612', project_id: secondProject.id, title: 'Portada del sitio' };

function calendar(): CalendarApi {
  return {
    scopeKey: ['calendar', ownerId, space.id],
    profile: vi.fn().mockResolvedValue({ time_zone: 'America/La_Paz', version: 1, updated_at: firstProject.updated_at }),
    saveProfile: vi.fn(),
    items: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    scheduleTask: vi.fn(),
  };
}

function collaboration(): CollaborationApi {
  return {
    scopeKey: ['collaboration', ownerId, space.id],
    roles: vi.fn(),
    createRole: vi.fn(),
    updateRole: vi.fn(),
    deleteRole: vi.fn(),
    setMemberRoles: vi.fn(),
    removeMember: vi.fn(),
    projectAccess: vi.fn(),
    setProjectAccess: vi.fn(),
    removeProjectAccess: vi.fn(),
    assignableMembers: vi.fn(),
    assignTask: vi.fn(),
    activity: vi.fn().mockResolvedValue({ items: [], next_before_id: null }),
  };
}

function props(overrides: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    currentUserId: ownerId,
    workspace: space,
    workspaces: [space],
    projects: [firstProject, secondProject],
    tasks: [firstTask, secondTask],
    email: 'visual-navigation@example.com',
    loading: false,
    refreshing: false,
    pending: false,
    error: null,
    calendar: calendar(),
    collaboration: collaboration(),
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

function HistoryControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <output aria-label="Ruta de prueba">{`${location.pathname}${location.search}`}</output>
      <button onClick={() => navigate(-1)}>Historial anterior</button>
      <button onClick={() => navigate(1)}>Historial siguiente</button>
    </div>
  );
}

function mount(value: WorkspaceProps, entry = `/?workspace=${space.id}`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<Workspace {...value} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[entry]}>
          {children}
          <HistoryControls />
        </MemoryRouter>
      </QueryClientProvider>
    ),
  });
}

async function expandProject(name = firstProject.name) {
  const toggle = screen.queryByRole('button', { name: `Mostrar vistas de ${name}` });
  if (toggle) await userEvent.click(toggle);
  return screen.getByLabelText(`Vistas de ${name}`);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('navegación visual conservando proyectos y permisos', () => {
  it('muestra todos los proyectos autorizados, incluidos los posteriores al décimo, y omite los archivados', () => {
    const projects = Array.from({ length: 13 }, (_, index) => ({
      ...firstProject,
      id: `visual-project-${index}`,
      name: `Proyecto visible ${index + 1}`,
    }));
    mount(props({ projects: [...projects, { ...secondProject, name: 'Proyecto archivado', archived_at: firstProject.updated_at }], tasks: [] }));
    const sidebar = screen.getByRole('complementary', { name: 'Navegación principal' });
    for (const project of projects) expect(within(sidebar).getByRole('link', { name: project.name })).toBeInTheDocument();
    expect(within(sidebar).queryByRole('link', { name: 'Proyecto archivado' })).not.toBeInTheDocument();
  });

  it('despliega vistas sin navegar ni escribir datos y conserva el espacio en cada enlace', async () => {
    const value = props();
    mount(value);
    const originalRoute = screen.getByLabelText('Ruta de prueba').textContent;
    const views = await expandProject();
    expect(screen.getByLabelText('Ruta de prueba')).toHaveTextContent(originalRoute!);
    for (const [name, view] of [
      ['Lista', 'list'],
      ['Tablero', 'board'],
      ['Calendario', 'calendar'],
      ['Actividad', 'activity'],
    ]) {
      expect(within(views).getByRole('link', { name })).toHaveAttribute('href', `/projects/${firstProject.id}?workspace=${space.id}&view=${view}`);
    }
    expect(value.onCreateProject).not.toHaveBeenCalled();
    expect(value.onUpdateProject).not.toHaveBeenCalled();
    expect(value.onUpdateTask).not.toHaveBeenCalled();
  });

  it('identifica solo la subvista activa y las navegaciones conservan historial sin recargar el documento', async () => {
    mount(props(), `/projects/${firstProject.id}?workspace=${space.id}&view=board`);
    const views = await expandProject();
    expect(within(views).getByRole('link', { name: 'Tablero' })).toHaveAttribute('aria-current', 'page');
    expect(within(views).getByRole('link', { name: 'Lista' })).not.toHaveAttribute('aria-current');
    expect(within(views).getByRole('link', { name: 'Calendario' })).not.toHaveAttribute('aria-current');
    expect(fireEvent.click(within(views).getByRole('link', { name: 'Lista' }))).toBe(false);
    expect(screen.getByRole('table', { name: 'Lista de tareas' })).toBeInTheDocument();
    expect(within(views).getByRole('link', { name: 'Lista' })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(screen.getByRole('button', { name: 'Historial anterior' }));
    expect(screen.getByLabelText('Ruta de prueba')).toHaveTextContent('view=board');
    expect(within(views).getByRole('link', { name: 'Tablero' })).toHaveAttribute('aria-current', 'page');
    await userEvent.click(screen.getByRole('button', { name: 'Historial siguiente' }));
    expect(screen.getByLabelText('Ruta de prueba')).toHaveTextContent('view=list');
  });

  it('alterna proyectos y actividad sin acumular las tareas anteriores ni ejecutar escrituras', async () => {
    const value = props();
    const result = mount(value, `/projects/${firstProject.id}?workspace=${space.id}&view=list`);
    const firstViews = await expandProject();
    await userEvent.click(within(firstViews).getByRole('link', { name: 'Actividad' }));
    await waitFor(() => expect(value.collaboration!.activity).toHaveBeenCalledWith(firstProject.id, null));
    const sidebar = screen.getByRole('complementary', { name: 'Navegación principal' });
    await userEvent.click(within(sidebar).getByRole('link', { name: secondProject.name }));
    expect(screen.getByRole('heading', { name: secondProject.name, level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: firstProject.name, level: 1 })).not.toBeInTheDocument();
    const secondViews = await expandProject(secondProject.name);
    await userEvent.click(within(secondViews).getByRole('link', { name: 'Lista' }));
    const table = screen.getByRole('table', { name: 'Lista de tareas' });
    expect(within(table).getByText(secondTask.title)).toBeInTheDocument();
    expect(within(table).queryByText(firstTask.title)).not.toBeInTheDocument();
    expect(result.container.querySelectorAll('.pw-project-page')).toHaveLength(1);
    expect(value.onUpdateTask).not.toHaveBeenCalled();
    expect(value.onUpdateProject).not.toHaveBeenCalled();
  });

  it('retira los accesos a actividad al perder el permiso y los proyectos retirados desaparecen del sidebar', async () => {
    const value = props();
    const result = mount(value, `/projects/${firstProject.id}?workspace=${space.id}&view=activity`);
    await expandProject();
    expect(screen.getByRole('region', { name: 'Actividad' })).toBeInTheDocument();
    result.rerender(
      <Workspace
        {...value}
        capabilities={{ [firstProject.id]: { project_id: firstProject.id, access_level: 'read', permissions: ['task.read', 'project.read'] } }}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Actividad' })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText(`Vistas de ${firstProject.name}`)).queryByRole('link', { name: 'Actividad' })).not.toBeInTheDocument();
    result.rerender(<Workspace {...value} projects={[secondProject]} tasks={[secondTask]} capabilities={{}} />);
    const sidebar = screen.getByRole('complementary', { name: 'Navegación principal' });
    expect(within(sidebar).queryByRole('link', { name: firstProject.name })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(`Vistas de ${firstProject.name}`)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: firstProject.name, level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByText(firstTask.title)).not.toBeInTheDocument();
  });

  it('permite contraer y expandir manteniendo enlaces con nombres accesibles y sin modificar los datos', async () => {
    const value = props();
    const result = mount(value);
    await userEvent.click(screen.getByRole('button', { name: 'Contraer barra lateral' }));
    expect(result.container.querySelector('.personal-workspace')).toHaveClass('collapsed');
    const sidebar = screen.getByRole('complementary', { name: 'Navegación principal' });
    expect(within(sidebar).getByRole('link', { name: firstProject.name })).toHaveAttribute('aria-label', firstProject.name);
    expect(within(sidebar).getByRole('link', { name: 'Proyectos 2' })).toHaveAttribute('aria-label', 'Proyectos 2');
    await userEvent.click(screen.getByRole('button', { name: 'Expandir barra lateral' }));
    expect(result.container.querySelector('.personal-workspace')).not.toHaveClass('collapsed');
    expect(value.onCreateProject).not.toHaveBeenCalled();
    expect(value.onUpdateProject).not.toHaveBeenCalled();
    expect(value.onUpdateTask).not.toHaveBeenCalled();
  });

  it('el menú Nuevo permite crear en un proyecto válido aunque se esté consultando uno archivado', async () => {
    const value = props({ projects: [{ ...firstProject, archived_at: firstProject.updated_at }, secondProject] });
    mount(value, `/projects/${firstProject.id}?workspace=${space.id}`);
    await userEvent.click(screen.getByRole('button', { name: 'Crear nuevo' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Nueva tarea' }));
    const dialog = screen.getByRole('dialog', { name: 'Nueva tarea' });
    expect(within(dialog).getByLabelText('Proyecto')).toHaveValue(secondProject.id);
    expect(value.onCreateTask).not.toHaveBeenCalled();
  });
});

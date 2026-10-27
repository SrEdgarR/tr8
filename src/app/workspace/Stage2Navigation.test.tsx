import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, Task, WorkspaceProps, WorkspaceSummary } from '../types';
import Workspace from './Workspace';

const ownerId = 'summary-owner';
const space: WorkspaceSummary = {
  id: 'summary-space',
  kind: 'personal',
  name: 'Espacio de prueba',
  owner_id: ownerId,
  version: 1,
  permissions: ['project.read', 'task.read'],
};
const project: Project = {
  id: '9a032f27-40ee-44ee-9a3f-521a76e25301',
  workspace_id: space.id,
  owner_id: ownerId,
  code: 'P-9A032F2740EE',
  name: 'Revista autorizada',
  description: 'Descripción de revista',
  color: '#23918A',
  icon: 'globe',
  status: 'active',
  archived_at: null,
  version: 1,
  created_at: '2026-10-01T12:00:00Z',
  updated_at: '2026-10-26T12:00:00Z',
};
const second: Project = {
  ...project,
  id: '9a032f27-40ee-44ee-9a3f-521a76e25302',
  name: 'Sitio autorizado',
  description: 'Descripción del sitio',
  code: 'P-9A032F2740EF',
};
const task: Task = {
  id: '9a032f27-40ee-44ee-9a3f-521a76e25303',
  workspace_id: space.id,
  owner_id: ownerId,
  project_id: project.id,
  assignee_member_id: null,
  task_number: 1,
  title: 'Revisar textos',
  description: '',
  status: 'todo',
  priority: 'high',
  start_date: null,
  due_date: '2999-01-01',
  position: 1,
  version: 1,
  created_at: project.created_at,
  updated_at: project.updated_at,
};
const secondTask: Task = { ...task, id: '9a032f27-40ee-44ee-9a3f-521a76e25304', project_id: second.id, title: 'Diseñar portada', task_number: 2 };

function props(overrides: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    currentUserId: ownerId,
    workspace: space,
    workspaces: [space],
    projects: [project, second],
    tasks: [task, secondTask],
    email: 'summary@example.com',
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
  return <output aria-label="Ruta de prueba">{`${location.pathname}${location.search}`}</output>;
}
function mount(data: WorkspaceProps, entry = `/?workspace=${space.id}`) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<Workspace {...data} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[entry]}>
          {children}
          <Location />
        </MemoryRouter>
      </QueryClientProvider>
    ),
  });
}
function content() {
  return document.querySelector('main#workspace-content') as HTMLElement;
}

beforeEach(() => window.localStorage.clear());

describe('recuperación de resúmenes con navegación y permisos reales', () => {
  it('alterna resumen, lista, vista general y proyectos sin acumular páginas y conserva el espacio', async () => {
    const data = props();
    const result = mount(data, `/projects/${project.id}?workspace=${space.id}&view=overview`);
    expect(within(content()).getByLabelText(`Resumen de ${project.name}`)).toBeInTheDocument();
    expect(within(content()).queryByRole('table', { name: 'Lista de tareas' })).not.toBeInTheDocument();
    expect(within(content()).getByRole('link', { name: 'Ver lista' })).toHaveAttribute('href', `/projects/${project.id}?workspace=${space.id}&view=list`);
    expect(fireEvent.click(within(content()).getByRole('link', { name: 'Ver lista' }))).toBe(false);
    expect(screen.getByLabelText('Ruta de prueba')).toHaveTextContent(`workspace=${space.id}`);
    expect(within(screen.getByRole('table', { name: 'Lista de tareas' })).getByText(task.title)).toBeInTheDocument();
    await userEvent.click(within(content()).getByRole('button', { name: 'Resumen' }));
    expect(within(content()).getByLabelText(`Resumen de ${project.name}`)).toBeInTheDocument();
    const sidebar = screen.getByRole('complementary', { name: 'Navegación principal' });
    await userEvent.click(within(sidebar).getByRole('link', { name: 'Vista general' }));
    expect(within(content()).getByRole('heading', { name: 'Vista general', level: 1 })).toBeInTheDocument();
    const portfolio = within(content()).getByRole('region', { name: 'Cartera de proyectos' });
    const portfolioLink = within(portfolio).getByRole('link', { name: project.name });
    expect(portfolioLink).toHaveAttribute('href', `/projects/${project.id}?workspace=${space.id}&view=overview`);
    await userEvent.click(portfolioLink);
    for (const selected of [second, project, second]) {
      await userEvent.click(within(sidebar).getByRole('link', { name: selected.name }));
      await userEvent.click(within(content()).getByRole('button', { name: 'Resumen' }));
      expect(within(content()).getByLabelText(`Resumen de ${selected.name}`)).toBeInTheDocument();
      const previous = selected.id === project.id ? second : project;
      expect(within(content()).queryByLabelText(`Resumen de ${previous.name}`)).not.toBeInTheDocument();
      expect(result.container.querySelectorAll('.pw-project-page')).toHaveLength(1);
      expect(result.container.querySelectorAll('.pw-project-summary')).toHaveLength(1);
      expect(screen.getByLabelText('Ruta de prueba')).toHaveTextContent(`workspace=${space.id}`);
    }
    expect(data.onUpdateTask).not.toHaveBeenCalled();
    expect(data.onUpdateProject).not.toHaveBeenCalled();
  });

  it('los indicadores abren solo sus tareas autorizadas y el filtro se puede retirar', async () => {
    const denied = { ...second, name: 'Proyecto sin lectura de tareas' };
    const overdue = { ...task, due_date: '2000-01-01', title: 'Vencida visible' };
    const done = { ...task, id: 'done-task', title: 'Terminada visible', status: 'done' as const, due_date: '2000-01-01' };
    const secret = { ...secondTask, title: 'Tarea que no puedo leer', due_date: '2000-01-01' };
    const data = props({
      projects: [project, denied],
      tasks: [overdue, done, secret],
      capabilities: {
        [project.id]: { project_id: project.id, access_level: 'read', permissions: ['project.read', 'task.read'] },
        [denied.id]: { project_id: denied.id, access_level: 'read', permissions: ['project.read'] },
      },
    });
    mount(data);
    const stats = within(content()).getByLabelText('Resumen del espacio');
    const overdueLink = within(stats).getByRole('link', { name: /^Vencidas/ });
    expect(overdueLink).toHaveAttribute('href', `/tasks?workspace=${space.id}&filter=overdue`);
    await userEvent.click(overdueLink);
    const table = screen.getByRole('table', { name: 'Lista de tareas' });
    expect(within(table).getByText(overdue.title)).toBeInTheDocument();
    expect(within(table).queryByText(done.title)).not.toBeInTheDocument();
    expect(within(table).queryByText(secret.title)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Ver todas las tareas' }));
    expect(screen.getByLabelText('Ruta de prueba')).toHaveTextContent(`/tasks?workspace=${space.id}`);
    expect(within(screen.getByRole('table', { name: 'Lista de tareas' })).getByText(done.title)).toBeInTheDocument();
    expect(screen.queryByText(secret.title)).not.toBeInTheDocument();
    expect(data.onUpdateTask).not.toHaveBeenCalled();
  });

  it('actualiza el resumen al cambiar la instantánea y retira los detalles al perder task.read', () => {
    const data = props();
    const result = mount(data, `/projects/${project.id}?workspace=${space.id}&view=overview`);
    expect(within(content()).getByRole('button', { name: `Abrir tarea ${task.title}` })).toBeInTheDocument();
    result.rerender(<Workspace {...data} tasks={[{ ...task, title: 'Texto actualizado', version: 2 }, secondTask]} />);
    expect(within(content()).getByRole('button', { name: 'Abrir tarea Texto actualizado' })).toBeInTheDocument();
    expect(within(content()).queryByRole('button', { name: `Abrir tarea ${task.title}` })).not.toBeInTheDocument();
    result.rerender(
      <Workspace
        {...data}
        tasks={[{ ...task, title: 'Texto actualizado' }]}
        capabilities={{ [project.id]: { project_id: project.id, access_level: 'read', permissions: ['project.read'] } }}
      />,
    );
    expect(within(content()).getByText('No tienes acceso a las tareas de este proyecto.')).toBeInTheDocument();
    expect(within(content()).queryByText('Texto actualizado')).not.toBeInTheDocument();
    expect(within(content()).queryByRole('img', { name: /tareas completadas/ })).not.toBeInTheDocument();
  });

  it('mantiene los controles de mutación desactivados para permisos de lectura y no añade acciones ficticias al resumen', async () => {
    const data = props({
      readOnly: true,
      capabilities: Object.fromEntries(
        [project, second].map(item => [item.id, { project_id: item.id, access_level: 'read' as const, permissions: ['project.read', 'task.read'] }]),
      ),
    });
    mount(data, `/projects/${project.id}?workspace=${space.id}&view=overview`);
    expect(within(content()).getByRole('button', { name: 'Nueva tarea' })).toBeDisabled();
    expect(within(content()).queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    await userEvent.click(within(content()).getByRole('button', { name: 'Configuración del proyecto' }));
    const dialog = screen.getByRole('dialog', { name: 'Configuración del proyecto' });
    expect(within(dialog).getByRole('button', { name: 'Editar' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Archivar' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Eliminar proyecto' })).not.toBeInTheDocument();
    expect(data.onCreateTask).not.toHaveBeenCalled();
    expect(data.onUpdateProject).not.toHaveBeenCalled();
  });

  it('una ruta de vista general usa solo el espacio actual aunque reciba datos residuales del anterior', async () => {
    const otherSpace = { ...space, id: 'other-space', name: 'Otro espacio' };
    const otherProject = { ...second, workspace_id: otherSpace.id };
    const otherTask = { ...secondTask, workspace_id: otherSpace.id };
    const data = props({ workspace: otherSpace, workspaces: [space, otherSpace], projects: [project, otherProject], tasks: [task, otherTask] });
    mount(data, `/overview?workspace=${otherSpace.id}`);
    const portfolio = within(content()).getByRole('region', { name: 'Cartera de proyectos' });
    expect(within(portfolio).getByRole('link', { name: otherProject.name })).toHaveAttribute(
      'href',
      `/projects/${otherProject.id}?workspace=${otherSpace.id}&view=overview`,
    );
    expect(within(portfolio).queryByRole('link', { name: project.name })).not.toBeInTheDocument();
    const sidebar = screen.getByRole('complementary', { name: 'Navegación principal' });
    expect(within(sidebar).getByRole('link', { name: 'Vista general' })).toHaveAttribute('href', `/overview?workspace=${otherSpace.id}`);
  });
});

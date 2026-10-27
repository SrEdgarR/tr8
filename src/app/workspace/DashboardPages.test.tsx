import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CollaborationApi, Project, Task, WorkspaceMember, WorkspaceProps } from '../types';
import { HomeDashboard, OverviewDashboard } from './DashboardPages';

vi.mock('./helpers', async importOriginal => ({ ...(await importOriginal<typeof import('./helpers')>()), localDate: () => '2026-10-27' }));

const project: Project = {
  id: 'project-a',
  workspace_id: 'space-a',
  owner_id: 'owner-a',
  name: 'Revista',
  description: 'Trabajo real',
  code: 'P-A',
  color: '#8662C9',
  icon: 'globe',
  status: 'active',
  archived_at: null,
  version: 1,
  created_at: '2026-10-20T12:00:00Z',
  updated_at: '2026-10-20T12:00:00Z',
};
const task: Task = {
  id: 'task-a',
  workspace_id: project.workspace_id,
  project_id: project.id,
  owner_id: project.owner_id,
  assignee_member_id: null,
  task_number: 1,
  title: 'Tarea de hoy',
  description: '',
  status: 'todo',
  priority: 'high',
  start_date: null,
  due_date: '2026-10-27',
  position: 1,
  version: 1,
  created_at: project.created_at,
  updated_at: project.updated_at,
};
const member: WorkspaceMember = {
  id: 'member-a',
  user_id: 'owner-a',
  display_name: 'Edgar Padilla',
  status: 'active',
  version: 1,
  is_owner: true,
  roles: [],
  permissions: [],
  can_manage_roles: false,
  can_remove: false,
};

function props(overrides: Partial<WorkspaceProps> = {}): WorkspaceProps {
  return {
    workspace: { id: 'space-a', kind: 'personal', name: 'Personal', owner_id: 'owner-a', version: 1, permissions: [] },
    currentUserId: 'owner-a',
    projects: [project],
    tasks: [task],
    email: 'owner@example.com',
    pending: false,
    loading: false,
    refreshing: false,
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

function actions() {
  return { onNewProject: vi.fn(), onNewTask: vi.fn(), onOpen: vi.fn(), onMove: vi.fn().mockResolvedValue(undefined) };
}

function renderPage(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    ),
  });
}

describe('Inicio y vista general con datos reales', () => {
  it('separa próximas, vencidas y completadas sin inventar una fecha de finalización', async () => {
    const user = userEvent.setup();
    const data = props({
      tasks: [task, { ...task, id: 'old', title: 'Tarea vencida', due_date: '2026-10-26' }, { ...task, id: 'done', title: 'Tarea terminada', status: 'done' }],
    });
    renderPage(<HomeDashboard data={data} {...actions()} />);
    const panel = screen.getByRole('region', { name: 'Mis tareas' });
    expect(within(panel).getByRole('button', { name: 'Abrir Tarea de hoy' })).toBeInTheDocument();
    expect(within(panel).queryByText('Tarea vencida')).not.toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Vencidas 1' }));
    expect(within(panel).getByText('Tarea vencida')).toBeInTheDocument();
    expect(within(panel).queryByText('Tarea de hoy')).not.toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Completadas 1' }));
    expect(within(panel).getByText('Tarea terminada')).toBeInTheDocument();
    expect(screen.queryByText(/esta semana/i)).not.toBeInTheDocument();
    expect(screen.getByText('Total actual de tareas completadas')).toBeInTheDocument();
  });

  it('las tarjetas y los proyectos navegan conservando el espacio y el filtro real', () => {
    renderPage(<HomeDashboard data={props()} {...actions()} />);
    expect(screen.getByRole('link', { name: /Tareas abiertas/ })).toHaveAttribute('href', '/tasks?workspace=space-a&filter=open');
    expect(screen.getByRole('link', { name: /Vencidas.*Necesitan|Vencidas.*Todo al día/ })).toHaveAttribute('href', '/tasks?workspace=space-a&filter=overdue');
    expect(screen.getByRole('link', { name: 'Revista' })).toHaveAttribute('href', '/projects/project-a?workspace=space-a&view=overview');
  });

  it('solo pone las tareas asignadas al usuario en Mis tareas dentro de un equipo', () => {
    const data = props({
      workspace: { id: 'space-a', kind: 'team', name: 'Editorial', owner_id: 'owner-a', version: 1, permissions: [] },
      members: [member, { ...member, id: 'member-b', user_id: 'other', display_name: 'Otra persona' }],
      tasks: [
        { ...task, assignee_member_id: member.id },
        { ...task, id: 'other', title: 'Trabajo de otra persona', assignee_member_id: 'member-b' },
      ],
    });
    renderPage(<HomeDashboard data={data} {...actions()} />);
    const panel = screen.getByRole('region', { name: 'Mis tareas' });
    expect(within(panel).getByText('Tarea de hoy')).toBeInTheDocument();
    expect(within(panel).queryByText('Trabajo de otra persona')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Próximos vencimientos' })).toHaveTextContent('Trabajo de otra persona');
  });

  it('completa únicamente la tarea pulsada y respeta un permiso de lectura', async () => {
    const user = userEvent.setup();
    const handlers = actions();
    const data = props({
      capabilities: { [project.id]: { project_id: project.id, access_level: 'write', permissions: ['project.read', 'task.read', 'task.edit'] } },
    });
    const view = renderPage(<HomeDashboard data={data} {...handlers} />);
    await user.click(screen.getByRole('button', { name: 'Completar Tarea de hoy' }));
    expect(handlers.onMove).toHaveBeenCalledExactlyOnceWith(task, 'done');
    view.rerender(
      <HomeDashboard
        data={{ ...data, capabilities: { [project.id]: { project_id: project.id, access_level: 'read', permissions: ['project.read', 'task.read'] } } }}
        {...handlers}
      />,
    );
    expect(screen.getByRole('button', { name: 'Completar Tarea de hoy' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Completar Tarea de hoy' }));
    expect(handlers.onMove).toHaveBeenCalledTimes(1);
  });

  it('distingue falta de acceso a tareas de un proyecto vacío y no filtra datos de otro espacio', () => {
    const hiddenProject = { ...project, id: 'foreign', workspace_id: 'foreign-space', name: 'Proyecto ajeno' };
    const data = props({
      projects: [project, hiddenProject],
      tasks: [task, { ...task, id: 'secret', project_id: hiddenProject.id, workspace_id: hiddenProject.workspace_id, title: 'Secreto' }],
      capabilities: {
        [project.id]: { project_id: project.id, access_level: 'read', permissions: ['project.read'] },
        [hiddenProject.id]: { project_id: hiddenProject.id, access_level: 'read', permissions: ['project.read', 'task.read'] },
      },
    });
    renderPage(<OverviewDashboard data={data} {...actions()} />);
    expect(screen.getByText('Sin acceso a tareas')).toBeInTheDocument();
    expect(screen.queryByText('Proyecto ajeno')).not.toBeInTheDocument();
    expect(screen.queryByText('Secreto')).not.toBeInTheDocument();
    expect(screen.queryByText('Tarea de hoy')).not.toBeInTheDocument();
    expect(screen.getByText(/Los totales incluyen únicamente/)).toBeInTheDocument();
  });

  it('un directorio fallido retira nombres anteriores y usa desconocido para el total de miembros', () => {
    const data = props({
      workspace: { id: 'space-a', kind: 'team', name: 'Editorial', owner_id: 'owner-a', version: 1, permissions: [] },
      members: [member],
      directoryError: 'No disponible',
      tasks: [{ ...task, assignee_member_id: member.id }],
    });
    renderPage(<OverviewDashboard data={data} {...actions()} />);
    expect(screen.queryByText('Edgar Padilla')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Miembros activos/ })).toHaveTextContent('—');
    expect(screen.getByText(/No se muestran nombres ni recuentos anteriores/)).toBeInTheDocument();
    expect(screen.queryByText('Responsable fuera del directorio visible')).not.toBeInTheDocument();
  });

  it('sustituye los resúmenes tras una actualización o retirada de acceso', () => {
    const data = props();
    const view = renderPage(<OverviewDashboard data={data} {...actions()} />);
    expect(screen.getByRole('link', { name: 'Revista' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Próximos vencimientos' })).toHaveTextContent('Tarea de hoy');
    view.rerender(<OverviewDashboard data={{ ...data, tasks: [{ ...task, status: 'done' }] }} {...actions()} />);
    expect(screen.getByRole('region', { name: 'Próximos vencimientos' })).not.toHaveTextContent('Tarea de hoy');
    expect(screen.getAllByText('100%')).toHaveLength(3);
    view.rerender(<OverviewDashboard data={{ ...data, accessUnavailable: true }} {...actions()} />);
    expect(screen.queryByRole('link', { name: 'Revista' })).not.toBeInTheDocument();
    expect(screen.getByText('Todavía no hay proyectos para mostrar.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nuevo proyecto' })).toBeDisabled();
  });

  it('no consulta actividad sin audit.read y usa el historial autorizado cuando existe', async () => {
    const activity = vi.fn().mockResolvedValue({
      items: [
        {
          id: 1,
          project_id: project.id,
          actor_id: 'owner-a',
          actor_name: 'Actor autorizado',
          action: 'task.updated',
          resource_id: task.id,
          created_at: task.updated_at,
        },
      ],
      next_before_id: null,
    });
    const api = { scopeKey: ['collaboration', 'owner-a', 'space-a'], activity } as unknown as CollaborationApi;
    const data = props({
      currentUserId: 'reader',
      collaboration: api,
      workspace: { id: 'space-a', kind: 'team', name: 'Editorial', owner_id: 'owner-a', version: 1, permissions: ['project.read', 'task.read'] },
    });
    const view = renderPage(<HomeDashboard data={data} {...actions()} />);
    expect(activity).not.toHaveBeenCalled();
    view.rerender(
      <HomeDashboard data={{ ...data, workspace: { ...data.workspace!, permissions: ['project.read', 'task.read', 'audit.read'] } }} {...actions()} />,
    );
    expect(await screen.findByText('Actor autorizado')).toBeInTheDocument();
    expect(activity).toHaveBeenCalledWith(null, null);
    expect(screen.getByRole('link', { name: 'Ver toda la actividad' })).toHaveAttribute('href', '/activity?workspace=space-a');
  });
});

import { act, fireEvent, render as testingRender, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityPage, CalendarApi, CollaborationApi, Project, Task, WorkspaceProps } from '../types';
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
    onDeleteProject: vi.fn().mockResolvedValue(undefined),
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
  it('mounts finance only inside the personal workspace and preserves the project list', () => {
    render(
      <MemoryRouter initialEntries={['/finance']}>
        <Workspace {...workspaceProps({ workspace: personal })} finance={<h1>Bóveda personal de prueba</h1>} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Bóveda personal de prueba' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Finanzas' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: project.name })).toBeInTheDocument();
  });
  it('never mounts a personal vault on a team finance URL', () => {
    render(
      <MemoryRouter initialEntries={['/finance']}>
        <Workspace {...workspaceProps({ workspace: { ...personal, kind: 'team' } })} finance={<h1>Bóveda personal de prueba</h1>} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('heading', { name: 'Bóveda personal de prueba' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Finanzas' })).not.toBeInTheDocument();
    expect(screen.getByText('Selecciona tu espacio personal para consultar Finanzas.')).toBeInTheDocument();
  });
  const team = { id: 'team-a', kind: 'team' as const, name: 'Equipo editorial', owner_id: 'personal-owner', version: 1, permissions: [] };

  it('navega desde Inicio y alterna proyectos sin navegación de documento ni acumular vistas o nombres', async () => {
    const user = userEvent.setup();
    const otherProject = { ...project, id: 'project-b', name: 'Sitio web', description: 'Proyecto independiente' };
    const otherTask = { ...task, id: 'task-b', project_id: otherProject.id, task_number: 15, title: 'Publicar portada' };
    const props = workspaceProps({ workspace: personal, workspaces: [personal], projects: [project, otherProject], tasks: [task, otherTask] });
    const { container } = render(
      <MemoryRouter initialEntries={['/?workspace=workspace-a']}>
        <Workspace {...props} />
      </MemoryRouter>,
    );
    const sidebar = screen.getByRole('complementary', { name: 'Navegación principal' });
    const firstLink = within(sidebar).getByRole('link', { name: project.name });
    // NavLink must consume a normal click instead of allowing a document request.
    expect(fireEvent.click(firstLink)).toBe(false);
    expect(screen.getByRole('heading', { name: project.name, level: 1 })).toBeInTheDocument();
    let previousPage = container.querySelector('.pw-project-page');
    for (let index = 0; index < 4; index += 1) {
      for (const selected of [otherProject, project]) {
        await user.click(within(sidebar).getByRole('link', { name: selected.name }));
        const previous = selected.id === project.id ? otherProject : project;
        expect(screen.getByRole('heading', { name: selected.name, level: 1 })).toBeInTheDocument();
        expect(screen.queryByRole('heading', { name: previous.name, level: 1 })).not.toBeInTheDocument();
        expect(container.querySelectorAll('.pw-project-page')).toHaveLength(1);
        expect(container.querySelectorAll('.crumbs .cur')).toHaveLength(1);
        expect(container.querySelector('.crumbs .cur')).toHaveTextContent(selected.name);
        expect(container.querySelector('.crumbs .cur')).not.toHaveTextContent(previous.name);
        expect(previousPage).not.toBeInTheDocument();
        previousPage = container.querySelector('.pw-project-page');
        expect(within(screen.getByRole('table', { name: 'Lista de tareas' })).getAllByRole('row')).toHaveLength(2);
      }
    }
    expect(props.onCreateProject).not.toHaveBeenCalled();
    expect(props.onCreateTask).not.toHaveBeenCalled();
    expect(props.onUpdateTask).not.toHaveBeenCalled();
  });

  it('retira el tablero anterior al alternar proyectos y no mezcla una respuesta tardía de actividad ni datos refrescados', async () => {
    const user = userEvent.setup();
    const otherProject = { ...project, id: 'project-b', name: 'Sitio web' };
    const otherTask = { ...task, id: 'task-b', project_id: otherProject.id, title: 'Publicar portada', task_number: 15 };
    const delayedActivity = deferred<ActivityPage>();
    const activityPage = (projectId: string): ActivityPage => ({
      items: [
        {
          id: projectId === project.id ? 1 : 2,
          project_id: projectId,
          actor_id: 'actor',
          actor_name: projectId === project.id ? 'Actividad de revista' : 'Actividad de sitio',
          action: 'task.updated',
          resource_id: null,
          created_at: project.updated_at,
        },
      ],
      next_before_id: null,
    });
    const collaboration: CollaborationApi = {
      scopeKey: ['collaboration', 'owner', 'workspace-a'],
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
      activity: vi.fn(projectId => (projectId === project.id ? delayedActivity.promise : Promise.resolve(activityPage(otherProject.id)))),
    };
    let props = workspaceProps({
      workspace: personal,
      workspaces: [personal],
      projects: [project, otherProject],
      tasks: [task, otherTask],
      collaboration,
    });
    const ui = () => (
      <MemoryRouter initialEntries={[`/projects/${project.id}?workspace=workspace-a`]}>
        <Workspace {...props} />
      </MemoryRouter>
    );
    const { container, rerender } = render(ui());
    await user.click(screen.getByRole('button', { name: 'Actividad' }));
    const sidebar = screen.getByRole('complementary', { name: 'Navegación principal' });
    await user.click(within(sidebar).getByRole('link', { name: otherProject.name }));
    await user.click(screen.getByRole('button', { name: 'Tablero' }));
    expect(container.querySelectorAll('.kcard')).toHaveLength(1);
    await act(async () => delayedActivity.resolve(activityPage(project.id)));
    expect(screen.queryByText('Actividad de revista')).not.toBeInTheDocument();
    expect(screen.queryByText('Actividad de sitio')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actividad' }));
    expect(await screen.findByText('Actividad de sitio')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tablero' }));

    props = {
      ...props,
      tasks: [
        { ...task, title: 'Edición actualizada' },
        { ...otherTask, title: 'Portada actualizada' },
      ],
      refreshing: true,
    };
    rerender(ui());
    expect(screen.getByRole('button', { name: 'Portada actualizada' })).toBeInTheDocument();
    for (let index = 0; index < 3; index += 1) {
      for (const [selected, expectedTitle, previousTitle] of [
        [project, 'Edición actualizada', 'Portada actualizada'],
        [otherProject, 'Portada actualizada', 'Edición actualizada'],
      ] as const) {
        const previousPage = container.querySelector('.pw-project-page');
        await user.click(within(sidebar).getByRole('link', { name: selected.name }));
        expect(previousPage).not.toBeInTheDocument();
        expect(container.querySelectorAll('.pw-project-page')).toHaveLength(1);
        expect(container.querySelectorAll('.pw-tasks-area')).toHaveLength(1);
        expect(container.querySelectorAll('.pw-activity')).toHaveLength(0);
        expect(container.querySelectorAll('.pw-board')).toHaveLength(0);
        expect(screen.getByRole('table', { name: 'Lista de tareas' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: expectedTitle })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: previousTitle })).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Tablero' }));
        expect(container.querySelectorAll('.pw-board')).toHaveLength(1);
        expect(container.querySelectorAll('.kcard')).toHaveLength(1);
        expect(screen.queryByRole('table', { name: 'Lista de tareas' })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: expectedTitle })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: previousTitle })).not.toBeInTheDocument();
      }
    }
    expect(props.onUpdateTask).not.toHaveBeenCalled();
    expect(collaboration.assignTask).not.toHaveBeenCalled();
  });

  it('abre las categorías de Configuración desde la navegación y conserva Mi cuenta por separado', async () => {
    const user = userEvent.setup();
    const calendar: CalendarApi = {
      scopeKey: ['settings', 'test'],
      profile: vi.fn().mockResolvedValue({ time_zone: 'America/La_Paz', version: 2, updated_at: null }),
      saveProfile: vi.fn(),
      items: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      scheduleTask: vi.fn(),
    };
    render(
      <MemoryRouter initialEntries={['/?workspace=workspace-a']}>
        <Workspace
          {...workspaceProps({ workspace: personal, workspaces: [personal], calendar })}
          processes={<section aria-label="Procesos en segundo plano">Estado de los procesos</section>}
          integrations={<section aria-label="Integración personal con Google">Estado de Google</section>}
        />
      </MemoryRouter>,
    );
    const settingsLink = screen.getByRole('link', { name: 'Configuración' });
    expect(settingsLink).toHaveAttribute('href', '/settings?workspace=workspace-a');
    await user.click(settingsLink);
    expect(await screen.findByRole('heading', { name: 'Configuración', level: 1 })).toBeInTheDocument();
    const categories = screen.getByRole('navigation', { name: 'Categorías de configuración' });
    expect(screen.getByRole('region', { name: 'Configuración general' })).toBeVisible();
    const zoneToggle = screen.getByRole('button', { name: /^Zona horaria/ });
    expect(zoneToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('combobox', { name: 'Zona horaria de visualización' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Procesos en segundo plano' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Integración personal con Google' })).not.toBeInTheDocument();
    await user.click(zoneToggle);
    const input = await screen.findByRole('combobox', { name: 'Zona horaria de visualización' });
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue('America/La_Paz');
    await user.click(within(categories).getByRole('button', { name: 'Conexiones' }));
    expect(screen.getByRole('region', { name: 'Conexiones de la cuenta' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Integración personal con Google' })).toBeVisible();
    expect(input).toBeInTheDocument();
    expect(input).not.toBeVisible();
    await user.click(within(categories).getByRole('button', { name: 'Actividad' }));
    expect(screen.getByRole('region', { name: 'Actividad de los procesos' })).toBeVisible();
    const processesToggle = screen.getByRole('button', { name: /^Procesos en segundo plano/ });
    expect(processesToggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Procesos en segundo plano' })).not.toBeInTheDocument();
    await user.click(processesToggle);
    expect(screen.getByRole('region', { name: 'Procesos en segundo plano' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Integración personal con Google' })).not.toBeInTheDocument();
    expect(calendar.items).not.toHaveBeenCalled();
    expect(calendar.saveProfile).not.toHaveBeenCalled();
    await user.click(screen.getByRole('link', { name: /personal@example.com/ }));
    expect(screen.getByRole('heading', { name: 'Mi cuenta', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Procesos en segundo plano' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Integración personal con Google' })).not.toBeInTheDocument();
  });

  it('ofrece eliminar desde el proyecto y su tarjeta, exige confirmación y vuelve al listado del espacio', async () => {
    const user = userEvent.setup();
    const otherProject = { ...project, id: 'project-b', name: 'Otro proyecto' };
    const props = workspaceProps({ workspace: personal, workspaces: [personal], projects: [project, otherProject] });
    render(
      <MemoryRouter initialEntries={[`/projects/${project.id}?workspace=workspace-a`]}>
        <Workspace {...props} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: 'Eliminar proyecto' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Configuración del proyecto' }));
    await user.click(screen.getByRole('button', { name: 'Eliminar proyecto' }));
    let dialog = screen.getByRole('dialog', { name: 'Eliminar proyecto' });
    expect(within(dialog).getByText(/Hay 1 tarea visible/)).toBeInTheDocument();
    expect(props.onDeleteProject).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(props.onDeleteProject).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Configuración del proyecto' }));
    await user.click(screen.getByRole('button', { name: 'Eliminar proyecto' }));
    dialog = screen.getByRole('dialog', { name: 'Eliminar proyecto' });
    await user.type(within(dialog).getByRole('textbox'), project.name);
    await user.click(within(dialog).getByRole('button', { name: 'Eliminar proyecto definitivamente' }));
    expect(props.onDeleteProject).toHaveBeenCalledExactlyOnceWith(project, project.name);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Proyectos', level: 1 })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `Eliminar ${otherProject.name}` }));
    expect(screen.getByRole('dialog', { name: 'Eliminar proyecto' })).toHaveTextContent(otherProject.name);
    expect(props.onDeleteProject).toHaveBeenCalledOnce();
  });

  it('no convierte el permiso de archivar en permiso de eliminar y cierra la confirmación al perder acceso', async () => {
    const user = userEvent.setup();
    const props = workspaceProps({
      workspace: personal,
      workspaces: [personal],
      capabilities: { [project.id]: { project_id: project.id, access_level: 'write', permissions: ['project.read', 'project.archive', 'task.read'] } },
    });
    const ui = (current: WorkspaceProps) => (
      <MemoryRouter initialEntries={[`/projects/${project.id}?workspace=workspace-a`]}>
        <Workspace {...current} />
      </MemoryRouter>
    );
    const { rerender } = render(ui(props));
    await user.click(screen.getByRole('button', { name: 'Configuración del proyecto' }));
    expect(screen.getByRole('button', { name: 'Archivar' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Eliminar proyecto' })).not.toBeInTheDocument();
    const allowed = { ...props, capabilities: { [project.id]: { ...props.capabilities![project.id], permissions: ['project.read', 'project.delete'] } } };
    await user.click(screen.getByRole('button', { name: 'Cerrar ventana' }));
    rerender(ui(allowed));
    await user.click(screen.getByRole('button', { name: 'Configuración del proyecto' }));
    await user.click(screen.getByRole('button', { name: 'Eliminar proyecto' }));
    expect(screen.getByRole('dialog', { name: 'Eliminar proyecto' })).toBeInTheDocument();
    rerender(ui(props));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(props.onDeleteProject).not.toHaveBeenCalled();
  });

  it('permite confirmar la eliminación de un proyecto archivado solo si conserva el permiso específico', async () => {
    const user = userEvent.setup();
    const archived = { ...project, archived_at: '2026-10-23T12:00:00Z' };
    const props = workspaceProps({
      projects: [archived],
      capabilities: { [project.id]: { project_id: project.id, access_level: 'write', permissions: ['project.read', 'project.delete', 'task.read'] } },
    });
    render(
      <MemoryRouter initialEntries={[`/projects/${project.id}`]}>
        <Workspace {...props} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Proyecto archivado · solo lectura')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Configuración del proyecto' }));
    await user.click(screen.getByRole('button', { name: 'Eliminar proyecto' }));
    expect(screen.getByRole('dialog', { name: 'Eliminar proyecto' })).toBeInTheDocument();
    expect(props.onDeleteProject).not.toHaveBeenCalled();
  });

  it('abre el calendario general mediante su API y conserva lista y tablero por proyecto', async () => {
    const user = userEvent.setup();
    const calendar: CalendarApi = {
      scopeKey: ['calendar', 'test'],
      profile: vi.fn().mockResolvedValue({ time_zone: 'America/La_Paz', version: 1, updated_at: null }),
      saveProfile: vi.fn(),
      items: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      scheduleTask: vi.fn(),
    };
    render(
      <MemoryRouter initialEntries={[`/projects/${project.id}?workspace=workspace-a&view=board`]}>
        <Workspace
          {...workspaceProps({
            workspace: { ...personal, permissions: ['project.read', 'task.read'] },
            workspaces: [{ ...personal, permissions: ['project.read', 'task.read'] }],
            calendar,
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Tablero' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Calendario' }));
    await waitFor(() =>
      expect(calendar.items).toHaveBeenCalledWith(
        expect.objectContaining({ workspace_ids: ['workspace-a'], project_ids: [project.id] }),
        expect.any(AbortSignal),
      ),
    );
    expect(screen.getByRole('button', { name: 'Calendario' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(task.title)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Lista' }));
    expect(screen.getByRole('table', { name: 'Lista de tareas' })).toBeInTheDocument();
    expect(screen.getByText(task.title)).toBeInTheDocument();
    await user.click(screen.getByTitle('Calendario'));
    expect(await screen.findByRole('heading', { name: 'Calendario', level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(calendar.items).toHaveBeenCalledWith(expect.not.objectContaining({ project_ids: [project.id] }), expect.any(AbortSignal)));
  });

  it('permite elegir un equipo sin mezclar los proyectos cargados', async () => {
    const onSelectWorkspace = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Workspace {...workspaceProps({ workspace: personal, workspaces: [personal, team], onSelectWorkspace })} />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('combobox', { name: 'Espacio de trabajo' }));
    await user.click(screen.getByRole('option', { name: 'Equipo editorial' }));
    expect(onSelectWorkspace).toHaveBeenCalledWith('team-a');
    expect(screen.getByRole('combobox', { name: 'Espacio de trabajo' })).toHaveTextContent('Mi espacio personal');
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

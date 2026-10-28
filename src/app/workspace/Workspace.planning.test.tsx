import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { PlanningApi } from '../planning-types';
import type { WorkspaceProps } from '../types';
import Workspace from './Workspace';
import { summaryProps, summaryProject, summaryTask } from './summary-test-fixtures';

function api(): PlanningApi {
  return {
    scopeKey: ['planning', 'integration'],
    load: vi.fn().mockResolvedValue({ dependencies: [], milestones: [] }),
    addDependency: vi.fn(),
    removeDependency: vi.fn(),
    createMilestone: vi.fn(),
    updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(),
  };
}
function mount(props: WorkspaceProps, path = '/projects') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Workspace {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
describe('Timeline integrado en TR8', () => {
  it('carga la planificación al entrar y alterna la vista global y de proyecto sin acumular páginas', async () => {
    const user = userEvent.setup(),
      planning = api();
    const { container } = mount(summaryProps({ planning }));
    expect(planning.load).not.toHaveBeenCalled();
    const sidebar = screen.getByRole('complementary', { name: 'Navegación principal' });
    await user.click(
      within(sidebar)
        .getAllByRole('link', { name: 'Timeline' })
        .find(link => link.getAttribute('href')?.startsWith('/timeline'))!,
    );
    await waitFor(() => expect(planning.load).toHaveBeenCalledTimes(1));
    expect(container.querySelectorAll('.pwt-page')).toHaveLength(1);
    await user.click(within(sidebar).getByRole('link', { name: summaryProject.name }));
    await user.click(within(screen.getByLabelText('Vista de tareas')).getByRole('button', { name: 'Timeline' }));
    expect(container.querySelectorAll('.pwt-page')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: summaryProject.name, level: 1 })).toBeInTheDocument();
    await user.click(
      within(sidebar)
        .getAllByRole('link', { name: 'Timeline' })
        .find(link => link.getAttribute('href')?.startsWith('/timeline'))!,
    );
    expect(container.querySelectorAll('.pwt-page')).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: summaryProject.name, level: 1 })).not.toBeInTheDocument();
  });
  it('no consulta planificación de una cuenta con permisos de directorio pero sin proyectos', () => {
    const planning = api();
    mount(
      summaryProps({
        planning,
        currentUserId: 'directory-reader',
        workspace: {
          id: summaryProject.workspace_id,
          kind: 'team',
          name: 'Editorial',
          owner_id: summaryProject.owner_id,
          version: 1,
          permissions: ['member.read'],
        },
        projects: [],
        tasks: [],
        capabilities: {},
      }),
      '/timeline',
    );
    expect(planning.load).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Timeline' })).not.toBeInTheDocument();
    expect(screen.queryByText(summaryTask.title)).not.toBeInTheDocument();
  });
  it('el detalle no expone una tarea obsoleta cuyo permiso de lectura fue retirado', () => {
    const planning = api();
    mount(
      summaryProps({
        planning,
        currentUserId: 'reader',
        workspace: {
          id: summaryProject.workspace_id,
          kind: 'team',
          name: 'Editorial',
          owner_id: summaryProject.owner_id,
          version: 1,
          permissions: ['project.read', 'task.read'],
        },
        capabilities: {},
        workManagement: {
          scopeKey: ['work'],
          createProject: vi.fn(),
          updateProject: vi.fn(),
          duplicateProject: vi.fn(),
          updateTaskDetails: vi.fn(),
          duplicateTask: vi.fn(),
          moveTask: vi.fn(),
          archiveTask: vi.fn(),
        },
      }),
      `/projects?task=${summaryTask.id}`,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Dependencias de la tarea')).not.toBeInTheDocument();
  });
});

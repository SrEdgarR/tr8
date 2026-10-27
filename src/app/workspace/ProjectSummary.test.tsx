import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import ProjectSummary from './ProjectSummary';
import { summaryApi, summaryMember, summaryProject, summaryProps, summaryTask } from './summary-test-fixtures';

function mount(data = summaryProps(), project = summaryProject, onOpen = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (next = data, selected = project) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectSummary project={selected} data={next} onOpen={onOpen} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...render(view()), view, onOpen };
}

describe('resumen real del proyecto', () => {
  it('muestra progreso y vencimiento de tareas sin inventar fecha objetivo o hitos', () => {
    mount(summaryProps({ tasks: [summaryTask, { ...summaryTask, id: 'done', status: 'done', due_date: null }] }));
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('1 de 2 completadas')).toBeInTheDocument();
    expect(screen.getByText(summaryProject.description)).toBeInTheDocument();
    expect(screen.getByText('Creado')).toBeInTheDocument();
    expect(screen.getByText('Actualizado')).toBeInTheDocument();
    expect(screen.getByText('Próxima tarea con vencimiento')).toBeInTheDocument();
    expect(screen.queryByText('Hitos')).not.toBeInTheDocument();
    expect(screen.queryByText('Fecha objetivo')).not.toBeInTheDocument();
  });

  it('abre solo una tarea del proyecto actual y conserva el espacio en los enlaces', async () => {
    const user = userEvent.setup();
    const otherTask = { ...summaryTask, id: 'other', project_id: 'other-project', title: 'Otra tarea privada' };
    const { onOpen } = mount(summaryProps({ tasks: [summaryTask, otherTask] }));
    expect(screen.queryByText(otherTask.title)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `Abrir tarea ${summaryTask.title}` }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(summaryTask);
    expect(screen.getByRole('link', { name: 'Ver lista' })).toHaveAttribute(
      'href',
      `/projects/${summaryProject.id}?workspace=${summaryProject.workspace_id}&view=list`,
    );
  });

  it('no interpreta la falta de permiso de tareas como un proyecto vacío ni revela títulos', () => {
    mount(summaryProps({ capabilities: { [summaryProject.id]: { project_id: summaryProject.id, access_level: 'read', permissions: ['project.read'] } } }));
    expect(screen.getByText('No tienes acceso a las tareas de este proyecto.')).toBeInTheDocument();
    expect(screen.queryByText(summaryTask.title)).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pendientes con fecha' })).not.toBeInTheDocument();
  });

  it('conserva el resumen de solo lectura de un proyecto archivado sin acciones de escritura', () => {
    const archived = { ...summaryProject, archived_at: '2026-10-26T12:00:00Z' };
    mount(summaryProps({ projects: [archived], readOnly: true }), archived);
    expect(screen.getByText('0%')).toBeInTheDocument();
    expect(screen.getByText('Proyecto archivado · solo lectura')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Editar|Crear|Eliminar)/ })).not.toBeInTheDocument();
  });

  it.each([{ directoryError: 'Error de directorio' }, { directoryLoading: true }])(
    'oculta nombres almacenados cuando el directorio no está disponible: %j',
    extra => {
      mount(summaryProps(extra));
      expect(screen.queryByText(summaryMember.display_name)).not.toBeInTheDocument();
      expect(screen.queryByRole('img', { name: summaryMember.display_name })).not.toBeInTheDocument();
    },
  );

  it('retira el resumen tras revocación o cambio de espacio', () => {
    const data = summaryProps();
    const { rerender, view } = mount(data);
    expect(screen.getByText(summaryProject.description)).toBeInTheDocument();
    rerender(view({ ...data, accessUnavailable: true }));
    expect(screen.getByText('Resumen no disponible')).toBeInTheDocument();
    expect(screen.queryByText(summaryProject.description)).not.toBeInTheDocument();
    rerender(view({ ...data, workspace: { ...data.workspace!, id: 'other-space' } }));
    expect(screen.queryByText(summaryTask.title)).not.toBeInTheDocument();
  });

  it('no consulta actividad sin audit.read y consulta solo el proyecto al concederlo', async () => {
    const api = summaryApi();
    const capabilities = { [summaryProject.id]: { project_id: summaryProject.id, access_level: 'read' as const, permissions: ['project.read', 'task.read'] } };
    const data = summaryProps({ collaboration: api, capabilities });
    const { rerender, view } = mount(data);
    expect(api.activity).not.toHaveBeenCalled();
    rerender(
      view({
        ...data,
        capabilities: { [summaryProject.id]: { ...capabilities[summaryProject.id], permissions: ['project.read', 'task.read', 'audit.read'] } },
      }),
    );
    await waitFor(() => expect(api.activity).toHaveBeenCalledExactlyOnceWith(summaryProject.id, null));
    const panel = screen.getByRole('region', { name: 'Actividad reciente del proyecto' });
    expect(within(panel).getByRole('link', { name: 'Ver toda la actividad' })).toHaveAttribute(
      'href',
      `/projects/${summaryProject.id}?workspace=${summaryProject.workspace_id}&view=activity`,
    );
  });
});

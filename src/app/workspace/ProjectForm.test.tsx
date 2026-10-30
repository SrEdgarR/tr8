import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PROJECT_ICONS } from '../project-identity';
import { PROJECT_TEMPLATES } from '../work-management-types';
import type { Project, WorkspaceProps } from '../types';
import ProjectForm from './ProjectForm';
import { summaryApi } from './summary-test-fixtures';

const project = {
  id: 'project-a',
  workspace_id: 'workspace-a',
  name: 'Mi proyecto',
  description: 'Trabajo actual',
  color: '#23918A',
  icon: 'rocket',
  status: 'active',
  version: 8,
} as Project;

function callbacks() {
  return {
    onCreate: vi.fn<WorkspaceProps['onCreateProject']>().mockResolvedValue(project),
    onUpdate: vi.fn<WorkspaceProps['onUpdateProject']>().mockResolvedValue(project),
    onSaved: vi.fn(),
    onClose: vi.fn(),
    pending: false,
  };
}

describe('identidad visual del proyecto', () => {
  it('can fold optional customization without submitting or losing its selection', async () => {
    const value = callbacks();
    render(<ProjectForm {...value} />);
    const toggle = screen.getByRole('button', { name: 'Plantilla, icono y color' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Icono Cohete' }));
    await userEvent.click(toggle);
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Icono Cohete' })).toHaveAttribute('aria-pressed', 'true');
    expect(value.onCreate).not.toHaveBeenCalled();
    expect(value.onUpdate).not.toHaveBeenCalled();
  });
  it('ofrece los 16 iconos de la demo y guarda icono y color de forma atómica', async () => {
    const user = userEvent.setup();
    const props = callbacks();
    render(<ProjectForm {...props} />);
    const icons = screen.getByRole('group', { name: 'Icono del proyecto' });
    expect(within(icons).getAllByRole('button')).toHaveLength(PROJECT_ICONS.length);
    expect(screen.getByRole('button', { name: 'Icono Carpeta' })).toHaveAttribute('aria-pressed', 'true');
    await user.type(screen.getByLabelText('Nombre del proyecto'), '  Lanzamiento  ');
    await user.click(screen.getByRole('button', { name: 'Icono Cohete' }));
    await user.click(screen.getByRole('button', { name: 'Color 4' }));
    await user.click(screen.getByRole('button', { name: 'Crear proyecto' }));
    await waitFor(() =>
      expect(props.onCreate).toHaveBeenCalledWith(
        { name: 'Lanzamiento', description: '', color: '#23918A', icon: 'rocket', status: 'planning' },
        expect.any(String),
      ),
    );
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(props.onSaved).toHaveBeenCalledWith(project);
  });

  it('mantiene el icono existente al editar otras propiedades', async () => {
    const user = userEvent.setup();
    const props = callbacks();
    render(<ProjectForm {...props} project={project} />);
    expect(screen.getByRole('button', { name: 'Icono Cohete' })).toHaveAttribute('aria-pressed', 'true');
    await user.clear(screen.getByLabelText('Descripción Opcional'));
    await user.type(screen.getByLabelText('Descripción Opcional'), 'Nuevo texto');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() =>
      expect(props.onUpdate).toHaveBeenCalledWith(project, {
        name: 'Mi proyecto',
        description: 'Nuevo texto',
        color: '#23918A',
        icon: 'rocket',
        status: 'active',
      }),
    );
    expect(props.onCreate).not.toHaveBeenCalled();
    expect(project.icon).toBe('rocket');
  });

  it('conserva los cambios de icono y el identificador para reintentar un fallo de red', async () => {
    const user = userEvent.setup();
    const props = callbacks();
    props.onCreate.mockRejectedValueOnce(new Error('Failed to fetch'));
    render(<ProjectForm {...props} />);
    await user.type(screen.getByLabelText('Nombre del proyecto'), 'Prueba');
    await user.click(screen.getByRole('button', { name: 'Icono Globo' }));
    await user.click(screen.getByRole('button', { name: 'Crear proyecto' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Icono Globo' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Crear proyecto' }));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledTimes(2));
    expect(props.onCreate.mock.calls[0]).toEqual(props.onCreate.mock.calls[1]);
  });

  it('usa carpeta para proyectos anteriores y bloquea el selector durante un guardado', () => {
    const props = callbacks();
    render(<ProjectForm {...props} project={{ ...project, icon: undefined }} pending />);
    expect(screen.getByRole('button', { name: 'Icono Carpeta' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Icono Cohete' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('button', { name: 'Guardar cambios' }).closest('form')!);
    expect(props.onUpdate).not.toHaveBeenCalled();
  });
});

describe('planificación del proyecto', () => {
  it('crea desde una plantilla sin simular sus tareas en el cliente', async () => {
    const user = userEvent.setup();
    const props = callbacks();
    render(<ProjectForm {...props} />);
    await user.type(screen.getByLabelText('Nombre del proyecto'), 'Sitio nuevo');
    await user.click(screen.getByRole('radio', { name: new RegExp(PROJECT_TEMPLATES[0].name) }));
    expect(screen.getByText(/Se crearán:/)).toHaveTextContent(PROJECT_TEMPLATES[0].tasks[0]);
    await user.click(screen.getByRole('button', { name: 'Crear proyecto' }));
    await waitFor(() => expect(props.onCreate).toHaveBeenCalledWith(expect.objectContaining({ template_key: PROJECT_TEMPLATES[0].key }), expect.any(String)));
    expect(props.onSaved).toHaveBeenCalledExactlyOnceWith(project);
  });

  it('valida las fechas propias y permite quitarlas sin borrar las demás propiedades', async () => {
    const user = userEvent.setup();
    const props = callbacks();
    const planned = { ...project, start_date: '2026-11-01', due_date: '2026-11-30' };
    render(<ProjectForm {...props} project={planned} />);
    const start = screen.getByLabelText('Inicio Opcional');
    const due = screen.getByLabelText('Fecha objetivo Opcional');
    fireEvent.change(start, { target: { value: '2026-12-01' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Guardar cambios' }).closest('form')!);
    expect(screen.getByRole('alert')).toHaveTextContent('La fecha objetivo no puede ser anterior');
    expect(props.onUpdate).not.toHaveBeenCalled();
    fireEvent.change(start, { target: { value: '' } });
    fireEvent.change(due, { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() =>
      expect(props.onUpdate).toHaveBeenCalledWith(planned, expect.objectContaining({ start_date: null, due_date: null, icon: project.icon })),
    );
    expect(screen.queryByRole('group', { name: 'Empezar desde una plantilla' })).not.toBeInTheDocument();
  });

  it('elige responsable solo del listado autorizado del proyecto existente', async () => {
    const user = userEvent.setup();
    const api = summaryApi();
    api.assignableMembers = vi.fn().mockResolvedValue([{ id: 'allowed', user_id: 'allowed-user', display_name: 'Persona con acceso', is_owner: false }]);
    const props = callbacks();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectForm {...props} project={project} collaboration={api} canAssignLead />
      </QueryClientProvider>,
    );
    const select = screen.getByRole('combobox', { name: 'Responsable del proyecto Opcional' });
    await screen.findByRole('option', { name: 'Persona con acceso' });
    expect(api.assignableMembers).toHaveBeenCalledExactlyOnceWith(project.id);
    await user.selectOptions(select, 'allowed');
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith(project, expect.objectContaining({ lead_member_id: 'allowed' })));
  });

  it('no consulta ni altera al responsable cuando falta su capacidad', async () => {
    const user = userEvent.setup();
    const api = summaryApi();
    const props = callbacks();
    const current = { ...project, lead_member_id: 'kept-member' };
    render(<ProjectForm {...props} project={current} collaboration={api} canAssignLead={false} />);
    expect(api.assignableMembers).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox', { name: 'Responsable del proyecto Opcional' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalled());
    expect(props.onUpdate.mock.calls[0][1]).not.toHaveProperty('lead_member_id');
  });

  it('no consulta responsables antes de crear el proyecto ni puede conceder acceso con una plantilla', () => {
    const api = summaryApi();
    render(<ProjectForm {...callbacks()} collaboration={api} canAssignLead />);
    expect(api.assignableMembers).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox', { name: 'Responsable del proyecto Opcional' })).not.toBeInTheDocument();
  });
});

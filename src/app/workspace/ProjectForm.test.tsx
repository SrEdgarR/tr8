import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PROJECT_ICONS } from '../project-identity';
import type { Project, WorkspaceProps } from '../types';
import ProjectForm from './ProjectForm';

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

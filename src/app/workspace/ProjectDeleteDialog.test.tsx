import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';
import ProjectDeleteDialog from './ProjectDeleteDialog';

const project: Project = {
  id: 'project-a',
  workspace_id: 'workspace-a',
  owner_id: 'owner',
  code: 'REV',
  name: 'Mi revista',
  description: '',
  color: '#00aa88',
  status: 'active',
  archived_at: null,
  version: 3,
  created_at: '2026-10-22T12:00:00Z',
  updated_at: '2026-10-22T12:00:00Z',
};

function setup(onDelete = vi.fn().mockResolvedValue(undefined)) {
  const props = { project, taskCount: 2, pending: false, onDelete, onDeleted: vi.fn(), onClose: vi.fn() };
  render(<ProjectDeleteDialog {...props} />);
  return { ...props, user: userEvent.setup() };
}

describe('confirmación de eliminación de proyectos', () => {
  it('muestra el alcance y exige el nombre exacto sin corregir mayúsculas ni espacios', async () => {
    const { user, onDelete, onDeleted } = setup();
    const input = screen.getByRole('textbox', { name: 'Escribe el nombre exacto del proyecto' });
    const button = screen.getByRole('button', { name: 'Eliminar proyecto definitivamente' });
    expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    expect(screen.getByText(/Hay 2 tareas visibles/)).toHaveTextContent('Mi revista');
    expect(screen.getByText(/historial de actividad/)).toBeInTheDocument();
    expect(screen.getByText(/Google Calendar y Google Tasks/)).toBeInTheDocument();
    expect(screen.getByText(/podrá crear otro destino cuando lleguen nuevas tareas/)).toBeInTheDocument();
    expect(button).toBeDisabled();
    for (const mismatch of ['mi revista', 'Mi revista ', ' Mi revista']) {
      await user.clear(input);
      await user.type(input, mismatch);
      expect(button).toBeDisabled();
      fireEvent.submit(input.closest('form')!);
      expect(onDelete).not.toHaveBeenCalled();
    }
    await user.clear(input);
    await user.type(input, project.name);
    expect(button).toBeEnabled();
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(button);
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(project, project.name);
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it('permite cancelar o escapar sin borrar', async () => {
    const { user, onClose, onDelete } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('espera confirmación del servidor, bloquea dobles envíos y conserva errores para reintentar', async () => {
    let reject!: (reason: Error) => void;
    const request = new Promise<void>((_resolve, rejectRequest) => {
      reject = rejectRequest;
    });
    const onDelete = vi.fn().mockReturnValueOnce(request).mockResolvedValueOnce(undefined);
    const { user, onClose, onDeleted } = setup(onDelete);
    const input = screen.getByRole('textbox', { name: 'Escribe el nombre exacto del proyecto' });
    await user.type(input, project.name);
    await user.dblClick(screen.getByRole('button', { name: 'Eliminar proyecto definitivamente' }));
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Eliminando…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => reject(new Error('El proyecto cambió en otro dispositivo.')));
    expect(screen.getByRole('alert')).toHaveTextContent('El proyecto cambió en otro dispositivo.');
    expect(input).toHaveValue(project.name);
    expect(onDeleted).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Eliminar proyecto definitivamente' }));
    expect(onDelete).toHaveBeenCalledTimes(2);
    expect(onDelete.mock.calls[1]).toEqual([project, project.name]);
    expect(onDeleted).toHaveBeenCalledOnce();
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ProjectDuplicateDialog from './ProjectDuplicateDialog';
import { summaryProject } from './summary-test-fixtures';

function callbacks() {
  const copy = { ...summaryProject, id: 'copy-project', name: 'Revista (copia)' };
  return { project: summaryProject, pending: false, onDuplicate: vi.fn().mockResolvedValue(copy), onClose: vi.fn(), onSaved: vi.fn(), copy };
}

describe('duplicación de proyecto', () => {
  it('crea una copia privada con tareas mediante una sola operación y sin alterar el original', async () => {
    const user = userEvent.setup();
    const props = callbacks();
    render(<ProjectDuplicateDialog {...props} taskCount={3} />);
    expect(screen.getByText(/La copia será privada/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Incluir tareas/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: /^Duplicar proyecto$/ }));
    await waitFor(() => expect(props.onDuplicate).toHaveBeenCalledWith('Revista (copia)', true, expect.stringMatching(/^[0-9a-f-]{36}$/)));
    expect(props.onSaved).toHaveBeenCalledExactlyOnceWith(props.copy);
    expect(summaryProject.name).toBe('Revista');
  });

  it('permite duplicar solo configuración', async () => {
    const user = userEvent.setup();
    const props = callbacks();
    render(<ProjectDuplicateDialog {...props} />);
    await user.click(screen.getByRole('checkbox', { name: /Incluir tareas/ }));
    await user.clear(screen.getByLabelText('Nombre de la copia'));
    await user.type(screen.getByLabelText('Nombre de la copia'), '  Edición nueva  ');
    await user.click(screen.getByRole('button', { name: /^Duplicar proyecto$/ }));
    await waitFor(() => expect(props.onDuplicate).toHaveBeenCalledWith('Edición nueva', false, expect.any(String)));
  });

  it.each([
    { includeTasksAllowed: false, taskCount: 2 },
    { includeTasksAllowed: true, taskCount: 51 },
  ])('no ofrece copiar tareas fuera del permiso o límite: %j', async extra => {
    const user = userEvent.setup();
    const props = callbacks();
    render(<ProjectDuplicateDialog {...props} {...extra} />);
    expect(screen.getByRole('checkbox', { name: /Incluir tareas/ })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Incluir tareas/ })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: /^Duplicar proyecto$/ }));
    await waitFor(() => expect(props.onDuplicate).toHaveBeenCalledWith('Revista (copia)', false, expect.any(String)));
  });

  it('conserva el borrador y la identidad ante una respuesta ambigua', async () => {
    const user = userEvent.setup();
    const props = callbacks();
    props.onDuplicate.mockRejectedValueOnce(new Error('No se pudo confirmar la respuesta'));
    render(<ProjectDuplicateDialog {...props} />);
    await user.click(screen.getByRole('button', { name: /^Duplicar proyecto$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo confirmar');
    expect(screen.getByLabelText('Nombre de la copia')).toHaveValue('Revista (copia)');
    expect(props.onSaved).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^Duplicar proyecto$/ }));
    await waitFor(() => expect(props.onDuplicate).toHaveBeenCalledTimes(2));
    expect(props.onDuplicate.mock.calls[0]).toEqual(props.onDuplicate.mock.calls[1]);
  });

  it('impide enviar o cerrar durante una duplicación pendiente', () => {
    const props = callbacks();
    render(<ProjectDuplicateDialog {...props} pending />);
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('button', { name: /^Duplicar proyecto$/ }).closest('form')!);
    expect(props.onDuplicate).not.toHaveBeenCalled();
  });
});

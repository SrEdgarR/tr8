import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import TaskViewNavigation from './TaskViewNavigation';

const available = { summary: true, calendar: true, timeline: true, files: true, activity: true, archived: true };

describe('navegación adaptable de tareas', () => {
  it('ofrece las mismas vistas autorizadas en el selector móvil y en escritorio', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const result = render(<TaskViewNavigation {...available} view="list" disabled={false} onChange={onChange} />);
    const picker = screen.getByRole('combobox', { name: 'Cambiar vista de tareas' });
    expect(screen.getAllByRole('option')).toHaveLength(9);
    await user.selectOptions(picker, 'calendar');
    expect(onChange).toHaveBeenLastCalledWith('calendar');
    result.rerender(<TaskViewNavigation {...available} view="calendar" disabled={false} onChange={onChange} />);
    expect(picker).toHaveValue('calendar');
    expect(screen.getByRole('button', { name: 'Calendario' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Lista' }));
    expect(onChange).toHaveBeenLastCalledWith('list');
  });

  it('no ofrece vistas cuyo contenido no está disponible', () => {
    render(
      <TaskViewNavigation
        summary={false}
        calendar={false}
        timeline={false}
        files={false}
        activity={false}
        archived={false}
        view="board"
        disabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Lista', 'Tablero', 'Tabla']);
    expect(screen.queryByRole('button', { name: 'Archivos' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('board');
  });

  it('bloquea ambos controles durante una acción masiva', async () => {
    const onChange = vi.fn();
    render(<TaskViewNavigation {...available} view="list" disabled onChange={onChange} />);
    expect(screen.getByRole('combobox')).toBeDisabled();
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Calendario' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

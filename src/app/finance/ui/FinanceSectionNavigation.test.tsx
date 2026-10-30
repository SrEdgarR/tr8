import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FinanceSectionNavigation from './FinanceSectionNavigation';

describe('navegación adaptable de Finanzas', () => {
  it('conserva las cinco secciones en escritorio y en el selector móvil controlado', () => {
    const onChange = vi.fn();
    const view = render(<FinanceSectionNavigation selected="Resumen" onChange={onChange} />);
    const picker = screen.getByRole('combobox', { name: 'Cambiar sección de finanzas' });
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Resumen', 'Cuentas', 'Movimientos', 'Planes', 'Seguridad']);
    fireEvent.change(picker, { target: { value: 'Planes' } });
    expect(onChange).toHaveBeenLastCalledWith('Planes');
    view.rerender(<FinanceSectionNavigation selected="Planes" onChange={onChange} />);
    expect(picker).toHaveValue('Planes');
    expect(screen.getByRole('button', { name: 'Planes' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Seguridad' }));
    expect(onChange).toHaveBeenLastCalledWith('Seguridad');
  });
});

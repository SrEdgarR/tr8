import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AmountInput from './AmountInput';

function controlled(initial = '20.2 + 10') {
  const changed = vi.fn();
  const submitted = vi.fn();
  function Fixture() {
    const [value, setValue] = useState(initial);
    return (
      <form
        onSubmit={event => {
          event.preventDefault();
          submitted();
        }}
      >
        <AmountInput
          aria-label="Importe"
          name="amount"
          required
          digits={2}
          value={value}
          onValueChange={next => {
            changed(next);
            setValue(next);
          }}
        />
        <input aria-label="Siguiente campo" />
        <button type="button" onClick={() => setValue('50.00')}>
          Cambiar importe externo
        </button>
        <button type="submit">Guardar</button>
      </form>
    );
  }
  render(<Fixture />);
  return { input: screen.getByRole('textbox', { name: 'Importe' }) as HTMLInputElement, changed, submitted };
}

describe('calculadora de importes', () => {
  it('muestra el resultado accesible y Tab sustituye la expresión sin enviar el formulario ni detener la navegación', async () => {
    const user = userEvent.setup();
    const { input, changed, submitted } = controlled();
    await user.click(input);
    expect(input).toHaveValue('20.2 + 10');
    expect(input).toHaveAccessibleDescription(/30[.,]20/);
    expect(input).toBeRequired();
    expect(input).toHaveAttribute('name', 'amount');
    await user.tab();
    expect(input).toHaveValue('30.20');
    expect(changed).toHaveBeenLastCalledWith('30.20');
    expect(screen.getByRole('textbox', { name: 'Siguiente campo' })).toHaveFocus();
    expect(submitted).not.toHaveBeenCalled();
  });

  it('deshace la sustitución como una sola acción y Ctrl+Y la rehace en un campo controlado', async () => {
    const user = userEvent.setup();
    const { input, submitted } = controlled();
    await user.click(input);
    await user.tab();
    await user.click(input);
    await user.keyboard('{Control>}z{/Control}');
    expect(input).toHaveValue('20.2 + 10');
    await user.keyboard('{Control>}y{/Control}');
    expect(input).toHaveValue('30.20');
    expect(submitted).not.toHaveBeenCalled();
  });

  it('permite aplicar, deshacer y rehacer también con defaultValue sin controlador externo', async () => {
    const user = userEvent.setup();
    render(
      <>
        <AmountInput aria-label="Importe libre" digits={2} defaultValue="20,2 + 10" />
        <input aria-label="Después" />
      </>,
    );
    const input = screen.getByRole('textbox', { name: 'Importe libre' });
    await user.click(input);
    await user.tab();
    expect(input).toHaveValue('30.20');
    expect(screen.getByRole('textbox', { name: 'Después' })).toHaveFocus();
    await user.click(input);
    await user.keyboard('{Control>}z{/Control}');
    expect(input).toHaveValue('20,2 + 10');
    await user.keyboard('{Control>}y{/Control}');
    expect(input).toHaveValue('30.20');
  });

  it('descarta rehacer cuando se escribe una nueva expresión después de deshacer', async () => {
    const user = userEvent.setup();
    const { input } = controlled();
    await user.click(input);
    await user.tab();
    await user.click(input);
    await user.keyboard('{Control>}z{/Control}');
    input.setSelectionRange(input.value.length, input.value.length);
    await user.keyboard(' + 5');
    expect(input).toHaveValue('20.2 + 10 + 5');
    await user.keyboard('{Control>}y{/Control}');
    expect(input).toHaveValue('20.2 + 10 + 5');
    await user.tab();
    expect(input).toHaveValue('35.20');
  });

  it('conserva selección y cursor al deshacer y rehacer una edición dentro de un importe', async () => {
    const user = userEvent.setup();
    const { input } = controlled('123.45');
    await user.click(input);
    input.setSelectionRange(1, 3);
    await user.keyboard('9');
    expect(input).toHaveValue('19.45');
    expect(input.selectionStart).toBe(2);
    await user.keyboard('{Control>}z{/Control}');
    expect(input).toHaveValue('123.45');
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
    await user.keyboard('{Control>}y{/Control}');
    expect(input).toHaveValue('19.45');
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2]);
  });

  it('no sustituye un cálculo incompleto y deja usar Tab para continuar', async () => {
    const user = userEvent.setup();
    const { input, changed, submitted } = controlled('20 +');
    await user.click(input);
    await user.tab();
    expect(input).toHaveValue('20 +');
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Siguiente campo' })).toHaveFocus();
    expect(submitted).not.toHaveBeenCalled();
  });

  it('conserva el importe literal y su precisión original cuando no hay una expresión que aplicar', async () => {
    const user = userEvent.setup();
    const { input, changed } = controlled('20.200');
    await user.click(input);
    await user.tab();
    expect(input).toHaveValue('20.200');
    expect(changed).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Aplicar resultado' })).not.toBeInTheDocument();
  });

  it('ofrece aplicación por botón y Enter sin guardar el formulario', async () => {
    const user = userEvent.setup();
    const { input, submitted } = controlled();
    await user.click(input);
    await user.click(screen.getByRole('button', { name: 'Aplicar resultado' }));
    expect(input).toHaveValue('30.20');
    expect(input).toHaveFocus();
    await user.keyboard('{Control>}z{/Control}');
    expect(input).toHaveValue('20.2 + 10');
    await user.keyboard('{Enter}');
    expect(input).toHaveValue('30.20');
    expect(submitted).not.toHaveBeenCalled();
  });

  it('un valor externo nuevo limpia el historial para no recuperar el importe de otra cuenta o moneda', async () => {
    const user = userEvent.setup();
    const { input } = controlled();
    await user.click(input);
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Cambiar importe externo' }));
    expect(input).toHaveValue('50.00');
    await user.click(input);
    await user.keyboard('{Control>}z{/Control}');
    expect(input).toHaveValue('50.00');
    await user.keyboard('{Control>}y{/Control}');
    expect(input).toHaveValue('50.00');
  });

  it('conserva disabled y readOnly y no aplica cálculos ni atajos en esos campos', () => {
    const changed = vi.fn();
    render(
      <>
        <AmountInput aria-label="Importe deshabilitado" digits={2} value="20 + 10" disabled onValueChange={changed} />
        <AmountInput aria-label="Importe de solo lectura" digits={2} value="20 + 10" readOnly onValueChange={changed} />
      </>,
    );
    const disabled = screen.getByRole('textbox', { name: 'Importe deshabilitado' });
    const readOnly = screen.getByRole('textbox', { name: 'Importe de solo lectura' });
    expect(disabled).toBeDisabled();
    expect(readOnly).toHaveAttribute('readonly');
    for (const input of [disabled, readOnly]) {
      fireEvent.keyDown(input, { key: 'Tab' });
      fireEvent.keyDown(input, { key: 'z', ctrlKey: true });
      fireEvent.keyDown(input, { key: 'y', ctrlKey: true });
      expect(input).toHaveValue('20 + 10');
    }
    expect(changed).not.toHaveBeenCalled();
  });

  it('inserta un operador en el cursor sin perder el foco y retira los botones al continuar con Tab', async () => {
    const user = userEvent.setup();
    const { input, submitted } = controlled('20.2');
    expect(screen.queryByRole('group', { name: 'Operadores del importe', hidden: true })).not.toBeInTheDocument();
    await user.click(input);
    const tools = within(screen.getByRole('group', { name: 'Operadores del importe', hidden: true }));
    for (const name of ['Insertar suma', 'Insertar resta', 'Insertar multiplicación', 'Insertar división']) {
      expect(tools.getByRole('button', { name, hidden: true })).toHaveAttribute('type', 'button');
    }
    input.setSelectionRange(4, 4);
    await user.click(tools.getByRole('button', { name: 'Insertar suma', hidden: true }));
    expect(input).toHaveValue('20.2+');
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5]);
    await user.keyboard('10');
    expect(input).toHaveAccessibleDescription(/30[.,]20/);
    await user.tab();
    expect(input).toHaveValue('30.20');
    expect(screen.getByRole('textbox', { name: 'Siguiente campo' })).toHaveFocus();
    expect(screen.queryByRole('group', { name: 'Operadores del importe', hidden: true })).not.toBeInTheDocument();
    expect(submitted).not.toHaveBeenCalled();
  });

  it('reemplaza la selección con el operador elegido y deshace o rehace la inserción completa', async () => {
    const user = userEvent.setup();
    const { input, submitted } = controlled('12 + 3');
    await user.click(input);
    input.setSelectionRange(3, 4);
    await user.click(screen.getByRole('button', { name: 'Insertar multiplicación', hidden: true }));
    expect(input).toHaveValue('12 × 3');
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 4]);
    expect(input).toHaveAccessibleDescription(/36[.,]00/);
    await user.keyboard('{Control>}z{/Control}');
    expect(input).toHaveValue('12 + 3');
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 4]);
    await user.keyboard('{Control>}y{/Control}');
    expect(input).toHaveValue('12 × 3');
    expect([input.selectionStart, input.selectionEnd]).toEqual([4, 4]);
    expect(submitted).not.toHaveBeenCalled();
  });
});

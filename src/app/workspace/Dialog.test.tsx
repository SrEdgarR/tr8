import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './ui';

function Fixture({ busy = false, onClose = () => {} }: { busy?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Abrir editor</button>
      {open && (
        <Dialog
          title="Editar cuenta"
          className="tf-card-dialog"
          busy={busy}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <label>
            Nombre
            <input data-initial-focus />
          </label>
        </Dialog>
      )}
    </>
  );
}
async function open(options: { busy?: boolean; onClose?: () => void } = {}) {
  render(<Fixture {...options} />);
  await userEvent.click(screen.getByRole('button', { name: 'Abrir editor' }));
  const dialog = screen.getByRole('dialog', { name: 'Editar cuenta' });
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 400, 300));
  return dialog;
}
function press(target: Element, x: number, y: number, button = 0) {
  // jsdom does not implement PointerEvent; React still consumes the native coordinates.
  fireEvent(target, new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button }));
}
function click(target: Element, x: number, y: number) {
  fireEvent.click(target, { clientX: x, clientY: y, detail: 1 });
}
describe('Dialog dismissal', () => {
  it('closes on a genuine backdrop click and restores focus to its opener', async () => {
    const onClose = vi.fn();
    const dialog = await open({ onClose });
    expect(dialog).toHaveClass('pw-dialog', 'tf-card-dialog');
    expect(screen.getByLabelText('Nombre')).toHaveFocus();
    press(dialog, 50, 50);
    click(dialog, 50, 50);
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir editor' })).toHaveFocus();
  });
  it('uses the native Escape cancel event, prevents implicit closure, and calls onClose', async () => {
    const onClose = vi.fn();
    const dialog = await open({ onClose });
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir editor' })).toHaveFocus();
  });
  it('ignores interior clicks, padding clicks, and drags that start inside', async () => {
    const onClose = vi.fn();
    const dialog = await open({ onClose });
    const input = screen.getByLabelText('Nombre');
    press(input, 150, 180);
    click(input, 150, 180);
    press(dialog, 110, 110);
    click(dialog, 110, 110);
    press(input, 150, 180);
    click(dialog, 50, 50);
    press(dialog, 50, 50);
    click(dialog, 150, 150);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });
  it('ignores canceled pointers, right clicks, and backdrop drags', async () => {
    const onClose = vi.fn();
    const dialog = await open({ onClose });
    press(dialog, 50, 50);
    fireEvent.pointerCancel(dialog);
    click(dialog, 50, 50);
    press(dialog, 50, 50, 2);
    click(dialog, 50, 50);
    press(dialog, 50, 50);
    click(dialog, 70, 70);
    expect(onClose).not.toHaveBeenCalled();
  });
  it('keeps the dialog open during an active save for backdrop, Escape, and close button', async () => {
    const onClose = vi.fn();
    const dialog = await open({ busy: true, onClose });
    press(dialog, 50, 50);
    click(dialog, 50, 50);
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: 'Cerrar ventana' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog).toBeInTheDocument();
  });
});

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
  it.each(['inert', 'hidden', 'display'] as const)('restores focus to visible navigation when the original trigger becomes %s', async conceal => {
    function HiddenOrigin() {
      const [open, setOpen] = useState(false);
      const [closedMenu, setClosedMenu] = useState(false);
      return (
        <>
          <button className="pw-menu">Abrir navegación</button>
          <aside
            inert={conceal === 'inert' && closedMenu}
            hidden={conceal === 'hidden' && closedMenu}
            style={conceal === 'display' && closedMenu ? { display: 'none' } : undefined}
          >
            <button
              onClick={() => {
                setClosedMenu(true);
                setOpen(true);
              }}
            >
              Crear desde menú
            </button>
          </aside>
          {open && (
            <Dialog title="Nuevo elemento" onClose={() => setOpen(false)}>
              <input aria-label="Nombre del elemento" data-initial-focus />
            </Dialog>
          )}
        </>
      );
    }
    render(<HiddenOrigin />);
    const opener = screen.getByRole('button', { name: 'Crear desde menú' });
    await userEvent.click(opener);
    expect(screen.getByRole('textbox', { name: 'Nombre del elemento' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar ventana' }));
    expect(opener).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Abrir navegación' })).toHaveFocus();
  });
  it('uses the content fallback when the trigger disappears and navigation is hidden', async () => {
    function RemovedOrigin() {
      const [open, setOpen] = useState(false);
      const [removed, setRemoved] = useState(false);
      return (
        <>
          <button className="pw-menu" style={{ display: 'none' }}>
            Navegación oculta
          </button>
          <main id="workspace-content" tabIndex={-1}>
            Contenido actual
          </main>
          {!removed && (
            <button
              onClick={() => {
                setRemoved(true);
                setOpen(true);
              }}
            >
              Abrir elemento
            </button>
          )}
          {open && (
            <Dialog title="Elemento" onClose={() => setOpen(false)}>
              <input aria-label="Nombre" data-initial-focus />
            </Dialog>
          )}
        </>
      );
    }
    render(<RemovedOrigin />);
    await userEvent.click(screen.getByRole('button', { name: 'Abrir elemento' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cerrar ventana' }));
    expect(screen.getByRole('main')).toHaveFocus();
  });
  it('closes only the inner dialog when Escape cancels a nested editor', async () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    function NestedFixture() {
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <Dialog title="Tarea" onClose={outerClose}>
          <button onClick={() => setInnerOpen(true)}>Editar comentario</button>
          {innerOpen && (
            <Dialog
              title="Comentario"
              onClose={() => {
                innerClose();
                setInnerOpen(false);
              }}
            >
              <input aria-label="Texto del comentario" data-initial-focus />
            </Dialog>
          )}
        </Dialog>
      );
    }
    render(<NestedFixture />);
    const opener = screen.getByRole('button', { name: 'Editar comentario' });
    await userEvent.click(opener);
    const inner = screen.getByRole('dialog', { name: 'Comentario' });
    fireEvent(inner, new Event('cancel', { cancelable: true }));
    expect(innerClose).toHaveBeenCalledOnce();
    expect(outerClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Tarea' })).toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
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

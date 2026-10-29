import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SyncStatus from './SyncStatus';
const connected = (online: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
afterEach(() => connected(true));
describe('confirmed information sync status', () => {
  it('combines confirmed status and refresh in one labeled button', async () => {
    const user = userEvent.setup();
    const refresh = vi.fn();
    render(<SyncStatus state="synced" scope="Proyectos y tareas" onRefresh={refresh} />);
    const button = screen.getByRole('button', { name: 'Actualizar datos' });
    expect(within(button).getByRole('status')).toHaveTextContent('Sincronizado');
    expect(button).toHaveAttribute('title', expect.stringContaining('Pulsa para actualizar los datos'));
    await user.click(button);
    expect(refresh).toHaveBeenCalledExactlyOnceWith();
  });
  it('disables refresh during checking, saving, explicit lockout and offline, but preserves pending retry', async () => {
    const user = userEvent.setup();
    const refresh = vi.fn();
    const view = render(<SyncStatus state="checking" scope="Datos" onRefresh={refresh} />);
    expect(screen.getByRole('button', { name: 'Actualizar datos' })).toBeDisabled();
    view.rerender(<SyncStatus state="saving" scope="Datos" onRefresh={refresh} />);
    expect(screen.getByRole('button', { name: 'Actualizar datos' })).toBeDisabled();
    view.rerender(<SyncStatus state="synced" scope="Datos" onRefresh={refresh} refreshDisabled />);
    expect(screen.getByRole('button', { name: 'Actualizar datos' })).toBeDisabled();
    view.rerender(<SyncStatus state="synced" scope="Datos" onRefresh={refresh} />);
    act(() => {
      connected(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('button', { name: 'Actualizar datos' })).toBeDisabled();
    act(() => {
      connected(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Por confirmar');
    await user.click(screen.getByRole('button', { name: 'Actualizar datos' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('Por confirmar');
    view.rerender(<SyncStatus state="checking" scope="Datos" onRefresh={refresh} />);
    view.rerender(<SyncStatus state="synced" scope="Datos" onRefresh={refresh} />);
    expect(screen.getByRole('status')).toHaveTextContent('Sincronizado');
  });
  it('distinguishes checking, saving, confirmed, pending and error', () => {
    const view = render(<SyncStatus state="checking" scope="Finanzas" />);
    expect(screen.getByRole('status')).toHaveTextContent('Comprobando…');
    view.rerender(<SyncStatus state="saving" scope="Finanzas" />);
    expect(screen.getByRole('status')).toHaveTextContent('Guardando…');
    view.rerender(<SyncStatus state="synced" scope="Finanzas" />);
    expect(screen.getByRole('status')).toHaveTextContent('Sincronizado');
    view.rerender(<SyncStatus state="pending" scope="Finanzas" />);
    expect(screen.getByRole('status')).toHaveTextContent('Por confirmar');
    view.rerender(<SyncStatus state="error" scope="Finanzas" />);
    expect(screen.getByRole('status')).toHaveTextContent('Error de sincronización');
  });
  it('does not treat reconnection alone as a server confirmation', () => {
    const view = render(<SyncStatus state="synced" scope="Finanzas" />);
    act(() => {
      connected(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Sin conexión');
    act(() => {
      connected(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByRole('status')).toHaveTextContent('Por confirmar');
    view.rerender(<SyncStatus state="checking" scope="Finanzas" />);
    view.rerender(<SyncStatus state="synced" scope="Finanzas" />);
    expect(screen.getByRole('status')).toHaveTextContent('Sincronizado');
  });
});

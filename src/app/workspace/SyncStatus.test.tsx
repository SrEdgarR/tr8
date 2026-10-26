import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import SyncStatus from './SyncStatus';
const connected = (online: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
afterEach(() => connected(true));
describe('confirmed information sync status', () => {
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

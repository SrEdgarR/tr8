import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoogleCalendarApi, GoogleCalendarStatus, GoogleCompletion } from '../data/google-calendar';
import { DataError } from '../data/errors';
import { googleAuthorization, googleFixture } from '../test/google-calendar';
import GoogleCalendarPanel from './GoogleCalendarPanel';
import * as popupApi from './google-oauth';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}
const clients: QueryClient[] = [];
function mount(initial: GoogleCalendarStatus = googleFixture(), overrides: Partial<GoogleCalendarApi> = {}) {
  const load = vi.fn().mockResolvedValue(initial);
  const api: GoogleCalendarApi = {
    scopeKey: ['google-calendar', 'owner-a'],
    callbackOrigin: window.location.origin,
    load,
    begin: vi.fn().mockResolvedValue(googleAuthorization()),
    complete: vi.fn().mockResolvedValue(initial),
    change: vi.fn().mockResolvedValue(initial),
    ...overrides,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <GoogleCalendarPanel key={api.scopeKey.join(':')} api={api} />
    </QueryClientProvider>,
  );
  return { ...view, api, load, client };
}
afterEach(() => {
  clients.splice(0).forEach(client => client.clear());
  vi.restoreAllMocks();
});
describe('Google Calendar en Configuración', () => {
  it('adopta provisioning → connected automáticamente y vuelve a consultar cada 30 segundos', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const preparing = googleFixture({ state: 'provisioning', generation: 1, version: 3 });
    const connected = googleFixture({ state: 'connected', generation: 1, version: 4 });
    const load = vi.fn().mockResolvedValueOnce(preparing).mockResolvedValue(connected);
    const view = mount(preparing, { load });
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Preparando tu calendario')).toBeInTheDocument();
      expect(load).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2999);
      });
      expect(load).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(load).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
      expect(screen.getByText('Conectado')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sincronizar ahora' })).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29000);
      });
      expect(load).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(load).toHaveBeenCalledTimes(3);
    } finally {
      view.unmount();
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  it('no consulta en segundo plano y retoma el estado al volver a la aplicación', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const preparing = googleFixture({ state: 'provisioning', generation: 1, version: 3 });
    const connected = googleFixture({ state: 'connected', generation: 1, version: 4 });
    const load = vi.fn().mockResolvedValueOnce(preparing).mockResolvedValue(connected);
    const view = mount(preparing, { load });
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(load).toHaveBeenCalledTimes(1);
      act(() => focusManager.setFocused(false));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90000);
      });
      expect(load).toHaveBeenCalledTimes(1);
      act(() => focusManager.setFocused(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Conectado')).toBeInTheDocument();
    } finally {
      view.unmount();
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  it('mantiene 30 segundos cuando la creación necesita comprobación manual', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const unknown = googleFixture({ state: 'provisioning_unknown', generation: 1, version: 3, reason: 'provisioning_unknown' });
    const load = vi.fn().mockResolvedValue(unknown);
    const view = mount(unknown, { load });
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText('Calendario por comprobar')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29999);
      });
      expect(load).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: 'Recuperar calendario existente' })).toBeInTheDocument();
    } finally {
      view.unmount();
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  it('muestra configuración pendiente sin ofrecer una conexión inexistente', async () => {
    const { api } = mount(googleFixture({ configured: false, reason: 'config_pending' }));
    await screen.findByText('Configuración pendiente');
    expect(screen.queryByRole('button', { name: 'Conectar Google Calendar' })).not.toBeInTheDocument();
    expect(screen.getByText(/altas externas siguen desactivados/)).toBeInTheDocument();
    expect(api.begin).not.toHaveBeenCalled();
  });
  it('explica el consentimiento antes de abrir la ventana y completa con secreto solo en memoria', async () => {
    const authorization = googleAuthorization();
    const completion = deferred<GoogleCompletion>();
    const cancel = vi.fn();
    const authorize = vi.fn();
    const open = vi.spyOn(popupApi, 'openGooglePopup').mockReturnValue({ result: completion.promise, cancel, authorize });
    const { api, load } = mount();
    await screen.findByRole('button', { name: 'Conectar Google Calendar' });
    fireEvent.click(screen.getByRole('button', { name: 'Conectar Google Calendar' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Una copia ya enviada puede permanecer');
    expect(screen.getByRole('link', { name: 'Privacidad en TR8' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: 'Privacidad en TR8' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: 'Acerca de TR8' })).toHaveAttribute('href', '/about');
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar con Google' }));
    expect(open).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(authorize).toHaveBeenCalledWith(authorization));
    expect(api.begin).toHaveBeenCalledWith(
      { request_id: expect.any(String), expected_version: 1, browser_secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
      expect.any(AbortSignal),
    );
    expect(screen.getByRole('button', { name: 'Continuar con Google' })).toBeDisabled();
    const connected = googleFixture({ state: 'connected', generation: 1, version: 3 });
    vi.mocked(api.complete).mockResolvedValue(connected);
    load.mockResolvedValue(connected);
    await act(async () => completion.resolve({ state: authorization.state, browser_secret: 'memory-only' }));
    await screen.findByText('Conectado');
    expect(api.complete).toHaveBeenCalledWith({ state: authorization.state, browser_secret: 'memory-only' }, expect.any(AbortSignal));
    expect(cancel).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('descarta una autorización tardía al salir de la cuenta o pantalla', async () => {
    const completion = deferred<GoogleCompletion>();
    const cancel = vi.fn();
    vi.spyOn(popupApi, 'openGooglePopup').mockReturnValue({ result: completion.promise, cancel, authorize: vi.fn() });
    const { api, unmount } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar Google Calendar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continuar con Google' }));
    await waitFor(() => expect(api.begin).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => completion.resolve({ state: googleAuthorization().state, browser_secret: 'memory-only' }));
    expect(cancel).toHaveBeenCalled();
    expect(api.complete).not.toHaveBeenCalled();
  });
  it('solicita reconciliación sin presentarla como sincronización terminada', async () => {
    const status = googleFixture({ state: 'connected', generation: 1, version: 6, last_sync_at: '2026-10-23T12:00:00Z' });
    const { api, load } = mount(status);
    const pending = { ...status, version: 7, pending: 2 };
    vi.mocked(api.change).mockResolvedValue(pending);
    load.mockResolvedValue(pending);
    fireEvent.click(await screen.findByRole('button', { name: 'Sincronizar ahora' }));
    expect(await screen.findByText(/Revisión solicitada/)).toBeInTheDocument();
    expect(api.change).toHaveBeenCalledWith({ action: 'reconcile', request_id: expect.any(String), expected_version: 6 }, expect.any(AbortSignal));
    expect(screen.getByText('2')).toBeInTheDocument();
  });
  it('conserva eventos por defecto y exige elegir explícitamente la eliminación', async () => {
    const status = googleFixture({ state: 'connected', generation: 1, version: 2 });
    const { api, load } = mount(status);
    fireEvent.click(await screen.findByRole('button', { name: 'Desconectar' }));
    expect(screen.getByRole('radio', { name: /Conservar los eventos/ })).toBeChecked();
    expect(api.change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: /Intentar eliminar los eventos/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Conservaremos el calendario y sus demás eventos');
    const next = googleFixture({ state: 'disconnecting', generation: 2, version: 3, pending: 2 });
    vi.mocked(api.change).mockResolvedValue(next);
    load.mockResolvedValue(next);
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar copias y desconectar' }));
    await screen.findByText('Desconectando');
    expect(api.change).toHaveBeenCalledWith(
      { action: 'disconnect', mode: 'delete', request_id: expect.any(String), expected_version: 2 },
      expect.any(AbortSignal),
    );
  });
  it('requiere confirmar el abandono de una limpieza y no oculta el fallo', async () => {
    const status = googleFixture({ state: 'cleanup_failed', generation: 2, version: 5, failed: 2, reason: 'cleanup_failed' });
    const { api, load } = mount(status);
    fireEvent.click(await screen.findByRole('button', { name: 'Conservar restantes y desconectar' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Los eventos que no se pudieron retirar permanecerán en Google');
    expect(api.change).not.toHaveBeenCalled();
    const next = googleFixture({ generation: 3, version: 6 });
    vi.mocked(api.change).mockResolvedValue(next);
    load.mockResolvedValue(next);
    fireEvent.click(screen.getByRole('button', { name: 'Conservar y finalizar' }));
    await screen.findByText('Desconectado');
    expect(api.change).toHaveBeenCalledWith({ action: 'abandon_cleanup', request_id: expect.any(String), expected_version: 5 }, expect.any(AbortSignal));
  });
  it('no recrea un calendario de confirmación desconocida sin comprobar su identificador', async () => {
    const status = googleFixture({ state: 'provisioning_unknown', generation: 1, version: 4, reason: 'provisioning_unknown' });
    const { api } = mount(status);
    fireEvent.click(await screen.findByRole('button', { name: 'Recuperar calendario existente' }));
    expect(screen.getByRole('button', { name: 'Comprobar calendario' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Conectar Google Calendar' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Identificador del calendario' }), {
      target: { value: 'created-calendar@group.calendar.google.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar calendario' }));
    await waitFor(() =>
      expect(api.change).toHaveBeenCalledWith(
        { action: 'recover_calendar', calendar_id: 'created-calendar@group.calendar.google.com', request_id: expect.any(String), expected_version: 4 },
        expect.any(AbortSignal),
      ),
    );
  });
  it('oculta estado anterior si falla la lectura y no reintenta automáticamente mutaciones en conflicto', async () => {
    const status = googleFixture({ state: 'connected', generation: 1, version: 8, pending: 42 });
    const { api, load } = mount(status);
    fireEvent.click(await screen.findByRole('button', { name: 'Sincronizar ahora' }));
    vi.mocked(api.change).mockRejectedValue(new DataError('La conexión cambió en otra pestaña.', 'STALE_VERSION'));
    // The first click's promise was already created; use a fresh mutation after its confirmation.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sincronizar ahora' })).toBeEnabled());
    load.mockRejectedValue(new Error('Ya no tienes acceso'));
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar ahora' }));
    expect(await screen.findByText('La conexión cambió en otra pestaña.')).toBeInTheDocument();
    await screen.findByText('Ya no tienes acceso');
    expect(screen.queryByText('42')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sincronizar ahora' })).not.toBeInTheDocument();
    expect(api.change).toHaveBeenCalledTimes(2);
  });
  it('solo reconstruye eventos eliminados de Google tras una confirmación explícita', async () => {
    const status = googleFixture({ state: 'connected', generation: 1, version: 4, reason: 'remote_missing' });
    const { api } = mount(status);
    fireEvent.click(await screen.findByRole('button', { name: 'Reconstruir eventos ausentes' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('copias manuales');
    expect(screen.getByRole('dialog')).toHaveTextContent('Las ediciones hechas en Google no se importan');
    expect(api.change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reconstruir copias' }));
    await waitFor(() =>
      expect(api.change).toHaveBeenCalledWith({ action: 'rebuild_missing', request_id: expect.any(String), expected_version: 4 }, expect.any(AbortSignal)),
    );
  });
  it('ignora un resultado viejo si otra conexión más nueva ya llegó', async () => {
    const status = googleFixture({ state: 'connected', generation: 1, version: 2 });
    const completion = deferred<GoogleCalendarStatus>();
    const { api, client } = mount(status, { change: vi.fn().mockReturnValue(completion.promise) });
    fireEvent.click(await screen.findByRole('button', { name: 'Sincronizar ahora' }));
    await waitFor(() => expect(api.change).toHaveBeenCalledTimes(1));
    await act(async () =>
      client.setQueryData(
        [...api.scopeKey, 'status'],
        googleFixture({ state: 'needs_reauthorization', generation: 3, version: 10, reason: 'reauthorization_required' }),
      ),
    );
    await act(async () => completion.resolve({ ...status, version: 3, pending: 99 }));
    expect(screen.getByText('Necesita reconexión')).toBeInTheDocument();
    expect(screen.queryByText('99')).not.toBeInTheDocument();
  });
});

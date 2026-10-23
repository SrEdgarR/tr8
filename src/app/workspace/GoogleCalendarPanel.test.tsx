import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoogleCalendarApi, GoogleCalendarStatus, GoogleCompletion } from '../data/google-calendar';
import type { GoogleTasksApi, GoogleTasksStatus } from '../data/google-tasks';
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
function mount(initial: GoogleCalendarStatus = googleFixture(), overrides: Partial<GoogleCalendarApi> = {}, tasksApi?: GoogleTasksApi, collapsible = false) {
  const load = vi.fn().mockResolvedValue(initial);
  const api: GoogleCalendarApi = {
    scopeKey: ['google-calendar', 'owner-a'],
    callbackOrigin: window.location.origin,
    load,
    begin: vi.fn().mockResolvedValue(tasksApi ? tasksAuthorization() : googleAuthorization()),
    complete: vi.fn().mockResolvedValue(initial),
    change: vi.fn().mockResolvedValue(initial),
    ...overrides,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <GoogleCalendarPanel key={api.scopeKey.join(':')} api={api} tasksApi={tasksApi} collapsible={collapsible} />
    </QueryClientProvider>,
  );
  return { ...view, api, load, client };
}
function disconnectedTasks(overrides: Partial<GoogleTasksStatus> = {}): GoogleTasksApi {
  const status: GoogleTasksStatus = {
    configured: true,
    enabled: false,
    state: 'disconnected',
    version: 0,
    last_sync_at: null,
    next_sync_at: null,
    pending: 0,
    failed: 0,
    conflicts: 0,
    reason: null,
    lists: [],
    conflict_items: [],
    ...overrides,
  };
  return { scopeKey: ['google-tasks', 'owner-a'], load: vi.fn().mockResolvedValue(status), change: vi.fn().mockResolvedValue(status) };
}
function connectedTasks(overrides: Partial<GoogleTasksStatus> = {}) {
  return disconnectedTasks({ enabled: true, state: 'connected', version: 4, lists: [{ id: 'list-a', title: 'Mis tareas', selected: true }], ...overrides });
}
function tasksAuthorization() {
  const authorization = googleAuthorization();
  const url = new URL(authorization.authorization_url);
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks');
  return { ...authorization, authorization_url: url.href };
}
afterEach(() => {
  clients.splice(0).forEach(client => client.clear());
  vi.restoreAllMocks();
});
describe('Conexión única de Google en Configuración', () => {
  it('muestra Google cerrado por defecto y abre sus opciones con un control accesible sin desmontarlas', async () => {
    const tasksApi = connectedTasks();
    const { api } = mount(googleFixture({ state: 'connected', generation: 1, version: 5 }), {}, tasksApi, true);
    const toggle = screen.getByRole('button', { name: 'Google' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const body = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(body).toHaveAttribute('hidden');
    await screen.findByText('Conectado');
    expect(api.load).toHaveBeenCalled();
    expect(tasksApi.load).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Sincronizar ahora' })).not.toBeInTheDocument();
    expect(body?.querySelector('.pw-google-tasks.is-embedded')).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(body).not.toHaveAttribute('hidden');
    expect(screen.getByRole('button', { name: 'Sincronizar ahora' })).toBeVisible();
    const lists = screen.getByRole('checkbox', { name: /Mis tareas/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(body).toHaveAttribute('hidden');
    expect(lists.isConnected).toBe(true);
    expect(screen.getByText('Conectado')).toBeVisible();
  });

  it('usa la G multicolor decorativa y referencias únicas para los cuerpos y máscaras SVG', async () => {
    const first = mount(googleFixture(), {}, undefined, true);
    const firstToggle = screen.getByRole('button', { name: 'Google' });
    const firstIcon = firstToggle.querySelector('.pw-google-brand svg')!;
    expect(firstIcon).toHaveAttribute('aria-hidden', 'true');
    expect(firstIcon).toHaveAttribute('focusable', 'false');
    expect(within(firstToggle).queryByRole('img')).not.toBeInTheDocument();
    expect(firstIcon.querySelector('[fill="#3186FF"]')).not.toBeNull();
    expect(firstIcon.querySelector('[fill="#FF4641"]')).not.toBeNull();
    mount(googleFixture(), { scopeKey: ['google-calendar', 'another-instance'] }, undefined, true);
    const toggles = screen.getAllByRole('button', { name: 'Google' });
    expect(new Set(toggles.map(toggle => toggle.getAttribute('aria-controls'))).size).toBe(2);
    const maskIds = [...document.querySelectorAll('.pw-google-brand mask')].map(mask => mask.id);
    expect(new Set(maskIds).size).toBe(2);
    expect(first.container.querySelector('script, img[src], image[href]')).toBeNull();
  });

  it('conserva la autorización y el diálogo en curso al plegar Google', async () => {
    const completion = deferred<GoogleCompletion>();
    const cancel = vi.fn();
    const authorize = vi.fn();
    vi.spyOn(popupApi, 'openGooglePopup').mockReturnValue({ result: completion.promise, cancel, authorize });
    const { api, load } = mount(googleFixture(), {}, undefined, true);
    const toggle = screen.getByRole('button', { name: 'Google' });
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar Google' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Continuar con Google' }));
    await waitFor(() => expect(authorize).toHaveBeenCalledWith(googleAuthorization()));
    fireEvent.click(toggle);
    const body = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(body).toHaveAttribute('hidden');
    expect(body?.contains(screen.getByRole('dialog'))).toBe(false);
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(cancel).not.toHaveBeenCalled();
    expect(api.complete).not.toHaveBeenCalled();
    const next = googleFixture({ state: 'connected', generation: 1, version: 3 });
    vi.mocked(api.complete).mockResolvedValue(next);
    load.mockResolvedValue(next);
    await act(async () => completion.resolve({ state: googleAuthorization().state, browser_secret: 'memory-only' }));
    await waitFor(() => expect(api.complete).toHaveBeenCalledTimes(1));
    await screen.findByText('Conectado');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Sincronizar ahora' })).not.toBeInTheDocument();
  });
  it('revisa el permiso de todas las tareas y permite cancelar sin abrir OAuth ni mutar la conexión', async () => {
    const open = vi.spyOn(popupApi, 'openGooglePopup');
    const tasksApi = disconnectedTasks();
    const { api } = mount(googleFixture({ state: 'connected', generation: 1, version: 5 }), {}, tasksApi);
    fireEvent.click(await screen.findByRole('button', { name: 'Completar conexión con Google' }));
    const dialog = screen.getByRole('dialog', { name: 'Conectar Google' });
    expect(dialog).toHaveTextContent('Google no permite limitar ese permiso a una lista');
    expect(dialog).toHaveTextContent('en TR8 elegirás las listas activas');
    expect(dialog).toHaveTextContent('Se conserva el acceso a tu calendario TR8 si ya estaba conectado');
    expect(dialog).toHaveTextContent('no podemos leer ni modificar la hora');
    expect(open).not.toHaveBeenCalled();
    expect(api.begin).not.toHaveBeenCalled();
    expect(tasksApi.change).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(api.begin).not.toHaveBeenCalled();
  });

  it('solo amplía OAuth con Tasks después del consentimiento explícito y actualiza su estado al volver', async () => {
    const authorization = tasksAuthorization();
    const completion = deferred<GoogleCompletion>();
    const authorize = vi.fn();
    const cancel = vi.fn();
    const open = vi.spyOn(popupApi, 'openGooglePopup').mockReturnValue({ result: completion.promise, authorize, cancel });
    const tasksApi = disconnectedTasks();
    const initial = googleFixture({ state: 'connected', generation: 1, version: 5 });
    const { api, load, client } = mount(initial, { begin: vi.fn().mockResolvedValue(authorization) }, tasksApi);
    fireEvent.click(await screen.findByRole('button', { name: 'Completar conexión con Google' }));
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Continuar con Google' }));
    await waitFor(() => expect(authorize).toHaveBeenCalledWith(authorization));
    expect(api.begin).toHaveBeenCalledExactlyOnceWith(
      { request_id: expect.any(String), expected_version: 5, browser_secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), tasks_requested: true },
      expect.any(AbortSignal),
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(api.complete).not.toHaveBeenCalled();
    const next = { ...initial, version: 6 };
    vi.mocked(api.complete).mockResolvedValue(next);
    load.mockResolvedValue(next);
    const previousTasks = client.getQueryData<GoogleTasksStatus>([...tasksApi.scopeKey, 'status'])!;
    vi.mocked(tasksApi.load).mockResolvedValue({ ...previousTasks, enabled: true, state: 'connected', version: 1 });
    const beforeTasksRefresh = vi.mocked(tasksApi.load).mock.calls.length;
    await act(async () => completion.resolve({ state: authorization.state, browser_secret: 'memory-only' }));
    await waitFor(() => expect(api.complete).toHaveBeenCalledWith({ state: authorization.state, browser_secret: 'memory-only' }, expect.any(AbortSignal)));
    await waitFor(() => expect(vi.mocked(tasksApi.load).mock.calls.length).toBeGreaterThan(beforeTasksRefresh));
    expect(cancel).toHaveBeenCalled();
    expect(tasksApi.change).not.toHaveBeenCalled();
    expect(await screen.findByText('Autorizado')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Completar conexión con Google' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('solicita Calendar y Tasks desde la primera conexión tras explicar ambos permisos', async () => {
    const completion = deferred<GoogleCompletion>();
    const cancel = vi.fn();
    const authorize = vi.fn();
    vi.spyOn(popupApi, 'openGooglePopup').mockReturnValue({ result: completion.promise, cancel, authorize });
    const { api, unmount } = mount(googleFixture(), {}, disconnectedTasks());
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar Google' }));
    const dialog = screen.getByRole('dialog', { name: 'Conectar Google' });
    expect(dialog).toHaveTextContent('Google Calendar y Google Tasks con una misma cuenta y autorización');
    expect(dialog).toHaveTextContent('gestionar tus tareas de Google Tasks');
    expect(dialog).toHaveTextContent('Google no permite limitar ese permiso a una lista');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continuar con Google' }));
    await waitFor(() => expect(api.begin).toHaveBeenCalledTimes(1));
    expect(api.begin).toHaveBeenCalledWith(
      { request_id: expect.any(String), expected_version: 1, browser_secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), tasks_requested: true },
      expect.any(AbortSignal),
    );
    expect(new URL(vi.mocked(authorize).mock.calls[0][0].authorization_url).searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/calendar.app.created https://www.googleapis.com/auth/tasks',
    );
    unmount();
    await act(async () => completion.resolve({ state: googleAuthorization().state, browser_secret: 'late' }));
    expect(api.complete).not.toHaveBeenCalled();
  });
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
    expect(screen.queryByRole('button', { name: 'Conectar Google' })).not.toBeInTheDocument();
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
    await screen.findByRole('button', { name: 'Conectar Google' });
    fireEvent.click(screen.getByRole('button', { name: 'Conectar Google' }));
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
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar Google' }));
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
    expect(screen.queryByRole('button', { name: 'Conectar Google' })).not.toBeInTheDocument();
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

  it('muestra una sola tarjeta y controles compartidos, con Calendar y Tasks como capacidades internas', async () => {
    mount(googleFixture({ state: 'connected', generation: 1, version: 2 }), {}, connectedTasks());
    const card = await screen.findByRole('region', { name: 'Integración con Google' });
    await screen.findByRole('heading', { name: 'Tareas de Google', level: 3 });
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(within(card).getByRole('heading', { name: 'Google', level: 2 })).toBeInTheDocument();
    expect(within(card).getByRole('group', { name: 'Eventos de Google Calendar' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Desconectar' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Sincronizar ahora' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Actualizar conexión' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Conectar Google Tasks|Sincronizar tareas ahora|Actualizar estado de tareas/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Pausar Google Tasks no revoca el permiso/)).not.toBeInTheDocument();
  });

  it('solicita con el botón compartido la revisión de ambos servicios usando la versión actual de Tasks', async () => {
    const initial = googleFixture({ state: 'connected', generation: 1, version: 2 });
    const tasksApi = connectedTasks();
    const { api, load, client } = mount(initial, {}, tasksApi);
    await screen.findByRole('button', { name: 'Pausar tareas' });
    const latestTasks = { ...client.getQueryData<GoogleTasksStatus>([...tasksApi.scopeKey, 'status'])!, version: 9 };
    vi.mocked(tasksApi.load).mockResolvedValue(latestTasks);
    vi.mocked(tasksApi.change).mockResolvedValue({ ...latestTasks, version: 10, pending: 1 });
    vi.mocked(api.change).mockResolvedValue({ ...initial, version: 3 });
    load.mockResolvedValue({ ...initial, version: 3 });
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar ahora' }));
    await waitFor(() =>
      expect(tasksApi.change).toHaveBeenCalledExactlyOnceWith(
        { action: 'tasks_reconcile', request_id: expect.any(String), expected_version: 9 },
        expect.any(AbortSignal),
      ),
    );
    expect(api.change).toHaveBeenCalledExactlyOnceWith({ action: 'reconcile', request_id: expect.any(String), expected_version: 2 }, expect.any(AbortSignal));
    expect(await screen.findByText(/Revisión solicitada/)).toBeInTheDocument();
  });

  it.each([
    { enabled: true, state: 'paused' as const },
    { enabled: false, state: 'disconnected' as const },
  ])('respeta una pausa o permiso desactivado observado al sincronizar: %j', async current => {
    const tasksApi = connectedTasks();
    const { api, client } = mount(googleFixture({ state: 'connected', generation: 1, version: 2 }), {}, tasksApi);
    await screen.findByRole('button', { name: 'Pausar tareas' });
    const snapshot = client.getQueryData<GoogleTasksStatus>([...tasksApi.scopeKey, 'status'])!;
    vi.mocked(tasksApi.load).mockResolvedValue({ ...snapshot, ...current, version: 8 });
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar ahora' }));
    await screen.findByText(/Revisión solicitada/);
    expect(api.change).toHaveBeenCalledTimes(1);
    expect(tasksApi.change).not.toHaveBeenCalled();
  });

  it('actualiza ambos estados si Tasks rechaza una revisión y no reintenta la mutación automáticamente', async () => {
    const tasksApi = connectedTasks();
    const { api, load } = mount(googleFixture({ state: 'connected', generation: 1, version: 2 }), {}, tasksApi);
    await screen.findByRole('button', { name: 'Pausar tareas' });
    const calendarReads = load.mock.calls.length;
    const tasksReads = vi.mocked(tasksApi.load).mock.calls.length;
    vi.mocked(tasksApi.change).mockRejectedValue(new DataError('La revisión de tareas cambió en otra pestaña.', 'STALE_VERSION'));
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar ahora' }));
    expect(await screen.findByText('La revisión de tareas cambió en otra pestaña.')).toBeInTheDocument();
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThan(calendarReads));
    await waitFor(() => expect(vi.mocked(tasksApi.load).mock.calls.length).toBeGreaterThan(tasksReads + 1));
    expect(api.change).toHaveBeenCalledTimes(1);
    expect(tasksApi.change).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Revisión solicitada/)).not.toBeInTheDocument();
  });

  it('bloquea desconectar y sincronizar mientras se guarda una elección de Tasks', async () => {
    const pending = deferred<GoogleTasksStatus>();
    const tasksApi = connectedTasks();
    vi.mocked(tasksApi.change).mockReturnValue(pending.promise);
    const { api, client } = mount(googleFixture({ state: 'connected', generation: 1, version: 2 }), {}, tasksApi);
    fireEvent.click(await screen.findByRole('button', { name: 'Pausar tareas' }));
    await waitFor(() => expect(tasksApi.change).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Desconectar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sincronizar ahora' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Desconectar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar ahora' }));
    expect(api.change).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const paused = { ...client.getQueryData<GoogleTasksStatus>([...tasksApi.scopeKey, 'status'])!, state: 'paused' as const, version: 5 };
    vi.mocked(tasksApi.load).mockResolvedValue(paused);
    await act(async () => pending.resolve(paused));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Desconectar' })).toBeEnabled());
  });

  it('bloquea las listas y pausa de Tasks mientras está pendiente una revisión compartida', async () => {
    const pending = deferred<GoogleCalendarStatus>();
    const tasksApi = connectedTasks();
    const initial = googleFixture({ state: 'connected', generation: 1, version: 2 });
    const { api } = mount(initial, { change: vi.fn().mockReturnValue(pending.promise) }, tasksApi);
    await screen.findByRole('button', { name: 'Pausar tareas' });
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar ahora' }));
    await waitFor(() => expect(api.change).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Pausar tareas' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /Mis tareas/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Pausar tareas' }));
    expect(tasksApi.change).not.toHaveBeenCalled();
    await act(async () => pending.resolve(initial));
    await waitFor(() => expect(tasksApi.change).toHaveBeenCalledTimes(1));
  });

  it('no escribe en Tasks ni repuebla su caché si la lectura compartida termina después de cerrar la pantalla', async () => {
    const delayed = deferred<GoogleTasksStatus>();
    const tasksApi = connectedTasks();
    const { api, client, unmount } = mount(googleFixture({ state: 'connected', generation: 1, version: 2 }), {}, tasksApi);
    await screen.findByRole('button', { name: 'Pausar tareas' });
    const priorTasks = client.getQueryData<GoogleTasksStatus>([...tasksApi.scopeKey, 'status'])!;
    const priorReads = vi.mocked(tasksApi.load).mock.calls.length;
    vi.mocked(tasksApi.load).mockReturnValue(delayed.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Sincronizar ahora' }));
    await waitFor(() => expect(api.change).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(vi.mocked(tasksApi.load).mock.calls.length).toBeGreaterThan(priorReads));
    const signal = vi.mocked(tasksApi.load).mock.calls.at(-1)?.[0];
    unmount();
    client.removeQueries({ queryKey: tasksApi.scopeKey });
    expect(signal?.aborted).toBe(true);
    await act(async () => delayed.resolve({ ...priorTasks, version: 99 }));
    expect(tasksApi.change).not.toHaveBeenCalled();
    expect(client.getQueriesData({ queryKey: tasksApi.scopeKey })).toHaveLength(0);
  });

  it('desconecta la cuenta una sola vez y explica que las tareas de Google permanecen en ambos lugares', async () => {
    const tasksApi = connectedTasks();
    const initial = googleFixture({ state: 'connected', generation: 1, version: 2 });
    const { api, load, client } = mount(initial, {}, tasksApi);
    fireEvent.click(await screen.findByRole('button', { name: 'Desconectar' }));
    const dialog = screen.getByRole('dialog', { name: 'Desconectar Google' });
    expect(dialog).toHaveTextContent('Desconectar Google también detendrá Google Tasks');
    expect(dialog).toHaveTextContent('Sus tareas se conservarán tanto en Google como en el proyecto personal importado');
    expect(within(dialog).getByRole('radio', { name: /Conservar los eventos/ })).toBeChecked();
    const disconnected = googleFixture({ state: 'disconnected', generation: 2, version: 3 });
    vi.mocked(api.change).mockResolvedValue(disconnected);
    load.mockResolvedValue(disconnected);
    vi.mocked(tasksApi.load).mockResolvedValue({
      ...client.getQueryData<GoogleTasksStatus>([...tasksApi.scopeKey, 'status'])!,
      state: 'disconnected',
      enabled: false,
      version: 5,
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Conservar y desconectar' }));
    await screen.findByRole('button', { name: 'Conectar Google' });
    expect(api.change).toHaveBeenCalledExactlyOnceWith(
      { action: 'disconnect', mode: 'keep', request_id: expect.any(String), expected_version: 2 },
      expect.any(AbortSignal),
    );
    expect(tasksApi.change).not.toHaveBeenCalled();
  });
});

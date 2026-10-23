import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataError } from '../data/errors';
import type { GoogleTasksApi, GoogleTasksStatus } from '../data/google-tasks';
import GoogleTasksPanel, { type GoogleTasksPanelProps } from './GoogleTasksPanel';

function fixture(change: Partial<GoogleTasksStatus> = {}): GoogleTasksStatus {
  return {
    configured: true,
    enabled: true,
    state: 'connected',
    version: 3,
    last_sync_at: '2026-10-23T12:00:00Z',
    next_sync_at: null,
    pending: 0,
    failed: 0,
    conflicts: 0,
    reason: null,
    lists: [
      { id: 'list-a', title: 'Mis tareas', selected: true },
      { id: 'list-b', title: 'Compras', selected: false },
    ],
    conflict_items: [],
    ...change,
  };
}
const clients: QueryClient[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
function mount(
  initial = fixture(),
  overrides: Partial<GoogleTasksApi> = {},
  presentation: Pick<GoogleTasksPanelProps, 'embedded' | 'connectionBusy' | 'onBusyChange'> = {},
) {
  const load = vi.fn().mockResolvedValue(initial);
  const api: GoogleTasksApi = { scopeKey: ['google-tasks', 'owner-a'], load, change: vi.fn().mockResolvedValue(initial), ...overrides };
  const onConnect = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <StrictMode>
        <GoogleTasksPanel api={api} onConnect={onConnect} {...presentation} />
      </StrictMode>
    </QueryClientProvider>,
  );
  return { ...view, api, client, onConnect, load };
}
afterEach(() => {
  clients.splice(0).forEach(client => client.clear());
  vi.restoreAllMocks();
});

describe('Google Tasks en Configuración', () => {
  it('se integra en la tarjeta Google sin otra sección, cabecera, conectar, refrescar o sincronizar independientes', async () => {
    const { container, onConnect } = mount(fixture(), {}, { embedded: true });
    await screen.findByText('Autorizado');
    expect(screen.getByRole('heading', { level: 3, name: 'Tareas de Google' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    expect(container.querySelector('section')).toBeNull();
    expect(container.querySelector('header')).toBeNull();
    expect(container.querySelector('footer')).toBeNull();
    expect(container.querySelector('.pw-google-tasks')).toHaveClass('is-embedded');
    expect(screen.queryByRole('button', { name: /Conectar|autorizar|Actualizar|Sincronizar|Desconectar/i })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Mis tareas/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Pausar tareas' })).toBeInTheDocument();
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('delega el consentimiento pendiente y los errores de carga a los controles comunes de Google', async () => {
    const { api, onConnect, unmount } = mount(fixture({ enabled: false, state: 'disconnected' }), {}, { embedded: true });
    await screen.findByText('Permiso pendiente');
    expect(screen.queryByRole('button', { name: /Conectar Google Tasks/ })).not.toBeInTheDocument();
    expect(api.change).not.toHaveBeenCalled();
    expect(onConnect).not.toHaveBeenCalled();
    unmount();
    mount(
      fixture(),
      { scopeKey: ['google-tasks', 'failed-owner'], load: vi.fn().mockRejectedValue(new Error('No se pudo consultar Google')) },
      { embedded: true },
    );
    await screen.findByText('No se pudo consultar Google');
    expect(screen.queryByRole('button', { name: /Reintentar|Actualizar/ })).not.toBeInTheDocument();
  });

  it('bloquea listas, pausa y conflictos durante una operación común de Google', async () => {
    const { api } = mount(
      fixture({ conflicts: 1, conflict_items: [{ id: 'link-a', title: 'Tarea', google_title: 'Otra', reason: 'concurrent_changes' }] }),
      {},
      { embedded: true, connectionBusy: true },
    );
    const list = await screen.findByRole('checkbox', { name: /Compras/ });
    expect(list).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pausar tareas' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Elegir TR8' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Elegir Google' })).toBeDisabled();
    fireEvent.click(list);
    fireEvent.click(screen.getByRole('button', { name: 'Pausar tareas' }));
    expect(api.change).not.toHaveBeenCalled();
    expect(screen.queryByText('Guardando tu elección…')).not.toBeInTheDocument();
  });

  it('avisa al padre de una operación local antes de esperar la respuesta y lo libera al finalizar', async () => {
    const result = deferred<GoogleTasksStatus>();
    const onBusyChange = vi.fn();
    const { api, load } = mount(fixture(), { change: vi.fn().mockReturnValue(result.promise) }, { embedded: true, onBusyChange });
    fireEvent.click(await screen.findByRole('checkbox', { name: /Compras/ }));
    expect(onBusyChange).toHaveBeenCalledExactlyOnceWith(true);
    await waitFor(() => expect(api.change).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Pausar tareas' })).toBeDisabled();
    const next = fixture({ version: 4 });
    load.mockResolvedValue(next);
    await act(async () => result.resolve(next));
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pausar tareas' })).toBeEnabled());
  });

  it('libera el bloqueo al desmontarse y una respuesta antigua no libera otra operación del padre', async () => {
    const result = deferred<GoogleTasksStatus>();
    const onBusyChange = vi.fn();
    const { api, unmount } = mount(fixture(), { change: vi.fn().mockReturnValue(result.promise) }, { embedded: true, onBusyChange });
    fireEvent.click(await screen.findByRole('checkbox', { name: /Compras/ }));
    await waitFor(() => expect(api.change).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(api.change).mock.calls[0][1];
    unmount();
    expect(signal?.aborted).toBe(true);
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    await act(async () => result.resolve(fixture({ version: 4 })));
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });
  it('explica el permiso amplio, la selección de listas y la fecha sin horas antes de conectar', async () => {
    const { api, onConnect } = mount(fixture({ enabled: false, state: 'disconnected' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Conectar Google Tasks' }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(api.change).not.toHaveBeenCalled();
    expect(screen.getByText(/Google solicita acceso a todas tus tareas/)).toBeInTheDocument();
    expect(screen.getByText(/La fecha de Google se guarda como fecha de inicio, sin hora/)).toBeInTheDocument();
    expect(screen.getByText(/No crearemos eventos duplicados/)).toBeInTheDocument();
  });

  it('mantiene la configuración incompleta desactivada', async () => {
    mount(fixture({ configured: false, enabled: false, state: 'disconnected', reason: 'config_pending' }));
    await screen.findByText('Configuración pendiente');
    expect(screen.queryByRole('button', { name: 'Conectar Google Tasks' })).not.toBeInTheDocument();
  });

  it('actualiza una lista seleccionada con UUID, versión y cancelación; conserva las demás', async () => {
    const { api, load } = mount();
    const next = fixture({
      version: 4,
      lists: [
        { id: 'list-a', title: 'Mis tareas', selected: true },
        { id: 'list-b', title: 'Compras', selected: true },
      ],
    });
    vi.mocked(api.change).mockResolvedValue(next);
    load.mockResolvedValue(next);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Compras/ }));
    await waitFor(() => expect(api.change).toHaveBeenCalledTimes(1));
    expect(api.change).toHaveBeenCalledWith(
      { action: 'tasks_select_list', list_id: 'list-b', selected: true, expected_version: 3, request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      expect.any(AbortSignal),
    );
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Compras/ })).toBeChecked());
    expect(screen.getByRole('checkbox', { name: /Mis tareas/ })).toBeChecked();
  });

  it('pausa sin revocar el permiso y permite reanudar con otra acción explícita', async () => {
    const { api, load } = mount();
    const paused = fixture({ state: 'paused', version: 4 });
    vi.mocked(api.change).mockResolvedValue(paused);
    load.mockResolvedValue(paused);
    fireEvent.click(await screen.findByRole('button', { name: 'Pausar tareas' }));
    await screen.findByText('En pausa');
    expect(api.change).toHaveBeenLastCalledWith({ action: 'tasks_pause', request_id: expect.any(String), expected_version: 3 }, expect.any(AbortSignal));
    expect(screen.getByText(/Pausar Google Tasks no revoca el permiso de Google/)).toBeInTheDocument();
    vi.mocked(api.change).mockResolvedValue(fixture({ version: 5 }));
    load.mockResolvedValue(fixture({ version: 5 }));
    fireEvent.click(screen.getByRole('button', { name: 'Reanudar tareas' }));
    await screen.findByRole('button', { name: 'Pausar tareas' });
    expect(api.change).toHaveBeenLastCalledWith({ action: 'tasks_resume', request_id: expect.any(String), expected_version: 4 }, expect.any(AbortSignal));
  });

  it('solicita revisión sin afirmar que las tareas ya se sincronizaron', async () => {
    const { api, load } = mount();
    vi.mocked(api.change).mockResolvedValue(fixture({ version: 4, pending: 2 }));
    load.mockResolvedValue(fixture({ version: 4, pending: 2 }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sincronizar tareas ahora' }));
    expect(await screen.findByText(/Revisión solicitada/)).toBeInTheDocument();
    expect(api.change).toHaveBeenCalledWith({ action: 'tasks_reconcile', request_id: expect.any(String), expected_version: 3 }, expect.any(AbortSignal));
  });

  it.each([
    ['Elegir TR8', 'Conservar versión de TR8', 'local'],
    ['Elegir Google', 'Conservar versión de Google', 'google'],
  ])('revisa el conflicto antes de %s', async (trigger, confirm, choice) => {
    const conflict = { id: 'link-a', title: 'Título en TR8', google_title: 'Título en Google', reason: 'concurrent_changes' };
    const { api, load } = mount(fixture({ conflicts: 1, conflict_items: [conflict] }));
    fireEvent.click(await screen.findByRole('button', { name: trigger }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Título en TR8');
    expect(dialog).toHaveTextContent('Título en Google');
    expect(dialog).toHaveTextContent('reemplazar el título, la fecha y el estado');
    expect(api.change).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
    vi.mocked(api.change).mockResolvedValue(fixture({ version: 4 }));
    load.mockResolvedValue(fixture({ version: 4 }));
    fireEvent.click(within(dialog).getByRole('button', { name: confirm }));
    await waitFor(() =>
      expect(api.change).toHaveBeenCalledWith(
        { action: 'tasks_resolve', link_id: 'link-a', resolution: choice, request_id: expect.any(String), expected_version: 3 },
        expect.any(AbortSignal),
      ),
    );
  });

  it('explica la eliminación antes de elegir una tarea eliminada en Google', async () => {
    const { api } = mount(fixture({ conflicts: 1, conflict_items: [{ id: 'link-a', title: 'Tarea', google_title: null, reason: 'remote_deleted' }] }));
    fireEvent.click(await screen.findByRole('button', { name: 'Elegir Google' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('puede retirar la tarea vinculada de TR8');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancelar' }));
    expect(api.change).not.toHaveBeenCalled();
  });

  it('no envía cambios duplicados ni sobrescribe una versión más reciente', async () => {
    const result = deferred<GoogleTasksStatus>();
    const { api, client } = mount(fixture(), { change: vi.fn().mockReturnValue(result.promise) });
    const button = await screen.findByRole('button', { name: 'Sincronizar tareas ahora' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(api.change).toHaveBeenCalledTimes(1));
    await act(async () => client.setQueryData([...api.scopeKey, 'status'], fixture({ state: 'needs_reauthorization', version: 10 })));
    await act(async () => result.resolve(fixture({ version: 4, pending: 99 })));
    expect(screen.getByText('Necesita autorización')).toBeInTheDocument();
    expect(screen.queryByText('99')).not.toBeInTheDocument();
  });

  it('oculta los datos anteriores cuando falla la lectura y no reintenta mutaciones', async () => {
    const { api, load } = mount(fixture({ pending: 42 }));
    vi.mocked(api.change).mockRejectedValue(new DataError('La conexión cambió en otra pestaña.', 'STALE_VERSION'));
    load.mockRejectedValue(new Error('La cuenta ya no tiene acceso'));
    fireEvent.click(await screen.findByRole('button', { name: 'Sincronizar tareas ahora' }));
    await screen.findByText('La cuenta ya no tiene acceso');
    expect(screen.queryByText('42')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(api.change).toHaveBeenCalledTimes(1);
  });

  it('descarta una respuesta tardía y cancela su solicitud al cambiar de cuenta', async () => {
    const result = deferred<GoogleTasksStatus>();
    const { api, client, rerender } = mount(fixture(), { change: vi.fn().mockReturnValue(result.promise) });
    fireEvent.click(await screen.findByRole('button', { name: 'Sincronizar tareas ahora' }));
    await waitFor(() => expect(api.change).toHaveBeenCalledTimes(1));
    const requestSignal = vi.mocked(api.change).mock.calls[0][1];
    const nextApi = { ...api, scopeKey: ['google-tasks', 'owner-b'], load: vi.fn().mockResolvedValue(fixture({ lists: [], version: 1 })) };
    rerender(
      <QueryClientProvider client={client}>
        <GoogleTasksPanel api={nextApi} onConnect={vi.fn()} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(nextApi.load).toHaveBeenCalled());
    expect(requestSignal?.aborted).toBe(true);
    await act(async () => result.resolve(fixture({ version: 4, pending: 99 })));
    expect(screen.queryByText('99')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('consulta cada 30 segundos estable y no consulta en segundo plano', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const { unmount, load } = mount();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const initialCalls = load.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29999);
      });
      expect(load).toHaveBeenCalledTimes(initialCalls);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(load).toHaveBeenCalledTimes(initialCalls + 1);
      act(() => focusManager.setFocused(false));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90000);
      });
      expect(load).toHaveBeenCalledTimes(initialCalls + 1);
      act(() => focusManager.setFocused(true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(load).toHaveBeenCalledTimes(initialCalls + 2);
    } finally {
      unmount();
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  it('acelera trabajos pendientes por un tiempo acotado y luego vuelve a 30 segundos', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const { unmount, load } = mount(fixture({ pending: 1 }));
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const initialCalls = load.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(load).toHaveBeenCalledTimes(initialCalls + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(57000);
      });
      const afterMinute = load.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(29999);
      });
      expect(load).toHaveBeenCalledTimes(afterMinute);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(load).toHaveBeenCalledTimes(afterMinute + 1);
    } finally {
      unmount();
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });
});

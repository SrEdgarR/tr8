import { StrictMode, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarApi, CalendarPreferences, WorkspaceSummary } from '../types';
import { DataError } from '../data/errors';
import * as CalendarTime from './CalendarTime';
import Calendar from './Calendar';
import CalendarSettings from './CalendarZoneSettings';

const emptyProfile: CalendarPreferences = { time_zone: null, version: 1, updated_at: null };
const savedProfile = (zone: string, version = 2): CalendarPreferences => ({ time_zone: zone, version, updated_at: '2026-10-23T12:00:00Z' });
const spaces: WorkspaceSummary[] = [
  { id: 'personal-a', kind: 'personal', name: 'Personal', owner_id: 'owner-a', version: 1, permissions: ['project.read', 'task.read'] },
];

function calendarApi(overrides: Partial<CalendarApi> = {}): CalendarApi {
  return {
    scopeKey: ['calendar-zone-test', 'owner-a'],
    profile: vi.fn().mockResolvedValue(emptyProfile),
    saveProfile: vi.fn().mockImplementation((zone: string, version: number) => Promise.resolve(savedProfile(zone, version + 1))),
    items: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    scheduleTask: vi.fn(),
    ...overrides,
  };
}

function mount(api: CalendarApi, strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const content = (current: CalendarApi) => <Calendar api={current} workspaces={spaces} projects={[]} onOpen={vi.fn()} />;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{strict ? <StrictMode>{children}</StrictMode> : children}</QueryClientProvider>
  );
  const rendered = render(content(api), { wrapper });
  return { ...rendered, client, rerenderCalendar: (current: CalendarApi) => rendered.rerender(content(current)) };
}

describe('preferencia horaria automática del calendario', () => {
  beforeEach(() => {
    vi.spyOn(CalendarTime, 'detectDeviceTimeZone').mockReturnValue('Asia/Tokyo');
  });

  it('guarda la zona detectada una sola vez en modo estricto y espera la confirmación del servidor antes de consultar fechas', async () => {
    let finishSave!: (saved: CalendarPreferences) => void;
    const api = calendarApi({
      saveProfile: vi.fn().mockImplementation(
        () =>
          new Promise<CalendarPreferences>(resolve => {
            finishSave = resolve;
          }),
      ),
    });
    const { rerenderCalendar } = mount(api, true);
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledExactlyOnceWith('Asia/Tokyo', 1));
    expect(api.items).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Zona horaria de visualización' })).toBeDisabled();
    await act(async () => {
      finishSave(savedProfile('Asia/Tokyo'));
    });
    await screen.findByRole('button', { name: 'Mes siguiente' });
    rerenderCalendar(api);
    expect(api.saveProfile).toHaveBeenCalledTimes(1);
    expect(api.items).toHaveBeenCalledWith(expect.objectContaining({ time_zone: 'Asia/Tokyo' }), expect.any(AbortSignal));
    expect(screen.queryByRole('region', { name: 'Zona horaria del calendario' })).not.toBeInTheDocument();
    expect(screen.getByText(/Horas en Asia\/Tokyo/)).toBeInTheDocument();
  });

  it('respeta la preferencia existente aunque el dispositivo tenga otra zona y adopta cambios posteriores sin sobrescribirlos', async () => {
    const profile = vi.fn().mockResolvedValue(savedProfile('America/La_Paz', 3));
    const api = calendarApi({ profile });
    const { client } = mount(api, true);
    await screen.findByRole('button', { name: 'Mes siguiente' });
    expect(screen.queryByRole('combobox', { name: 'Zona horaria de visualización' })).not.toBeInTheDocument();
    expect(screen.getByText(/Horas en America\/La_Paz/)).toBeInTheDocument();
    expect(api.saveProfile).not.toHaveBeenCalled();
    profile.mockResolvedValue(savedProfile('Europe/Madrid', 4));
    await act(async () => {
      await client.refetchQueries({ queryKey: [...api.scopeKey, 'profile'], exact: true });
    });
    await screen.findByText(/Horas en Europe\/Madrid/);
    expect(api.saveProfile).not.toHaveBeenCalled();
    expect(api.items).toHaveBeenLastCalledWith(expect.objectContaining({ time_zone: 'Europe/Madrid' }), expect.any(AbortSignal));
  });

  it('un fallo automático no genera un bucle y permite guardar manualmente otra zona', async () => {
    const saveProfile = vi
      .fn()
      .mockRejectedValueOnce(new Error('Sin conexión'))
      .mockImplementation((zone: string, version: number) => Promise.resolve(savedProfile(zone, version + 1)));
    const api = calendarApi({ saveProfile });
    const { client, rerenderCalendar } = mount(api, true);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sin conexión');
    expect(saveProfile).toHaveBeenCalledTimes(1);
    expect(api.items).not.toHaveBeenCalled();
    rerenderCalendar({ ...api });
    await act(async () => {
      await client.refetchQueries({ queryKey: [...api.scopeKey, 'profile'], exact: true });
    });
    expect(saveProfile).toHaveBeenCalledTimes(1);
    const input = screen.getByRole('combobox', { name: 'Zona horaria de visualización' });
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: 'UTC' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar zona' }));
    await screen.findByRole('button', { name: 'Mes siguiente' });
    expect(saveProfile).toHaveBeenNthCalledWith(2, 'UTC', 1);
    expect(api.items).toHaveBeenLastCalledWith(expect.objectContaining({ time_zone: 'UTC' }), expect.any(AbortSignal));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ante un conflicto de inicialización carga la zona guardada en otra sesión sin reintentar la escritura automática', async () => {
    const profile = vi.fn().mockResolvedValueOnce(emptyProfile).mockResolvedValue(savedProfile('Pacific/Auckland', 2));
    const api = calendarApi({ profile, saveProfile: vi.fn().mockRejectedValue(new DataError('Conflicto de versión', 'PT409')) });
    const { client } = mount(api);
    await screen.findByText(/Horas en Pacific\/Auckland/);
    expect(screen.queryByRole('region', { name: 'Zona horaria del calendario' })).not.toBeInTheDocument();
    expect(api.saveProfile).toHaveBeenCalledExactlyOnceWith('Asia/Tokyo', 1);
    await act(async () => {
      await client.refetchQueries({ queryKey: [...api.scopeKey, 'profile'], exact: true });
    });
    expect(api.saveProfile).toHaveBeenCalledTimes(1);
    expect(api.items).toHaveBeenLastCalledWith(expect.objectContaining({ time_zone: 'Pacific/Auckland' }), expect.any(AbortSignal));
  });

  it('si el dispositivo no entrega una zona válida deja elegir manualmente y no inventa una preferencia', async () => {
    vi.mocked(CalendarTime.detectDeviceTimeZone).mockReturnValue(null);
    const api = calendarApi();
    mount(api);
    await screen.findByText(/No pudimos detectar la zona del dispositivo/);
    const input = screen.getByRole('combobox', { name: 'Zona horaria de visualización' });
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue('');
    expect(api.saveProfile).not.toHaveBeenCalled();
    expect(api.items).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirmar zona' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'Bolivia' } });
    expect(screen.getByRole('button', { name: 'Confirmar zona' })).toBeDisabled();
    fireEvent.change(input, { target: { value: 'America/La_Paz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar zona' }));
    await screen.findByRole('button', { name: 'Mes siguiente' });
    expect(api.saveProfile).toHaveBeenCalledExactlyOnceWith('America/La_Paz', 1);
  });

  it('no inicializa preferencias si falla la carga del perfil o está denegado el acceso al calendario', async () => {
    const failed = calendarApi({ profile: vi.fn().mockRejectedValue(new Error('Perfil no disponible')) });
    const { unmount } = mount(failed);
    expect(await screen.findByRole('alert')).toHaveTextContent('Perfil no disponible');
    expect(failed.saveProfile).not.toHaveBeenCalled();
    expect(failed.items).not.toHaveBeenCalled();
    unmount();
    const denied = calendarApi({ accessError: 'Ya no tienes acceso' });
    mount(denied);
    expect(await screen.findByRole('alert')).toHaveTextContent('Ya no tienes acceso');
    await waitFor(() => expect(denied.profile).toHaveBeenCalled());
    expect(denied.saveProfile).not.toHaveBeenCalled();
    expect(denied.items).not.toHaveBeenCalled();
  });
});

describe('zona horaria en Configuración', () => {
  function mountSettings(api: CalendarApi) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    return { ...render(<CalendarSettings api={api} processes={<div>Procesos en segundo plano</div>} />, { wrapper }), client };
  }

  it('permite editar la preferencia guardada y la comparte con el calendario sin volver a mostrar el editor allí', async () => {
    const api = calendarApi({ profile: vi.fn().mockResolvedValue(savedProfile('America/La_Paz', 3)) });
    const { client, rerender } = mountSettings(api);
    const input = await screen.findByRole('combobox', { name: 'Zona horaria de visualización' });
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue('America/La_Paz');
    expect(screen.getByText('Procesos en segundo plano')).toBeInTheDocument();
    expect(api.saveProfile).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Europe/Madrid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar zona' }));
    await screen.findByText(/Zona horaria guardada\. Los vencimientos/);
    expect(api.saveProfile).toHaveBeenCalledExactlyOnceWith('Europe/Madrid', 3);
    expect(screen.getByRole('combobox', { name: 'Zona horaria de visualización' })).toHaveValue('Europe/Madrid');
    expect(client.getQueryData([...api.scopeKey, 'profile'])).toEqual(savedProfile('Europe/Madrid', 4));
    vi.mocked(api.profile).mockResolvedValue(savedProfile('Europe/Madrid', 4));
    rerender(<Calendar api={api} workspaces={spaces} projects={[]} onOpen={vi.fn()} />);
    await screen.findByRole('button', { name: 'Mes siguiente' });
    expect(screen.queryByRole('region', { name: 'Zona horaria del calendario' })).not.toBeInTheDocument();
    expect(api.items).toHaveBeenCalledWith(expect.objectContaining({ time_zone: 'Europe/Madrid' }), expect.any(AbortSignal));
  });

  it('no guarda una zona automática solo por visitar Configuración con un perfil nuevo', async () => {
    const api = calendarApi();
    mountSettings(api);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirmar zona' })).toBeEnabled());
    expect(api.saveProfile).not.toHaveBeenCalled();
    expect(api.items).not.toHaveBeenCalled();
  });

  it('conserva el borrador después de un conflicto y exige otra acción explícita con la versión actual', async () => {
    const profile = vi.fn().mockResolvedValueOnce(savedProfile('America/La_Paz', 3)).mockResolvedValue(savedProfile('Asia/Tokyo', 4));
    const saveProfile = vi.fn().mockRejectedValueOnce(new DataError('Conflicto de versión', 'PT409')).mockResolvedValue(savedProfile('Europe/Madrid', 5));
    const api = calendarApi({ profile, saveProfile });
    mountSettings(api);
    const input = await screen.findByRole('combobox', { name: 'Zona horaria de visualización' });
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: 'Europe/Madrid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar zona' }));
    await screen.findByText('Se cargó la zona guardada desde otra sesión. Revisa la hora antes de cambiarla.');
    expect(input).toHaveValue('Europe/Madrid');
    expect(screen.getByText('Actual: Asia/Tokyo')).toBeInTheDocument();
    expect(saveProfile).toHaveBeenCalledExactlyOnceWith('Europe/Madrid', 3);
    fireEvent.click(screen.getByRole('button', { name: 'Guardar zona' }));
    await screen.findByText(/Zona horaria guardada\. Los vencimientos/);
    expect(saveProfile).toHaveBeenNthCalledWith(2, 'Europe/Madrid', 4);
  });
});

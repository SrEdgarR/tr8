import { StrictMode } from 'react';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appearanceStorageKey, DEFAULT_APPEARANCE, parseAppearance, readAppearance, type AppearancePatch } from './appearance';
import useAppearance from './useAppearance';
import CalendarSettings from './CalendarZoneSettings';

let nextOwner = 0;
const owner = () => `appearance-owner-${++nextOwner}`;

beforeEach(() => {
  window.localStorage.clear();
  for (const name of ['data-theme', 'data-accent', 'data-side', 'data-density', 'data-motion']) document.documentElement.removeAttribute(name);
});

describe('preferencias de apariencia por cuenta', () => {
  it('recupera únicamente el formato versionado y descarta datos inválidos o del prototipo', () => {
    for (const value of [
      null,
      [],
      { ...DEFAULT_APPEARANCE, version: 2 },
      { ...DEFAULT_APPEARANCE, email: 'legacy@example.test' },
      { ...DEFAULT_APPEARANCE, theme: '<script>' },
    ])
      expect(parseAppearance(value)).toBeNull();
    for (const raw of ['{', 'null', '[]', 'x'.repeat(2049)]) expect(readAppearance(raw)).toEqual(DEFAULT_APPEARANCE);
    expect(appearanceStorageKey('someone@example.test')).toBeNull();
  });

  it('aplica preferencias guardadas y restaura los atributos anteriores al cerrar la cuenta', () => {
    const id = owner();
    document.documentElement.setAttribute('data-theme', 'light');
    window.localStorage.setItem(appearanceStorageKey(id)!, JSON.stringify({ ...DEFAULT_APPEARANCE, theme: 'dark', accent: 'rose', motion: 'reduce' }));
    const { result, unmount } = renderHook(() => useAppearance(id), { wrapper: StrictMode });
    expect(result.current.persisted).toBe(true);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('data-accent', 'rose');
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduce');
    unmount();
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(document.documentElement).not.toHaveAttribute('data-accent');
    expect(document.documentElement).not.toHaveAttribute('data-motion');
  });

  it('mantiene separadas dos cuentas, sus densidades y su estado de navegación', () => {
    const first = owner(),
      second = owner();
    const { result, rerender } = renderHook(({ id }) => useAppearance(id), { initialProps: { id: first } });
    act(() => result.current.update({ theme: 'dark', accent: 'teal', sidebarDensity: 'compact', taskDensity: 'compact', sidebarCollapsed: true }));
    expect(document.documentElement).toHaveAttribute('data-side', 'compact');
    expect(document.documentElement).toHaveAttribute('data-density', 'compact');
    expect(JSON.parse(window.localStorage.getItem(appearanceStorageKey(first)!)!)).toMatchObject({ accent: 'teal', sidebarCollapsed: true });
    expect(window.localStorage.getItem(appearanceStorageKey(second)!)).toBeNull();
    rerender({ id: second });
    expect(result.current.preferences).toEqual(DEFAULT_APPEARANCE);
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(document.documentElement).not.toHaveAttribute('data-accent');
    expect(document.documentElement).toHaveAttribute('data-side', 'comfortable');
    act(() => result.current.update({ theme: 'light', accent: 'blue' }));
    rerender({ id: first });
    expect(result.current.preferences).toMatchObject({ theme: 'dark', accent: 'teal', sidebarCollapsed: true });
  });

  it('sin identidad estable conserva ajustes solo en memoria y no utiliza datos heredados', () => {
    window.localStorage.setItem('gr8r', JSON.stringify({ theme: 'dark', projects: ['synthetic'] }));
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => useAppearance());
    expect(result.current.preferences).toEqual(DEFAULT_APPEARANCE);
    act(() => result.current.update({ theme: 'light' }));
    expect(result.current.preferences.theme).toBe('light');
    expect(result.current.persisted).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('sigue funcionando cuando el navegador impide leer o guardar preferencias', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Full', 'QuotaExceededError');
    });
    const id = owner();
    const { result } = renderHook(() => useAppearance(id));
    act(() => result.current.update({ theme: 'dark', motion: 'reduce' }));
    expect(result.current.preferences).toMatchObject({ theme: 'dark', motion: 'reduce' });
    expect(result.current.persisted).toBe(false);
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  });

  it('sincroniza otra pestaña del mismo usuario y descarta eventos de otras cuentas', () => {
    const id = owner();
    const { result } = renderHook(() => useAppearance(id));
    act(() =>
      window.dispatchEvent(
        new StorageEvent('storage', { key: appearanceStorageKey(owner()), newValue: JSON.stringify({ ...DEFAULT_APPEARANCE, theme: 'dark' }) }),
      ),
    );
    expect(result.current.preferences.theme).toBe('system');
    act(() =>
      window.dispatchEvent(
        new StorageEvent('storage', { key: appearanceStorageKey(id), newValue: JSON.stringify({ ...DEFAULT_APPEARANCE, theme: 'dark', accent: 'violet' }) }),
      ),
    );
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(document.documentElement).toHaveAttribute('data-accent', 'violet');
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: appearanceStorageKey(id), newValue: 'broken' })));
    expect(result.current.preferences).toEqual(DEFAULT_APPEARANCE);
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });

  it('recarga cambios guardados mientras la cuenta estaba desmontada', () => {
    const id = owner();
    const first = renderHook(() => useAppearance(id));
    first.unmount();
    window.localStorage.setItem(appearanceStorageKey(id)!, JSON.stringify({ ...DEFAULT_APPEARANCE, theme: 'light', accent: 'graphite' }));
    const { result } = renderHook(() => useAppearance(id));
    expect(result.current.preferences).toMatchObject({ theme: 'light', accent: 'graphite' });
    expect(document.documentElement).toHaveAttribute('data-accent', 'graphite');
  });

  it('rechaza un cambio fuera del contrato y permite restablecer ajustes sin borrar otros datos', () => {
    const id = owner();
    window.localStorage.setItem('unrelated-test-value', 'preserve');
    const { result } = renderHook(() => useAppearance(id));
    act(() => result.current.update({ theme: 'dark', accent: 'blue' }));
    act(() => result.current.update({ theme: 'anything' } as unknown as AppearancePatch));
    expect(result.current.preferences).toMatchObject({ theme: 'dark', accent: 'blue' });
    act(() => result.current.reset());
    expect(result.current.preferences).toEqual(DEFAULT_APPEARANCE);
    expect(window.localStorage.getItem('unrelated-test-value')).toBe('preserve');
    expect(Object.keys(JSON.parse(window.localStorage.getItem(appearanceStorageKey(id)!)!))).not.toContain('email');
  });
});

describe('apariencia en Configuración', () => {
  function Settings({ userId }: { userId: string }) {
    const appearance = useAppearance(userId);
    return <CalendarSettings appearance={appearance} />;
  }

  it('muestra las categorías y controles colapsados; cambia tema, acento y densidad con controles accesibles', async () => {
    const user = userEvent.setup();
    const id = owner();
    render(<Settings userId={id} />);
    await user.click(screen.getByRole('button', { name: 'Apariencia' }));
    const region = screen.getByRole('region', { name: 'Configuración de apariencia' });
    expect(within(region).getByRole('button', { name: 'Tema' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(region).queryByRole('radio', { name: 'Oscuro' })).not.toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Tema' }));
    await user.click(within(region).getByRole('radio', { name: 'Oscuro' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    await user.click(within(region).getByRole('button', { name: 'Color de acento' }));
    await user.click(within(region).getByRole('radio', { name: 'Acento Verde azulado' }));
    expect(document.documentElement).toHaveAttribute('data-accent', 'teal');
    await user.click(within(region).getByRole('button', { name: 'Densidad' }));
    await user.click(within(within(region).getByRole('group', { name: 'Densidad de tareas' })).getByRole('radio', { name: 'Compacta' }));
    expect(document.documentElement).toHaveAttribute('data-density', 'compact');
    await user.click(within(region).getByRole('button', { name: 'Movimiento' }));
    fireEvent.change(within(region).getByRole('combobox', { name: 'Animaciones' }), { target: { value: 'reduce' } });
    expect(document.documentElement).toHaveAttribute('data-motion', 'reduce');
    expect(within(region).getByRole('status')).toHaveTextContent('en este navegador');
    await user.click(within(region).getByRole('button', { name: 'Restablecer apariencia' }));
    expect(document.documentElement).not.toHaveAttribute('data-theme');
    expect(document.documentElement).not.toHaveAttribute('data-accent');
  });
});

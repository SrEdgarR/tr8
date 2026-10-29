import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../profile-types';
import { createProfileRepository } from './profile';

const owner = 'fb120000-0000-4000-8000-000000000001';
const profile: UserProfile = { user_id: owner, display_name: 'Persona de prueba', updated_at: '2026-10-29T12:15:30.123456+00:00' };
function setup(data: unknown = profile) {
  const abortSignal = vi.fn().mockResolvedValue({ data, error: null });
  const rpc = vi.fn().mockReturnValue(Object.assign(Promise.resolve({ data, error: null }), { abortSignal }));
  return { rpc, abortSignal, api: createProfileRepository({ rpc } as unknown as SupabaseClient, owner) };
}

describe('perfil de la cuenta actual', () => {
  it('lee solo el perfil de la sesión, sin enviar un usuario elegible como argumento', async () => {
    const { api, rpc, abortSignal } = setup();
    const signal = new AbortController().signal;
    expect(await api.load(signal)).toEqual(profile);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('tr8_v2_profile', { p_name: null, p_expected_updated_at: null });
    expect(abortSignal).toHaveBeenCalledExactlyOnceWith(signal);
  });
  it('normaliza el nombre y conserva la revisión exacta con microsegundos', async () => {
    const next = { ...profile, display_name: 'Ángela de prueba', updated_at: '2026-10-29T12:16:30.654321+00:00' };
    const { api, rpc } = setup(next);
    expect(await api.save(profile, '  Ángela de prueba  ')).toEqual(next);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('tr8_v2_profile', { p_name: next.display_name, p_expected_updated_at: profile.updated_at });
    expect(profile.display_name).toBe('Persona de prueba');
  });
  it('conserva la revisión y el nombre en un reintento de resultado incierto', async () => {
    const { api, rpc } = setup();
    rpc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api.save(profile, profile.display_name)).rejects.toMatchObject({ name: 'DataError' });
    await expect(api.save(profile, profile.display_name)).resolves.toEqual(profile);
    expect(rpc.mock.calls[1][1]).toEqual(rpc.mock.calls[0][1]);
  });
  it('acepta un nombre Unicode de 120 caracteres sin contar dos veces los pares sustitutos', async () => {
    const name = '😀'.repeat(120);
    const { api } = setup({ ...profile, display_name: name });
    expect((await api.save(profile, name)).display_name).toBe(name);
  });
  it.each(['', '   ', 'a'.repeat(121), 'Nombre\nApellido', 'Nombre\tApellido', `Nombre${String.fromCharCode(127)}`, `Nombre${String.fromCharCode(128)}`])(
    'rechaza nombres inválidos sin transporte (%#)',
    async name => {
      const { api, rpc } = setup();
      await expect(api.save(profile, name)).rejects.toMatchObject({ code: '22023' });
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...profile, user_id: 'fb120000-0000-4000-8000-000000000002' },
    { ...profile, updated_at: '2026-02-30T12:15:30Z' },
    { ...profile, updated_at: '2026-10-29' },
    { ...profile, updated_at: 'infinity' },
    { ...profile, private: true },
  ])('no guarda un perfil ajeno o una revisión inválida (%#)', async value => {
    const { api, rpc } = setup();
    await expect(api.save(value as UserProfile, 'Nuevo nombre')).rejects.toMatchObject({ code: '22023' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    {},
    { ...profile, user_id: 'fb120000-0000-4000-8000-000000000002' },
    { ...profile, display_name: '' },
    { ...profile, display_name: 'a'.repeat(121) },
    { ...profile, display_name: 'Nombre\nApellido' },
    { ...profile, updated_at: '2026-02-30T12:15:30Z' },
    { ...profile, updated_at: '2026-10-29T25:15:30Z' },
    { ...profile, updated_at: 'infinity' },
    { ...profile, enabled: true },
  ])('no acepta una respuesta ajena o fuera del contrato (%#)', async value => {
    await expect(setup(value).api.load()).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });
  it.each(['42501', 'PT409', 'PGRST202'])('propaga el fallo seguro %s en vez de anunciar un guardado', async code => {
    const { api, rpc } = setup();
    rpc.mockResolvedValue({ data: null, error: { code, message: 'Server failure' } });
    await expect(api.save(profile, 'Nuevo nombre')).rejects.toMatchObject({ code });
  });
  it('rechaza crear un repositorio sin identidad de cuenta válida', () => {
    expect(() => createProfileRepository({} as SupabaseClient, 'not-an-id')).toThrow();
  });
});

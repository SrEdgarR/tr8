import { describe, expect, it } from 'vitest';
import { readConfiguration } from './configuration';

const valid = {
  VITE_SUPABASE_URL: 'https://personal.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_for_tests',
  VITE_OWNER_EMAIL: 'owner@example.com',
};

function legacyKey(role: string) {
  const encode = (value: object) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role, ref: 'test-project' })}.test-signature`;
}

describe('configuración pública de Supabase', () => {
  it.each(['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'])('impide arrancar con %s ausente o en blanco', variable => {
    expect(readConfiguration({ ...valid, [variable]: undefined })).toBeNull();
    expect(readConfiguration({ ...valid, [variable]: '  ' })).toBeNull();
  });

  it.each([undefined, '', 'owner', 'member@example.com'])('no usa el correo inicial como requisito de autorización (%s)', email => {
    expect(readConfiguration({ ...valid, VITE_OWNER_EMAIL: email })).not.toBeNull();
  });

  it.each([
    'not-a-url',
    'http://personal.supabase.co',
    'http://localhost.evil.example',
    'ftp://127.0.0.1:54321',
    'file:///tmp/supabase',
    'javascript:alert(1)',
  ])('rechaza una URL insegura o inválida: %s', url => {
    expect(readConfiguration({ ...valid, VITE_SUPABASE_URL: url })).toBeNull();
  });

  it.each(['https://user:password@personal.supabase.co', 'https://user@personal.supabase.co'])('no acepta credenciales embebidas en la URL: %s', url => {
    expect(readConfiguration({ ...valid, VITE_SUPABASE_URL: url })).toBeNull();
  });

  it.each(['http://localhost:54321', 'http://127.0.0.1:54321', 'http://[::1]:54321'])('permite HTTP solamente para el desarrollo local: %s', url => {
    expect(readConfiguration({ ...valid, VITE_SUPABASE_URL: url })?.url).toBe(url);
  });

  it('normaliza el origen, los espacios y el correo del propietario', () => {
    expect(
      readConfiguration({
        VITE_SUPABASE_URL: '  HTTPS://PERSONAL.SUPABASE.CO:443/path?query=value#fragment  ',
        VITE_SUPABASE_PUBLISHABLE_KEY: '  sb_publishable_example_for_tests  ',
        VITE_OWNER_EMAIL: '  OWNER@EXAMPLE.COM  ',
      }),
    ).toEqual({
      url: 'https://personal.supabase.co',
      publishableKey: valid.VITE_SUPABASE_PUBLISHABLE_KEY,
      ownerEmail: 'owner@example.com',
    });
  });

  it.each(['sb_secret_example_for_tests', legacyKey('service_role'), legacyKey('authenticated')])(
    'bloquea claves secretas o privilegiadas en la configuración del navegador (%s)',
    key => {
      expect(readConfiguration({ ...valid, VITE_SUPABASE_PUBLISHABLE_KEY: key })).toBeNull();
    },
  );

  it('mantiene la compatibilidad con una clave pública legacy anon', () => {
    const key = legacyKey('anon');
    expect(readConfiguration({ ...valid, VITE_SUPABASE_PUBLISHABLE_KEY: key })).toEqual({
      url: valid.VITE_SUPABASE_URL,
      publishableKey: key,
      ownerEmail: valid.VITE_OWNER_EMAIL,
    });
  });

  it.each(['invalid-key', 'header.%%%.signature', `header.${btoa('not-json')}.signature`])(
    'maneja una clave legacy malformada sin provocar un fallo de arranque (%s)',
    key => {
      expect(() => readConfiguration({ ...valid, VITE_SUPABASE_PUBLISHABLE_KEY: key })).not.toThrow();
      expect(readConfiguration({ ...valid, VITE_SUPABASE_PUBLISHABLE_KEY: key })).toBeNull();
    },
  );
});

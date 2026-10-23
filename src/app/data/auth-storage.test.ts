import { describe, expect, it, vi } from 'vitest';
import { AUTH_STORAGE_KEY, AUTH_STORAGE_MIGRATION_KEY, migrateAuthStorage } from './auth-storage';

const legacyKey = 'gr8r.auth.v1';

function storageWith(values: Record<string, string> = {}) {
  const valuesMap = new Map(Object.entries(values));
  const storage = {
    get length() {
      return valuesMap.size;
    },
    key: vi.fn((index: number) => [...valuesMap.keys()][index] ?? null),
    getItem: vi.fn((key: string) => valuesMap.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      valuesMap.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      valuesMap.delete(key);
    }),
  };
  return { storage, valuesMap };
}

describe('migración de sesión a TR8', () => {
  it('conserva sesión, usuario y verificador PKCE y retira las claves antiguas', () => {
    const { storage, valuesMap } = storageWith({
      [legacyKey]: 'existing-session',
      [`${legacyKey}-user`]: 'existing-user',
      [`${legacyKey}-code-verifier`]: 'existing-verifier',
    });
    migrateAuthStorage(storage);
    expect(Object.fromEntries(valuesMap)).toEqual({
      [AUTH_STORAGE_KEY]: 'existing-session',
      [`${AUTH_STORAGE_KEY}-user`]: 'existing-user',
      [`${AUTH_STORAGE_KEY}-code-verifier`]: 'existing-verifier',
      [AUTH_STORAGE_MIGRATION_KEY]: '1',
    });
    expect(storage.setItem.mock.calls.at(-2)?.[0]).toBe(AUTH_STORAGE_KEY);
    expect(storage.setItem.mock.calls.at(-1)?.[0]).toBe(AUTH_STORAGE_MIGRATION_KEY);
  });

  it('no mezcla una sesión antigua con una sesión TR8 que ya existe', () => {
    const { storage, valuesMap } = storageWith({
      [legacyKey]: 'old-session',
      [`${legacyKey}-code-verifier`]: 'old-verifier',
      [AUTH_STORAGE_KEY]: 'new-session',
      [`${AUTH_STORAGE_KEY}-user`]: 'new-user',
    });
    migrateAuthStorage(storage);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(AUTH_STORAGE_MIGRATION_KEY, '1');
    expect(Object.fromEntries(valuesMap)).toEqual({
      [AUTH_STORAGE_KEY]: 'new-session',
      [`${AUTH_STORAGE_KEY}-user`]: 'new-user',
      [AUTH_STORAGE_MIGRATION_KEY]: '1',
    });
  });

  it('respeta un verificador PKCE nuevo mientras migra una sesión anterior', () => {
    const { storage, valuesMap } = storageWith({
      [legacyKey]: 'old-session',
      [`${legacyKey}-code-verifier`]: 'old-verifier',
      [`${AUTH_STORAGE_KEY}-code-verifier`]: 'current-verifier',
    });
    migrateAuthStorage(storage);
    expect(valuesMap.get(`${AUTH_STORAGE_KEY}-code-verifier`)).toBe('current-verifier');
    expect(valuesMap.get(AUTH_STORAGE_KEY)).toBe('old-session');
  });

  it('marca una migración vacía sin escribir estado de autenticación', () => {
    const { storage } = storageWith();
    migrateAuthStorage(storage);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(AUTH_STORAGE_MIGRATION_KEY, '1');
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('mantiene todo el estado antiguo si falla una escritura antes de copiar la sesión', () => {
    const original = { [legacyKey]: 'existing-session', [`${legacyKey}-user`]: 'existing-user', [`${legacyKey}-code-verifier`]: 'existing-verifier' };
    const { storage, valuesMap } = storageWith(original);
    storage.setItem.mockImplementation((key, value) => {
      if (key.endsWith('-user')) throw new Error('Quota exceeded');
      valuesMap.set(key, value);
    });
    expect(() => migrateAuthStorage(storage)).not.toThrow();
    expect(Object.fromEntries(valuesMap)).toEqual(original);
  });

  it('tolera almacenamiento bloqueado sin impedir que arranque la aplicación', () => {
    const { storage } = storageWith();
    storage.getItem.mockImplementation(() => {
      throw new Error('Storage blocked');
    });
    expect(() => migrateAuthStorage(storage)).not.toThrow();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('conserva la copia completa si falla la limpieza de una clave antigua', () => {
    const { storage, valuesMap } = storageWith({ [legacyKey]: 'existing-session', [`${legacyKey}-user`]: 'existing-user' });
    storage.removeItem.mockImplementation(key => {
      if (key.endsWith('-user')) throw new Error('Cleanup blocked');
      valuesMap.delete(key);
    });
    migrateAuthStorage(storage);
    expect(valuesMap.get(AUTH_STORAGE_KEY)).toBe('existing-session');
    expect(valuesMap.get(`${AUTH_STORAGE_KEY}-user`)).toBe('existing-user');
  });

  it('migra los slots PKCE que el SDK consulta por flowId y reconstruye su índice', () => {
    const firstId = '0123456789abcdef';
    const orphanId = 'orphan_flow_1234';
    const { storage, valuesMap } = storageWith({
      [legacyKey]: 'existing-session',
      [`${legacyKey}-flows-code-verifier`]: JSON.stringify([firstId, '../invalid']),
      [`${legacyKey}-flow-${firstId}-code-verifier`]: 'first-verifier',
      [`${legacyKey}-flow-${orphanId}-code-verifier`]: 'orphan-verifier',
      'unrelated-flow-01234567-code-verifier': 'unrelated-state',
    });
    migrateAuthStorage(storage);
    expect(valuesMap.get(`${AUTH_STORAGE_KEY}-flow-${firstId}-code-verifier`)).toBe('first-verifier');
    expect(valuesMap.get(`${AUTH_STORAGE_KEY}-flow-${orphanId}-code-verifier`)).toBe('orphan-verifier');
    expect(JSON.parse(valuesMap.get(`${AUTH_STORAGE_KEY}-flows-code-verifier`)!)).toEqual([firstId, orphanId]);
    expect(valuesMap.get(AUTH_STORAGE_KEY)).toBe('existing-session');
    expect(storage.setItem.mock.calls.at(-2)?.[0]).toBe(AUTH_STORAGE_KEY);
    expect(valuesMap.has(`${legacyKey}-flows-code-verifier`)).toBe(false);
    expect(valuesMap.has(`${legacyKey}-flow-${firstId}-code-verifier`)).toBe(false);
    expect(valuesMap.has(`${legacyKey}-flow-${orphanId}-code-verifier`)).toBe(false);
    expect(valuesMap.get('unrelated-flow-01234567-code-verifier')).toBe('unrelated-state');
    expect(storage.getItem).not.toHaveBeenCalledWith('unrelated-flow-01234567-code-verifier');
  });

  it('fusiona índices sin sobrescribir verificadores ni el orden de flujos nuevos', () => {
    const oldId = 'old_flow_12345678';
    const sharedId = 'shared_flow_1234';
    const newId = 'new_flow_12345678';
    const { storage, valuesMap } = storageWith({
      [`${legacyKey}-flows-code-verifier`]: JSON.stringify([oldId, sharedId]),
      [`${legacyKey}-flow-${oldId}-code-verifier`]: 'old-verifier',
      [`${legacyKey}-flow-${sharedId}-code-verifier`]: 'superseded-verifier',
      [`${AUTH_STORAGE_KEY}-flows-code-verifier`]: JSON.stringify([newId, sharedId]),
      [`${AUTH_STORAGE_KEY}-flow-${sharedId}-code-verifier`]: 'current-verifier',
      [`${AUTH_STORAGE_KEY}-flow-${newId}-code-verifier`]: 'new-verifier',
    });
    migrateAuthStorage(storage);
    expect(valuesMap.get(`${AUTH_STORAGE_KEY}-flow-${sharedId}-code-verifier`)).toBe('current-verifier');
    expect(valuesMap.get(`${AUTH_STORAGE_KEY}-flow-${newId}-code-verifier`)).toBe('new-verifier');
    expect(JSON.parse(valuesMap.get(`${AUTH_STORAGE_KEY}-flows-code-verifier`)!)).toEqual([oldId, newId, sharedId]);
  });

  it('no importa flujos antiguos en una sesión TR8 existente', () => {
    const id = 'legacy_flow_1234';
    const { storage, valuesMap } = storageWith({
      [AUTH_STORAGE_KEY]: 'new-session',
      [`${legacyKey}-flows-code-verifier`]: JSON.stringify([id]),
      [`${legacyKey}-flow-${id}-code-verifier`]: 'old-verifier',
    });
    migrateAuthStorage(storage);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(AUTH_STORAGE_MIGRATION_KEY, '1');
    expect(Object.fromEntries(valuesMap)).toEqual({ [AUTH_STORAGE_KEY]: 'new-session', [AUTH_STORAGE_MIGRATION_KEY]: '1' });
  });

  it('restaura el índice nuevo y los slots originales si la última escritura de sesión falla', () => {
    const oldId = 'old_flow_12345678';
    const newId = 'new_flow_12345678';
    const original = {
      [legacyKey]: 'existing-session',
      [`${legacyKey}-flows-code-verifier`]: JSON.stringify([oldId]),
      [`${legacyKey}-flow-${oldId}-code-verifier`]: 'old-verifier',
      [`${AUTH_STORAGE_KEY}-flows-code-verifier`]: JSON.stringify([newId]),
      [`${AUTH_STORAGE_KEY}-flow-${newId}-code-verifier`]: 'new-verifier',
    };
    const { storage, valuesMap } = storageWith(original);
    storage.setItem.mockImplementation((key, value) => {
      if (key === AUTH_STORAGE_KEY) throw new Error('Quota exceeded');
      valuesMap.set(key, value);
    });
    migrateAuthStorage(storage);
    expect(Object.fromEntries(valuesMap)).toEqual(original);
  });

  it('no restaura una sesión vieja tras limpieza fallida, cierre de sesión TR8 y reinicio', () => {
    const { storage, valuesMap } = storageWith({ [legacyKey]: 'existing-session', [`${legacyKey}-user`]: 'existing-user' });
    storage.removeItem.mockImplementation(key => {
      if (key === legacyKey) throw new Error('Legacy cleanup blocked');
      valuesMap.delete(key);
    });
    migrateAuthStorage(storage);
    expect(valuesMap.get(AUTH_STORAGE_KEY)).toBe('existing-session');
    expect(valuesMap.get(AUTH_STORAGE_MIGRATION_KEY)).toBe('1');
    storage.removeItem(AUTH_STORAGE_KEY);
    storage.removeItem(`${AUTH_STORAGE_KEY}-user`);
    storage.setItem.mockClear();

    migrateAuthStorage(storage);

    expect(valuesMap.has(AUTH_STORAGE_KEY)).toBe(false);
    expect(valuesMap.has(`${AUTH_STORAGE_KEY}-user`)).toBe(false);
    expect(valuesMap.get(legacyKey)).toBe('existing-session');
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('revierte la sesión y los slots copiados si falla guardar el marcador de migración', () => {
    const id = 'legacy_flow_1234';
    const original = {
      [legacyKey]: 'existing-session',
      [`${legacyKey}-flows-code-verifier`]: JSON.stringify([id]),
      [`${legacyKey}-flow-${id}-code-verifier`]: 'existing-verifier',
    };
    const { storage, valuesMap } = storageWith(original);
    storage.setItem.mockImplementation((key, value) => {
      if (key === AUTH_STORAGE_MIGRATION_KEY) throw new Error('Quota exceeded');
      valuesMap.set(key, value);
    });
    migrateAuthStorage(storage);
    expect(Object.fromEntries(valuesMap)).toEqual(original);
  });
});

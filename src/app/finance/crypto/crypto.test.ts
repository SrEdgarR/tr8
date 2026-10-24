import { webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vector from '../compatibility/fixtures/vault-vectors.json';
import {
  MAX_PLAINTEXT_BYTES,
  assertOpaqueTransition,
  decodeBase64Url,
  encodeBase64Url,
  encodeUtf8,
  validateEnvelope,
  type VaultEnvelope,
} from '../compatibility/protocol';
import { derivePasswordKey } from './argon2';
import { createVault, replaceCredentialWraps, unlockVault } from './credentials';
import { confirmVaultCustody } from './custody';
import { aesDecrypt, aesEncrypt, deriveAesKey, importAesKey, importRootKey, randomBytes, requireSecureCrypto } from './native-crypto';
import { normalizePrivatePassword } from './password';
import { decryptSnapshot, encryptSnapshot } from './payload';
import { parsePlaintext, serializePlaintext, validatePlaintext, type VaultPlaintext } from './plaintext';
import { confirmRecoverySecret, decodeRecoverySecret, encodeRecoverySecret, formatRecoverySecret } from './recovery';
import { assertSuiteMigrationAllowed, recoverVault, rekeyVault, rotatePassword, rotateRecovery } from './rotations';

const hex = (value: Uint8Array) => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
const fixture = () => validateEnvelope(structuredClone(vector.envelope));
const context = { ownerId: vector.envelope.ownerId, vaultId: vector.envelope.vaultId };
const plaintext = () => validatePlaintext(structuredClone(vector.plaintext));
const recoveryCode = formatRecoverySecret(encodeRecoverySecret(Uint8Array.from(vector.recoveryHex.match(/../g)!, value => Number.parseInt(value, 16))));
const newPassword = 'NEW synthetic password 🔒 123456';

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('isSecureContext', true);
});
afterEach(() => vi.unstubAllGlobals());

describe('private password and recovery format compatibility', () => {
  it('normalizes only NFC, counts Unicode scalars after NFC, and preserves case and spaces', () => {
    expect(normalizePrivatePassword('e\u0301'.repeat(16))).toEqual(normalizePrivatePassword('é'.repeat(16)));
    expect(normalizePrivatePassword(' '.repeat(16))).toEqual(encodeUtf8(' '.repeat(16)));
    expect(normalizePrivatePassword(' a'.repeat(8))).not.toEqual(normalizePrivatePassword(' A'.repeat(8)));
    expect(normalizePrivatePassword('😀'.repeat(16))).toEqual(encodeUtf8('😀'.repeat(16)));
    expect(normalizePrivatePassword('a'.repeat(1024))).toHaveLength(1024);
    expect(normalizePrivatePassword('e\u0301'.repeat(512))).toHaveLength(1024);
    for (const invalid of ['a'.repeat(15), 'a'.repeat(1025), '😀'.repeat(257), '\ud800' + 'a'.repeat(20), 'a'.repeat(20) + '\udc00']) {
      expect(() => normalizePrivatePassword(invalid)).toThrow(expect.objectContaining({ code: 'INVALID_PASSWORD' }));
    }
  });

  it('encodes exactly 256-bit recovery with canonical full reentry and defined presentation', () => {
    const secret = new Uint8Array(32).fill(255);
    const canonical = '7'.repeat(51) + 'Q';
    expect(encodeRecoverySecret(secret)).toBe(canonical);
    expect(formatRecoverySecret(canonical).split('-')).toHaveLength(13);
    expect(decodeRecoverySecret(formatRecoverySecret(canonical).toLowerCase())).toEqual(secret);
    expect(confirmRecoverySecret(secret, canonical)).toBe(true);
    expect(confirmRecoverySecret(secret, canonical.slice(0, -1) + 'A')).toBe(false);
    for (const invalid of [
      canonical + '=',
      canonical.slice(1),
      canonical.slice(0, -1) + 'R',
      ' ' + canonical,
      '0' + canonical.slice(1),
      '1' + canonical.slice(1),
      canonical.replace(/^(.{2})/, '$1-'),
    ]) {
      expect(() => decodeRecoverySecret(invalid)).toThrow(expect.objectContaining({ code: 'INVALID_RECOVERY' }));
    }
    expect(() => encodeRecoverySecret(new Uint8Array(31))).toThrow();
  });
});

describe('local secure primitives and exact Argon2id WASM', () => {
  it('runs the actual pinned Argon2id implementation against the independent public vector', async () => {
    const password = normalizePrivatePassword(vector.password);
    const original = new Uint8Array(password);
    const salt = decodeBase64Url(vector.envelope.passwordWrap.salt, 16);
    const key = await derivePasswordKey(password, salt);
    expect(hex(key)).toBe(vector.passwordKekHex);
    expect(hex(password)).toBe(hex(original));
    expect(hex(salt)).toBe(hex(decodeBase64Url(vector.envelope.passwordWrap.salt, 16)));
    password.fill(0);
    original.fill(0);
    key.fill(0);
  }, 20_000);

  it('requires secure context, Web Crypto, CSPRNG and WASM without weaker profile fallback', async () => {
    vi.stubGlobal('isSecureContext', false);
    expect(() => requireSecureCrypto()).toThrow(expect.objectContaining({ code: 'CRYPTO_UNAVAILABLE' }));
    await expect(derivePasswordKey(encodeUtf8(vector.password), new Uint8Array(16))).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('WebAssembly', undefined);
    await expect(derivePasswordKey(encodeUtf8(vector.password), new Uint8Array(16))).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
    vi.stubGlobal('crypto', undefined);
    expect(() => randomBytes(32)).toThrow(expect.objectContaining({ code: 'RNG_FAILED' }));
  });

  it('fails closed when native capability methods are missing and wipes a failed CSPRNG target', async () => {
    for (const missing of ['subtle', 'getRandomValues'] as const) {
      vi.stubGlobal('crypto', { subtle: webcrypto.subtle, getRandomValues: webcrypto.getRandomValues.bind(webcrypto), [missing]: undefined });
      expect(() => requireSecureCrypto()).toThrow(expect.objectContaining({ code: 'CRYPTO_UNAVAILABLE' }));
    }
    let owned: Uint8Array | undefined;
    vi.stubGlobal('crypto', {
      subtle: webcrypto.subtle,
      getRandomValues(target: Uint8Array) {
        owned = target;
        target.fill(77);
        throw new Error('synthetic private diagnostic');
      },
    });
    expect(() => randomBytes(32)).toThrow(expect.objectContaining({ code: 'RNG_FAILED' }));
    expect(owned?.every(byte => byte === 0)).toBe(true);
  });

  it('passes no secret to KDF callbacks and wipes owned buffers on success or callback failure', async () => {
    const sodium = (await import('libsodium-wrappers-sumo')).default;
    await sodium.ready;
    const descriptor = Object.getOwnPropertyDescriptor(sodium, 'crypto_pwhash')!;
    const actual = sodium.crypto_pwhash;
    let ownedPassword: Uint8Array | undefined;
    let ownedSalt: Uint8Array | undefined;
    let ownedOutput: Uint8Array | undefined;
    Object.defineProperty(sodium, 'crypto_pwhash', {
      ...descriptor,
      value: (length: number, password: string | Uint8Array, salt: Uint8Array, ops: number, memory: number, algorithm: number) => {
        expect(typeof password).not.toBe('string');
        ownedPassword = password as Uint8Array;
        ownedSalt = salt;
        ownedOutput = actual(length, password, salt, ops, memory, algorithm);
        return ownedOutput;
      },
    });
    const password = normalizePrivatePassword(vector.password);
    const salt = decodeBase64Url(vector.envelope.passwordWrap.salt, 16);
    const onStart = vi.fn();
    const onTiming = vi.fn();
    try {
      const result = await derivePasswordKey(password, salt, onTiming, onStart);
      expect(hex(result)).toBe(vector.passwordKekHex);
      expect(ownedPassword?.every(byte => byte === 0)).toBe(true);
      expect(ownedSalt?.every(byte => byte === 0)).toBe(true);
      expect(ownedOutput?.every(byte => byte === 0)).toBe(true);
      expect(onStart.mock.calls).toEqual([[]]);
      const timing = onTiming.mock.calls[0];
      expect(timing).toHaveLength(1);
      expect(Object.keys(timing[0]).sort()).toEqual(['kdfMs', 'loadMs']);
      expect(Object.values(timing[0]).every(value => typeof value === 'number' && Number.isFinite(value))).toBe(true);
      result.fill(0);
      await expect(
        derivePasswordKey(password, salt, () => {
          throw new Error('synthetic private diagnostic');
        }),
      ).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
      expect(ownedPassword?.every(byte => byte === 0)).toBe(true);
      expect(ownedSalt?.every(byte => byte === 0)).toBe(true);
      expect(ownedOutput?.every(byte => byte === 0)).toBe(true);
      expect(hex(password)).toBe(hex(normalizePrivatePassword(vector.password)));
    } finally {
      Object.defineProperty(sodium, 'crypto_pwhash', descriptor);
      password.fill(0);
    }
  }, 20_000);

  it('sanitizes native encryption/derivation failures and wipes only its owned plaintext copy', async () => {
    const root = await importRootKey(new Uint8Array(32));
    const aes = await importAesKey(new Uint8Array(32));
    const input = new Uint8Array([1, 2, 3]);
    let owned: Uint8Array | undefined;
    vi.stubGlobal('crypto', {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      subtle: {
        importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
        deriveKey: async () => {
          throw new Error('synthetic private diagnostic');
        },
        encrypt: async (_algorithm: unknown, _key: unknown, data: Uint8Array) => {
          owned = data;
          throw new Error('synthetic private diagnostic');
        },
        decrypt: async () => {
          throw new Error('synthetic private diagnostic');
        },
      },
    });
    await expect(deriveAesKey(root, new Uint8Array(32), new Uint8Array())).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
    await expect(aesEncrypt(aes, input, new Uint8Array(12), new Uint8Array())).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
    expect(owned?.every(byte => byte === 0)).toBe(true);
    expect(Array.from(input)).toEqual([1, 2, 3]);
    await expect(aesDecrypt(aes, new Uint8Array(17), new Uint8Array(12), new Uint8Array())).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(aesEncrypt(aes, input, new Uint8Array(11), new Uint8Array())).rejects.toMatchObject({ code: 'INVALID_FORMAT' });
  });

  it('fails the pinned ESM package in a fresh process when actual WASM instantiation fails', () => {
    // A fresh module instance is essential: an already-ready sodium cache would
    // not prove that its loader rejects unavailable WASM instead of using asm.js.
    const code = `
      const original = WebAssembly.instantiate;
      WebAssembly.instantiate = async () => { throw new Error('synthetic WASM unavailable'); };
      console.error = () => {};
      try {
        const sodium = (await import('libsodium-wrappers-sumo')).default;
        await sodium.ready;
        process.stdout.write('unexpected-ready');
        process.exitCode = 1;
      } catch {
        process.stdout.write('wasm-rejected');
      } finally { WebAssembly.instantiate = original; }
    `;
    expect(execFileSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 10_000, encoding: 'utf8' })).toBe('wasm-rejected');
  }, 15_000);

  it('keeps VDK/HKDF and AES keys non-extractable with only operational usages', async () => {
    const raw = randomBytes(32);
    const root = await importRootKey(raw);
    const aes = await importAesKey(raw);
    const payloadKey = await deriveAesKey(root, randomBytes(32), encodeUtf8('synthetic'));
    raw.fill(0);
    expect(root.extractable).toBe(false);
    expect(root.usages).toEqual(['deriveKey']);
    expect(root.algorithm.name).toBe('HKDF');
    for (const key of [root, aes, payloadKey]) await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    expect(aes.algorithm).toEqual({ name: 'AES-GCM', length: 256 });
    const unsafe = await crypto.subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', true, ['encrypt']);
    await expect(deriveAesKey(unsafe, new Uint8Array(32), new Uint8Array())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(importRootKey(new Uint8Array(31))).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(derivePasswordKey(encodeUtf8(vector.password), new Uint8Array(15))).rejects.toMatchObject({ code: 'INVALID_PASSWORD' });
    for (const invalid of [0, -1, 65537, 1.5]) expect(() => randomBytes(invalid)).toThrow();
  });
});

describe('real encrypted snapshots and private means', () => {
  it('opens the original independent vector with the actual password KDF and recovery HKDF', async () => {
    const password = await unlockVault(fixture(), context, { kind: 'password', value: vector.password });
    const recovery = await unlockVault(fixture(), context, { kind: 'recovery', value: recoveryCode });
    expect(password.plaintext).toEqual(vector.plaintext);
    expect(password.mode).toBe('password');
    expect(recovery.plaintext).toEqual(vector.plaintext);
    expect(recovery.mode).toBe('recovery-readonly');
    expect(password.rootKey.extractable).toBe(false);
    await expect(unlockVault(fixture(), context, { kind: 'password', value: newPassword })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(
      unlockVault(fixture(), context, { kind: 'recovery', value: formatRecoverySecret(encodeRecoverySecret(new Uint8Array(32))) }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  }, 20_000);

  it('rejects profile/downgrade/context errors before invoking the KDF', async () => {
    const started = vi.fn();
    for (const mutate of [
      (e: VaultEnvelope) => Object.assign(e.passwordWrap, { memoryKiB: 16 }),
      (e: VaultEnvelope) => Object.assign(e.passwordWrap, { passes: 1 }),
      (e: VaultEnvelope) => Object.assign(e.passwordWrap, { profileId: 'weaker' }),
      (e: VaultEnvelope) => Object.assign(e, { formatVersion: 0 }),
      (e: VaultEnvelope) => Object.assign(e, { extra: true }),
      (e: VaultEnvelope) => {
        e.ownerId = 'different-owner';
      },
    ]) {
      const envelope = fixture();
      mutate(envelope);
      await expect(unlockVault(envelope, context, { kind: 'password', value: vector.password }, started)).rejects.toThrow();
    }
    expect(started).not.toHaveBeenCalled();
    expect(() => assertSuiteMigrationAllowed('tr8-new-suite')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_FORMAT' }));
  });

  it('creates a fresh encrypted snapshot and actually verifies both full private means', async () => {
    const created = await createVault({ ...context, vaultId: encodeBase64Url(randomBytes(16)), password: newPassword, plaintext: plaintext() });
    const newContext = { ownerId: created.envelope.ownerId, vaultId: created.envelope.vaultId };
    expect(created.rootKey.extractable).toBe(false);
    expect(created.envelope).not.toEqual(vector.envelope);
    expect(created.recoveryCode.split('-')).toHaveLength(13);
    expect((await unlockVault(created.envelope, newContext, { kind: 'password', value: newPassword })).plaintext).toEqual(plaintext());
    expect((await unlockVault(created.envelope, newContext, { kind: 'recovery', value: created.recoveryCode })).plaintext).toEqual(plaintext());
    await expect(confirmVaultCustody(created.envelope, newContext, newPassword, created.recoveryCode)).resolves.toBeUndefined();
    await expect(confirmVaultCustody(created.envelope, newContext, newPassword + 'wrong', created.recoveryCode)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(confirmVaultCustody(created.envelope, newContext, newPassword, created.recoveryCode.slice(0, -4))).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    assertOpaqueTransition(null, { envelope: created.envelope, operationId: created.envelope.operationId, expectedRevision: '0' });
  }, 20_000);

  it('opens a newly encrypted vault with the canonically equivalent NFC password', async () => {
    const decomposed = 'e\u0301'.repeat(16);
    const composed = 'é'.repeat(16);
    const created = await createVault({ ...context, password: decomposed, plaintext: plaintext() });
    expect((await unlockVault(created.envelope, context, { kind: 'password', value: composed })).plaintext).toEqual(vector.plaintext);
    await expect(unlockVault(created.envelope, context, { kind: 'password', value: composed.toUpperCase() })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  }, 20_000);

  it('uses a fresh payload salt/nonce/operation for every snapshot and retains exact retry material', async () => {
    const unlocked = await unlockVault(fixture(), context, { kind: 'password', value: vector.password });
    const modified = { schemaVersion: 1, financialSpace: { marker: 'synthetic-only' } } satisfies VaultPlaintext;
    const snapshot = await encryptSnapshot(unlocked.rootKey, fixture(), modified);
    expect(snapshot.revision).toBe('2');
    for (const field of ['keySalt', 'nonce', 'ciphertext'] as const) expect(snapshot.payload[field]).not.toBe(vector.envelope.payload[field]);
    expect(snapshot.operationId).not.toBe(vector.envelope.operationId);
    expect(await decryptSnapshot(unlocked.rootKey, snapshot, context)).toEqual(modified);
    expect(snapshot.passwordWrap).toEqual(vector.envelope.passwordWrap);
    expect(snapshot.recoveryWrap).toEqual(vector.envelope.recoveryWrap);
    assertOpaqueTransition(fixture(), { envelope: snapshot, operationId: snapshot.operationId, expectedRevision: '1' });
    await expect(encryptSnapshot(unlocked.rootKey, fixture(), modified, '3')).rejects.toMatchObject({ code: 'STALE_REVISION' });
  }, 20_000);

  it('authenticates every public field bound by AAD, including both complete credential slots', async () => {
    const original = fixture();
    const opened = await unlockVault(original, context, { kind: 'recovery', value: recoveryCode });
    for (const field of ['ownerId', 'vaultId', 'keyEpoch', 'credentialEpoch', 'revision', 'operationId'] as const) {
      const next = structuredClone(original);
      if (field === 'ownerId') next[field] = 'edited-owner';
      else if (field === 'vaultId' || field === 'operationId') next[field] = encodeBase64Url(randomBytes(16));
      else next[field] = '2';
      await expect(decryptSnapshot(opened.rootKey, next, context)).rejects.toThrow();
    }
    for (const slot of ['passwordWrap', 'recoveryWrap'] as const) {
      for (const [field, value] of Object.entries(original[slot])) {
        const next = structuredClone(original);
        Object.assign(next[slot], { [field]: typeof value === 'number' ? value + 1 : field === 'slotEpoch' ? '2' : value + 'A' });
        await expect(decryptSnapshot(opened.rootKey, next, context)).rejects.toThrow();
      }
    }
    for (const field of ['keySalt', 'nonce', 'ciphertext'] as const) {
      const next = structuredClone(original);
      const bytes = decodeBase64Url(next.payload[field]);
      bytes[0] ^= 1;
      next.payload[field] = encodeBase64Url(bytes);
      await expect(decryptSnapshot(opened.rootKey, next, context)).rejects.toThrow();
    }
  });
});

describe('credential rotation and recovery-readonly rescue', () => {
  it('rewraps a password without changing VDK or the recovery slot', async () => {
    const previous = fixture();
    const changed = await rotatePassword(previous, context, vector.password, newPassword);
    expect(changed.envelope.keyEpoch).toBe('1');
    expect(changed.envelope.credentialEpoch).toBe('2');
    expect(changed.envelope.passwordWrap.slotEpoch).toBe('2');
    expect(changed.envelope.recoveryWrap).toEqual(previous.recoveryWrap);
    expect(changed.envelope.revision).toBe('2');
    assertOpaqueTransition(previous, { envelope: changed.envelope, operationId: changed.envelope.operationId, expectedRevision: '1' });
    await expect(unlockVault(changed.envelope, context, { kind: 'password', value: vector.password })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect((await unlockVault(changed.envelope, context, { kind: 'password', value: newPassword })).plaintext).toEqual(plaintext());
    expect((await unlockVault(changed.envelope, context, { kind: 'recovery', value: recoveryCode })).plaintext).toEqual(plaintext());
  }, 20_000);

  it('rotates the recovery slot using the password while preserving the password slot', async () => {
    const previous = fixture();
    const changed = await rotateRecovery(previous, context, { kind: 'password', value: vector.password });
    expect(changed.envelope.keyEpoch).toBe('1');
    expect(changed.envelope.credentialEpoch).toBe('2');
    expect(changed.envelope.passwordWrap).toEqual(previous.passwordWrap);
    expect(changed.envelope.recoveryWrap.slotEpoch).toBe('2');
    expect(changed.recoveryCode).not.toBe(recoveryCode);
    await expect(unlockVault(changed.envelope, context, { kind: 'recovery', value: recoveryCode })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await confirmVaultCustody(changed.envelope, context, vector.password, changed.recoveryCode!);
    assertOpaqueTransition(previous, { envelope: changed.envelope, operationId: changed.envelope.operationId, expectedRevision: '1' });
  }, 20_000);

  it('requires recovery use to rotate BOTH wraps and supply a new password before a writable candidate exists', async () => {
    for (const changes of [{ recovery: false, password: newPassword }, { recovery: true }]) {
      await expect(replaceCredentialWraps(fixture(), context, { kind: 'recovery', value: recoveryCode }, changes)).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
    }
    const recovered = await recoverVault(fixture(), context, recoveryCode, newPassword);
    expect(recovered.mode).toBe('password');
    expect(recovered.envelope.keyEpoch).toBe('1');
    expect(recovered.envelope.credentialEpoch).toBe('2');
    expect(recovered.envelope.passwordWrap.slotEpoch).toBe('2');
    expect(recovered.envelope.recoveryWrap.slotEpoch).toBe('2');
    expect(recovered.recoveryCode).not.toBe(recoveryCode);
    await confirmVaultCustody(recovered.envelope, context, newPassword, recovered.recoveryCode!);
    await expect(unlockVault(recovered.envelope, context, { kind: 'recovery', value: recoveryCode })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(unlockVault(recovered.envelope, context, { kind: 'password', value: vector.password })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    assertOpaqueTransition(fixture(), { envelope: recovered.envelope, operationId: recovered.envelope.operationId, expectedRevision: '1' });
  }, 20_000);

  it('rekeys to a new VDK and renews both slots and all epochs without exposing raw material', async () => {
    const old = await unlockVault(fixture(), context, { kind: 'password', value: vector.password });
    const rekeyed = await rekeyVault(old.rootKey, fixture(), context, newPassword);
    expect(rekeyed.envelope.keyEpoch).toBe('2');
    expect(rekeyed.envelope.credentialEpoch).toBe('2');
    expect(rekeyed.envelope.passwordWrap.slotEpoch).toBe('2');
    expect(rekeyed.envelope.recoveryWrap.slotEpoch).toBe('2');
    expect(rekeyed.envelope.revision).toBe('2');
    expect(rekeyed.rootKey.extractable).toBe(false);
    expect(rekeyed.plaintext).toEqual(plaintext());
    await expect(decryptSnapshot(old.rootKey, rekeyed.envelope, context)).rejects.toThrow();
    await confirmVaultCustody(rekeyed.envelope, context, newPassword, rekeyed.recoveryCode);
    assertOpaqueTransition(fixture(), { envelope: rekeyed.envelope, operationId: rekeyed.envelope.operationId, expectedRevision: '1' });
  }, 20_000);
});

describe('opaque bounded plaintext JSON; no financial domain activation', () => {
  it('detaches data and preserves its opaque fields without silently dropping them', () => {
    const input = plaintext();
    const copy = validatePlaintext(input);
    input.financialSpace.newField = 'changed after validation';
    expect(copy.financialSpace.newField).toBeUndefined();
    expect(parsePlaintext(serializePlaintext(copy))).toEqual(vector.plaintext);
    const data = { schemaVersion: 1, financialSpace: { futureOpaqueField: [null, true, 1, 'é', { key: 'value' }] } } satisfies VaultPlaintext;
    expect(parsePlaintext(serializePlaintext(data))).toEqual(data);
  });

  it('rejects cycles, unsafe numbers, duplicate keys, malformed Unicode, accessors and sparse arrays', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse: unknown[] = [];
    sparse.length = 1;
    for (const value of [cyclic, sparse, 1.5, -0, Number.MAX_SAFE_INTEGER + 1, Infinity, '\ud800', new Date()]) {
      expect(() => validatePlaintext({ schemaVersion: 1, financialSpace: { value } })).toThrow();
    }
    expect(() => parsePlaintext(encodeUtf8('{"schemaVersion":1,"schemaVersion":1,"financialSpace":{}}'))).toThrow();
    let called = false;
    const access = { schemaVersion: 1, financialSpace: {} };
    Object.defineProperty(access.financialSpace, 'secret', {
      enumerable: true,
      get() {
        called = true;
        return 'value';
      },
    });
    expect(() => validatePlaintext(access)).toThrow();
    expect(called).toBe(false);
    expect(() => validatePlaintext({ ...plaintext(), extra: true })).toThrow();
  });

  it('bounds nesting/nodes and rejects prototype-bearing objects and array accessors without evaluating them', () => {
    let nested: unknown = null;
    for (let level = 0; level < 40; level++) nested = { nested };
    expect(() => validatePlaintext({ schemaVersion: 1, financialSpace: { nested } })).toThrow();
    expect(() => validatePlaintext({ schemaVersion: 1, financialSpace: { nodes: new Array(200_001).fill(null) } })).toThrow();
    expect(() => validatePlaintext({ schemaVersion: 1, financialSpace: Object.assign(Object.create({ inherited: true }), { value: 1 }) })).toThrow();
    let called = false;
    const values: unknown[] = [];
    Object.defineProperty(values, '0', {
      enumerable: true,
      get() {
        called = true;
        return 1;
      },
    });
    expect(() => validatePlaintext({ schemaVersion: 1, financialSpace: { values } })).toThrow();
    expect(called).toBe(false);
    expect(() => parsePlaintext(new Uint8Array([0xc0, 0xaf]))).toThrow();
    expect(() => parsePlaintext(encodeUtf8('{"schemaVersion":1,"financialSpace":{"constructor":1}}'))).toThrow();
  });

  it('checks the complete serialized 1 MiB limit before encryption or KDF', async () => {
    const prefix = serializePlaintext({ schemaVersion: 1, financialSpace: { text: '' } }).length;
    const allowed = { schemaVersion: 1, financialSpace: { text: 'a'.repeat(MAX_PLAINTEXT_BYTES - prefix) } } satisfies VaultPlaintext;
    expect(serializePlaintext(allowed)).toHaveLength(MAX_PLAINTEXT_BYTES);
    const over = { schemaVersion: 1, financialSpace: { text: allowed.financialSpace.text + 'a' } } satisfies VaultPlaintext;
    expect(() => serializePlaintext(over)).toThrow(expect.objectContaining({ code: 'SIZE_LIMIT' }));
    await expect(createVault({ ...context, password: vector.password, plaintext: over })).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
  });

  it('encrypts and decrypts exactly 1 MiB with a 16-byte GCM tag and rejects one extra byte before KDF', async () => {
    const prefix = serializePlaintext({ schemaVersion: 1, financialSpace: { text: '' } }).length;
    const maximum = { schemaVersion: 1, financialSpace: { text: 'a'.repeat(MAX_PLAINTEXT_BYTES - prefix) } } satisfies VaultPlaintext;
    const opened = await unlockVault(fixture(), context, { kind: 'recovery', value: recoveryCode });
    const envelope = await encryptSnapshot(opened.rootKey, fixture(), maximum);
    expect(decodeBase64Url(envelope.payload.ciphertext)).toHaveLength(MAX_PLAINTEXT_BYTES + 16);
    const decoded = await decryptSnapshot(opened.rootKey, envelope, context);
    expect(decoded.financialSpace.text).toHaveLength(MAX_PLAINTEXT_BYTES - prefix);
    const oversized = { ...envelope, payload: { ...envelope.payload, ciphertext: encodeBase64Url(new Uint8Array(MAX_PLAINTEXT_BYTES + 17)) } };
    const onStart = vi.fn();
    await expect(unlockVault(oversized, context, { kind: 'password', value: vector.password }, onStart)).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    expect(onStart).not.toHaveBeenCalled();
    expect(() => parsePlaintext(new Uint8Array(MAX_PLAINTEXT_BYTES + 1))).toThrow(expect.objectContaining({ code: 'SIZE_LIMIT' }));
  }, 20_000);
});

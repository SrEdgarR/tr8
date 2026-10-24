import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import vector from './fixtures/vault-vectors.json';
import {
  MAX_ENVELOPE_BYTES,
  MAX_PLAINTEXT_BYTES,
  OpaqueError,
  VaultError,
  assertEnvelopeContext,
  assertNextEpochs,
  assertOpaqueTransition,
  decodeBase64Url,
  decodeUtf8,
  encodeBase64Url,
  encodeUtf8,
  hashOpaqueRequest,
  incrementEpoch,
  parseEnvelope,
  parseOpaquePut,
  parseStrictJson,
  serializeOpaquePut,
  validateEnvelope,
  validateEpoch,
  type OpaquePut,
  type VaultEnvelope,
} from './protocol';
import { passwordWrapAad, payloadAad, payloadKeyInfo, recoveryKeyInfo, recoveryWrapAad } from './aad';

beforeAll(() => vi.stubGlobal('crypto', webcrypto));
afterAll(() => vi.unstubAllGlobals());

const bytes = (length: number, value = 0) => encodeBase64Url(new Uint8Array(length).fill(value));
const hex = (data: Uint8Array) => Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = (value: string) => Uint8Array.from(value.match(/../g) ?? [], byte => Number.parseInt(byte, 16));
const envelope = () => validateEnvelope(structuredClone(vector.envelope));
const put = (value = envelope(), expectedRevision = '0'): OpaquePut => ({
  expectedRevision,
  operationId: value.operationId,
  envelope: value,
});

function nextSnapshot(previous = envelope()): VaultEnvelope {
  return {
    ...structuredClone(previous),
    revision: incrementEpoch(previous.revision),
    operationId: bytes(16, 1),
    payload: {
      keySalt: bytes(32, 2),
      nonce: bytes(12, 3),
      ciphertext: bytes(17, 4),
    },
  };
}

function rotateWraps(previous: VaultEnvelope, rekey = false): VaultEnvelope {
  const next = nextSnapshot(previous);
  next.credentialEpoch = incrementEpoch(previous.credentialEpoch);
  next.passwordWrap = {
    ...next.passwordWrap,
    slotEpoch: incrementEpoch(previous.passwordWrap.slotEpoch),
    salt: bytes(16, 5),
    nonce: bytes(12, 6),
    wrappedKey: bytes(48, 7),
  };
  next.recoveryWrap = {
    ...next.recoveryWrap,
    slotEpoch: incrementEpoch(previous.recoveryWrap.slotEpoch),
    salt: bytes(32, 8),
    nonce: bytes(12, 9),
    wrappedKey: bytes(48, 10),
  };
  if (rekey) next.keyEpoch = incrementEpoch(previous.keyEpoch);
  return next;
}

async function deriveKey(secret: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>) {
  const input = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, input, 256));
}

async function decrypt(key: Uint8Array<ArrayBuffer>, nonce: string, aad: Uint8Array<ArrayBuffer>, ciphertext: string) {
  const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: decodeBase64Url(nonce, 12),
        additionalData: aad,
        tagLength: 128,
      },
      aes,
      decodeBase64Url(ciphertext),
    ),
  );
}

describe('Pulso v1 closed protocol compatibility; public synthetic data only', () => {
  it('accepts the pinned upstream envelope and detaches all mutable input', () => {
    const original = structuredClone(vector.envelope);
    const accepted = validateEnvelope(original);
    expect(parseEnvelope(JSON.stringify(original))).toEqual(original);
    original.passwordWrap.salt = 'invalid';
    expect(accepted.passwordWrap.salt).not.toEqual(original.passwordWrap.salt);
    expect(accepted.ownerId).toBe('fixture-owner-1');
  });

  it.each([
    ['top-level extension', (e: VaultEnvelope) => Object.assign(e, { extra: 1 })],
    ['version', (e: VaultEnvelope) => Object.assign(e, { formatVersion: 2 })],
    ['suite', (e: VaultEnvelope) => Object.assign(e, { suiteId: 'tr8-v1' })],
    ['payload schema', (e: VaultEnvelope) => Object.assign(e, { payloadSchemaVersion: 2 })],
    ['wrap extension', (e: VaultEnvelope) => Object.assign(e.passwordWrap, { extra: 1 })],
    ['profile', (e: VaultEnvelope) => Object.assign(e.passwordWrap, { profileId: 'weaker' })],
    ['Argon version', (e: VaultEnvelope) => Object.assign(e.passwordWrap, { argonVersion: 16 })],
    ['memory', (e: VaultEnvelope) => Object.assign(e.passwordWrap, { memoryKiB: 32768 })],
    ['passes', (e: VaultEnvelope) => Object.assign(e.passwordWrap, { passes: 2 })],
    ['parallelism', (e: VaultEnvelope) => Object.assign(e.passwordWrap, { parallelism: 2 })],
    ['output size', (e: VaultEnvelope) => Object.assign(e.passwordWrap, { outputBytes: 16 })],
    ['wrong KDF', (e: VaultEnvelope) => Object.assign(e.passwordWrap, { kdfId: 'pbkdf2' })],
    ['recovery scheme', (e: VaultEnvelope) => Object.assign(e.recoveryWrap, { schemeId: 'other' })],
    ['payload extension', (e: VaultEnvelope) => Object.assign(e.payload, { extra: 1 })],
    ['short ID', (e: VaultEnvelope) => Object.assign(e, { vaultId: bytes(15) })],
    ['padded ID', (e: VaultEnvelope) => Object.assign(e, { operationId: e.operationId + '==' })],
    ['non ASCII owner', (e: VaultEnvelope) => Object.assign(e, { ownerId: 'propietário' })],
    ['owner spaces', (e: VaultEnvelope) => Object.assign(e, { ownerId: 'owner name' })],
    ['owner too long', (e: VaultEnvelope) => Object.assign(e, { ownerId: 'a'.repeat(129) })],
    ['empty owner', (e: VaultEnvelope) => Object.assign(e, { ownerId: '' })],
    ['short wrap', (e: VaultEnvelope) => Object.assign(e.passwordWrap, { wrappedKey: bytes(47) })],
    ['short nonce', (e: VaultEnvelope) => Object.assign(e.payload, { nonce: bytes(11) })],
    ['short salt', (e: VaultEnvelope) => Object.assign(e.recoveryWrap, { salt: bytes(31) })],
  ])('rejects %s structurally before any KDF is available', (_label, mutate) => {
    const e = envelope();
    mutate(e);
    expect(() => validateEnvelope(e)).toThrow(VaultError);
  });

  it('rejects getters and custom prototypes without evaluating user-owned accessors', () => {
    const e = envelope();
    let called = false;
    Object.defineProperty(e, 'ownerId', {
      enumerable: true,
      get() {
        called = true;
        return 'fixture-owner-1';
      },
    });
    expect(() => validateEnvelope(e)).toThrow(VaultError);
    expect(called).toBe(false);
    expect(() => validateEnvelope(Object.assign(Object.create({ inherited: true }), envelope()))).toThrow();
  });

  it.each(['_w=', '/w', '_x', ' _w', 'A', '_w\n', ''])('rejects noncanonical base64url %j', value => {
    expect(() => decodeBase64Url(value)).toThrow(VaultError);
  });

  it('checks base64url byte lengths and canonical trailing bits', () => {
    expect(decodeBase64Url('_w', 1)).toEqual(new Uint8Array([255]));
    expect(() => decodeBase64Url('_w', 2)).toThrow();
    expect(encodeBase64Url(new Uint8Array([255]))).toBe('_w');
  });

  it.each(['0', '01', '-1', '1.0', '9223372036854775808', 1, null])('rejects epoch %j', epoch => {
    expect(() => validateEpoch(epoch)).toThrow();
  });

  it('bounds epochs to signed 64-bit decimal strings', () => {
    expect(incrementEpoch('9223372036854775806')).toBe('9223372036854775807');
    expect(() => incrementEpoch('9223372036854775807')).toThrow();
  });

  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"__proto__":{}}',
    '{"constructor":0}',
    '{"prototype":1}',
    '{"x":9007199254740992}',
    '{"x":1e999}',
    '{"x":-0}',
    '{"x":1.0}',
    '{"x":"\\ud800"}',
    '[1,]',
    '\ufeff{"x":1}',
  ])('rejects ambiguous or unsafe JSON %s', source => {
    expect(() => parseStrictJson(source)).toThrow();
  });

  it('bounds depth, node count, UTF-8 bytes and malformed UTF-8', () => {
    expect(() => parseStrictJson('[[[[1]]]]', { maxDepth: 3 })).toThrow();
    expect(() => parseStrictJson('[1,2]', { maxNodes: 2 })).toThrow();
    expect(() => parseStrictJson('"é"', { maxBytes: 3 })).toThrow();
    expect(() => decodeUtf8(new Uint8Array([0xc0, 0xaf]))).toThrow();
    expect(() => encodeUtf8('\ud800')).toThrow();
    expect(parseStrictJson('{"x":[1,true,null,"é"]}')).toEqual({ x: [1, true, null, 'é'] });
  });

  it('enforces exactly 1 MiB maximum plaintext plus a 16-byte tag', () => {
    const e = envelope();
    e.payload.ciphertext = bytes(MAX_PLAINTEXT_BYTES + 16);
    expect(validateEnvelope(e).payload.ciphertext).toBe(e.payload.ciphertext);
    e.payload.ciphertext = bytes(MAX_PLAINTEXT_BYTES + 17);
    expect(() => validateEnvelope(e)).toThrow(expect.objectContaining({ code: 'SIZE_LIMIT' }));
    e.payload.ciphertext = bytes(16);
    expect(() => validateEnvelope(e)).toThrow();
  });

  it('bounds the complete original opaque request to 2 MiB including whitespace', async () => {
    const source = serializeOpaquePut(put());
    const exact = source + ' '.repeat(MAX_ENVELOPE_BYTES - encodeUtf8(source).length);
    expect(parseOpaquePut(exact)).toEqual(put());
    expect(() => parseOpaquePut(exact + ' ')).toThrow(expect.objectContaining({ code: 'SIZE_LIMIT' }));
    await expect(hashOpaqueRequest(new Uint8Array(MAX_ENVELOPE_BYTES + 1))).rejects.toThrow();
  });

  it('keeps opaque serialization stable and hashes original bytes without normalizing JSON', async () => {
    const source = serializeOpaquePut(put());
    expect(serializeOpaquePut(parseOpaquePut(source))).toBe(source);
    expect(parseOpaquePut(source + '\n')).toEqual(parseOpaquePut(source));
    expect(await hashOpaqueRequest(encodeUtf8(source))).not.toBe(await hashOpaqueRequest(encodeUtf8(source + '\n')));
    expect(await hashOpaqueRequest(encodeUtf8('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(() => parseOpaquePut(source.replace('"expectedRevision":"0"', '"expectedRevision":"00"'))).toThrow();
    expect(() => parseOpaquePut(JSON.stringify({ ...put(), operationId: bytes(16, 23) }))).toThrow();
    expect(() => parseOpaquePut(JSON.stringify({ ...put(), extension: true }))).toThrow();
  });

  it('binds the authenticated owner and vault without replacing identifiers in ciphertext', () => {
    const e = envelope();
    expect(() => assertEnvelopeContext(e, { ownerId: 'different', vaultId: e.vaultId })).toThrow(expect.objectContaining({ code: 'AUTH_FAILED' }));
    expect(() => assertEnvelopeContext(e, { ownerId: e.ownerId, vaultId: bytes(16, 1) })).toThrow();
  });
});

describe('Pulso CAS and epoch transition compatibility', () => {
  it('accepts initial creation and ordinary next snapshots', () => {
    const previous = envelope();
    expect(() => assertOpaqueTransition(null, put(previous))).not.toThrow();
    expect(() => assertOpaqueTransition(previous, put(nextSnapshot(previous), '1'))).not.toThrow();
  });

  it('rejects stale revisions, skipped revisions and replacement of the owner or context', () => {
    const previous = envelope();
    expect(() => assertOpaqueTransition(previous, put(nextSnapshot(previous), '0'))).toThrow(new OpaqueError('STALE_REVISION'));
    expect(() => assertOpaqueTransition(previous, put({ ...nextSnapshot(previous), revision: '3' }, '1'))).toThrow(new OpaqueError('INVALID_ENVELOPE'));
    expect(() => assertOpaqueTransition(previous, put({ ...nextSnapshot(previous), ownerId: 'other' }, '1'))).toThrow(new OpaqueError('FORBIDDEN'));
    expect(() => assertOpaqueTransition(previous, put({ ...nextSnapshot(previous), vaultId: bytes(16, 20) }, '1'))).toThrow(new OpaqueError('FORBIDDEN'));
  });

  it('requires every epoch to begin at one', () => {
    for (const mutate of [
      (e: VaultEnvelope) => {
        e.keyEpoch = '2';
      },
      (e: VaultEnvelope) => {
        e.credentialEpoch = '2';
      },
      (e: VaultEnvelope) => {
        e.passwordWrap.slotEpoch = '2';
      },
      (e: VaultEnvelope) => {
        e.recoveryWrap.slotEpoch = '2';
      },
    ]) {
      const e = envelope();
      mutate(e);
      expect(() => assertOpaqueTransition(null, put(e))).toThrow(new OpaqueError('INVALID_ENVELOPE'));
    }
  });

  it('requires new payload key salt and nonce for each committed snapshot', () => {
    const previous = envelope();
    for (const field of ['keySalt', 'nonce'] as const) {
      const next = nextSnapshot(previous);
      next.payload[field] = previous.payload[field];
      expect(() => assertNextEpochs(previous, next)).toThrow();
    }
  });

  it('allows rewrap without rekey and rekey only with both fresh wraps', () => {
    const previous = envelope();
    expect(() => assertNextEpochs(previous, rotateWraps(previous))).not.toThrow();
    expect(() => assertNextEpochs(previous, rotateWraps(previous, true))).not.toThrow();
    const single = rotateWraps(previous);
    single.recoveryWrap = structuredClone(previous.recoveryWrap);
    expect(() => assertNextEpochs(previous, single)).not.toThrow();
    single.keyEpoch = '2';
    expect(() => assertNextEpochs(previous, single)).toThrow();
  });

  it('rejects skipped epochs, slot-only changes and partial salt/nonce/ciphertext renewal', () => {
    const previous = envelope();
    for (const mutate of [
      (e: VaultEnvelope) => {
        e.keyEpoch = '3';
      },
      (e: VaultEnvelope) => {
        e.credentialEpoch = '3';
      },
      (e: VaultEnvelope) => {
        e.passwordWrap.slotEpoch = '3';
      },
      (e: VaultEnvelope) => {
        e.recoveryWrap.slotEpoch = '3';
      },
      (e: VaultEnvelope) => {
        e.passwordWrap.salt = previous.passwordWrap.salt;
      },
      (e: VaultEnvelope) => {
        e.passwordWrap.nonce = previous.passwordWrap.nonce;
      },
      (e: VaultEnvelope) => {
        e.passwordWrap.wrappedKey = previous.passwordWrap.wrappedKey;
      },
      (e: VaultEnvelope) => {
        e.recoveryWrap.salt = previous.recoveryWrap.salt;
      },
      (e: VaultEnvelope) => {
        e.recoveryWrap.nonce = previous.recoveryWrap.nonce;
      },
      (e: VaultEnvelope) => {
        e.recoveryWrap.wrappedKey = previous.recoveryWrap.wrappedKey;
      },
    ]) {
      const next = rotateWraps(previous, true);
      mutate(next);
      expect(() => assertOpaqueTransition(previous, put(next, '1'))).toThrow(new OpaqueError('INVALID_ENVELOPE'));
    }
    const slotOnly = nextSnapshot(previous);
    slotOnly.passwordWrap.slotEpoch = '2';
    slotOnly.credentialEpoch = '2';
    expect(() => assertNextEpochs(previous, slotOnly)).toThrow();
  });
});

describe('pinned independent AES-GCM/HKDF vector; Argon2 WASM is deferred', () => {
  it('matches every positional AAD and HKDF info byte from the upstream fixture', () => {
    const e = envelope();
    expect(hex(passwordWrapAad(e, e.passwordWrap))).toBe(vector.aadHex.password);
    expect(hex(recoveryWrapAad(e, e.recoveryWrap))).toBe(vector.aadHex.recovery);
    expect(hex(payloadAad(e))).toBe(vector.aadHex.payload);
    expect(hex(payloadKeyInfo(e))).toBe(vector.aadHex.payloadInfo);
    expect(hex(recoveryKeyInfo(e, e.recoveryWrap))).toBe(vector.aadHex.recoveryInfo);
    const reordered = Object.fromEntries(Object.entries(e).reverse());
    expect(payloadAad(validateEnvelope(reordered))).toEqual(payloadAad(e));
  });

  it('derives the independent recovery and payload keys and decrypts the public synthetic vector', async () => {
    const e = envelope();
    const recoveryKek = await deriveKey(unhex(vector.recoveryHex), decodeBase64Url(e.recoveryWrap.salt), recoveryKeyInfo(e, e.recoveryWrap));
    expect(hex(recoveryKek)).toBe(vector.recoveryKekHex);
    const root = await decrypt(recoveryKek, e.recoveryWrap.nonce, recoveryWrapAad(e, e.recoveryWrap), e.recoveryWrap.wrappedKey);
    expect(hex(root)).toBe(vector.rootHex);
    const payloadKey = await deriveKey(root, decodeBase64Url(e.payload.keySalt), payloadKeyInfo(e));
    expect(hex(payloadKey)).toBe(vector.payloadKeyHex);
    const plaintext = await decrypt(payloadKey, e.payload.nonce, payloadAad(e), e.payload.ciphertext);
    expect(JSON.parse(decodeUtf8(plaintext))).toEqual(vector.plaintext);
    // Uses the published fixture KEK: this does not run or validate Argon2.
    expect(hex(await decrypt(unhex(vector.passwordKekHex), e.passwordWrap.nonce, passwordWrapAad(e, e.passwordWrap), e.passwordWrap.wrappedKey))).toBe(
      vector.rootHex,
    );
  });

  it('fails authentication when owner, snapshot metadata or complete wrap binding is edited', async () => {
    const e = envelope();
    for (const mutate of [
      (next: VaultEnvelope) => {
        next.ownerId = 'new-supabase-owner';
      },
      (next: VaultEnvelope) => {
        next.vaultId = bytes(16, 22);
      },
      (next: VaultEnvelope) => {
        next.keyEpoch = '2';
      },
      (next: VaultEnvelope) => {
        next.credentialEpoch = '2';
      },
      (next: VaultEnvelope) => {
        next.revision = '2';
      },
      (next: VaultEnvelope) => {
        next.operationId = bytes(16, 22);
      },
      (next: VaultEnvelope) => {
        next.passwordWrap.wrappedKey = bytes(48, 22);
      },
      (next: VaultEnvelope) => {
        next.recoveryWrap.wrappedKey = bytes(48, 22);
      },
      (next: VaultEnvelope) => {
        next.passwordWrap.slotEpoch = '2';
      },
      (next: VaultEnvelope) => {
        next.recoveryWrap.slotEpoch = '2';
      },
    ]) {
      const next = structuredClone(e);
      mutate(next);
      expect(payloadAad(next)).not.toEqual(payloadAad(e));
      await expect(decrypt(unhex(vector.payloadKeyHex), e.payload.nonce, payloadAad(next), e.payload.ciphertext)).rejects.toThrow();
    }
  });

  it('authenticates every complete password/recovery slot field in the payload snapshot', async () => {
    const e = envelope();
    for (const slot of ['passwordWrap', 'recoveryWrap'] as const) {
      for (const [field, value] of Object.entries(e[slot])) {
        const next = structuredClone(e);
        // Invalid format constants are rejected by parsing; this also proves the
        // authentication tuple includes them if an object bypassed that parser.
        Object.assign(next[slot], { [field]: typeof value === 'number' ? value + 1 : value + 'A' });
        expect(payloadAad(next)).not.toEqual(payloadAad(e));
        await expect(decrypt(unhex(vector.payloadKeyHex), e.payload.nonce, payloadAad(next), e.payload.ciphertext)).rejects.toThrow();
      }
    }
  });
});

/** Compatibility-only Pulso v1 protocol. See NOTICE.md; no vault is activated. */
export const FORMAT_VERSION = 1;
export const SUITE_ID = 'pulso-v1-aes256gcm-hkdfsha256-argon2id13';
export const PASSWORD_PROFILE_ID = 'argon2id-64m-t3-p1-v1';
export const MAX_EPOCH = BigInt('9223372036854775807');
export const MAX_PLAINTEXT_BYTES = 1_048_576;
export const MAX_ENVELOPE_BYTES = 2_097_152;

export interface VaultContext {
  ownerId: string;
  vaultId: string;
}

export interface EnvelopeHeader extends VaultContext {
  formatVersion: 1;
  suiteId: typeof SUITE_ID;
  keyEpoch: string;
  credentialEpoch: string;
  revision: string;
  operationId: string;
  payloadSchemaVersion: 1;
}

export type KeyContext = Pick<EnvelopeHeader, 'formatVersion' | 'suiteId' | 'vaultId' | 'ownerId' | 'keyEpoch'>;

export interface PasswordWrap {
  wrapVersion: 1;
  slotEpoch: string;
  kdfId: 'argon2id';
  argonVersion: 19;
  profileId: typeof PASSWORD_PROFILE_ID;
  memoryKiB: 65536;
  passes: 3;
  parallelism: 1;
  outputBytes: 32;
  salt: string;
  nonce: string;
  wrappedKey: string;
}

export interface RecoveryWrap {
  wrapVersion: 1;
  slotEpoch: string;
  schemeId: 'HKDF-SHA-256';
  salt: string;
  nonce: string;
  wrappedKey: string;
}

export interface VaultPayload {
  keySalt: string;
  nonce: string;
  ciphertext: string;
}

export interface VaultEnvelope extends EnvelopeHeader {
  passwordWrap: PasswordWrap;
  recoveryWrap: RecoveryWrap;
  payload: VaultPayload;
}

export type VaultErrorCode =
  | 'INVALID_FORMAT'
  | 'UNSUPPORTED_FORMAT'
  | 'INVALID_PASSWORD'
  | 'INVALID_RECOVERY'
  | 'AUTH_FAILED'
  | 'CRYPTO_UNAVAILABLE'
  | 'RNG_FAILED'
  | 'INVALID_PLAINTEXT'
  | 'INVALID_STATE'
  | 'SIZE_LIMIT'
  | 'STALE_REVISION'
  | 'CONFLICT';

const messages: Record<VaultErrorCode, string> = {
  INVALID_FORMAT: 'La copia de la bóveda no tiene un formato válido.',
  UNSUPPORTED_FORMAT: 'Esta versión de la bóveda no es compatible.',
  INVALID_PASSWORD: 'La contraseña privada debe tener al menos 16 caracteres Unicode válidos y como máximo 1024 bytes.',
  INVALID_RECOVERY: 'El código de recuperación no tiene un formato válido.',
  AUTH_FAILED: 'No se pudo abrir la bóveda. Comprueba tu medio privado o la copia.',
  CRYPTO_UNAVAILABLE: 'Este navegador no ofrece las capacidades necesarias para abrir la bóveda.',
  RNG_FAILED: 'No se pudo obtener aleatoriedad segura. La operación fue cancelada.',
  INVALID_PLAINTEXT: 'El contenido financiero de la copia no es válido.',
  INVALID_STATE: 'La bóveda está bloqueada o la operación ya no es válida.',
  SIZE_LIMIT: 'La copia supera el tamaño admitido por este prototipo.',
  STALE_REVISION: 'El espacio cambió. Revisa la versión actual antes de continuar.',
  CONFLICT: 'La operación entra en conflicto con la versión actual.',
};

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode) {
    const checked = Object.hasOwn(messages, code) ? code : 'AUTH_FAILED';
    super(messages[checked]);
    this.name = 'VaultError';
    this.code = checked;
  }
}

export function vaultError(code: VaultErrorCode): VaultError {
  return new VaultError(code);
}

export function normalizeVaultError(error: unknown): VaultError {
  return error instanceof VaultError ? error : vaultError('AUTH_FAILED');
}

export function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
  if (!isWellFormedUnicode(value)) throw vaultError('INVALID_FORMAT');
  return new TextEncoder().encode(value);
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    // BOM is data, never silently stripped from a JSON document.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw vaultError('INVALID_FORMAT');
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeBase64Url(value: string, expectedBytes?: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > MAX_ENVELOPE_BYTES || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw vaultError('INVALID_FORMAT');
  }
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const result = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
    if ((expectedBytes !== undefined && result.length !== expectedBytes) || encodeBase64Url(result) !== value) throw vaultError('INVALID_FORMAT');
    return result;
  } catch {
    throw vaultError('INVALID_FORMAT');
  }
}

interface JsonLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
}

// Bounded JSON parser: duplicate decoded keys cannot survive JSON.parse.
export function parseStrictJson(source: string, limits: JsonLimits = {}): unknown {
  const maxBytes = limits.maxBytes ?? MAX_ENVELOPE_BYTES;
  const maxDepth = limits.maxDepth ?? 32;
  const maxNodes = limits.maxNodes ?? 200_000;
  if (typeof source !== 'string' || source.length > maxBytes || encodeUtf8(source).length > maxBytes) throw vaultError('SIZE_LIMIT');
  let cursor = 0;
  let nodes = 0;
  const fail = (): never => {
    throw vaultError('INVALID_FORMAT');
  };
  const whitespace = () => {
    while (/^[\t\r\n ]$/.test(source[cursor] ?? '')) cursor++;
  };
  const string = (): string => {
    if (source[cursor] !== '"') return fail();
    const start = cursor++;
    while (cursor < source.length) {
      const character = source[cursor++];
      if (character === '"') {
        let result: unknown;
        try {
          result = JSON.parse(source.slice(start, cursor));
        } catch {
          return fail();
        }
        if (typeof result !== 'string' || !isWellFormedUnicode(result)) return fail();
        return result;
      }
      if (character === '\\') {
        const escaped = source[cursor++];
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(cursor, cursor + 4))) return fail();
          cursor += 4;
        } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) return fail();
      } else if (character.charCodeAt(0) < 32) return fail();
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > maxDepth || ++nodes > maxNodes) return fail();
    whitespace();
    const character = source[cursor];
    if (character === '"') return string();
    if (character === '{') {
      cursor++;
      const result: Record<string, unknown> = {};
      const keys = new Set<string>();
      whitespace();
      if (source[cursor] === '}') {
        cursor++;
        return result;
      }
      while (cursor < source.length) {
        whitespace();
        const key = string();
        if (keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return fail();
        keys.add(key);
        whitespace();
        if (source[cursor++] !== ':') return fail();
        result[key] = value(depth + 1);
        whitespace();
        const next = source[cursor++];
        if (next === '}') return result;
        if (next !== ',') return fail();
      }
      return fail();
    }
    if (character === '[') {
      cursor++;
      const result: unknown[] = [];
      whitespace();
      if (source[cursor] === ']') {
        cursor++;
        return result;
      }
      while (cursor < source.length) {
        result.push(value(depth + 1));
        whitespace();
        const next = source[cursor++];
        if (next === ']') return result;
        if (next !== ',') return fail();
      }
      return fail();
    }
    for (const [literal, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (source.slice(cursor, cursor + literal.length) === literal) {
        cursor += literal.length;
        return result;
      }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(cursor))?.[0];
    if (!token) return fail();
    const number = Number(token);
    if (!Number.isSafeInteger(number) || Object.is(number, -0) || String(number) !== token) return fail();
    cursor += token.length;
    return number;
  };
  const result = value(0);
  whitespace();
  if (cursor !== source.length) return fail();
  return result;
}

export function requireClosedRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw vaultError('INVALID_FORMAT');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) throw vaultError('INVALID_FORMAT');
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw vaultError('INVALID_FORMAT');
  }
  return value as Record<string, unknown>;
}

const headerFields = ['formatVersion', 'suiteId', 'vaultId', 'ownerId', 'keyEpoch', 'credentialEpoch', 'revision', 'operationId', 'payloadSchemaVersion'];
const passwordFields = [
  'wrapVersion',
  'slotEpoch',
  'kdfId',
  'argonVersion',
  'profileId',
  'memoryKiB',
  'passes',
  'parallelism',
  'outputBytes',
  'salt',
  'nonce',
  'wrappedKey',
];
const recoveryFields = ['wrapVersion', 'slotEpoch', 'schemeId', 'salt', 'nonce', 'wrappedKey'];

export function validateEpoch(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > MAX_EPOCH) throw vaultError('INVALID_FORMAT');
  return value;
}

export function incrementEpoch(value: string): string {
  const current = BigInt(validateEpoch(value));
  if (current === MAX_EPOCH) throw vaultError('INVALID_FORMAT');
  return String(current + BigInt(1));
}

export function validateKeyContext(context: KeyContext): void {
  if (context.formatVersion !== FORMAT_VERSION || context.suiteId !== SUITE_ID) throw vaultError('UNSUPPORTED_FORMAT');
  decodeBase64Url(context.vaultId, 16);
  if (typeof context.ownerId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(context.ownerId)) throw vaultError('INVALID_FORMAT');
  validateEpoch(context.keyEpoch);
}

export function validatePasswordWrap(value: unknown, includeCiphertext = true): PasswordWrap {
  const wrap = requireClosedRecord(value, includeCiphertext ? passwordFields : passwordFields.filter(key => key !== 'wrappedKey'));
  if (wrap.wrapVersion !== 1 || wrap.kdfId !== 'argon2id' || wrap.argonVersion !== 19 || wrap.profileId !== PASSWORD_PROFILE_ID)
    throw vaultError('UNSUPPORTED_FORMAT');
  if (wrap.memoryKiB !== 65536 || wrap.passes !== 3 || wrap.parallelism !== 1 || wrap.outputBytes !== 32) throw vaultError('INVALID_FORMAT');
  validateEpoch(wrap.slotEpoch);
  decodeBase64Url(wrap.salt as string, 16);
  decodeBase64Url(wrap.nonce as string, 12);
  if (includeCiphertext) decodeBase64Url(wrap.wrappedKey as string, 48);
  return wrap as unknown as PasswordWrap;
}

export function validateRecoveryWrap(value: unknown, includeCiphertext = true): RecoveryWrap {
  const wrap = requireClosedRecord(value, includeCiphertext ? recoveryFields : recoveryFields.filter(key => key !== 'wrappedKey'));
  if (wrap.wrapVersion !== 1 || wrap.schemeId !== 'HKDF-SHA-256') throw vaultError('UNSUPPORTED_FORMAT');
  validateEpoch(wrap.slotEpoch);
  decodeBase64Url(wrap.salt as string, 32);
  decodeBase64Url(wrap.nonce as string, 12);
  if (includeCiphertext) decodeBase64Url(wrap.wrappedKey as string, 48);
  return wrap as unknown as RecoveryWrap;
}

export function validateEnvelope(input: unknown): VaultEnvelope {
  const record = requireClosedRecord(input, [...headerFields, 'passwordWrap', 'recoveryWrap', 'payload']);
  validateKeyContext(record as unknown as KeyContext);
  if (record.payloadSchemaVersion !== 1) throw vaultError('UNSUPPORTED_FORMAT');
  validateEpoch(record.credentialEpoch);
  validateEpoch(record.revision);
  decodeBase64Url(record.operationId as string, 16);
  validatePasswordWrap(record.passwordWrap);
  validateRecoveryWrap(record.recoveryWrap);
  const payload = requireClosedRecord(record.payload, ['keySalt', 'nonce', 'ciphertext']);
  decodeBase64Url(payload.keySalt as string, 32);
  decodeBase64Url(payload.nonce as string, 12);
  const ciphertext = decodeBase64Url(payload.ciphertext as string);
  if (ciphertext.length <= 16 || ciphertext.length > MAX_PLAINTEXT_BYTES + 16) throw vaultError('SIZE_LIMIT');
  const json = JSON.stringify(record);
  if (encodeUtf8(json).length > MAX_ENVELOPE_BYTES) throw vaultError('SIZE_LIMIT');
  // Detach from caller-owned mutable objects before an asynchronous KDF begins.
  return JSON.parse(json) as VaultEnvelope;
}

export function parseEnvelope(json: string): VaultEnvelope {
  return validateEnvelope(parseStrictJson(json, { maxBytes: MAX_ENVELOPE_BYTES }));
}

export function assertEnvelopeContext(envelope: VaultEnvelope, expected: VaultContext): void {
  if (envelope.ownerId !== expected.ownerId || envelope.vaultId !== expected.vaultId) throw vaultError('AUTH_FAILED');
}

export interface OpaquePut {
  expectedRevision: string;
  operationId: string;
  envelope: VaultEnvelope;
}
export interface OpaqueReceipt {
  revision: string;
  operationId: string;
}
export type OpaqueErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'VAULT_NOT_FOUND'
  | 'STALE_REVISION'
  | 'OPERATION_CONFLICT'
  | 'INVALID_ENVELOPE'
  | 'ENVELOPE_TOO_LARGE'
  | 'STORAGE_UNAVAILABLE'
  | 'REAUTHENTICATION_REQUIRED';

export class OpaqueError extends Error {
  readonly code: OpaqueErrorCode;
  constructor(code: OpaqueErrorCode) {
    super(code);
    this.name = 'OpaqueError';
    this.code = code;
  }
}

export function validateOpaquePut(value: unknown): OpaquePut {
  const record = requireClosedRecord(value, ['expectedRevision', 'operationId', 'envelope']);
  const envelope = validateEnvelope(record.envelope);
  const expectedRevision = record.expectedRevision === '0' ? '0' : validateEpoch(record.expectedRevision);
  decodeBase64Url(record.operationId as string, 16);
  if (record.operationId !== envelope.operationId) throw vaultError('INVALID_FORMAT');
  return { expectedRevision, operationId: envelope.operationId, envelope };
}

export function parseOpaquePut(body: string): OpaquePut {
  return validateOpaquePut(parseStrictJson(body, { maxBytes: MAX_ENVELOPE_BYTES }));
}

export function serializeOpaquePut(value: OpaquePut): string {
  const body = JSON.stringify(validateOpaquePut(value));
  if (encodeUtf8(body).length > MAX_ENVELOPE_BYTES) throw vaultError('SIZE_LIMIT');
  return body;
}

function sameWrap(a: object, b: object): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key]);
}

/** P3's existing structural transition rules; no decryption or KDF. */
export function assertNextEpochs(previous: VaultEnvelope, next: VaultEnvelope): void {
  const passwordChanged = !sameWrap(previous.passwordWrap, next.passwordWrap);
  const recoveryChanged = !sameWrap(previous.recoveryWrap, next.recoveryWrap);
  const rekey = next.keyEpoch !== previous.keyEpoch;
  if (
    next.keyEpoch !== (rekey ? incrementEpoch(previous.keyEpoch) : previous.keyEpoch) ||
    next.credentialEpoch !== (passwordChanged || recoveryChanged ? incrementEpoch(previous.credentialEpoch) : previous.credentialEpoch)
  )
    throw vaultError('CONFLICT');
  for (const [before, after, changed] of [
    [previous.passwordWrap, next.passwordWrap, passwordChanged],
    [previous.recoveryWrap, next.recoveryWrap, recoveryChanged],
  ] as const) {
    if (after.slotEpoch !== (changed ? incrementEpoch(before.slotEpoch) : before.slotEpoch)) throw vaultError('CONFLICT');
    if (changed && (after.salt === before.salt || after.nonce === before.nonce || after.wrappedKey === before.wrappedKey)) throw vaultError('CONFLICT');
  }
  if ((rekey && !(passwordChanged && recoveryChanged)) || previous.payload.keySalt === next.payload.keySalt || previous.payload.nonce === next.payload.nonce)
    throw vaultError('CONFLICT');
}

export function assertOpaqueTransition(previous: VaultEnvelope | null, put: OpaquePut): void {
  const revision = previous?.revision ?? '0';
  if (put.expectedRevision !== revision) throw new OpaqueError('STALE_REVISION');
  if (put.envelope.revision !== (revision === '0' ? '1' : incrementEpoch(revision))) throw new OpaqueError('INVALID_ENVELOPE');
  if (previous) {
    if (previous.vaultId !== put.envelope.vaultId || previous.ownerId !== put.envelope.ownerId) throw new OpaqueError('FORBIDDEN');
    try {
      assertNextEpochs(previous, put.envelope);
    } catch {
      throw new OpaqueError('INVALID_ENVELOPE');
    }
  } else if (
    [put.envelope.keyEpoch, put.envelope.credentialEpoch, put.envelope.passwordWrap.slotEpoch, put.envelope.recoveryWrap.slotEpoch].some(epoch => epoch !== '1')
  )
    throw new OpaqueError('INVALID_ENVELOPE');
}

/** Hash the original request bytes; JSON reserialization changes idempotency identity. */
export async function hashOpaqueRequest(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw vaultError('SIZE_LIMIT');
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

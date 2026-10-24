/** The financial domain is deliberately opaque until the next delivery. */
import { MAX_PLAINTEXT_BYTES, decodeUtf8, encodeUtf8, isWellFormedUnicode, parseStrictJson, requireClosedRecord, vaultError } from '../compatibility/protocol';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface VaultPlaintext {
  schemaVersion: 1;
  financialSpace: Record<string, JsonValue>;
}

function cloneJson(input: unknown, depth = 0, budget = { nodes: 0, characters: 0 }, path = new Set<object>()): JsonValue {
  if (depth > 32 || ++budget.nodes > 200_000) throw vaultError('INVALID_PLAINTEXT');
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'string') {
    budget.characters += input.length;
    if (budget.characters > MAX_PLAINTEXT_BYTES) throw vaultError('SIZE_LIMIT');
    if (!isWellFormedUnicode(input)) throw vaultError('INVALID_PLAINTEXT');
    return input;
  }
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || Object.is(input, -0)) throw vaultError('INVALID_PLAINTEXT');
    return input;
  }
  if (typeof input !== 'object' || path.has(input)) throw vaultError('INVALID_PLAINTEXT');
  path.add(input);
  try {
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype || Reflect.ownKeys(input).length !== input.length + 1) throw vaultError('INVALID_PLAINTEXT');
      const result: JsonValue[] = [];
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw vaultError('INVALID_PLAINTEXT');
        result.push(cloneJson(descriptor.value, depth + 1, budget, path));
      }
      return result;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw vaultError('INVALID_PLAINTEXT');
    const result: Record<string, JsonValue> = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !isWellFormedUnicode(key) || ['__proto__', 'constructor', 'prototype'].includes(key))
        throw vaultError('INVALID_PLAINTEXT');
      budget.characters += key.length;
      if (budget.characters > MAX_PLAINTEXT_BYTES) throw vaultError('SIZE_LIMIT');
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw vaultError('INVALID_PLAINTEXT');
      result[key] = cloneJson(descriptor.value, depth + 1, budget, path);
    }
    return result;
  } finally {
    path.delete(input);
  }
}

export function validatePlaintext(input: unknown): VaultPlaintext {
  try {
    const record = requireClosedRecord(input, ['schemaVersion', 'financialSpace']);
    if (record.schemaVersion !== 1 || !record.financialSpace || typeof record.financialSpace !== 'object' || Array.isArray(record.financialSpace))
      throw vaultError('INVALID_PLAINTEXT');
    const clone = cloneJson(record) as unknown as VaultPlaintext;
    const bytes = encodeUtf8(JSON.stringify(clone));
    try {
      if (bytes.byteLength > MAX_PLAINTEXT_BYTES) throw vaultError('SIZE_LIMIT');
    } finally {
      bytes.fill(0);
    }
    return clone;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SIZE_LIMIT') throw error;
    throw vaultError('INVALID_PLAINTEXT');
  }
}

export function serializePlaintext(input: VaultPlaintext): Uint8Array<ArrayBuffer> {
  return encodeUtf8(JSON.stringify(validatePlaintext(input)));
}

export function parsePlaintext(bytes: Uint8Array): VaultPlaintext {
  if (bytes.byteLength > MAX_PLAINTEXT_BYTES) throw vaultError('SIZE_LIMIT');
  return validatePlaintext(parseStrictJson(decodeUtf8(bytes), { maxBytes: MAX_PLAINTEXT_BYTES }));
}

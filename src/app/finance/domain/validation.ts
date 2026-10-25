import { isLocalDate } from './dates';
import type { CurrencyDefinition } from './types';
import { isWellFormedUnicode } from '../compatibility/protocol';

export function requireRecord(candidate: unknown): Record<string, unknown> {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate) || ![Object.prototype, null].includes(Object.getPrototypeOf(candidate))) {
    throw new Error('La información financiera no es válida.');
  }
  for (const key of Reflect.ownKeys(candidate)) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor) || ['__proto__', 'prototype', 'constructor'].includes(key))
      throw new Error('La información financiera no es válida.');
  }
  return candidate as Record<string, unknown>;
}

export function requireText(candidate: unknown): string {
  if (typeof candidate !== 'string' || !candidate.trim() || !isWellFormedUnicode(candidate) || new TextEncoder().encode(candidate).length > 1024) {
    throw new Error('Falta un identificador o nombre válido.');
  }
  return candidate.trim();
}

export function requireMinor(candidate: unknown, positive = false): number {
  if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || Object.is(candidate, -0) || (positive && candidate <= 0)) {
    throw new Error('El importe debe ser un entero válido en unidades menores.');
  }
  return candidate;
}

export function requireDate(candidate: unknown): string {
  if (typeof candidate !== 'string' || !isLocalDate(candidate)) {
    throw new Error('La fecha financiera no es válida.');
  }
  return candidate;
}

export function safeMinor(candidate: bigint): number {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (candidate > maximum || candidate < -maximum) {
    throw new Error('El resultado monetario supera el rango de enteros seguros.');
  }
  return Number(candidate);
}

export function requireCurrencyDefinitions(definitions: readonly CurrencyDefinition[]): ReadonlyMap<string, CurrencyDefinition> {
  if (!Array.isArray(definitions)) throw new Error('Faltan las definiciones de moneda.');
  const result = new Map<string, CurrencyDefinition>();
  for (const candidate of definitions) {
    const definition = requireRecord(candidate);
    const code = requireText(definition.code);
    const minorUnitDigits = requireMinor(definition.minorUnitDigits);
    if (code !== definition.code || minorUnitDigits < 0 || result.has(code)) {
      throw new Error('La definición de moneda no es válida o está duplicada.');
    }
    result.set(code, { code, minorUnitDigits });
  }
  return result;
}

export function requireCurrency(candidate: unknown, definitions: ReadonlyMap<string, CurrencyDefinition>): string {
  if (typeof candidate !== 'string' || !definitions.has(candidate)) {
    throw new Error('La moneda debe tener una definición explícita.');
  }
  return candidate;
}

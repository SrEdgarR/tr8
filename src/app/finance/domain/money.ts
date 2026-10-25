import type { CurrencyDefinition } from './types';
import { safeMinor } from './validation';

function precision(digits: number): bigint {
  if (!Number.isInteger(digits) || digits < 0 || digits > 6) throw new Error('La precisión de la moneda no es compatible.');
  return BigInt(10) ** BigInt(digits);
}

/** Exact decimal grammar: one separator, no grouping or scientific notation. */
export function parseAmountMinor(input: string, digits: number, options: { allowZero?: boolean; allowNegative?: boolean } = {}): number {
  const scale = precision(digits);
  if (typeof input !== 'string' || input.length > 100) throw new Error('Introduce un importe válido.');
  const value = input.trim();
  const match = /^(-?)(\d+)(?:[.,](\d+))?$/.exec(value);
  if (!match || (match[1] && !options.allowNegative)) throw new Error('Usa un importe decimal sin separadores de miles.');
  const fraction = match[3] ?? '';
  if (fraction.length > digits) throw new Error(`Esta moneda admite ${digits} decimales.`);
  const absolute = BigInt(match[2]!) * scale + BigInt(fraction.padEnd(digits, '0') || '0');
  if (absolute === BigInt(0) && (!options.allowZero || match[1])) throw new Error('El importe debe ser mayor que cero.');
  return safeMinor(match[1] ? -absolute : absolute);
}

/** Format integer components, so the last cent is preserved at MAX_SAFE_INTEGER. */
export function formatMoneyMinor(amount: number, currency: CurrencyDefinition): string {
  if (!Number.isSafeInteger(amount) || Object.is(amount, -0)) throw new Error('El importe no es válido.');
  const scale = precision(currency.minorUnitDigits);
  const signed = BigInt(amount);
  const absolute = signed < BigInt(0) ? -signed : signed;
  const whole = new Intl.NumberFormat('es', { useGrouping: true }).format(absolute / scale);
  const fraction = currency.minorUnitDigits ? `,${String(absolute % scale).padStart(currency.minorUnitDigits, '0')}` : '';
  return `${currency.code} ${signed < BigInt(0) ? '-' : ''}${whole}${fraction}`;
}

export function localToday(date = new Date()): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

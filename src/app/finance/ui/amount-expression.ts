/** A deliberately small calculator grammar. It never executes JavaScript. */
export interface AmountExpressionResult {
  decimal: string;
  minor: number;
  rounded: boolean;
}

const MAX_LENGTH = 256;
const MAX_DEPTH = 16;
const MAX_OPERATIONS = 128;
const MAX_INTERMEDIATE_DIGITS = 512;
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const incomplete = () => new Error('Completa el cálculo con números y operadores válidos.');
const normalize = (input: string) => input.replaceAll('×', '*').replaceAll('÷', '/').replaceAll('−', '-');

/** A leading minus alone belongs to a normal amount, not to a calculation. */
export function isAmountExpression(input: string): boolean {
  const value = normalize(input).trim();
  return /[+\-*/()]/.test(value.startsWith('-') ? value.slice(1) : value);
}

interface Rational {
  n: bigint;
  d: bigint;
}

const abs = (value: bigint) => (value < 0n ? -value : value);
function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}
function rational(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new Error('No se puede dividir entre cero.');
  if (abs(n).toString().length > MAX_INTERMEDIATE_DIGITS || abs(d).toString().length > MAX_INTERMEDIATE_DIGITS)
    throw new Error('El cálculo es demasiado grande.');
  if (n === 0n) return { n: 0n, d: 1n };
  const divisor = gcd(abs(n), abs(d));
  return { n: (d < 0n ? -n : n) / divisor, d: abs(d) / divisor };
}

/**
 * Decimal comma and decimal point are accepted, without grouping separators.
 * Fractions stay exact until the final currency rounding, half away from zero.
 * Normal numeric literals return null so their existing validation is unchanged.
 */
export function evaluateAmountExpression(input: string, digits: number): AmountExpressionResult | null {
  if (typeof input !== 'string' || input.length > MAX_LENGTH) throw new Error('El cálculo admite hasta 256 caracteres.');
  if (!Number.isInteger(digits) || digits < 0 || digits > 6) throw new Error('La precisión de la moneda no es compatible.');
  const value = normalize(input).trim();
  if (/^-?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(value)) return null;
  if (!value || /[^\d\s.,+\-*/()]/.test(value)) throw new Error('Usa solo números, +, −, ×, ÷ y paréntesis.');
  let cursor = 0;
  let operations = 0;
  const whitespace = () => {
    while (/\s/.test(value[cursor] ?? '') && cursor < value.length) cursor++;
  };
  const step = () => {
    if (++operations > MAX_OPERATIONS) throw new Error('El cálculo tiene demasiadas operaciones.');
  };
  function primary(depth: number): Rational {
    if (depth > MAX_DEPTH) throw new Error('Usa como máximo 16 niveles de paréntesis o signos.');
    whitespace();
    const token = value[cursor];
    if (token === '+' || token === '-') {
      cursor++;
      step();
      const result = primary(depth + 1);
      return token === '-' ? { n: -result.n, d: result.d } : result;
    }
    if (token === '(') {
      cursor++;
      const result = expression(depth + 1);
      whitespace();
      if (value[cursor++] !== ')') throw incomplete();
      return result;
    }
    const start = cursor;
    while (/[\d.,]/.test(value[cursor] ?? '') && cursor < value.length) cursor++;
    const number = value.slice(start, cursor);
    if (!/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(number)) throw incomplete();
    const [whole, fraction = ''] = number.replace(',', '.').split('.');
    return rational(BigInt((whole || '0') + fraction), 10n ** BigInt(fraction.length));
  }
  function product(depth: number): Rational {
    let left = primary(depth);
    while (true) {
      whitespace();
      const token = value[cursor];
      if (token !== '*' && token !== '/') return left;
      cursor++;
      step();
      const right = primary(depth);
      if (token === '/' && right.n === 0n) throw new Error('No se puede dividir entre cero.');
      left = token === '*' ? rational(left.n * right.n, left.d * right.d) : rational(left.n * right.d, left.d * right.n);
    }
  }
  function expression(depth: number): Rational {
    let left = product(depth);
    while (true) {
      whitespace();
      const token = value[cursor];
      if (token !== '+' && token !== '-') return left;
      cursor++;
      step();
      const right = product(depth);
      left = rational(left.n * right.d + (token === '+' ? right.n : -right.n) * left.d, left.d * right.d);
    }
  }
  const result = expression(0);
  whitespace();
  if (cursor !== value.length) throw incomplete();
  const scale = 10n ** BigInt(digits);
  const scaled = abs(result.n) * scale;
  const remainder = scaled % result.d;
  const unsignedMinor = scaled / result.d + (remainder * 2n >= result.d ? 1n : 0n);
  if (unsignedMinor > MAX_SAFE_MINOR) throw new Error('El resultado es demasiado grande.');
  const minor = result.n < 0n && unsignedMinor !== 0n ? -unsignedMinor : unsignedMinor;
  const decimal = `${minor < 0n ? '-' : ''}${unsignedMinor / scale}${digits ? `.${String(unsignedMinor % scale).padStart(digits, '0')}` : ''}`;
  return { decimal, minor: Number(minor), rounded: remainder !== 0n };
}

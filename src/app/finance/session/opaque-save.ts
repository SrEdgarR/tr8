import { vaultError } from '../compatibility/protocol';

export const DEFINITIVE_OPAQUE_SAVE_CODES = [
  'AUTH_REQUIRED',
  'FINANCE_ACCESS_DENIED',
  'FINANCE_CONFLICT',
  'REAUTHENTICATION_REQUIRED',
  'CONTEXT_DENIED',
  'INVALID_INPUT',
] as const;
export type DefinitiveOpaqueSaveCode = (typeof DEFINITIVE_OPAQUE_SAVE_CODES)[number];

export function isDefinitiveOpaqueSaveCode(value: unknown): value is DefinitiveOpaqueSaveCode {
  return typeof value === 'string' && DEFINITIVE_OPAQUE_SAVE_CODES.some(code => code === value);
}

/**
 * A trusted transport may construct this only after validating a definitive
 * rejection from the expected backend. Never infer it from a message, loose
 * status, timeout, generic 5xx, or failure to parse an uncertain response.
 */
export class DefinitiveOpaqueSaveError extends Error {
  readonly code: DefinitiveOpaqueSaveCode;
  constructor(code: DefinitiveOpaqueSaveCode) {
    if (!isDefinitiveOpaqueSaveCode(code)) throw vaultError('INVALID_STATE');
    super(code);
    this.name = 'DefinitiveOpaqueSaveError';
    this.code = code;
    Object.freeze(this);
  }
}

import { isWellFormedUnicode } from '../compatibility/protocol';
import { vaultError } from '../compatibility/protocol';

export function normalizePrivatePassword(password: string): Uint8Array<ArrayBuffer> {
  if (typeof password !== 'string' || !isWellFormedUnicode(password)) throw vaultError('INVALID_PASSWORD');
  const normalized = password.normalize('NFC');
  if (Array.from(normalized).length < 16) throw vaultError('INVALID_PASSWORD');
  const bytes = new TextEncoder().encode(normalized);
  if (bytes.length > 1024) {
    bytes.fill(0);
    throw vaultError('INVALID_PASSWORD');
  }
  return bytes;
}

import { vaultError } from '../compatibility/protocol';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encodeRecoverySecret(secret: Uint8Array): string {
  if (secret.length !== 32) throw vaultError('INVALID_RECOVERY');
  let accumulator = 0;
  let bits = 0;
  let result = '';
  for (const byte of secret) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(accumulator << (5 - bits)) & 31];
  return result;
}

export function decodeRecoverySecret(input: string): Uint8Array<ArrayBuffer> {
  if (typeof input !== 'string' || !(/^[A-Za-z2-7]{52}$/.test(input) || /^(?:[A-Za-z2-7]{4}-){12}[A-Za-z2-7]{4}$/.test(input)))
    throw vaultError('INVALID_RECOVERY');
  const canonical = input.replace(/-/g, '').toUpperCase();
  const secret = new Uint8Array(32);
  let accumulator = 0;
  let bits = 0;
  let index = 0;
  for (const character of canonical) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      secret[index++] = (accumulator >>> bits) & 255;
    }
  }
  if (index !== 32 || encodeRecoverySecret(secret) !== canonical) {
    secret.fill(0);
    throw vaultError('INVALID_RECOVERY');
  }
  return secret;
}

export function formatRecoverySecret(canonical: string): string {
  const bytes = decodeRecoverySecret(canonical);
  try {
    return encodeRecoverySecret(bytes).match(/.{4}/g)!.join('-');
  } finally {
    bytes.fill(0);
  }
}

export function confirmRecoverySecret(expected: Uint8Array, reentry: string): boolean {
  if (expected.length !== 32) return false;
  let decoded: Uint8Array<ArrayBuffer> | undefined;
  try {
    decoded = decodeRecoverySecret(reentry);
    let difference = 0;
    for (let index = 0; index < 32; index++) difference |= expected[index] ^ decoded[index];
    return difference === 0;
  } catch {
    return false;
  } finally {
    decoded?.fill(0);
  }
}

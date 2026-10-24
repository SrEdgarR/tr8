import { vaultError } from '../compatibility/protocol';

/** Require secure Web Crypto; there is no weak RNG or local cipher fallback. */
export function requireSecureCrypto(): Crypto {
  if (
    globalThis.isSecureContext !== true ||
    !globalThis.crypto?.subtle ||
    typeof globalThis.crypto.getRandomValues !== 'function' ||
    typeof globalThis.crypto.subtle.importKey !== 'function' ||
    typeof globalThis.crypto.subtle.deriveKey !== 'function' ||
    typeof globalThis.crypto.subtle.encrypt !== 'function' ||
    typeof globalThis.crypto.subtle.decrypt !== 'function'
  )
    throw vaultError('CRYPTO_UNAVAILABLE');
  return globalThis.crypto;
}

/** Secret buffers are owned copies; wiping them is best effort, not JS zeroization. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(length) || length < 1 || length > 65536) throw vaultError('RNG_FAILED');
  const bytes = new Uint8Array(length);
  try {
    requireSecureCrypto().getRandomValues(bytes);
    return bytes;
  } catch {
    wipe(bytes);
    throw vaultError('RNG_FAILED');
  }
}

export async function importRootKey(raw: Uint8Array): Promise<CryptoKey> {
  requireSecureCrypto();
  if (raw.byteLength !== 32) throw vaultError('INVALID_STATE');
  const copy = new Uint8Array(raw);
  try {
    return await crypto.subtle.importKey('raw', copy, 'HKDF', false, ['deriveKey']);
  } catch {
    throw vaultError('CRYPTO_UNAVAILABLE');
  } finally {
    wipe(copy);
  }
}

export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  requireSecureCrypto();
  if (raw.byteLength !== 32) throw vaultError('INVALID_STATE');
  const copy = new Uint8Array(raw);
  try {
    return await crypto.subtle.importKey('raw', copy, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch {
    throw vaultError('CRYPTO_UNAVAILABLE');
  } finally {
    wipe(copy);
  }
}

export async function deriveAesKey(root: CryptoKey, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  requireSecureCrypto();
  if (root.extractable || root.algorithm.name !== 'HKDF' || root.usages.length !== 1 || root.usages[0] !== 'deriveKey') throw vaultError('INVALID_STATE');
  try {
    return await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(salt),
        info: new Uint8Array(info),
      },
      root,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } catch {
    throw vaultError('CRYPTO_UNAVAILABLE');
  }
}

export async function aesEncrypt(key: CryptoKey, plaintext: Uint8Array, nonce: Uint8Array, aad: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  requireSecureCrypto();
  if (nonce.byteLength !== 12) throw vaultError('INVALID_FORMAT');
  if (key.extractable || key.algorithm.name !== 'AES-GCM' || (key.algorithm as AesKeyAlgorithm).length !== 256) throw vaultError('INVALID_STATE');
  const copy = new Uint8Array(plaintext);
  try {
    return new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(nonce),
          additionalData: new Uint8Array(aad),
          tagLength: 128,
        },
        key,
        copy,
      ),
    );
  } catch {
    throw vaultError('CRYPTO_UNAVAILABLE');
  } finally {
    wipe(copy);
  }
}

export async function aesDecrypt(key: CryptoKey, ciphertext: Uint8Array, nonce: Uint8Array, aad: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  requireSecureCrypto();
  if (nonce.byteLength !== 12 || ciphertext.byteLength < 16) throw vaultError('AUTH_FAILED');
  if (key.extractable || key.algorithm.name !== 'AES-GCM' || (key.algorithm as AesKeyAlgorithm).length !== 256) throw vaultError('AUTH_FAILED');
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(nonce),
          additionalData: new Uint8Array(aad),
          tagLength: 128,
        },
        key,
        new Uint8Array(ciphertext),
      ),
    );
  } catch {
    throw vaultError('AUTH_FAILED');
  }
}

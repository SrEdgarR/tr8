import { vaultError } from '../compatibility/protocol';
import { requireSecureCrypto, wipe } from './native-crypto';

/** Only this module may load sumo. Its object and additional APIs never escape. */
export async function derivePasswordKey(
  password: Uint8Array,
  salt: Uint8Array,
  onTiming?: (timing: { loadMs: number; kdfMs: number }) => void,
  onStart?: () => void,
): Promise<Uint8Array<ArrayBuffer>> {
  requireSecureCrypto();
  if (typeof globalThis.WebAssembly?.compile !== 'function' || typeof globalThis.WebAssembly?.instantiate !== 'function')
    throw vaultError('CRYPTO_UNAVAILABLE');
  if (salt.byteLength !== 16 || password.byteLength < 16 || password.byteLength > 1024) throw vaultError('INVALID_PASSWORD');
  const passwordCopy = new Uint8Array(password);
  const saltCopy = new Uint8Array(salt);
  let derived: Uint8Array | undefined;
  try {
    const loadStarted = performance.now();
    const sodium = (await import('libsodium-wrappers-sumo')).default;
    await sodium.ready;
    const loadMs = performance.now() - loadStarted;
    const kdfStarted = performance.now();
    onStart?.();
    derived = sodium.crypto_pwhash(32, passwordCopy, saltCopy, 3, 64 * 1024 * 1024, sodium.crypto_pwhash_ALG_ARGON2ID13);
    onTiming?.({ loadMs, kdfMs: performance.now() - kdfStarted });
    return new Uint8Array(derived);
  } catch {
    throw vaultError('CRYPTO_UNAVAILABLE');
  } finally {
    wipe(passwordCopy);
    wipe(saltCopy);
    if (derived) wipe(derived);
  }
}

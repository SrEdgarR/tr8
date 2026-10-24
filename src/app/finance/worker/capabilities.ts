import { vaultError } from '../compatibility/protocol';

export function requireVaultBrowserCapabilities(): void {
  if (
    !globalThis.isSecureContext ||
    !globalThis.crypto?.subtle ||
    typeof globalThis.crypto?.getRandomValues !== 'function' ||
    typeof globalThis.Worker !== 'function' ||
    typeof globalThis.MessageChannel !== 'function' ||
    typeof globalThis.WebAssembly?.compile !== 'function'
  )
    throw vaultError('CRYPTO_UNAVAILABLE');
}

/** Nonfinancial probe keys stay inside the Worker, including its clone test. */
export async function probeWorkerCapabilities(): Promise<void> {
  if (
    !globalThis.isSecureContext ||
    !globalThis.crypto?.subtle ||
    typeof globalThis.crypto?.getRandomValues !== 'function' ||
    typeof globalThis.MessageChannel !== 'function' ||
    typeof globalThis.WebAssembly?.compile !== 'function'
  )
    throw vaultError('CRYPTO_UNAVAILABLE');
  const raw = new Uint8Array(32);
  let channel: MessageChannel | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    crypto.getRandomValues(raw);
    await globalThis.WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const key = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    raw.fill(0);
    channel = new MessageChannel();
    const received = new Promise<CryptoKey>((resolve, reject) => {
      timer = setTimeout(() => reject(vaultError('CRYPTO_UNAVAILABLE')), 5000);
      channel!.port1.onmessage = (event: MessageEvent<CryptoKey>) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      channel!.port1.onmessageerror = () => {
        clearTimeout(timer);
        reject(vaultError('CRYPTO_UNAVAILABLE'));
      };
      channel!.port1.start();
      // CryptoKey supports structured clone; it is not a Transferable object.
      // Sending inside the executor turns synchronous DataCloneError into a handled rejection.
      channel!.port2.postMessage(key);
    });
    const cloned = await received;
    if (cloned.extractable || cloned.algorithm.name !== 'HKDF' || cloned.usages.join() !== 'deriveKey') throw vaultError('CRYPTO_UNAVAILABLE');
    const aes = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new Uint8Array([1]) },
      cloned,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, aes, new Uint8Array([1]));
    const clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, aes, cipher));
    if (clear.length !== 1 || clear[0] !== 1) throw vaultError('CRYPTO_UNAVAILABLE');
    clear.fill(0);
  } catch {
    throw vaultError('CRYPTO_UNAVAILABLE');
  } finally {
    raw.fill(0);
    clearTimeout(timer);
    channel?.port1.close();
    channel?.port2.close();
  }
}

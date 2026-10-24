import { webcrypto } from 'node:crypto';
import { MessageChannel as NativeMessageChannel } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeWorkerCapabilities, requireVaultBrowserCapabilities } from './capabilities';

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('MessageChannel', NativeMessageChannel);
  vi.stubGlobal('Worker', class {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('explicit browser and Worker capability admission', () => {
  it('probes nonextractable HKDF CryptoKey cloning and native AES inside the Worker boundary', async () => {
    expect(() => requireVaultBrowserCapabilities()).not.toThrow();
    await expect(probeWorkerCapabilities()).resolves.toBeUndefined();
  });

  it.each(['crypto', 'WebAssembly', 'MessageChannel'] as const)('rejects absent %s uniformly without a fallback', async missing => {
    vi.stubGlobal(missing, undefined);
    expect(() => requireVaultBrowserCapabilities()).toThrow(expect.objectContaining({ code: 'CRYPTO_UNAVAILABLE' }));
    await expect(probeWorkerCapabilities()).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
  });

  it('requires a secure context and real Worker support on the main thread', () => {
    vi.stubGlobal('isSecureContext', false);
    expect(() => requireVaultBrowserCapabilities()).toThrow(expect.objectContaining({ code: 'CRYPTO_UNAVAILABLE' }));
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('Worker', undefined);
    expect(() => requireVaultBrowserCapabilities()).toThrow(expect.objectContaining({ code: 'CRYPTO_UNAVAILABLE' }));
  });

  it('clears timeout and closes ports if CryptoKey cloning throws synchronously', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1 = { onmessage: null, onmessageerror: null, start() {}, close };
        port2 = {
          postMessage() {
            throw new DOMException('synthetic cannot clone', 'DataCloneError');
          },
          close,
        };
      },
    );
    await expect(probeWorkerCapabilities()).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
    expect(close).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5001);
  });

  it('normalizes CSPRNG failures and wipes the owned probe buffer', async () => {
    let probe: Uint8Array | undefined;
    vi.stubGlobal('crypto', {
      subtle: webcrypto.subtle,
      getRandomValues(buffer: Uint8Array) {
        probe = buffer;
        buffer.fill(9);
        throw new Error('synthetic CSPRNG error');
      },
    });
    await expect(probeWorkerCapabilities()).rejects.toMatchObject({ code: 'CRYPTO_UNAVAILABLE' });
    expect(probe?.every(byte => byte === 0)).toBe(true);
  });
});

import vector from '../../src/app/finance/compatibility/fixtures/vault-vectors.json';

// Test-only entry: the production vault Worker never exposes derived key bytes.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => Promise<void>) | null;
  postMessage: (value: unknown) => void;
};
scope.onmessage = async event => {
  const command = event.data;
  try {
    if (command === 'deny-wasm') {
      Object.defineProperty(WebAssembly, 'instantiate', {
        value: () => Promise.reject(new Error('Synthetic unavailable WASM')),
      });
    } else if (command !== 'vector') {
      throw new Error('Unsupported probe');
    }
    const { derivePasswordKey } = await import('../../src/app/finance/crypto/argon2');
    const { decodeBase64Url } = await import('../../src/app/finance/compatibility/protocol');
    let timing: { loadMs: number; kdfMs: number } | undefined;
    const raw = await derivePasswordKey(new TextEncoder().encode(vector.password), decodeBase64Url(vector.envelope.passwordWrap.salt, 16), value => {
      timing = value;
    });
    const actual = Array.from(raw, byte => byte.toString(16).padStart(2, '0')).join('');
    raw.fill(0);
    scope.postMessage({ command, passed: command === 'vector' && actual === vector.passwordKekHex, timing });
  } catch {
    scope.postMessage({ command, passed: command === 'deny-wasm' });
  }
};

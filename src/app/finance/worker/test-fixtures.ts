/** Synthetic unit doubles only. Browser harnesses exercise the actual Worker/crypto. */
import { webcrypto } from 'node:crypto';
import vector from '../compatibility/fixtures/vault-vectors.json';
import { encodeBase64Url, validateEnvelope, type VaultEnvelope } from '../compatibility/protocol';
import { validatePlaintext, type VaultPlaintext } from '../crypto/plaintext';
import { VaultWorkerEngine, type VaultEngineCrypto } from './engine';
import type { VaultWorkerRequest } from './messages';

export const testIdentity = { ownerId: vector.envelope.ownerId, sessionId: 'test-session', epoch: '1', valid: true };
export const testPassword = 'synthetic password for worker tests';
export const testRecovery = 'synthetic-full-recovery';
export const testPlaintext = (): VaultPlaintext => validatePlaintext({ schemaVersion: 1, financialSpace: { synthetic: 'private test value' } });
export const testEnvelope = (): VaultEnvelope => validateEnvelope(structuredClone(vector.envelope));
export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function syntheticCore(): Promise<VaultEngineCrypto> {
  const rootKey = (await webcrypto.subtle.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveKey'])) as CryptoKey;
  let operation = 1;
  const next = (previous: VaultEnvelope) =>
    validateEnvelope({ ...previous, revision: String(BigInt(previous.revision) + 1n), operationId: encodeBase64Url(new Uint8Array(16).fill(++operation)) });
  const opened = (mode: 'password' | 'recovery-readonly' = 'password') => ({ rootKey, plaintext: testPlaintext(), mode });
  return {
    probe: async () => {},
    create: async input => ({
      ...opened(),
      plaintext: input.plaintext,
      envelope: { ...testEnvelope(), ownerId: input.ownerId, vaultId: input.vaultId },
      recoveryCode: testRecovery,
    }),
    unlock: async (_envelope, _context, credential) => opened(credential.kind === 'recovery' ? 'recovery-readonly' : 'password'),
    custody: async (_envelope, _context, password, recovery) => {
      if (password !== testPassword || recovery !== testRecovery) throw new Error('TEST_CUSTODY_REJECTED');
    },
    encrypt: async (_key, previous) => next(previous),
    recover: async previous => ({ ...opened(), envelope: next(previous), recoveryCode: testRecovery }),
    rotatePassword: async previous => ({ ...opened(), envelope: next(previous) }),
    rotateRecovery: async previous => ({ ...opened(), envelope: next(previous), recoveryCode: testRecovery }),
    rekey: async (_key, previous) => ({ ...opened(), envelope: next(previous), recoveryCode: testRecovery }),
  };
}

export class SyntheticWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  readonly sent: VaultWorkerRequest[] = [];
  transform?: (request: VaultWorkerRequest, response: unknown) => unknown;
  readonly engine: VaultWorkerEngine;
  constructor(core: VaultEngineCrypto) {
    this.engine = new VaultWorkerEngine(core);
  }
  postMessage(input: VaultWorkerRequest): void {
    const request = structuredClone(input);
    this.sent.push(request);
    const receiver = this.onmessage;
    void this.engine.handle(request).then(
      response => {
        // Deliberately retain the callback to exercise delivery queued before terminate.
        const value = this.transform ? this.transform(request, response) : structuredClone(response);
        receiver?.({ data: value } as MessageEvent);
      },
      () => receiver?.({ data: null } as MessageEvent),
    );
  }
  terminate(): void {
    this.terminated = true;
    this.engine.close();
  }
}

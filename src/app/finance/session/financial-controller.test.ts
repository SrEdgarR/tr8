/** Protocol doubles only; the browser acceptance runs the actual financial Worker/KDF. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_ENVELOPE_BYTES, encodeBase64Url, parseOpaquePut, validateEnvelope, type OpaqueReceipt, type VaultEnvelope } from '../compatibility/protocol';
import { validatePlaintext } from '../crypto/plaintext';
import { emptyFinancialSnapshot } from '../domain/workspace';
import { serializeEncryptedBackup } from '../import/format';
import type { ImportPreview } from '../import/preview';
import type { VaultWorkerRequest } from '../worker/messages';
import { deferred, testEnvelope, testIdentity, testPassword, testRecovery } from '../worker/test-fixtures';
import { DefinitiveOpaqueSaveError, VaultSessionController } from './controller';
import { FinancialVaultSessionController } from './financial-controller';
import type { VaultSessionIdentity } from './lifecycle';

const controllers: VaultSessionController[] = [];
const encoded = (byte: number) => encodeBase64Url(new Uint8Array(16).fill(byte));
const source = () => testEnvelope();
const backup = () => serializeEncryptedBackup(source());
const summary = (): ImportPreview => ({
  sourceDomainSchemaVersion: 4,
  targetDomainSchemaVersion: 4,
  sourceCurrencyCatalogVersion: 'currency-catalog-v1',
  targetCurrencyCatalogVersion: 'currency-catalog-v1',
  requiresUpgrade: false,
  accounts: 0,
  operations: 0,
  plans: 0,
  currencies: [],
});

class FinancialProtocolWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  readonly sent: VaultWorkerRequest[] = [];
  readonly previewId: string;
  current = source();
  pending?: VaultEnvelope;
  expectedRevision = '0';
  respond?: (request: VaultWorkerRequest) => unknown | Promise<unknown>;

  constructor(index: number) {
    this.previewId = encoded(10 + index);
  }
  defaultReply(request: VaultWorkerRequest): unknown {
    if (request.method === 'probe') return true;
    if (request.method === 'import-preview' || request.method === 'restore-preview') return { previewId: this.previewId, summary: summary() };
    if (request.method === 'import-accept') {
      this.pending = validateEnvelope({ ...source(), ownerId: request.identity.ownerId, vaultId: encoded(45), operationId: encoded(46) });
      this.expectedRevision = '0';
      return { recoveryCode: testRecovery };
    }
    if (request.method === 'confirm-custody') return { envelope: this.pending!, expectedRevision: this.expectedRevision };
    if (request.method === 'unlock') {
      const value = request.value as { envelope: VaultEnvelope; credential: { kind: string } };
      this.current = validateEnvelope(value.envelope);
      return { mode: value.credential.kind === 'recovery' ? 'recovery-readonly' : 'password' };
    }
    if (request.method === 'restore-accept') {
      this.expectedRevision = this.current.revision;
      this.pending = validateEnvelope({ ...this.current, revision: String(BigInt(this.current.revision) + 1n), operationId: encoded(47) });
      return { envelope: this.pending, expectedRevision: this.expectedRevision };
    }
    if (request.method === 'ack') {
      this.current = this.pending!;
      this.pending = undefined;
      return { mode: 'password' };
    }
    if (request.method === 'read') return validatePlaintext(emptyFinancialSnapshot());
    if (request.method === 'backup-export') return serializeEncryptedBackup(this.current);
    throw new Error('Unexpected synthetic financial protocol method');
  }
  postMessage(input: VaultWorkerRequest): void {
    const request = structuredClone(input);
    this.sent.push(request);
    // Capture the callback deliberately: tests deliver replies queued before terminate.
    const receiver = this.onmessage;
    void Promise.resolve(this.respond ? this.respond(request) : this.defaultReply(request)).then(value => {
      receiver?.({ data: { id: request.id, generation: request.generation, identity: request.identity, value: structuredClone(value) } } as MessageEvent);
    });
  }
  terminate(): void {
    this.terminated = true;
    this.pending = undefined;
  }
}

function harness(configureWorker?: (worker: FinancialProtocolWorker) => void) {
  let identity: VaultSessionIdentity = { ...testIdentity };
  const workers: FinancialProtocolWorker[] = [];
  const clear = vi.fn();
  const readOpaque = vi.fn(async (actor: VaultSessionIdentity): Promise<{ envelope: VaultEnvelope | null; epoch: string }> => {
    expect(actor).toMatchObject({ ownerId: testIdentity.ownerId, sessionId: identity.sessionId, epoch: identity.epoch });
    return { envelope: null, epoch: identity.epoch };
  });
  const verify = vi.fn(async () => ({ ...identity }));
  const bodies: string[] = [];
  const save = vi.fn(async (body: string): Promise<OpaqueReceipt> => {
    bodies.push(body);
    const put = parseOpaquePut(body);
    return { operationId: put.operationId, revision: put.envelope.revision };
  });
  const controller = new FinancialVaultSessionController({
    ownerId: testIdentity.ownerId,
    verifyIdentity: verify,
    readOpaque,
    saveOpaque: save,
    onClear: clear,
    capabilityCheck: () => {},
    makeWorker: () => {
      const worker = new FinancialProtocolWorker(workers.length);
      workers.push(worker);
      configureWorker?.(worker);
      return worker as unknown as Worker;
    },
  });
  controllers.push(controller);
  const preview = () => controller.beginImportPreview(backup(), { kind: 'password', value: testPassword });
  const accepted = async () => {
    const result = await preview();
    return controller.acceptImport(result.previewId, testPassword);
  };
  const pending = async () => {
    await accepted();
    return controller.confirmCustody(testPassword, testRecovery);
  };
  return {
    controller,
    workers,
    clear,
    verify,
    readOpaque,
    save,
    bodies,
    preview,
    accepted,
    pending,
    setIdentity: (value: VaultSessionIdentity) => {
      identity = value;
    },
  };
}

afterEach(() => {
  controllers.splice(0).forEach(controller => controller.lock());
  vi.restoreAllMocks();
});

describe('financial import controller authority, custody and asynchronous fences', () => {
  it('reads the trusted empty destination twice and keeps import inactive until custody plus ACK', async () => {
    const h = harness();
    const preview = await h.preview();
    expect(preview).toEqual({ previewId: h.workers[0].previewId, summary: summary() });
    expect(h.readOpaque).toHaveBeenCalledTimes(1);
    expect(h.controller.state()).toMatchObject({ phase: 'import-preview', canDisplay: false });
    await expect(h.controller.read()).rejects.toBeDefined();
    await expect(h.controller.exportBackup()).rejects.toBeDefined();
    expect(h.save).not.toHaveBeenCalled();
    await h.controller.acceptImport(preview.previewId, testPassword);
    expect(h.readOpaque).toHaveBeenCalledTimes(2);
    expect(
      h.readOpaque.mock.calls.every(([actor]) => actor.ownerId === testIdentity.ownerId && actor.sessionId === testIdentity.sessionId && actor.epoch === '1'),
    ).toBe(true);
    expect(h.controller.state().phase).toBe('custody');
    const prepared = await h.controller.confirmCustody(testPassword, testRecovery);
    expect(prepared.expectedRevision).toBe('0');
    expect(prepared.envelope.vaultId).not.toBe(source().vaultId);
    expect(h.save).not.toHaveBeenCalled();
    await h.controller.commit();
    expect(parseOpaquePut(h.bodies[0]).expectedRevision).toBe('0');
    expect(h.controller.state()).toMatchObject({ phase: 'open', mode: 'password', canDisplay: true });
    expect(h.workers[0].sent.every(request => !JSON.stringify(request).includes('rootKey'))).toBe(true);
  });

  it.each([
    ['already occupied', { envelope: source(), epoch: '1' }],
    ['wrong epoch', { envelope: null, epoch: '2' }],
    ['extra head fields', { envelope: null, epoch: '1', privateValue: 'untrusted' }],
    ['missing envelope', { epoch: '1' }],
    ['malformed epoch', { envelope: null, epoch: '01' }],
  ])('rejects a %s destination before sending a backup to the Worker', async (_label, head) => {
    const h = harness();
    h.readOpaque.mockResolvedValueOnce(head as never);
    await expect(h.preview()).rejects.toBeDefined();
    expect(h.workers[0].sent.map(request => request.method)).toEqual(['probe']);
    expect(h.workers[0].terminated).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('requires the trusted head callback rather than a missing or caller-provided empty flag', async () => {
    const worker = new FinancialProtocolWorker(0);
    const controller = new VaultSessionController({
      ownerId: testIdentity.ownerId,
      verifyIdentity: async () => ({ ...testIdentity }),
      saveOpaque: vi.fn(),
      onClear: vi.fn(),
      makeWorker: () => worker as unknown as Worker,
      capabilityCheck: () => {},
    });
    controllers.push(controller);
    await expect(controller.beginImportPreview(backup(), { kind: 'password', value: testPassword })).rejects.toBeDefined();
    expect(worker.terminated).toBe(true);
    expect(worker.sent.some(request => request.method === 'import-preview')).toBe(false);
  });

  it('rechecks emptiness at acceptance and stops if another writer created a vault', async () => {
    const h = harness();
    const preview = await h.preview();
    h.readOpaque.mockResolvedValueOnce({ envelope: source(), epoch: '1' });
    await expect(h.controller.acceptImport(preview.previewId, testPassword)).rejects.toBeDefined();
    expect(h.workers[0].sent.some(request => request.method === 'import-accept')).toBe(false);
    expect(h.controller.state().phase).toBe('locked');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('discards an old head result after logout without affecting a new preview generation', async () => {
    const h = harness();
    const head = deferred<{ envelope: VaultEnvelope | null; epoch: string }>();
    const entered = deferred<void>();
    h.readOpaque.mockImplementationOnce(async () => {
      entered.resolve();
      return head.promise;
    });
    const old = h.preview();
    const rejected = expect(old).rejects.toBeDefined();
    await entered.promise;
    h.controller.lock('logout');
    const next = await h.preview();
    head.resolve({ envelope: null, epoch: '1' });
    await rejected;
    expect(h.workers[0].terminated).toBe(true);
    expect(h.workers[1].terminated).toBe(false);
    expect(h.controller.state().phase).toBe('import-preview');
    await h.controller.acceptImport(next.previewId, testPassword);
    expect(h.controller.state().phase).toBe('custody');
  });

  it('checks live session again after the asynchronous head read', async () => {
    const h = harness();
    const head = deferred<{ envelope: VaultEnvelope | null; epoch: string }>();
    const entered = deferred<void>();
    h.readOpaque.mockImplementationOnce(async () => {
      entered.resolve();
      return head.promise;
    });
    const pending = h.preview();
    const rejected = expect(pending).rejects.toBeDefined();
    await entered.promise;
    h.setIdentity({ ...testIdentity, sessionId: 'new-session' });
    head.resolve({ envelope: null, epoch: '1' });
    await rejected;
    expect(h.workers[0].terminated).toBe(true);
    expect(h.workers[0].sent.some(request => request.method === 'import-preview')).toBe(false);
  });

  it('ignores a queued old preview reply after a replacement Worker has entered its own preview', async () => {
    const reply = deferred<unknown>();
    const entered = deferred<void>();
    let first = true;
    const h = harness(worker => {
      if (!first) return;
      first = false;
      worker.respond = request => {
        if (request.method === 'import-preview') {
          entered.resolve();
          return reply.promise;
        }
        return worker.defaultReply(request);
      };
    });
    const old = h.preview();
    const rejected = expect(old).rejects.toBeDefined();
    await entered.promise;
    h.controller.lock('navigation');
    const next = await h.preview();
    reply.resolve({ previewId: h.workers[0].previewId, summary: summary() });
    await rejected;
    await Promise.resolve();
    expect(h.controller.state().phase).toBe('import-preview');
    expect(h.workers[0].terminated).toBe(true);
    expect(h.workers[1].terminated).toBe(false);
    await h.controller.acceptImport(next.previewId, testPassword);
    expect(h.controller.state().phase).toBe('custody');
  });

  it('rejects preview metadata containing unknown private data instead of exposing it to the caller', async () => {
    const h = harness(worker => {
      worker.respond = request =>
        request.method === 'import-preview'
          ? { previewId: worker.previewId, summary: { ...summary(), financialSpace: { note: 'synthetic-private-canary' } } }
          : worker.defaultReply(request);
    });
    await expect(h.preview()).rejects.toBeDefined();
    expect(h.controller.state().phase).toBe('locked');
    expect(h.workers[0].terminated).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('rejects stale preview IDs and never asks the Worker to accept them', async () => {
    const h = harness();
    await h.preview();
    await expect(h.controller.acceptImport(encoded(100), testPassword)).rejects.toBeDefined();
    expect(h.readOpaque).toHaveBeenCalledTimes(1);
    expect(h.workers[0].sent.some(request => request.method === 'import-accept')).toBe(false);
    expect(h.controller.state().phase).toBe('locked');
  });

  it('holds the operation ticket through the second head read and accepts only once', async () => {
    const h = harness();
    const preview = await h.preview();
    const head = deferred<{ envelope: VaultEnvelope | null; epoch: string }>();
    const entered = deferred<void>();
    h.readOpaque.mockImplementationOnce(async () => {
      entered.resolve();
      return head.promise;
    });
    const first = h.controller.acceptImport(preview.previewId, testPassword);
    await entered.promise;
    await expect(h.controller.acceptImport(preview.previewId, testPassword)).rejects.toBeDefined();
    head.resolve({ envelope: null, epoch: '1' });
    await first;
    expect(h.workers[0].sent.filter(request => request.method === 'import-accept')).toHaveLength(1);
    expect(h.controller.state().phase).toBe('custody');
  });

  it('keeps abort active while waiting for the final empty-destination read', async () => {
    const h = harness();
    const preview = await h.preview();
    const head = deferred<{ envelope: VaultEnvelope | null; epoch: string }>();
    const entered = deferred<void>();
    h.readOpaque.mockImplementationOnce(async () => {
      entered.resolve();
      return head.promise;
    });
    const abort = new AbortController();
    const pending = h.controller.acceptImport(preview.previewId, testPassword, abort.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    await entered.promise;
    abort.abort();
    head.resolve({ envelope: null, epoch: '1' });
    await rejected;
    expect(h.workers[0].terminated).toBe(true);
    expect(h.workers[0].sent.some(request => request.method === 'import-accept')).toBe(false);
  });

  it('keeps CAS-zero import bytes identical after ambiguous ACK and blocks on a definitive retry rejection', async () => {
    const h = harness();
    await h.pending();
    h.save.mockImplementationOnce(async body => {
      h.bodies.push(body);
      throw new Error('Synthetic ACK lost');
    });
    await expect(h.controller.commit()).rejects.toBeDefined();
    expect(h.controller.state()).toMatchObject({ phase: 'unconfirmed', canDisplay: false });
    await expect(h.controller.exportBackup()).rejects.toBeDefined();
    h.save.mockImplementationOnce(async body => {
      h.bodies.push(body);
      throw new DefinitiveOpaqueSaveError('FINANCE_CONFLICT');
    });
    await expect(h.controller.commit()).rejects.toBeInstanceOf(DefinitiveOpaqueSaveError);
    expect(h.bodies[0]).toBe(h.bodies[1]);
    expect(parseOpaquePut(h.bodies[0]).expectedRevision).toBe('0');
    expect(h.controller.state().phase).toBe('locked');
    expect(h.workers[0].terminated).toBe(true);
  });

  it('keeps restore preview, prepared content and export inactive until its matching ACK', async () => {
    const h = harness();
    await h.controller.unlock(source(), { kind: 'password', value: testPassword });
    const old = await h.controller.exportBackup();
    const preview = await h.controller.beginRestorePreview(old, { kind: 'password', value: testPassword });
    expect(h.controller.state()).toMatchObject({ phase: 'restore-preview', canDisplay: false });
    await expect(h.controller.exportBackup()).rejects.toBeDefined();
    const prepared = await h.controller.acceptRestore(preview.previewId);
    expect(prepared.expectedRevision).toBe('1');
    expect(prepared.envelope.revision).toBe('2');
    expect(prepared.envelope.vaultId).toBe(source().vaultId);
    expect(prepared.envelope.keyEpoch).toBe(source().keyEpoch);
    expect(prepared.envelope.passwordWrap).toEqual(source().passwordWrap);
    await expect(h.controller.exportBackup()).rejects.toBeDefined();
    await h.controller.commit();
    expect(await h.controller.exportBackup()).not.toBe(old);
    expect(h.readOpaque).not.toHaveBeenCalled();
  });

  it('does not allow a recovery-only session to prepare a data restore', async () => {
    const h = harness();
    await h.controller.unlock(source(), { kind: 'recovery', value: testRecovery });
    await expect(h.controller.beginRestorePreview(backup(), { kind: 'recovery', value: testRecovery })).rejects.toBeDefined();
    expect(h.workers[0].sent.some(request => request.method === 'restore-preview')).toBe(false);
  });

  it('canonicalizes a valid 2 MiB pretty backup before bounded Worker transport', async () => {
    const h = harness();
    const canonical = backup();
    const pretty = JSON.stringify(JSON.parse(canonical), null, 2);
    const padded = pretty + ' '.repeat(MAX_ENVELOPE_BYTES - new TextEncoder().encode(pretty).length);
    await h.controller.beginImportPreview(padded, { kind: 'password', value: testPassword });
    const request = h.workers[0].sent.find(request => request.method === 'import-preview');
    expect((request!.value as { backup: string }).backup).toBe(canonical);
    expect(h.save).not.toHaveBeenCalled();
    await expect(h.controller.beginImportPreview(padded + ' ', { kind: 'password', value: testPassword })).rejects.toBeDefined();
    expect(h.workers).toHaveLength(1);
    expect(h.controller.state().phase).toBe('locked');
  });
});

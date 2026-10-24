import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseOpaquePut, type OpaqueReceipt } from '../compatibility/protocol';
import { deferred, syntheticCore, SyntheticWorker, testEnvelope, testIdentity, testPassword, testPlaintext, testRecovery } from '../worker/test-fixtures';
import { VaultSessionController } from './controller';
import type { VaultSessionIdentity } from './lifecycle';
import { DEFINITIVE_OPAQUE_SAVE_CODES, DefinitiveOpaqueSaveError, isDefinitiveOpaqueSaveCode, type DefinitiveOpaqueSaveCode } from './opaque-save';

const controllers: VaultSessionController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.lock();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function harness() {
  const core = await syntheticCore();
  const workers: SyntheticWorker[] = [];
  const clear = vi.fn();
  let identity = { ...testIdentity };
  let clock = 100;
  const verify = vi.fn(async (): Promise<VaultSessionIdentity> => ({ ...identity }));
  const bodies: string[] = [];
  const save = vi.fn(async (body: string): Promise<OpaqueReceipt> => {
    bodies.push(body);
    const put = parseOpaquePut(body);
    return { operationId: put.operationId, revision: put.envelope.revision };
  });
  const controller = new VaultSessionController({
    ownerId: testIdentity.ownerId,
    verifyIdentity: verify,
    saveOpaque: save,
    onClear: clear,
    capabilityCheck: () => {},
    now: () => clock,
    makeWorker: () => {
      const worker = new SyntheticWorker(core);
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  controllers.push(controller);
  const create = async () => controller.beginCreate({ vaultId: testEnvelope().vaultId, password: testPassword, plaintext: testPlaintext() });
  const pending = async () => {
    await create();
    return controller.confirmCustody(testPassword, testRecovery);
  };
  const open = async () => {
    await pending();
    await controller.commit();
  };
  return {
    controller,
    core,
    workers,
    clear,
    verify,
    save,
    bodies,
    create,
    pending,
    open,
    setIdentity: (value: VaultSessionIdentity) => {
      identity = value;
    },
    setClock: (value: number) => {
      clock = value;
    },
  };
}

describe('Worker-only vault controller and custody', () => {
  it('only exposes recovery until full custody, and activates only after a matching ACK', async () => {
    const h = await harness();
    expect(await h.create()).toEqual({ recoveryCode: testRecovery });
    expect(h.controller.state()).toMatchObject({ phase: 'custody', canDisplay: false });
    await expect(h.controller.read()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const prepared = await h.controller.confirmCustody(testPassword, testRecovery);
    expect(prepared.expectedRevision).toBe('0');
    expect(h.controller.state()).toMatchObject({ phase: 'pending', canDisplay: false });
    await h.controller.commit();
    expect(h.controller.state()).toMatchObject({ phase: 'open', mode: 'password', canDisplay: true });
    expect(await h.controller.read()).toEqual(testPlaintext());
    expect(h.workers[0].sent.every(request => !JSON.stringify(request).includes('rootKey'))).toBe(true);
  });

  it('fails closed for wrong full custody without saving', async () => {
    const h = await harness();
    await h.create();
    await expect(h.controller.confirmCustody(testPassword, testRecovery.slice(0, -1))).rejects.toBeDefined();
    expect(h.workers[0].terminated).toBe(true);
    expect(h.controller.state().phase).toBe('locked');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('retries exact persisted bytes after a lost ACK without allowing any read between attempts', async () => {
    const h = await harness();
    await h.pending();
    h.save.mockImplementationOnce(async body => {
      h.bodies.push(body);
      throw new Error('synthetic ACK lost after persistence');
    });
    await expect(h.controller.commit()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(h.controller.state()).toMatchObject({ phase: 'unconfirmed', canDisplay: false });
    expect(h.workers[0].terminated).toBe(false);
    await expect(h.controller.read()).rejects.toBeDefined();
    await h.controller.commit();
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1]).toBe(h.bodies[0]);
    expect(h.controller.state().canDisplay).toBe(true);
    expect(h.workers[0].sent.filter(request => request.method === 'create')).toHaveLength(1);
  });

  it('locks on a malformed ACK and never promotes its draft', async () => {
    const h = await harness();
    await h.pending();
    h.save.mockResolvedValueOnce({ operationId: 'wrong', revision: '1' });
    await expect(h.controller.commit()).rejects.toBeDefined();
    expect(h.workers[0].terminated).toBe(true);
    expect(h.controller.state()).toMatchObject({ phase: 'locked', canDisplay: false });
    expect(h.workers[0].sent.some(request => request.method === 'ack')).toBe(false);
  });

  it.each(DEFINITIVE_OPAQUE_SAVE_CODES)('terminates its pending draft on definitive %s', async code => {
    const h = await harness();
    await h.pending();
    const denied = new DefinitiveOpaqueSaveError(code);
    h.clear.mockClear();
    h.save.mockRejectedValueOnce(denied);
    await expect(h.controller.commit()).rejects.toBe(denied);
    expect(h.clear).toHaveBeenCalled();
    expect(h.workers[0].terminated).toBe(true);
    expect(h.controller.state()).toMatchObject({ phase: 'locked', canDisplay: false });
    await expect(h.controller.read()).rejects.toBeDefined();
    await expect(h.controller.commit()).rejects.toBeDefined();
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('ends an ambiguous retry when its next exact request receives a definitive denial', async () => {
    const h = await harness();
    await h.pending();
    h.save
      .mockImplementationOnce(async body => {
        h.bodies.push(body);
        throw new Error('synthetic ACK lost');
      })
      .mockImplementationOnce(async body => {
        h.bodies.push(body);
        throw new DefinitiveOpaqueSaveError('FINANCE_ACCESS_DENIED');
      });
    await expect(h.controller.commit()).rejects.toBeDefined();
    expect(h.controller.state().phase).toBe('unconfirmed');
    expect(h.workers[0].terminated).toBe(false);
    await expect(h.controller.commit()).rejects.toBeInstanceOf(DefinitiveOpaqueSaveError);
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1]).toBe(h.bodies[0]);
    expect(h.workers[0].terminated).toBe(true);
    expect(h.controller.state().phase).toBe('locked');
  });

  it('does not infer a definitive denial from an arbitrary error message, code or status', async () => {
    const h = await harness();
    await h.pending();
    h.save.mockRejectedValueOnce({ message: 'FINANCE_ACCESS_DENIED', code: 'FINANCE_ACCESS_DENIED', status: 403 });
    await expect(h.controller.commit()).rejects.toBeDefined();
    expect(h.controller.state().phase).toBe('unconfirmed');
    expect(h.workers[0].terminated).toBe(false);
    await h.controller.commit();
    expect(h.controller.state().canDisplay).toBe(true);
  });

  it('admits only the closed set of definitive backend error codes', () => {
    expect(isDefinitiveOpaqueSaveCode('FINANCE_CONFLICT')).toBe(true);
    for (const code of ['DEPENDENCY_UNAVAILABLE', 'TIMEOUT', 'synthetic private diagnostic', null, 403]) expect(isDefinitiveOpaqueSaveCode(code)).toBe(false);
    expect(() => new DefinitiveOpaqueSaveError('TIMEOUT' as DefinitiveOpaqueSaveCode)).toThrow(expect.objectContaining({ code: 'INVALID_STATE' }));
  });

  it('takes the commit mutex before asynchronous identity verification', async () => {
    const h = await harness();
    await h.pending();
    const proof = deferred<VaultSessionIdentity>();
    h.verify.mockImplementationOnce(() => proof.promise);
    const first = h.controller.commit();
    await expect(h.controller.commit()).rejects.toBeDefined();
    expect(h.save).not.toHaveBeenCalled();
    proof.resolve(testIdentity);
    await first;
    expect(h.save).toHaveBeenCalledTimes(1);
  });

  it('a late old save cannot release the mutex of a new generation', async () => {
    const h = await harness();
    await h.pending();
    const oldReceipt = deferred<OpaqueReceipt>();
    const newReceipt = deferred<OpaqueReceipt>();
    h.save.mockImplementationOnce(() => oldReceipt.promise).mockImplementationOnce(() => newReceipt.promise);
    const oldCommit = h.controller.commit();
    const oldRejected = expect(oldCommit).rejects.toBeDefined();
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    h.controller.lock();
    await h.pending();
    const newCommit = h.controller.commit();
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(2));
    oldReceipt.reject(new Error('old network completed'));
    await oldRejected;
    await expect(h.controller.commit()).rejects.toBeDefined();
    expect(h.save).toHaveBeenCalledTimes(2);
    const put = parseOpaquePut(h.save.mock.calls[1][0]);
    newReceipt.resolve({ operationId: put.operationId, revision: put.envelope.revision });
    await newCommit;
    expect(h.controller.state().canDisplay).toBe(true);
  });

  it('locks before commit when its trusted identity changes', async () => {
    const h = await harness();
    await h.pending();
    h.setIdentity({ ...testIdentity, sessionId: 'new-session' });
    await expect(h.controller.commit()).rejects.toBeDefined();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.workers[0].terminated).toBe(true);
    expect(h.controller.state().phase).toBe('locked');
  });

  it.each(['oversize', 'cyclic', 'malformed-mode', 'malformed-snapshot'] as const)('settles and locks on %s Worker response', async kind => {
    const h = await harness();
    if (kind === 'malformed-snapshot') await h.open();
    else if (kind !== 'malformed-mode') await h.create();
    if (kind === 'malformed-mode') {
      const makeWorker = h.core.unlock;
      h.core.unlock = async (...args) => ({ ...(await makeWorker(...args)), mode: 'invalid' as 'password' });
      await expect(h.controller.unlock(testEnvelope(), { kind: 'password', value: testPassword })).rejects.toBeDefined();
    } else {
      h.workers[0].transform = (_request, response) => {
        const record = response as { value: unknown };
        if (kind === 'oversize') record.value = 'x'.repeat(2 * 1024 * 1024 + 1);
        else if (kind === 'cyclic') {
          const cyclic: unknown[] = [];
          cyclic.push(cyclic);
          record.value = cyclic;
        } else record.value = { schemaVersion: 1, financialSpace: {}, forbidden: true };
        return response;
      };
      await expect(kind === 'malformed-snapshot' ? h.controller.read() : h.controller.getCustody()).rejects.toBeDefined();
    }
    expect(h.workers.at(-1)?.terminated).toBe(true);
    expect(h.controller.state().phase).toBe('locked');
  });

  it('hides immediately, revalidates on return, and expires retained keys at sixty seconds', async () => {
    const h = await harness();
    await h.open();
    h.clear.mockClear();
    h.controller.setHidden(true);
    expect(h.clear).toHaveBeenCalledOnce();
    expect(h.controller.state().canDisplay).toBe(false);
    h.setClock(60_099);
    h.controller.setHidden(false);
    expect(h.controller.state().canDisplay).toBe(false);
    expect(await h.controller.read()).toEqual(testPlaintext());
    expect(h.controller.state().canDisplay).toBe(true);
    h.controller.setHidden(true);
    h.setClock(120_099);
    h.controller.tick();
    expect(h.workers[0].terminated).toBe(true);
  });

  it('does not dispatch an old operation to a replacement Worker after verification resolves', async () => {
    const h = await harness();
    await h.open();
    const proof = deferred<VaultSessionIdentity>();
    h.verify.mockImplementationOnce(() => proof.promise);
    const oldRead = h.controller.read();
    const rejected = expect(oldRead).rejects.toBeDefined();
    h.controller.lock();
    await h.open();
    const count = h.workers[1].sent.length;
    proof.resolve(testIdentity);
    await rejected;
    expect(h.workers[1].sent).toHaveLength(count);
    expect(h.controller.state().canDisplay).toBe(true);
  });

  it('terminates an aborted KDF job and cannot reactivate from its queued late output', async () => {
    const h = await harness();
    const create = h.core.create;
    const gate = deferred<void>();
    h.core.create = async (...args) => {
      await gate.promise;
      return create(...args);
    };
    const abort = new AbortController();
    const pending = h.controller.beginCreate({ vaultId: testEnvelope().vaultId, password: testPassword, plaintext: testPlaintext() }, abort.signal);
    const rejected = expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(h.workers[0]?.sent.some(request => request.method === 'create')).toBe(true));
    abort.abort();
    await rejected;
    expect(h.workers[0].terminated).toBe(true);
    gate.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.controller.state()).toMatchObject({ phase: 'locked', canDisplay: false });
  });

  it('forces recovery readonly until replacement credentials, custody and ACK complete', async () => {
    const h = await harness();
    await h.controller.unlock(testEnvelope(), { kind: 'recovery', value: testRecovery });
    expect(h.controller.state().mode).toBe('recovery-readonly');
    expect(await h.controller.read()).toEqual(testPlaintext());
    await h.controller.beginRecovery(testRecovery, testPassword);
    expect(h.controller.state()).toMatchObject({ phase: 'custody', canDisplay: false });
    await h.controller.confirmCustody(testPassword, testRecovery);
    await h.controller.commit();
    expect(h.controller.state()).toMatchObject({ phase: 'open', mode: 'password', canDisplay: true });
  });

  it('rejects concurrent mutations while an ACK is being verified, without losing the pending commit', async () => {
    const h = await harness();
    await h.pending();
    const proof = deferred<VaultSessionIdentity>();
    let ack = false;
    h.workers[0].transform = (request, response) => {
      if (request.method === 'ack') ack = true;
      return response;
    };
    h.verify.mockImplementation(() => (ack ? proof.promise : Promise.resolve(testIdentity)));
    const commit = h.controller.commit();
    await vi.waitFor(() => expect(ack).toBe(true));
    await expect(h.controller.prepareWrite(testPlaintext())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h.controller.read()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h.controller.beginRekey(testPassword)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(h.workers[0].sent.filter(request => request.method === 'write')).toHaveLength(0);
    proof.resolve(testIdentity);
    await commit;
    expect(h.controller.state().canDisplay).toBe(true);
  });

  it('serializes a read through its final identity verification and disclosure', async () => {
    const h = await harness();
    await h.open();
    const proof = deferred<VaultSessionIdentity>();
    let verifyingReply = false;
    h.verify.mockResolvedValueOnce(testIdentity).mockImplementationOnce(() => {
      verifyingReply = true;
      return proof.promise;
    });
    const reading = h.controller.read();
    await vi.waitFor(() => expect(verifyingReply).toBe(true));
    await expect(h.controller.prepareWrite(testPlaintext())).rejects.toBeDefined();
    proof.resolve(testIdentity);
    expect(await reading).toEqual(testPlaintext());
    await h.controller.prepareWrite(testPlaintext());
    expect(h.controller.state()).toMatchObject({ phase: 'pending', canDisplay: false });
  });

  it('keeps cancellation live after the Worker reply while final identity verification is pending', async () => {
    const h = await harness();
    await h.open();
    const proof = deferred<VaultSessionIdentity>();
    let verifyingReply = false;
    h.verify.mockResolvedValueOnce(testIdentity).mockImplementationOnce(() => {
      verifyingReply = true;
      return proof.promise;
    });
    const abort = new AbortController();
    const reading = h.controller.read(abort.signal);
    const rejected = expect(reading).rejects.toBeDefined();
    await vi.waitFor(() => expect(verifyingReply).toBe(true));
    abort.abort();
    expect(h.workers[0].terminated).toBe(true);
    expect(h.controller.state().phase).toBe('locked');
    proof.resolve(testIdentity);
    await rejected;
    expect(h.controller.state().canDisplay).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { VaultWorkerEngine } from './engine';
import { deferred, syntheticCore, testEnvelope, testIdentity, testPassword, testPlaintext, testRecovery } from './test-fixtures';
import type { VaultWorkerMethod, VaultWorkerReply } from './messages';

async function fixture() {
  const core = await syntheticCore();
  const engine = new VaultWorkerEngine(core);
  let id = 0;
  const identity = { ownerId: testIdentity.ownerId, sessionId: testIdentity.sessionId, epoch: testIdentity.epoch };
  const request = (method: VaultWorkerMethod, value: unknown) => engine.handle({ id: ++id, generation: 1, identity, method, value });
  const create = () => request('create', { vaultId: testEnvelope().vaultId, password: testPassword, plaintext: testPlaintext() });
  const open = () => request('unlock', { envelope: testEnvelope(), credential: { kind: 'password', value: testPassword } });
  const confirm = () => request('confirm-custody', { password: testPassword, recoveryCode: testRecovery });
  return { core, engine, request, create, open, confirm, identity };
}
const value = (reply: VaultWorkerReply) => {
  if (!('value' in reply)) throw new Error('synthetic unexpected error');
  return reply.value;
};

describe('closed Worker vault engine', () => {
  it('holds creation pending custody and ACK, and returns detached copies without keys', async () => {
    const h = await fixture();
    expect(value(await h.create())).toEqual({ recoveryCode: testRecovery });
    expect(value(await h.request('custody', null))).toEqual({ recoveryCode: testRecovery });
    const prepared = value(await h.confirm()) as { envelope: ReturnType<typeof testEnvelope>; expectedRevision: string };
    expect(prepared.expectedRevision).toBe('0');
    expect(Object.keys(prepared).sort()).toEqual(['envelope', 'expectedRevision']);
    expect(value(await h.request('ack', { operationId: prepared.envelope.operationId, revision: prepared.envelope.revision }))).toEqual({ mode: 'password' });
    const snapshot = value(await h.request('read', null)) as ReturnType<typeof testPlaintext>;
    snapshot.financialSpace.synthetic = 'mutated external copy';
    expect(value(await h.request('read', null))).toEqual(testPlaintext());
    const candidate = value(await h.request('write', testPlaintext())) as typeof prepared;
    expect(candidate.expectedRevision).toBe('1');
    expect(candidate.envelope.revision).toBe('2');
    expect(JSON.stringify(candidate)).not.toContain('rootKey');
  });

  it.each(['read', 'write'] as const)('refuses %s while custody is incomplete', async method => {
    const h = await fixture();
    await h.create();
    expect(await h.request(method, method === 'read' ? null : testPlaintext())).toMatchObject({ error: 'INVALID_STATE' });
    await expect(h.confirm()).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('refuses an ACK for a different operation and closes the engine', async () => {
    const h = await fixture();
    await h.create();
    await h.confirm();
    expect(await h.request('ack', { operationId: 'wrong', revision: '1' })).toMatchObject({ error: 'INVALID_STATE' });
    await expect(h.request('read', null)).rejects.toBeDefined();
  });

  it.each(['write', 'rotate-password', 'rotate-recovery', 'rekey'] as const)('recovery mode cannot invoke %s', async method => {
    const h = await fixture();
    expect(value(await h.request('unlock', { envelope: testEnvelope(), credential: { kind: 'recovery', value: testRecovery } }))).toEqual({
      mode: 'recovery-readonly',
    });
    expect(await h.request(method, {})).toMatchObject({ error: 'INVALID_STATE' });
  });

  it('does not install state from an asynchronous job completed after close', async () => {
    const h = await fixture();
    const original = h.core.create;
    const delayed = deferred<void>();
    h.core.create = async (...args) => {
      await delayed.promise;
      return original(...args);
    };
    const pending = h.create();
    h.engine.close();
    delayed.resolve();
    expect(await pending).toMatchObject({ error: 'INVALID_STATE' });
    // Reflect private fields solely to assert no delayed key/snapshot retention in the test engine.
    const memory = h.engine as unknown as { draft?: unknown; current?: unknown };
    expect(memory.draft).toBeUndefined();
    expect(memory.current).toBeUndefined();
    await expect(h.request('custody', null)).rejects.toBeDefined();
  });

  it.each(['duplicate', 'generation', 'identity', 'extra-field', 'oversize'] as const)('rejects and closes on %s request', async kind => {
    const h = await fixture();
    await h.request('probe', null);
    const request = { id: 2, generation: 1, identity: h.identity, method: 'read', value: null as unknown };
    if (kind === 'duplicate') request.id = 1;
    if (kind === 'generation') request.generation = 2;
    if (kind === 'identity') request.identity = { ...h.identity, sessionId: 'another-session' };
    if (kind === 'oversize') request.value = 'x'.repeat(2 * 1024 * 1024 + 1);
    const input = kind === 'extra-field' ? { ...request, unexpected: true } : request;
    await expect(h.engine.handle(input)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h.request('probe', null)).rejects.toBeDefined();
  });

  it('preserves NFC core compatibility for transport passwords over 1024 raw UTF8 bytes', async () => {
    const h = await fixture();
    const password = 'e\u0301'.repeat(400);
    let received = '';
    const original = h.core.unlock;
    h.core.unlock = async (envelope, context, credential) => {
      received = credential.value;
      return original(envelope, context, credential);
    };
    expect(new TextEncoder().encode(password)).toHaveLength(1200);
    expect(new TextEncoder().encode(password.normalize('NFC'))).toHaveLength(800);
    expect(value(await h.request('unlock', { envelope: testEnvelope(), credential: { kind: 'password', value: password } }))).toEqual({ mode: 'password' });
    expect(received).toBe(password);
  });

  it('compares password confirmation after NFC before rewrapping', async () => {
    const h = await fixture();
    await h.open();
    const password = 'e\u0301'.repeat(400);
    expect(await h.request('rotate-password', { password: testPassword, newPassword: password, confirmation: password.normalize('NFC') })).toHaveProperty(
      'value',
    );
  });
});

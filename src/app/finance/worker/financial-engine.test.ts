import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vector from '../compatibility/fixtures/vault-vectors.json';
import { assertOpaqueTransition, validateEnvelope, type VaultEnvelope } from '../compatibility/protocol';
import { createVault } from '../crypto/credentials';
import { validatePlaintext } from '../crypto/plaintext';
import { validateFinancialSnapshot } from '../domain/snapshot';
import { addAccount, addEntry, emptyFinancialSnapshot } from '../domain/workspace';
import { updateFinancialOperation, deleteFinancialOperation } from '../domain/operation-edit';
import { serializeEncryptedBackup, parseEncryptedBackup } from '../import/format';
import { financialVaultPolicy } from './financial-policy';
import { VaultWorkerEngine } from './engine';
import type { VaultWorkerMethod } from './messages';

const password = 'SYNTHETIC ONLY destination password 🔐';
const envelope = () => validateEnvelope(structuredClone(vector.envelope));
const backup = () => serializeEncryptedBackup(envelope());
const sourceCredential = { kind: 'password' as const, value: vector.password };
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('isSecureContext', true);
});
afterEach(() => vi.unstubAllGlobals());

function noKeys(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  expect(Object.prototype.toString.call(value)).not.toBe('[object CryptoKey]');
  expect(value instanceof ArrayBuffer || ArrayBuffer.isView(value)).toBe(false);
  Object.values(value).forEach(noKeys);
}
function fixture(ownerId = 'synthetic-financial-destination') {
  const engine = new VaultWorkerEngine(undefined, financialVaultPolicy);
  let id = 0;
  const request = (method: VaultWorkerMethod, value: unknown) =>
    engine.handle({ id: ++id, generation: 1, identity: { ownerId, sessionId: 'synthetic-session', epoch: '1' }, method, value });
  const call = async <T>(method: VaultWorkerMethod, value: unknown): Promise<T> => {
    const reply = await request(method, value);
    noKeys(reply);
    if ('error' in reply) throw new Error('Synthetic Worker rejection: ' + reply.error);
    return reply.value as T;
  };
  const preview = () =>
    call<{ previewId: string; summary: { sourceDomainSchemaVersion: number; targetDomainSchemaVersion: number } }>('import-preview', {
      backup: backup(),
      credential: sourceCredential,
    });
  const importVault = async () => {
    const p = await preview();
    const custody = await call<{ recoveryCode: string }>('import-accept', { previewId: p.previewId, password });
    const prepared = await call<{ envelope: VaultEnvelope; expectedRevision: string }>('confirm-custody', { password, recoveryCode: custody.recoveryCode });
    assertOpaqueTransition(null, { ...prepared, operationId: prepared.envelope.operationId });
    await call('ack', { operationId: prepared.envelope.operationId, revision: prepared.envelope.revision });
    return { prepared, recoveryCode: custody.recoveryCode };
  };
  return { engine, request, call, preview, importVault };
}

describe('financial Worker policy with actual Argon2id and Web Crypto', () => {
  it('encrypts movement corrections and removals through the same guarded snapshot path, preserving unrelated data and recovery read-only', async () => {
    let snapshot = addAccount(emptyFinancialSnapshot(), {
      id: 'edit-account',
      name: 'Cuenta QA',
      type: 'cash',
      currency: 'DOP',
      openingBalanceMinor: 10000,
      openingDate: '2026-01-01',
    });
    for (const id of ['edit-operation', 'keep-operation'])
      snapshot = addEntry(snapshot, {
        id,
        kind: 'expense',
        accountId: 'edit-account',
        amountMinor: 500,
        date: '2026-01-02',
        description: id,
        category: 'other',
        note: '',
      });
    const raw = await createVault({
      ownerId: 'synthetic-financial-destination',
      vaultId: envelope().vaultId,
      password,
      plaintext: validatePlaintext(snapshot),
    });
    const f = fixture();
    await f.call('unlock', { envelope: raw.envelope, credential: { kind: 'password', value: password } });
    const original = snapshot.financialSpace.operations[0];
    const edited = updateFinancialOperation(snapshot, original, { ...original, amountMinor: 1200, description: 'Corregido QA' });
    const write = await f.call<{ envelope: VaultEnvelope; expectedRevision: string }>('write', validatePlaintext(edited));
    expect(write.expectedRevision).toBe('1');
    await f.call('ack', { operationId: write.envelope.operationId, revision: write.envelope.revision });
    expect(validateFinancialSnapshot(await f.call('read', null))).toEqual(edited);
    const removed = deleteFinancialOperation(edited, edited.financialSpace.operations[0], '2026-01-03');
    const second = await f.call<{ envelope: VaultEnvelope; expectedRevision: string }>('write', validatePlaintext(removed));
    expect(second.expectedRevision).toBe('2');
    await f.call('ack', { operationId: second.envelope.operationId, revision: second.envelope.revision });
    expect(validateFinancialSnapshot(await f.call('read', null)).financialSpace.operations).toEqual([snapshot.financialSpace.operations[1]]);
    f.engine.close();
    const recovered = fixture();
    await recovered.call('unlock', { envelope: second.envelope, credential: { kind: 'recovery', value: raw.recoveryCode } });
    expect(await recovered.request('write', validatePlaintext(edited))).toMatchObject({ error: 'INVALID_STATE' });
    recovered.engine.close();
  });
  it('imports only after preview and custody, with a new owner/context and no source key or plaintext in the preview', async () => {
    const f = fixture();
    const preview = await f.preview();
    expect(preview.summary).toMatchObject({
      sourceDomainSchemaVersion: 1,
      targetDomainSchemaVersion: 4,
      requiresUpgrade: true,
      accounts: 1,
      operations: 1,
      plans: 0,
    });
    expect(JSON.stringify(preview)).not.toContain('845239');
    expect(JSON.stringify(preview)).not.toContain('synthetic-debit');
    const custody = await f.call<{ recoveryCode: string }>('import-accept', { previewId: preview.previewId, password });
    expect(Object.keys(custody)).toEqual(['recoveryCode']);
    const prepared = await f.call<{ envelope: VaultEnvelope; expectedRevision: string }>('confirm-custody', { password, recoveryCode: custody.recoveryCode });
    expect(prepared.expectedRevision).toBe('0');
    expect(prepared.envelope.ownerId).toBe('synthetic-financial-destination');
    expect(prepared.envelope.vaultId).not.toBe(vector.envelope.vaultId);
    expect(prepared.envelope).toMatchObject({
      keyEpoch: '1',
      credentialEpoch: '1',
      revision: '1',
      passwordWrap: { slotEpoch: '1' },
      recoveryWrap: { slotEpoch: '1' },
    });
    await f.call('ack', { operationId: prepared.envelope.operationId, revision: '1' });
    const snapshot = validateFinancialSnapshot(await f.call('read', null));
    expect(snapshot.financialSpace.domainSchemaVersion).toBe(4);
    expect(snapshot.financialSpace.accounts[0].id).toBe(vector.plaintext.financialSpace.accounts[0].id);
    expect(snapshot.financialSpace.operations[0].amountMinor).toBe(78213);
    expect(snapshot.financialSpace.plans).toEqual([]);
    const exported = await f.call<string>('backup-export', null);
    expect(parseEncryptedBackup(exported).envelope).toEqual(prepared.envelope);
    expect(JSON.stringify(snapshot)).not.toContain('rootKey');
    f.engine.close();
    const reopened = fixture();
    await reopened.call('unlock', { envelope: prepared.envelope, credential: { kind: 'recovery', value: custody.recoveryCode } });
    expect(validateFinancialSnapshot(await reopened.call('read', null))).toEqual(snapshot);
    reopened.engine.close();
  });

  it.each(['read', 'write', 'backup-export', 'create', 'unlock', 'rekey'] as const)('blocks %s while a source preview is held', async method => {
    const f = fixture();
    await f.preview();
    expect(await f.request(method, null)).toMatchObject({ error: 'INVALID_STATE' });
    await expect(f.preview()).rejects.toBeDefined();
  });

  it('rejects a different preview ID and a replay into another Worker', async () => {
    const first = fixture();
    const old = await first.preview();
    first.engine.close();
    const next = fixture();
    const fresh = await next.preview();
    expect(fresh.previewId).not.toBe(old.previewId);
    expect(await next.request('import-accept', { previewId: old.previewId, password })).toMatchObject({ error: 'INVALID_STATE' });
  });

  it('rejects a cryptographically valid but financially invalid plaintext on unlock and before encrypting new data', async () => {
    const raw = await createVault({
      ownerId: 'synthetic-financial-destination',
      vaultId: envelope().vaultId,
      password,
      plaintext: { schemaVersion: 1, financialSpace: { unsupported: true } },
    });
    const f = fixture();
    expect(await f.request('unlock', { envelope: raw.envelope, credential: { kind: 'password', value: password } })).toMatchObject({
      error: 'INVALID_PLAINTEXT',
    });
    const g = fixture();
    expect(
      await g.request('create', { vaultId: envelope().vaultId, password, plaintext: { schemaVersion: 1, financialSpace: { unsupported: true } } }),
    ).toMatchObject({ error: 'INVALID_PLAINTEXT' });
    const h = fixture();
    await h.importVault();
    expect(await h.request('write', { schemaVersion: 1, financialSpace: { unsupported: true } })).toMatchObject({ error: 'INVALID_PLAINTEXT' });
  });

  it('restores only data from its own context and keeps current wraps, key epoch and credentials', async () => {
    const f = fixture();
    const imported = await f.importVault();
    const oldBackup = await f.call<string>('backup-export', null);
    const changed = await f.call<{ envelope: VaultEnvelope; expectedRevision: string }>('write', validatePlaintext(emptyFinancialSnapshot()));
    await f.call('ack', { operationId: changed.envelope.operationId, revision: changed.envelope.revision });
    const p = await f.call<{ previewId: string }>('restore-preview', { backup: oldBackup, credential: { kind: 'password', value: password } });
    const restored = await f.call<{ envelope: VaultEnvelope; expectedRevision: string }>('restore-accept', { previewId: p.previewId });
    expect(restored.expectedRevision).toBe('2');
    expect(restored.envelope).toMatchObject({
      revision: '3',
      keyEpoch: changed.envelope.keyEpoch,
      credentialEpoch: changed.envelope.credentialEpoch,
      passwordWrap: changed.envelope.passwordWrap,
      recoveryWrap: changed.envelope.recoveryWrap,
    });
    assertOpaqueTransition(changed.envelope, { ...restored, operationId: restored.envelope.operationId });
    await f.call('ack', { operationId: restored.envelope.operationId, revision: '3' });
    expect(validateFinancialSnapshot(await f.call('read', null)).financialSpace.accounts).toHaveLength(1);
    expect(imported.recoveryCode.length).toBeGreaterThan(52);
    f.engine.close();
    const g = fixture();
    await g.importVault();
    expect(await g.request('restore-preview', { backup: oldBackup, credential: { kind: 'password', value: password } })).toMatchObject({
      error: 'AUTH_FAILED',
    });
  });

  it('the generic crypto profile does not offer a financial import or export bypass', async () => {
    const engine = new VaultWorkerEngine();
    expect(
      await engine.handle({
        id: 1,
        generation: 1,
        identity: { ownerId: 'synthetic', sessionId: 'synthetic', epoch: '1' },
        method: 'import-preview',
        value: { backup: backup(), credential: sourceCredential },
      }),
    ).toMatchObject({ error: 'INVALID_STATE' });
  });
});

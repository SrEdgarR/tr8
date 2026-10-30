import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vector from '../compatibility/fixtures/vault-vectors.json';
import { MAX_ENVELOPE_BYTES, assertOpaqueTransition, encodeBase64Url, encodeUtf8, validateEnvelope } from '../compatibility/protocol';
import { createVault, unlockVault } from '../crypto/credentials';
import { confirmVaultCustody } from '../crypto/custody';
import { importRootKey } from '../crypto/native-crypto';
import { decryptSnapshot } from '../crypto/payload';
import { validatePlaintext } from '../crypto/plaintext';
import { rekeyVault } from '../crypto/rotations';
import { encodeRecoverySecret, formatRecoverySecret } from '../crypto/recovery';
import { addAccount, emptyFinancialSnapshot, upgradeSnapshot } from '../domain/workspace';
import { addPairedOperation } from '../domain/connected-operations';
import { openEncryptedBackup, prepareBackupImport, prepareBackupRestore, previewOpenedBackup, type ImportDestination } from './backup';
import { parseEncryptedBackup, parseEncryptedBackupBytes, serializeEncryptedBackup } from './format';
import { validateImportPreview } from './preview';

const source = () => validateEnvelope(structuredClone(vector.envelope));
const backup = () => serializeEncryptedBackup(source());
const oldPassword = vector.password;
const newPassword = 'SYNTHETIC ONLY imported private password 123';
const sourceContext = { ownerId: vector.envelope.ownerId, vaultId: vector.envelope.vaultId };
const recoveryCode = formatRecoverySecret(encodeRecoverySecret(Uint8Array.from(vector.recoveryHex.match(/../g)!, value => Number.parseInt(value, 16))));
const destination = (): ImportDestination => ({
  ownerId: '815ad18a-6d0e-402b-a3d8-dff0233fe67c',
  vaultId: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  password: newPassword,
  currentEnvelope: null,
});

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('isSecureContext', true);
});
afterEach(() => vi.unstubAllGlobals());

describe('opaque backup file boundary', () => {
  it('keeps the exact Pulso v1 wrapper and canonicalizes pretty ciphertext without opening it', () => {
    const json = backup();
    expect(Object.keys(JSON.parse(json))).toEqual(['kind', 'exportFormatVersion', 'envelope']);
    expect(parseEncryptedBackup(json)).toEqual({ kind: 'pulso-encrypted-backup', exportFormatVersion: 1, envelope: source() });
    expect(parseEncryptedBackup(JSON.stringify(JSON.parse(json), null, 2))).toEqual(parseEncryptedBackup(json));
    expect(parseEncryptedBackupBytes(encodeUtf8(json))).toEqual(parseEncryptedBackup(json));
    expect(json).not.toContain(vector.password);
    expect(json).not.toContain(vector.rootHex);
    expect(json).not.toContain(vector.plaintext.financialSpace.accounts[0].name);
  });

  it('rejects duplicate fields, wrong kind, unknown version and unexpected or prototype fields', () => {
    const base = JSON.parse(backup());
    const candidates = [null, [], {}, { ...base, kind: 'tr8-backup' }, { ...base, extra: true }];
    for (const candidate of candidates) expect(() => parseEncryptedBackup(JSON.stringify(candidate))).toThrow();
    expect(() => parseEncryptedBackup('{"kind":"pulso-encrypted-backup",' + backup().slice(1))).toThrow();
    expect(() => parseEncryptedBackup(backup().replace('"exportFormatVersion":1', '"exportFormatVersion":2'))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_FORMAT' }),
    );
    expect(() => parseEncryptedBackup(backup().replace('{', '{"__proto__":{},'))).toThrow();
  });

  it('enforces the raw UTF-8 file limit and fatal UTF-8 before parsing', () => {
    expect(() => parseEncryptedBackup(' '.repeat(MAX_ENVELOPE_BYTES) + backup())).toThrow(expect.objectContaining({ code: 'SIZE_LIMIT' }));
    expect(() => parseEncryptedBackupBytes(new Uint8Array(MAX_ENVELOPE_BYTES + 1))).toThrow(expect.objectContaining({ code: 'SIZE_LIMIT' }));
    expect(() => parseEncryptedBackupBytes(new Uint8Array([0xc3, 0x28]))).toThrow();
    expect(() => parseEncryptedBackup('\ufeff' + backup())).toThrow();
    expect(() => serializeEncryptedBackup({ ...source(), revision: '01' })).toThrow();
  });
});

describe('private backup preview', () => {
  it('opens using original authenticated context without retaining a source key and previews explicit legacy upgrade', async () => {
    const original = backup();
    const opened = await openEncryptedBackup(original, { kind: 'password', value: oldPassword });
    expect(Object.keys(opened).sort()).toEqual(['envelope', 'mode', 'plaintext']);
    expect(opened.envelope).toEqual(source());
    expect(opened.plaintext).toEqual(vector.plaintext);
    const preview = previewOpenedBackup(opened);
    expect(preview).toMatchObject({
      sourceDomainSchemaVersion: 1,
      targetDomainSchemaVersion: 4,
      requiresUpgrade: true,
      accounts: 1,
      operations: 1,
      plans: 0,
      currencies: ['DOP'],
    });
    expect(preview.sourceCurrencyCatalogVersion).toBe('pulso-p3-fixture-currencies-v1');
    expect(preview.targetCurrencyCatalogVersion).toBe('currency-catalog-v1');
    expect(JSON.stringify(preview)).not.toContain(vector.plaintext.financialSpace.accounts[0].name);
    expect(JSON.stringify(preview)).not.toContain('845239');
    expect(opened.plaintext.financialSpace.domainSchemaVersion).toBe(1);
    expect(backup()).toBe(original);
    const recovered = await openEncryptedBackup(original, { kind: 'recovery', value: recoveryCode });
    expect(recovered.mode).toBe('recovery-readonly');
    expect(recovered.plaintext).toEqual(opened.plaintext);
  }, 20_000);

  it('rejects bad credentials, ciphertext tampering and relabelled owner or vault', async () => {
    await expect(openEncryptedBackup(backup(), { kind: 'password', value: oldPassword + 'wrong' })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(openEncryptedBackup(backup(), { kind: 'recovery', value: 'not-a-recovery-code' })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    const changed = source();
    changed.payload.ciphertext = (changed.payload.ciphertext[0] === 'A' ? 'B' : 'A') + changed.payload.ciphertext.slice(1);
    await expect(openEncryptedBackup(serializeEncryptedBackup(changed), { kind: 'password', value: oldPassword })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    for (const envelope of [
      { ...source(), ownerId: 'new-owner-with-same-email' },
      { ...source(), vaultId: destination().vaultId },
    ])
      await expect(openEncryptedBackup(serializeEncryptedBackup(envelope), { kind: 'password', value: oldPassword })).rejects.toMatchObject({
        code: 'AUTH_FAILED',
      });
  }, 20_000);

  it('rejects a correctly encrypted generic payload that is not a legitimate financial domain', async () => {
    const invalid = await createVault({ ...sourceContext, password: oldPassword, plaintext: { schemaVersion: 1, financialSpace: { synthetic: true } } });
    await expect(openEncryptedBackup(serializeEncryptedBackup(invalid.envelope), { kind: 'password', value: oldPassword })).rejects.toMatchObject({
      code: 'INVALID_PLAINTEXT',
    });
  }, 20_000);

  it('validates a closed bounded preview reply without getters or domain data leakage', async () => {
    const preview = previewOpenedBackup(await openEncryptedBackup(backup(), { kind: 'recovery', value: recoveryCode }));
    expect(validateImportPreview(preview)).toEqual(preview);
    for (const candidate of [
      { ...preview, plaintext: vector.plaintext },
      { ...preview, accounts: -0 },
      { ...preview, operations: 10_001 },
      { ...preview, sourceDomainSchemaVersion: 6 },
      { ...preview, sourceDomainSchemaVersion: 5, targetDomainSchemaVersion: 4 },
      { ...preview, targetDomainSchemaVersion: 5 },
      { ...preview, requiresUpgrade: false },
      { ...preview, currencies: ['DOP', 'DOP'] },
      { ...preview, currencies: ['dop'] },
      { ...preview, currencies: ['UNKNOWN'] },
      { ...preview, currencies: new Array(1) },
      { ...preview, plans: 1.5 },
      { ...preview, plans: 10_001 },
      { ...preview, sourceCurrencyCatalogVersion: 'unrecognized-catalog' },
      { ...preview, targetCurrencyCatalogVersion: 'unrecognized-catalog' },
    ])
      expect(() => validateImportPreview(candidate)).toThrow();
    const getter = vi.fn(() => 1);
    const candidate = Object.defineProperty({ ...preview }, 'accounts', { get: getter });
    expect(() => validateImportPreview(candidate)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(validateImportPreview({ ...preview, operations: 10_000, plans: 10_000 })).toMatchObject({ operations: 10_000, plans: 10_000 });
    const currencies = Object.defineProperty([], '0', { get: getter, enumerable: true });
    expect(() => validateImportPreview({ ...preview, currencies })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('explicit import acceptance inside the Worker', () => {
  it('preserves a version 5 cross-currency card payment through encrypted export, preview and import without downgrading', async () => {
    let snapshot = emptyFinancialSnapshot();
    snapshot = addAccount(snapshot, {
      id: 'dop-savings',
      name: 'Ahorro de prueba',
      type: 'debit',
      currency: 'DOP',
      openingBalanceMinor: 1000000,
      openingDate: '2026-10-01',
    });
    snapshot = addAccount(snapshot, {
      id: 'usd-card',
      name: 'Tarjeta de prueba',
      type: 'credit',
      currency: 'USD',
      openingBalanceMinor: 20000,
      creditLimitMinor: 100000,
      openingDate: '2026-10-01',
    });
    snapshot = addPairedOperation(snapshot, {
      id: 'fx-card-payment',
      kind: 'card-payment',
      fromAccountId: 'dop-savings',
      toAccountId: 'usd-card',
      amountMinor: 600000,
      destinationCurrency: 'USD',
      destinationAmountMinor: 10000,
      date: '2026-10-30',
      description: 'Pago entre monedas de prueba',
      note: '',
    });
    expect(snapshot.financialSpace.domainSchemaVersion).toBe(5);
    const old = await createVault({ ...sourceContext, password: oldPassword, plaintext: validatePlaintext(snapshot) });
    const opened = await openEncryptedBackup(serializeEncryptedBackup(old.envelope), { kind: 'password', value: oldPassword });
    const preview = previewOpenedBackup(opened);
    expect(preview).toMatchObject({ sourceDomainSchemaVersion: 5, targetDomainSchemaVersion: 5, requiresUpgrade: false, accounts: 2, operations: 1 });
    expect(validateImportPreview(preview)).toEqual(preview);
    const target = destination();
    const imported = await prepareBackupImport(opened, target);
    const reopened = await unlockVault(imported.envelope, target, { kind: 'password', value: newPassword });
    expect(reopened.plaintext).toEqual(validatePlaintext(snapshot));
    expect(reopened.plaintext.financialSpace.domainSchemaVersion).toBe(5);
    expect(opened.plaintext).toEqual(validatePlaintext(snapshot));
  }, 20_000);

  it('imports a current financial backup with refund and pending plan references unchanged', async () => {
    const snapshot = upgradeSnapshot(vector.plaintext);
    snapshot.financialSpace.operations.push({
      id: 'synthetic-refund',
      kind: 'refund',
      originalExpenseId: 'synthetic-expense',
      destinationAccountId: 'synthetic-debit',
      currency: 'DOP',
      amountMinor: 100,
      date: '2026-10-07',
      description: 'Synthetic refund',
      note: '',
    });
    snapshot.financialSpace.plans = [
      {
        id: 'synthetic-plan',
        status: 'pending',
        operation: {
          id: 'synthetic-planned-expense',
          kind: 'expense',
          accountId: 'synthetic-debit',
          currency: 'DOP',
          amountMinor: 37,
          date: '2026-11-01',
          description: 'Synthetic planned expense',
          note: '',
          category: 'other',
        },
      },
    ];
    const target = destination();
    const old = await createVault({
      ownerId: 'legacy-source-owner',
      vaultId: destination().vaultId,
      password: oldPassword,
      plaintext: validatePlaintext(snapshot),
    });
    const opened = await openEncryptedBackup(serializeEncryptedBackup(old.envelope), { kind: 'password', value: oldPassword });
    expect(previewOpenedBackup(opened)).toMatchObject({
      sourceDomainSchemaVersion: 4,
      targetDomainSchemaVersion: 4,
      requiresUpgrade: false,
      accounts: 1,
      operations: 2,
      plans: 1,
    });
    const imported = await prepareBackupImport(opened, target);
    const reopened = await unlockVault(imported.envelope, target, { kind: 'password', value: newPassword });
    expect(reopened.plaintext).toEqual(validatePlaintext(snapshot));
    expect(imported.envelope.ownerId).not.toBe(old.envelope.ownerId);
    expect(imported.envelope.vaultId).not.toBe(old.envelope.vaultId);
  }, 20_000);

  it('creates fresh context, VDK, private means and initial epochs while retaining financial IDs only', async () => {
    const original = backup();
    const opened = await openEncryptedBackup(original, { kind: 'password', value: oldPassword });
    const target = destination();
    const created = await prepareBackupImport(opened, target);
    expect(created.envelope.ownerId).toBe(target.ownerId);
    expect(created.envelope.vaultId).toBe(target.vaultId);
    expect(created.envelope.vaultId).not.toBe(opened.envelope.vaultId);
    expect(created.envelope).toMatchObject({
      keyEpoch: '1',
      credentialEpoch: '1',
      revision: '1',
      passwordWrap: { slotEpoch: '1' },
      recoveryWrap: { slotEpoch: '1' },
    });
    for (const field of ['salt', 'nonce', 'wrappedKey'] as const) {
      expect(created.envelope.passwordWrap[field]).not.toBe(source().passwordWrap[field]);
      expect(created.envelope.recoveryWrap[field]).not.toBe(source().recoveryWrap[field]);
    }
    expect(created.rootKey.extractable).toBe(false);
    expect(created.plaintext).toEqual(validatePlaintext(upgradeSnapshot(vector.plaintext)));
    expect(created.plaintext.financialSpace.domainSchemaVersion).toBe(4);
    expect(created.plaintext.financialSpace.accounts).toEqual(vector.plaintext.financialSpace.accounts);
    await confirmVaultCustody(created.envelope, target, newPassword, created.recoveryCode);
    const reopened = await unlockVault(created.envelope, target, { kind: 'password', value: newPassword });
    expect(reopened.plaintext).toEqual(created.plaintext);
    expect((await unlockVault(created.envelope, target, { kind: 'recovery', value: created.recoveryCode })).plaintext).toEqual(created.plaintext);
    await expect(unlockVault(created.envelope, target, { kind: 'password', value: oldPassword })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(unlockVault(created.envelope, target, { kind: 'recovery', value: recoveryCode })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    const oldRoot = await importRootKey(Uint8Array.from(vector.rootHex.match(/../g)!, value => Number.parseInt(value, 16)));
    await expect(decryptSnapshot(oldRoot, created.envelope, target)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(decryptSnapshot(created.rootKey, source(), sourceContext)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    assertOpaqueTransition(null, { expectedRevision: '0', operationId: created.envelope.operationId, envelope: created.envelope });
    expect(backup()).toBe(original);
    expect(opened.plaintext).toEqual(vector.plaintext);
  }, 20_000);

  it('requires an explicitly empty local destination and disallows reused context or boolean authorization fields', async () => {
    const opened = await openEncryptedBackup(backup(), { kind: 'recovery', value: recoveryCode });
    const target = destination();
    for (const candidate of [
      { ...target, currentEnvelope: source(), password: 'short' },
      { ...target, currentEnvelope: undefined },
      { ...target, vaultId: source().vaultId },
    ])
      await expect(prepareBackupImport(opened, candidate as unknown as ImportDestination)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(prepareBackupImport(opened, { ...target, identityReauthenticated: true } as unknown as ImportDestination)).rejects.toMatchObject({
      code: 'INVALID_FORMAT',
    });
  });

  it('revalidates the private candidate before preparing its explicit upgrade', async () => {
    const opened = await openEncryptedBackup(backup(), { kind: 'recovery', value: recoveryCode });
    (opened.plaintext.financialSpace.accounts[0] as { currency: string }).currency = 'UNKNOWN';
    await expect(prepareBackupImport(opened, destination())).rejects.toMatchObject({ code: 'INVALID_PLAINTEXT' });
  });
});

describe('same-context data restore', () => {
  it('preserves live root, wraps and epochs and advances revision instead of reinstalling source credentials', async () => {
    const opened = await openEncryptedBackup(backup(), { kind: 'recovery', value: recoveryCode });
    const originalCurrent = await createVault({ ...sourceContext, password: newPassword, plaintext: validatePlaintext(upgradeSnapshot(vector.plaintext)) });
    const current = await rekeyVault(originalCurrent.rootKey, originalCurrent.envelope, sourceContext, newPassword);
    const before = structuredClone(current.envelope);
    const restored = await prepareBackupRestore(opened, current.rootKey, current.envelope, sourceContext);
    expect(restored.envelope).toMatchObject({
      keyEpoch: before.keyEpoch,
      credentialEpoch: before.credentialEpoch,
      passwordWrap: before.passwordWrap,
      recoveryWrap: before.recoveryWrap,
    });
    expect(restored.envelope.revision).toBe(String(BigInt(before.revision) + 1n));
    expect(restored.envelope.operationId).not.toBe(before.operationId);
    expect(restored.envelope.payload.nonce).not.toBe(before.payload.nonce);
    expect(current.envelope).toEqual(before);
    expect((await unlockVault(restored.envelope, sourceContext, { kind: 'password', value: newPassword })).plaintext).toEqual(restored.plaintext);
    await expect(unlockVault(restored.envelope, sourceContext, { kind: 'recovery', value: recoveryCode })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    assertOpaqueTransition(before, { expectedRevision: before.revision, operationId: restored.envelope.operationId, envelope: restored.envelope });
  }, 20_000);

  it('rejects foreign context or a key that does not open the current live envelope', async () => {
    const opened = await openEncryptedBackup(backup(), { kind: 'recovery', value: recoveryCode });
    const current = await createVault({ ...sourceContext, password: newPassword, plaintext: validatePlaintext(upgradeSnapshot(vector.plaintext)) });
    const foreign = { ...sourceContext, ownerId: destination().ownerId };
    await expect(prepareBackupRestore(opened, current.rootKey, current.envelope, foreign)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    const other = await createVault({ ...destination(), plaintext: validatePlaintext(upgradeSnapshot(vector.plaintext)) });
    await expect(prepareBackupRestore(opened, other.rootKey, current.envelope, sourceContext)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  }, 20_000);
});

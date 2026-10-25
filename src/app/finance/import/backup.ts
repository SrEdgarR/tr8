import {
  FORMAT_VERSION,
  SUITE_ID,
  assertEnvelopeContext,
  requireClosedRecord,
  validateEnvelope,
  validateKeyContext,
  vaultError,
  type VaultContext,
  type VaultEnvelope,
} from '../compatibility/protocol';
import { createVault, unlockVault, type CreatedVault, type PrivateCredential } from '../crypto/credentials';
import { decryptSnapshot, encryptSnapshot } from '../crypto/payload';
import { validatePlaintext } from '../crypto/plaintext';
import { validateFinancialPlaintext, type FinancialPlaintext } from '../domain/snapshot';
import { upgradeSnapshot } from '../domain/workspace';
import { parseEncryptedBackup } from './format';
import { validateImportPreview, type ImportPreview } from './preview';

function acceptedSnapshot(candidate: FinancialPlaintext) {
  try {
    return upgradeSnapshot(validateFinancialPlaintext(candidate));
  } catch {
    throw vaultError('INVALID_PLAINTEXT');
  }
}

export interface OpenedFinancialBackup {
  plaintext: FinancialPlaintext;
  mode: 'password' | 'recovery-readonly';
  envelope: VaultEnvelope;
}
export interface ImportDestination extends VaultContext {
  password: string;
  currentEnvelope: null;
}

/**
 * Worker-only offline opening. No Auth, email matching, storage or network.
 * The source key is not returned or retained by the import session.
 */
export async function openEncryptedBackup(json: string, credential: PrivateCredential): Promise<OpenedFinancialBackup> {
  const { envelope } = parseEncryptedBackup(json);
  const { plaintext, mode } = await unlockVault(envelope, envelope, credential);
  return { plaintext: validateFinancialPlaintext(plaintext), mode, envelope };
}

/** Preview a locally prepared upgrade; the source snapshot and file remain unchanged. */
export function previewOpenedBackup(opened: OpenedFinancialBackup): ImportPreview {
  const source = validateFinancialPlaintext(opened.plaintext).financialSpace;
  const target = acceptedSnapshot(opened.plaintext).financialSpace;
  return validateImportPreview({
    sourceDomainSchemaVersion: source.domainSchemaVersion,
    targetDomainSchemaVersion: target.domainSchemaVersion,
    sourceCurrencyCatalogVersion: source.currencyCatalogVersion,
    targetCurrencyCatalogVersion: target.currencyCatalogVersion,
    requiresUpgrade: source.domainSchemaVersion !== target.domainSchemaVersion || source.currencyCatalogVersion !== target.currencyCatalogVersion,
    accounts: target.accounts.length,
    operations: target.operations.length,
    plans: target.plans?.length ?? 0,
    currencies: [...new Set(target.accounts.map(account => account.currency))].sort(),
  });
}

/**
 * Worker-only acceptance primitive, after the user selects the preview ID.
 * currentEnvelope:null is a local precondition, NOT proof of Auth or emptiness:
 * the controller must read the trusted head, reauthenticate as required, confirm
 * full custody, then save with expectedRevision=0 and wait for the durable ACK.
 * Never accept an OpenedFinancialBackup object supplied by the main thread.
 */
export async function prepareBackupImport(opened: OpenedFinancialBackup, destination: ImportDestination): Promise<CreatedVault> {
  const target = requireClosedRecord(destination, ['ownerId', 'vaultId', 'password', 'currentEnvelope']);
  if (target.currentEnvelope !== null || typeof target.password !== 'string') throw vaultError('INVALID_STATE');
  if (typeof target.ownerId !== 'string' || typeof target.vaultId !== 'string') throw vaultError('INVALID_FORMAT');
  const context = { ownerId: target.ownerId, vaultId: target.vaultId };
  validateKeyContext({ ...context, formatVersion: FORMAT_VERSION, suiteId: SUITE_ID, keyEpoch: '1' });
  const source = validateEnvelope(opened.envelope);
  if (target.vaultId === source.vaultId) throw vaultError('INVALID_STATE');
  // Calling this acceptance primitive explicitly selects the previewed upgrade.
  const plaintext = validatePlaintext(acceptedSnapshot(opened.plaintext));
  return createVault({ ownerId: target.ownerId, vaultId: target.vaultId, password: target.password, plaintext });
}

/**
 * Worker-only same-context data restore, after explicit preview selection.
 * Live root, wraps and epochs stay authoritative; the backend still owns CAS.
 */
export async function prepareBackupRestore(opened: OpenedFinancialBackup, currentRoot: CryptoKey, input: VaultEnvelope, context: VaultContext) {
  const current = validateEnvelope(input);
  assertEnvelopeContext(current, context);
  assertEnvelopeContext(validateEnvelope(opened.envelope), context);
  validateFinancialPlaintext(await decryptSnapshot(currentRoot, current, context));
  const plaintext = validatePlaintext(acceptedSnapshot(opened.plaintext));
  return { plaintext, envelope: await encryptSnapshot(currentRoot, current, plaintext) };
}

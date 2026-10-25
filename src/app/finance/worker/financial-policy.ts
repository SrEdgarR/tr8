import { validatePlaintext } from '../crypto/plaintext';
import { validateFinancialSnapshot } from '../domain/snapshot';
import { openEncryptedBackup, prepareBackupImport, prepareBackupRestore, previewOpenedBackup } from '../import/backup';
import { serializeEncryptedBackup } from '../import/format';
import type { VaultEnginePolicy } from './engine';

/** Installed by the financial Worker; the generic crypto harness is not a domain validator. */
export const financialVaultPolicy: VaultEnginePolicy = {
  validate: value => validatePlaintext(validateFinancialSnapshot(value)),
  backups: {
    open: openEncryptedBackup,
    preview: previewOpenedBackup,
    create: prepareBackupImport,
    restore: prepareBackupRestore,
    serialize: serializeEncryptedBackup,
  },
};

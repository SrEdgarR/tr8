import {
  MAX_ENVELOPE_BYTES,
  decodeUtf8,
  encodeUtf8,
  parseStrictJson,
  requireClosedRecord,
  validateEnvelope,
  vaultError,
  type VaultEnvelope,
} from '../compatibility/protocol';

export interface EncryptedBackup {
  kind: 'pulso-encrypted-backup';
  exportFormatVersion: 1;
  envelope: VaultEnvelope;
}

/** Opaque format only: safe to use before sending a canonical backup to a Worker. */
export function serializeEncryptedBackup(input: VaultEnvelope): string {
  const json = JSON.stringify({
    kind: 'pulso-encrypted-backup',
    exportFormatVersion: 1,
    envelope: validateEnvelope(input),
  } satisfies EncryptedBackup);
  if (encodeUtf8(json).byteLength > MAX_ENVELOPE_BYTES) throw vaultError('SIZE_LIMIT');
  return json;
}

export function parseEncryptedBackup(json: string): EncryptedBackup {
  const record = requireClosedRecord(parseStrictJson(json, { maxBytes: MAX_ENVELOPE_BYTES }), ['kind', 'exportFormatVersion', 'envelope']);
  if (record.kind !== 'pulso-encrypted-backup') throw vaultError('INVALID_FORMAT');
  if (record.exportFormatVersion !== 1) throw vaultError('UNSUPPORTED_FORMAT');
  return { kind: 'pulso-encrypted-backup', exportFormatVersion: 1, envelope: validateEnvelope(record.envelope) };
}

/** File bytes must be bounded and decoded as fatal UTF-8, never replacement text. */
export function parseEncryptedBackupBytes(bytes: Uint8Array): EncryptedBackup {
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) throw vaultError('SIZE_LIMIT');
  return parseEncryptedBackup(decodeUtf8(bytes));
}

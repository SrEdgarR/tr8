import { payloadAad, payloadKeyInfo } from '../compatibility/aad';
import { decodeBase64Url, encodeBase64Url } from '../compatibility/protocol';
import {
  assertEnvelopeContext,
  incrementEpoch,
  validateEnvelope,
  validateEpoch,
  validateKeyContext,
  validatePasswordWrap,
  validateRecoveryWrap,
} from '../compatibility/protocol';
import { vaultError } from '../compatibility/protocol';
import { aesDecrypt, aesEncrypt, deriveAesKey, randomBytes, wipe } from './native-crypto';
import { parsePlaintext, serializePlaintext } from './plaintext';
import type { VaultContext, VaultEnvelope, VaultPlaintext } from './types';

/** Each call constructs a new snapshot. A network retry must retain its exact result. */
export async function encryptSnapshot(rootKey: CryptoKey, previous: VaultEnvelope, plaintext: VaultPlaintext, revision?: string): Promise<VaultEnvelope> {
  const base = previous.payload.ciphertext === '' ? structuredClone(previous) : validateEnvelope(previous);
  validateKeyContext(base);
  validateEpoch(base.credentialEpoch);
  validateEpoch(base.revision);
  validatePasswordWrap(base.passwordWrap);
  validateRecoveryWrap(base.recoveryWrap);
  if (base.payloadSchemaVersion !== 1) throw vaultError('UNSUPPORTED_FORMAT');
  const nextRevision = base.payload.ciphertext === '' ? base.revision : incrementEpoch(base.revision);
  if (revision !== undefined && revision !== nextRevision) throw vaultError('STALE_REVISION');
  const bytes = serializePlaintext(plaintext);
  try {
    const envelope: VaultEnvelope = {
      ...base,
      revision: nextRevision,
      operationId: encodeBase64Url(randomBytes(16)),
      payload: {
        keySalt: encodeBase64Url(randomBytes(32)),
        nonce: encodeBase64Url(randomBytes(12)),
        ciphertext: '',
      },
    };
    const key = await deriveAesKey(rootKey, decodeBase64Url(envelope.payload.keySalt, 32), payloadKeyInfo(envelope));
    const ciphertext = await aesEncrypt(key, bytes, decodeBase64Url(envelope.payload.nonce, 12), payloadAad(envelope));
    envelope.payload.ciphertext = encodeBase64Url(ciphertext);
    return validateEnvelope(envelope);
  } finally {
    wipe(bytes);
  }
}

export async function decryptSnapshot(rootKey: CryptoKey, input: VaultEnvelope, context: VaultContext, onDecryptStart?: () => void): Promise<VaultPlaintext> {
  const envelope = validateEnvelope(input);
  assertEnvelopeContext(envelope, context);
  const key = await deriveAesKey(rootKey, decodeBase64Url(envelope.payload.keySalt, 32), payloadKeyInfo(envelope));
  onDecryptStart?.();
  const plaintext = await aesDecrypt(key, decodeBase64Url(envelope.payload.ciphertext), decodeBase64Url(envelope.payload.nonce, 12), payloadAad(envelope));
  try {
    return parsePlaintext(plaintext);
  } finally {
    wipe(plaintext);
  }
}

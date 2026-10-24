import { encodeUtf8, validateKeyContext, type KeyContext, type PasswordWrap, type RecoveryWrap, type VaultEnvelope } from './protocol';

function contextValues(header: KeyContext): [number, string, string, string, string] {
  validateKeyContext(header);
  return [header.formatVersion, header.suiteId, header.vaultId, header.ownerId, header.keyEpoch];
}

function passwordTuple(wrap: Omit<PasswordWrap, 'wrappedKey'>, wrappedKey?: string): unknown[] {
  const values: unknown[] = [
    wrap.wrapVersion,
    wrap.slotEpoch,
    wrap.kdfId,
    wrap.argonVersion,
    wrap.profileId,
    wrap.memoryKiB,
    wrap.passes,
    wrap.parallelism,
    wrap.outputBytes,
    wrap.salt,
    wrap.nonce,
  ];
  if (wrappedKey !== undefined) values.push(wrappedKey);
  return values;
}

function recoveryTuple(wrap: Omit<RecoveryWrap, 'wrappedKey'>, wrappedKey?: string): unknown[] {
  const values: unknown[] = [wrap.wrapVersion, wrap.slotEpoch, wrap.schemeId, wrap.salt, wrap.nonce];
  if (wrappedKey !== undefined) values.push(wrappedKey);
  return values;
}

function encode(values: unknown[]): Uint8Array<ArrayBuffer> {
  return encodeUtf8(JSON.stringify(values));
}

export function passwordWrapAad(header: KeyContext, wrap: Omit<PasswordWrap, 'wrappedKey'>): Uint8Array<ArrayBuffer> {
  return encode(['pulso/password-wrap', ...contextValues(header), passwordTuple(wrap)]);
}

export function recoveryWrapAad(header: KeyContext, wrap: Omit<RecoveryWrap, 'wrappedKey'>): Uint8Array<ArrayBuffer> {
  return encode(['pulso/recovery-wrap', ...contextValues(header), recoveryTuple(wrap)]);
}

export function payloadAad(envelope: VaultEnvelope): Uint8Array<ArrayBuffer> {
  return encode([
    'pulso/payload',
    ...contextValues(envelope),
    envelope.credentialEpoch,
    envelope.revision,
    envelope.operationId,
    envelope.payloadSchemaVersion,
    passwordTuple(envelope.passwordWrap, envelope.passwordWrap.wrappedKey),
    recoveryTuple(envelope.recoveryWrap, envelope.recoveryWrap.wrappedKey),
    envelope.payload.keySalt,
    envelope.payload.nonce,
  ]);
}

export function payloadKeyInfo(header: KeyContext): Uint8Array<ArrayBuffer> {
  return encode(['pulso/payload-key', ...contextValues(header)]);
}

export function recoveryKeyInfo(header: KeyContext, wrap: Omit<RecoveryWrap, 'wrappedKey'>): Uint8Array<ArrayBuffer> {
  return encode(['pulso/recovery-key', ...contextValues(header), wrap.wrapVersion, wrap.slotEpoch]);
}

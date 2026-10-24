import { passwordWrapAad, recoveryKeyInfo, recoveryWrapAad } from '../compatibility/aad';
import { derivePasswordKey } from './argon2';
import { FORMAT_VERSION, PASSWORD_PROFILE_ID, SUITE_ID } from '../compatibility/protocol';
import { decodeBase64Url, encodeBase64Url } from '../compatibility/protocol';
import { assertEnvelopeContext, incrementEpoch, validateEnvelope, validateEpoch, validateKeyContext } from '../compatibility/protocol';
import { vaultError } from '../compatibility/protocol';
import { aesDecrypt, aesEncrypt, deriveAesKey, importAesKey, importRootKey, randomBytes, wipe } from './native-crypto';
import { normalizePrivatePassword } from './password';
import { validatePlaintext } from './plaintext';
import { decryptSnapshot, encryptSnapshot } from './payload';
import { decodeRecoverySecret, encodeRecoverySecret, formatRecoverySecret } from './recovery';
import type { EnvelopeHeader, PasswordWrap, RecoveryWrap, VaultContext, VaultEnvelope, VaultPlaintext } from './types';

export type PrivateCredential = { kind: 'password'; value: string } | { kind: 'recovery'; value: string };
export type OpenVault = { rootKey: CryptoKey; plaintext: VaultPlaintext; mode: 'password' | 'recovery-readonly' };
export type CreatedVault = OpenVault & {
  envelope: VaultEnvelope;
  recoveryCode: string;
};

async function passwordKey(password: string, salt: string, onKdfStart?: () => void): Promise<CryptoKey> {
  const passwordBytes = normalizePrivatePassword(password);
  let raw: Uint8Array | undefined;
  try {
    raw = await derivePasswordKey(passwordBytes, decodeBase64Url(salt, 16), undefined, onKdfStart);
    return await importAesKey(raw);
  } finally {
    wipe(passwordBytes);
    if (raw) wipe(raw);
  }
}

async function recoveryKey(code: string, header: EnvelopeHeader, wrap: RecoveryWrap): Promise<CryptoKey> {
  const secret = decodeRecoverySecret(code);
  try {
    return await deriveAesKey(await importRootKey(secret), decodeBase64Url(wrap.salt, 32), recoveryKeyInfo(header, wrap));
  } finally {
    wipe(secret);
  }
}

async function wrapPassword(rawRoot: Uint8Array, header: EnvelopeHeader, password: string, slotEpoch = '1'): Promise<PasswordWrap> {
  const wrap: PasswordWrap = {
    wrapVersion: 1,
    slotEpoch,
    kdfId: 'argon2id',
    argonVersion: 19,
    profileId: PASSWORD_PROFILE_ID,
    memoryKiB: 65536,
    passes: 3,
    parallelism: 1,
    outputBytes: 32,
    salt: encodeBase64Url(randomBytes(16)),
    nonce: encodeBase64Url(randomBytes(12)),
    wrappedKey: '',
  };
  const key = await passwordKey(password, wrap.salt);
  wrap.wrappedKey = encodeBase64Url(await aesEncrypt(key, rawRoot, decodeBase64Url(wrap.nonce, 12), passwordWrapAad(header, wrap)));
  return wrap;
}

async function wrapRecovery(rawRoot: Uint8Array, header: EnvelopeHeader, slotEpoch = '1'): Promise<{ wrap: RecoveryWrap; recoveryCode: string }> {
  const secret = randomBytes(32);
  try {
    const recoveryCode = formatRecoverySecret(encodeRecoverySecret(secret));
    const wrap: RecoveryWrap = {
      wrapVersion: 1,
      slotEpoch,
      schemeId: 'HKDF-SHA-256',
      salt: encodeBase64Url(randomBytes(32)),
      nonce: encodeBase64Url(randomBytes(12)),
      wrappedKey: '',
    };
    const key = await recoveryKey(recoveryCode, header, wrap);
    wrap.wrappedKey = encodeBase64Url(await aesEncrypt(key, rawRoot, decodeBase64Url(wrap.nonce, 12), recoveryWrapAad(header, wrap)));
    return { wrap, recoveryCode };
  } finally {
    wipe(secret);
  }
}

async function unwrapRoot(envelope: VaultEnvelope, credential: PrivateCredential, onKdfStart?: () => void): Promise<Uint8Array<ArrayBuffer>> {
  try {
    if (!credential || (credential.kind !== 'password' && credential.kind !== 'recovery') || typeof credential.value !== 'string')
      throw vaultError('AUTH_FAILED');
    const wrap = credential.kind === 'password' ? envelope.passwordWrap : envelope.recoveryWrap;
    const key =
      credential.kind === 'password'
        ? await passwordKey(credential.value, wrap.salt, onKdfStart)
        : await recoveryKey(credential.value, envelope, envelope.recoveryWrap);
    const aad = credential.kind === 'password' ? passwordWrapAad(envelope, envelope.passwordWrap) : recoveryWrapAad(envelope, envelope.recoveryWrap);
    const root = await aesDecrypt(key, decodeBase64Url(wrap.wrappedKey, 48), decodeBase64Url(wrap.nonce, 12), aad);
    if (root.byteLength !== 32) {
      wipe(root);
      throw vaultError('AUTH_FAILED');
    }
    return root;
  } catch {
    throw vaultError('AUTH_FAILED');
  }
}

export async function createVault(
  input: VaultContext & { password: string; plaintext: VaultPlaintext },
  epochs?: Pick<EnvelopeHeader, 'keyEpoch' | 'credentialEpoch' | 'revision'> & {
    passwordSlotEpoch: string;
    recoverySlotEpoch: string;
  },
): Promise<CreatedVault> {
  // Validate bounded public context and domain before spending Argon2 resources.
  const header: EnvelopeHeader = {
    formatVersion: FORMAT_VERSION,
    suiteId: SUITE_ID,
    vaultId: input.vaultId,
    ownerId: input.ownerId,
    keyEpoch: epochs?.keyEpoch ?? '1',
    credentialEpoch: epochs?.credentialEpoch ?? '1',
    revision: epochs?.revision ?? '1',
    operationId: encodeBase64Url(randomBytes(16)),
    payloadSchemaVersion: 1,
  };
  validateKeyContext(header);
  validateEpoch(header.credentialEpoch);
  validateEpoch(header.revision);
  validateEpoch(epochs?.passwordSlotEpoch ?? '1');
  validateEpoch(epochs?.recoverySlotEpoch ?? '1');
  const checkedPlaintext = validatePlaintext(input.plaintext);
  const rawRoot = randomBytes(32);
  try {
    const passwordWrap = await wrapPassword(rawRoot, header, input.password, epochs?.passwordSlotEpoch);
    const recovery = await wrapRecovery(rawRoot, header, epochs?.recoverySlotEpoch);
    const rootKey = await importRootKey(rawRoot);
    const pending: VaultEnvelope = {
      ...header,
      passwordWrap,
      recoveryWrap: recovery.wrap,
      payload: { keySalt: '', nonce: '', ciphertext: '' },
    };
    const envelope = await encryptSnapshot(rootKey, pending, checkedPlaintext, header.revision);
    const plaintext = await decryptSnapshot(rootKey, envelope, input);
    return {
      rootKey,
      plaintext,
      mode: 'password',
      envelope,
      recoveryCode: recovery.recoveryCode,
    };
  } finally {
    wipe(rawRoot);
  }
}

export async function unlockVault(input: VaultEnvelope, context: VaultContext, credential: PrivateCredential, onKdfStart?: () => void): Promise<OpenVault> {
  const envelope = validateEnvelope(input);
  assertEnvelopeContext(envelope, context);
  const rawRoot = await unwrapRoot(envelope, credential, onKdfStart);
  try {
    const rootKey = await importRootKey(rawRoot);
    const plaintext = await decryptSnapshot(rootKey, envelope, context);
    return { rootKey, plaintext, mode: credential.kind === 'recovery' ? 'recovery-readonly' : 'password' };
  } catch {
    throw vaultError('AUTH_FAILED');
  } finally {
    wipe(rawRoot);
  }
}

/** Raw material is contained here; no exportVaultKey or raw-root-returning API exists. */
export async function replaceCredentialWraps(
  input: VaultEnvelope,
  context: VaultContext,
  credential: PrivateCredential,
  changes: { password?: string; recovery: boolean },
): Promise<OpenVault & { envelope: VaultEnvelope; recoveryCode?: string }> {
  if (typeof changes.recovery !== 'boolean' || (!changes.recovery && changes.password === undefined)) throw vaultError('INVALID_STATE');
  // Recovery use may never leave the current password wrap in the new context.
  if (credential.kind === 'recovery' && (changes.password === undefined || !changes.recovery)) throw vaultError('INVALID_STATE');
  const envelope = validateEnvelope(input);
  assertEnvelopeContext(envelope, context);
  const rawRoot = await unwrapRoot(envelope, credential);
  try {
    const rootKey = await importRootKey(rawRoot);
    const plaintext = await decryptSnapshot(rootKey, envelope, context);
    const header = {
      ...envelope,
      credentialEpoch: incrementEpoch(envelope.credentialEpoch),
    };
    const passwordWrap =
      changes.password === undefined
        ? envelope.passwordWrap
        : await wrapPassword(rawRoot, header, changes.password, incrementEpoch(envelope.passwordWrap.slotEpoch));
    const recovery = changes.recovery ? await wrapRecovery(rawRoot, header, incrementEpoch(envelope.recoveryWrap.slotEpoch)) : undefined;
    const next = await encryptSnapshot(
      rootKey,
      {
        ...header,
        passwordWrap,
        recoveryWrap: recovery?.wrap ?? envelope.recoveryWrap,
      },
      plaintext,
    );
    await decryptSnapshot(rootKey, next, context);
    return {
      rootKey,
      plaintext,
      mode: 'password',
      envelope: next,
      ...(recovery ? { recoveryCode: recovery.recoveryCode } : {}),
    };
  } finally {
    wipe(rawRoot);
  }
}

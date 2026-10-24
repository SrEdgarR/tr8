import { createVault, replaceCredentialWraps } from './credentials';
import type { CreatedVault, PrivateCredential } from './credentials';
import { assertEnvelopeContext, incrementEpoch, validateEnvelope } from '../compatibility/protocol';
import { vaultError } from '../compatibility/protocol';
import { decryptSnapshot } from './payload';
import type { VaultContext, VaultEnvelope } from './types';

export function rotatePassword(envelope: VaultEnvelope, context: VaultContext, currentPassword: string, newPassword: string) {
  return replaceCredentialWraps(envelope, context, { kind: 'password', value: currentPassword }, { password: newPassword, recovery: false });
}

export function rotateRecovery(envelope: VaultEnvelope, context: VaultContext, credential: PrivateCredential) {
  return replaceCredentialWraps(envelope, context, credential, {
    recovery: true,
  });
}

/** Recovery use changes BOTH current credential wraps, even without a root rekey. */
export function recoverVault(envelope: VaultEnvelope, context: VaultContext, recoveryCode: string, newPassword: string) {
  return replaceCredentialWraps(envelope, context, { kind: 'recovery', value: recoveryCode }, { password: newPassword, recovery: true });
}

/** Explicit full rekey also supplies the last unlocked device's local rescue primitive. */
export async function rekeyVault(rootKey: CryptoKey, input: VaultEnvelope, context: VaultContext, newPassword: string): Promise<CreatedVault> {
  const envelope = validateEnvelope(input);
  assertEnvelopeContext(envelope, context);
  const plaintext = await decryptSnapshot(rootKey, envelope, context);
  return createVault(
    { ...context, password: newPassword, plaintext },
    {
      keyEpoch: incrementEpoch(envelope.keyEpoch),
      credentialEpoch: incrementEpoch(envelope.credentialEpoch),
      revision: incrementEpoch(envelope.revision),
      passwordSlotEpoch: incrementEpoch(envelope.passwordWrap.slotEpoch),
      recoverySlotEpoch: incrementEpoch(envelope.recoveryWrap.slotEpoch),
    },
  );
}

/** v1 has one approved suite. A migration may not silently downgrade or try alternatives. */
export function assertSuiteMigrationAllowed(targetSuite: string): never {
  void targetSuite;
  throw vaultError('UNSUPPORTED_FORMAT');
}

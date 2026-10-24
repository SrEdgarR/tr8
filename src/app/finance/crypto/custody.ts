import { assertEnvelopeContext, validateEnvelope, type VaultContext, type VaultEnvelope } from '../compatibility/protocol';
import { unlockVault } from './credentials';

/**
 * Full reentry must actually unwrap and authenticate the same encrypted snapshot
 * with both private means. The Worker owns the provisional/confirmed/ACK state;
 * this pure verifier never activates a vault or performs a network operation.
 */
export async function confirmVaultCustody(input: VaultEnvelope, context: VaultContext, passwordReentry: string, recoveryReentry: string): Promise<void> {
  const envelope = validateEnvelope(input);
  assertEnvelopeContext(envelope, context);
  await unlockVault(envelope, context, { kind: 'password', value: passwordReentry });
  await unlockVault(envelope, context, { kind: 'recovery', value: recoveryReentry });
}

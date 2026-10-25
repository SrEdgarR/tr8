/** Operator recovery metadata only. A valid signature never enables admission. */
import { controlState, stable, sha256, type ControlState } from './vault-control.ts';
import { uuid, fail, epoch } from './journal-core.ts';
import { decodeBase64Url, encodeBase64Url, requireClosedRecord } from '../../src/app/finance/compatibility/protocol.ts';
export interface RecoveryCheckpoint {
  protocol: 1;
  authorityId: string;
  caseId: string;
  ownerId: string;
  sequence: string;
  stateDigest: string;
  pendingDigest: string | null;
  issuedAtMs: number;
}
export interface SignedCheckpoint {
  checkpoint: RecoveryCheckpoint;
  signature: string;
}
export interface RecoveryPin {
  authorityId: string;
  caseId: string;
  ownerId: string;
  sequence: string;
  stateDigest: string;
  publicKeyFingerprint: string;
}
const hex = /^[a-f0-9]{64}$/;
function checkpoint(value: unknown): RecoveryCheckpoint {
  const c = requireClosedRecord(value, ['protocol', 'authorityId', 'caseId', 'ownerId', 'sequence', 'stateDigest', 'pendingDigest', 'issuedAtMs']);
  if (
    c.protocol !== 1 ||
    typeof c.authorityId !== 'string' ||
    !uuid.test(c.authorityId) ||
    typeof c.ownerId !== 'string' ||
    !uuid.test(c.ownerId) ||
    typeof c.caseId !== 'string' ||
    !/^[a-z-]{1,32}$/.test(c.caseId) ||
    typeof c.stateDigest !== 'string' ||
    !hex.test(c.stateDigest) ||
    (c.pendingDigest !== null && (typeof c.pendingDigest !== 'string' || !hex.test(c.pendingDigest))) ||
    typeof c.issuedAtMs !== 'number' ||
    !Number.isSafeInteger(c.issuedAtMs) ||
    c.issuedAtMs < 0
  )
    fail('INVALID_INPUT');
  epoch(c.sequence);
  return c as unknown as RecoveryCheckpoint;
}
export async function signRecoveryCheckpoint(
  authorityId: string,
  caseId: string,
  state: ControlState,
  pendingDigest: string | null,
  key: CryptoKey,
  issuedAtMs = Date.now(),
): Promise<SignedCheckpoint> {
  const current = controlState(state);
  const c = checkpoint({
    protocol: 1,
    authorityId,
    caseId,
    ownerId: current.ownerId,
    sequence: current.sequence,
    stateDigest: await sha256(stable(current)),
    pendingDigest,
    issuedAtMs,
  });
  const signature = encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode('tr8/control-recovery/v1\n' + stable(c)))),
  );
  return { checkpoint: c, signature };
}
export async function keyFingerprint(key: CryptoKey) {
  return sha256(encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', key))));
}
export async function verifyRecoveryCheckpoint(value: unknown, key: CryptoKey, pin: RecoveryPin): Promise<RecoveryCheckpoint> {
  try {
    const signed = requireClosedRecord(value, ['checkpoint', 'signature']);
    const c = checkpoint(signed.checkpoint);
    if (
      (await keyFingerprint(key)) !== pin.publicKeyFingerprint ||
      c.authorityId !== pin.authorityId ||
      c.caseId !== pin.caseId ||
      c.ownerId !== pin.ownerId ||
      epoch(c.sequence) < epoch(pin.sequence) ||
      (c.sequence === pin.sequence && c.stateDigest !== pin.stateDigest) ||
      typeof signed.signature !== 'string'
    )
      fail('UNTRUSTED_AUTHORITY');
    if (!(await crypto.subtle.verify('Ed25519', key, decodeBase64Url(signed.signature, 64), new TextEncoder().encode('tr8/control-recovery/v1\n' + stable(c)))))
      fail('UNTRUSTED_AUTHORITY');
    return c;
  } catch {
    return fail('UNTRUSTED_AUTHORITY');
  }
}
export async function assessAuthorityRecovery(signed: unknown, key: CryptoKey, pin: RecoveryPin | null, liveState: ControlState | null) {
  if (pin === null) return { admission: false as const, mode: 'closed' as const, reason: 'INDEPENDENT_PIN_REQUIRED', reuseVault: false };
  const c = await verifyRecoveryCheckpoint(signed, key, pin);
  if (c.pendingDigest !== null) return { admission: false as const, mode: 'closed' as const, reason: 'UNRESOLVED_INTENT', reuseVault: false };
  if (liveState === null) return { admission: false as const, mode: 'new-generation-required' as const, reason: 'FRESHNESS_NOT_PROVEN', reuseVault: false };
  const state = controlState(liveState);
  if (
    state.ownerId !== c.ownerId ||
    epoch(state.sequence) < epoch(c.sequence) ||
    (state.sequence === c.sequence && (await sha256(stable(state))) !== c.stateDigest)
  )
    return { admission: false as const, mode: 'closed' as const, reason: 'AUTHORITY_REGRESSED', reuseVault: false };
  return { admission: false as const, mode: 'reconcile-current-head' as const, reason: 'VERIFY_LATEST_ENCRYPTED_ENVELOPE_AND_AUTH', reuseVault: false };
}

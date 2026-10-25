import { beforeEach, describe, it, expect } from 'vitest';
import { initialControlState, sha256, stable } from './vault-control';
import { signRecoveryCheckpoint, verifyRecoveryCheckpoint, keyFingerprint, assessAuthorityRecovery, type SignedCheckpoint, type RecoveryPin } from './recovery';
const authority = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let keys: CryptoKeyPair, signed: SignedCheckpoint, pin: RecoveryPin;
beforeEach(async () => {
  keys = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const state = initialControlState(owner);
  signed = await signRecoveryCheckpoint(authority, 'heads', state, null, keys.privateKey);
  pin = {
    authorityId: authority,
    caseId: 'heads',
    ownerId: owner,
    sequence: '1',
    stateDigest: await sha256(stable(state)),
    publicKeyFingerprint: await keyFingerprint(keys.publicKey),
  };
});
describe('6B.5D.4 independent authority disaster recovery', () => {
  it('verifies an independently pinned checkpoint without granting admission', async () => {
    await expect(verifyRecoveryCheckpoint(signed, keys.publicKey, pin)).resolves.toMatchObject({ sequence: '1' });
    await expect(assessAuthorityRecovery(signed, keys.publicKey, pin, initialControlState(owner))).resolves.toMatchObject({
      admission: false,
      mode: 'reconcile-current-head',
    });
  });
  it.each(['authority', 'case', 'owner', 'sequence', 'digest', 'signature', 'key'])('rejects a checkpoint with changed %s', async field => {
    const copy = structuredClone(signed);
    if (field === 'authority') copy.checkpoint.authorityId = owner;
    if (field === 'case') copy.checkpoint.caseId = 'delete';
    if (field === 'owner') copy.checkpoint.ownerId = authority;
    if (field === 'sequence') copy.checkpoint.sequence = '2';
    if (field === 'digest') copy.checkpoint.stateDigest = '0'.repeat(64);
    if (field === 'signature') copy.signature = copy.signature.slice(0, -2) + 'AA';
    const key = field === 'key' ? ((await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair).publicKey : keys.publicKey;
    await expect(verifyRecoveryCheckpoint(copy, key, pin)).rejects.toThrow('UNTRUSTED_AUTHORITY');
  });
  it('rejects a correctly signed checkpoint older than the external minimum', async () => {
    await expect(verifyRecoveryCheckpoint(signed, keys.publicKey, { ...pin, sequence: '2' })).rejects.toThrow('UNTRUSTED_AUTHORITY');
  });
  it('does not trust a pin supplied by the backup itself', async () => {
    await expect(assessAuthorityRecovery(signed, keys.publicKey, null, null)).resolves.toMatchObject({ admission: false, reason: 'INDEPENDENT_PIN_REQUIRED' });
  });
  it('never recreates the old authority or vault when current state is lost', async () => {
    await expect(assessAuthorityRecovery(signed, keys.publicKey, pin, null)).resolves.toMatchObject({
      admission: false,
      mode: 'new-generation-required',
      reuseVault: false,
      reason: 'FRESHNESS_NOT_PROVEN',
    });
  });
  it('keeps unresolved writes and lifecycle events closed during a disaster', async () => {
    const pending = await signRecoveryCheckpoint(authority, 'heads', initialControlState(owner), 'f'.repeat(64), keys.privateKey);
    await expect(assessAuthorityRecovery(pending, keys.publicKey, pin, null)).resolves.toMatchObject({ admission: false, reason: 'UNRESOLVED_INTENT' });
  });
  it('detects a live journal behind the independently preserved checkpoint', async () => {
    const later = { ...initialControlState(owner), sequence: '2' };
    const seal = await signRecoveryCheckpoint(authority, 'heads', later, null, keys.privateKey);
    await expect(assessAuthorityRecovery(seal, keys.publicKey, pin, initialControlState(owner))).resolves.toMatchObject({
      admission: false,
      reason: 'AUTHORITY_REGRESSED',
    });
  });
  it('does not interpret integrity or a timestamp as proof of latestness', async () => {
    const future = await signRecoveryCheckpoint(authority, 'heads', initialControlState(owner), null, keys.privateKey, Date.now() + 3600000);
    await expect(assessAuthorityRecovery(future, keys.publicKey, pin, null)).resolves.toMatchObject({ admission: false, reason: 'FRESHNESS_NOT_PROVEN' });
  });
});

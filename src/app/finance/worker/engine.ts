import { createVault, unlockVault, type CreatedVault, type OpenVault } from '../crypto/credentials';
import { confirmVaultCustody } from '../crypto/custody';
import { encryptSnapshot } from '../crypto/payload';
import { validatePlaintext } from '../crypto/plaintext';
import { recoverVault, rekeyVault, rotatePassword, rotateRecovery } from '../crypto/rotations';
import {
  assertEnvelopeContext,
  normalizeVaultError,
  requireClosedRecord,
  validateEnvelope,
  validateEpoch,
  vaultError,
  type OpaqueReceipt,
  type VaultEnvelope,
} from '../compatibility/protocol';
import {
  boundedWorkerValue,
  matchingWorkerIdentity,
  parseWorkerRequest,
  type VaultWorkerReply,
  type VaultWorkerRequest,
  type WorkerIdentity,
} from './messages';
import { probeWorkerCapabilities } from './capabilities';

export interface VaultEngineCrypto {
  create: typeof createVault;
  unlock: typeof unlockVault;
  custody: typeof confirmVaultCustody;
  encrypt: typeof encryptSnapshot;
  recover: typeof recoverVault;
  rotatePassword: typeof rotatePassword;
  rotateRecovery: typeof rotateRecovery;
  rekey: typeof rekeyVault;
  probe: () => Promise<void>;
}
const nativeCore: VaultEngineCrypto = {
  create: createVault,
  unlock: unlockVault,
  custody: confirmVaultCustody,
  encrypt: encryptSnapshot,
  recover: recoverVault,
  rotatePassword,
  rotateRecovery,
  rekey: rekeyVault,
  probe: probeWorkerCapabilities,
};
type OpenState = OpenVault & { envelope: VaultEnvelope };
type Draft = OpenState & { expectedRevision: string; recoveryCode?: string; confirmed: boolean };

/** VDKs and authoritative state remain Worker-owned; read returns a validated plaintext copy. */
export class VaultWorkerEngine {
  private identity?: WorkerIdentity;
  private generation = 0;
  private lastRequest = 0;
  private busy = false;
  private closed = false;
  private current?: OpenState;
  private draft?: Draft;

  constructor(private readonly core: VaultEngineCrypto = nativeCore) {}
  close(): void {
    this.closed = true;
    this.generation++;
    this.identity = undefined;
    this.current = undefined;
    this.draft = undefined;
    // Dropping JS objects/CryptoKey references is best effort, not zeroization.
  }
  private checkKey(open: OpenVault): void {
    if (open.rootKey.extractable || open.rootKey.algorithm.name !== 'HKDF' || open.rootKey.usages.join() !== 'deriveKey') throw vaultError('INVALID_STATE');
  }
  private open(): OpenState {
    if (!this.current || this.draft) throw vaultError('INVALID_STATE');
    return this.current;
  }
  // Transport admission is separate from the core's 1024-byte limit AFTER NFC.
  private string(value: unknown, maximum = 8192): string {
    if (typeof value !== 'string' || new TextEncoder().encode(value).length > maximum) throw vaultError('INVALID_FORMAT');
    return value;
  }
  private ensure(request: VaultWorkerRequest): void {
    if (this.closed || this.busy || request.id <= this.lastRequest) throw vaultError('INVALID_STATE');
    if (!this.identity) {
      this.identity = { ...request.identity };
      this.generation = request.generation;
    }
    if (!matchingWorkerIdentity(this.identity, request.identity) || this.generation !== request.generation) throw vaultError('INVALID_STATE');
    this.lastRequest = request.id;
  }
  private ensureLive(request: VaultWorkerRequest): void {
    if (this.closed || this.generation !== request.generation || !this.identity || !matchingWorkerIdentity(this.identity, request.identity))
      throw vaultError('INVALID_STATE');
  }

  async handle(input: unknown): Promise<VaultWorkerReply> {
    let request: VaultWorkerRequest;
    try {
      request = parseWorkerRequest(input);
      this.ensure(request);
    } catch {
      this.close();
      throw vaultError('INVALID_STATE');
    }
    this.busy = true;
    const generation = this.generation;
    const header = { id: request.id, generation: request.generation, identity: { ...request.identity } };
    try {
      const value = await this.run(request);
      if (this.closed || generation !== this.generation) throw vaultError('INVALID_STATE');
      boundedWorkerValue(value);
      return { ...header, value };
    } catch (cause) {
      const error = normalizeVaultError(cause);
      this.close();
      return { ...header, error: error.code };
    } finally {
      this.busy = false;
    }
  }

  private async run(request: VaultWorkerRequest): Promise<unknown> {
    const { method, value } = request;
    const context = { ownerId: request.identity.ownerId, vaultId: this.current?.envelope.vaultId ?? this.draft?.envelope.vaultId ?? '' };
    if (['probe', 'read', 'custody'].includes(method)) {
      if (value !== null) throw vaultError('INVALID_FORMAT');
      if (method === 'probe') {
        if (this.current || this.draft) throw vaultError('INVALID_STATE');
        await this.core.probe();
        return true;
      }
      if (method === 'read') return validatePlaintext(this.open().plaintext);
      if (!this.draft?.recoveryCode || this.draft.confirmed) throw vaultError('INVALID_STATE');
      return { recoveryCode: this.draft.recoveryCode };
    }
    if (method === 'create') {
      if (this.current || this.draft) throw vaultError('INVALID_STATE');
      const job = requireClosedRecord(value, ['vaultId', 'password', 'plaintext']);
      const created: CreatedVault = await this.core.create({
        ownerId: context.ownerId,
        vaultId: this.string(job.vaultId, 128),
        password: this.string(job.password),
        plaintext: validatePlaintext(job.plaintext),
      });
      this.ensureLive(request);
      this.checkKey(created);
      const envelope = validateEnvelope(created.envelope);
      assertEnvelopeContext(envelope, { ownerId: context.ownerId, vaultId: job.vaultId as string });
      this.draft = { ...created, envelope, plaintext: validatePlaintext(created.plaintext), mode: 'password', expectedRevision: '0', confirmed: false };
      return { recoveryCode: created.recoveryCode };
    }
    if (method === 'unlock') {
      if (this.current || this.draft) throw vaultError('INVALID_STATE');
      const job = requireClosedRecord(value, ['envelope', 'credential']);
      const envelope = validateEnvelope(job.envelope);
      const credential = requireClosedRecord(job.credential, ['kind', 'value']);
      if (!['password', 'recovery'].includes(credential.kind as string)) throw vaultError('INVALID_FORMAT');
      assertEnvelopeContext(envelope, { ownerId: context.ownerId, vaultId: envelope.vaultId });
      const opened = await this.core.unlock(envelope, envelope, { kind: credential.kind as 'password' | 'recovery', value: this.string(credential.value) });
      this.ensureLive(request);
      this.checkKey(opened);
      this.current = { ...opened, envelope, plaintext: validatePlaintext(opened.plaintext) };
      return { mode: opened.mode };
    }
    if (method === 'confirm-custody') {
      if (!this.draft?.recoveryCode || this.draft.confirmed) throw vaultError('INVALID_STATE');
      const job = requireClosedRecord(value, ['password', 'recoveryCode']);
      await this.core.custody(this.draft.envelope, this.draft.envelope, this.string(job.password), this.string(job.recoveryCode));
      this.ensureLive(request);
      this.draft.recoveryCode = undefined;
      this.draft.confirmed = true;
      return { envelope: validateEnvelope(this.draft.envelope), expectedRevision: this.draft.expectedRevision };
    }
    if (method === 'ack') {
      if (!this.draft?.confirmed) throw vaultError('INVALID_STATE');
      const receipt = requireClosedRecord(value, ['operationId', 'revision']);
      const expected: OpaqueReceipt = { operationId: this.draft.envelope.operationId, revision: this.draft.envelope.revision };
      if (receipt.operationId !== expected.operationId || validateEpoch(receipt.revision) !== expected.revision) throw vaultError('INVALID_STATE');
      this.current = { rootKey: this.draft.rootKey, plaintext: this.draft.plaintext, envelope: this.draft.envelope, mode: 'password' };
      this.draft = undefined;
      return { mode: 'password' };
    }
    if (method === 'write') {
      const current = this.open();
      if (current.mode !== 'password') throw vaultError('INVALID_STATE');
      const plaintext = validatePlaintext(value);
      const envelope = validateEnvelope(await this.core.encrypt(current.rootKey, current.envelope, plaintext));
      this.ensureLive(request);
      assertEnvelopeContext(envelope, current.envelope);
      this.draft = { rootKey: current.rootKey, plaintext, envelope, mode: 'password', expectedRevision: current.envelope.revision, confirmed: true };
      return { envelope: validateEnvelope(envelope), expectedRevision: this.draft.expectedRevision };
    }
    if (method === 'recover') {
      const current = this.open();
      if (current.mode !== 'recovery-readonly') throw vaultError('INVALID_STATE');
      const job = requireClosedRecord(value, ['recoveryCode', 'newPassword']);
      const recovered = await this.core.recover(current.envelope, current.envelope, this.string(job.recoveryCode), this.string(job.newPassword));
      this.ensureLive(request);
      this.checkKey(recovered);
      const envelope = validateEnvelope(recovered.envelope);
      assertEnvelopeContext(envelope, current.envelope);
      this.draft = {
        ...recovered,
        envelope,
        plaintext: validatePlaintext(recovered.plaintext),
        mode: 'password',
        expectedRevision: current.envelope.revision,
        confirmed: false,
      };
      return { recoveryCode: recovered.recoveryCode };
    }
    if (method === 'rotate-password') {
      const current = this.open();
      if (current.mode !== 'password') throw vaultError('INVALID_STATE');
      const job = requireClosedRecord(value, ['password', 'newPassword', 'confirmation']);
      const password = this.string(job.newPassword);
      if (password.normalize('NFC') !== this.string(job.confirmation).normalize('NFC')) throw vaultError('INVALID_PASSWORD');
      const rotated = await this.core.rotatePassword(current.envelope, current.envelope, this.string(job.password), password);
      this.ensureLive(request);
      this.checkKey(rotated);
      const envelope = validateEnvelope(rotated.envelope);
      assertEnvelopeContext(envelope, current.envelope);
      this.draft = {
        ...rotated,
        envelope,
        plaintext: validatePlaintext(rotated.plaintext),
        mode: 'password',
        expectedRevision: current.envelope.revision,
        confirmed: true,
      };
      return { envelope: validateEnvelope(envelope), expectedRevision: this.draft.expectedRevision };
    }
    if (method === 'rotate-recovery' || method === 'rekey') {
      const current = this.open();
      if (current.mode !== 'password') throw vaultError('INVALID_STATE');
      const job = requireClosedRecord(value, method === 'rekey' ? ['newPassword'] : ['password']);
      const rotated =
        method === 'rekey'
          ? await this.core.rekey(current.rootKey, current.envelope, current.envelope, this.string(job.newPassword))
          : await this.core.rotateRecovery(current.envelope, current.envelope, { kind: 'password', value: this.string(job.password) });
      this.ensureLive(request);
      this.checkKey(rotated);
      const envelope = validateEnvelope(rotated.envelope);
      assertEnvelopeContext(envelope, current.envelope);
      this.draft = {
        ...rotated,
        envelope,
        plaintext: validatePlaintext(rotated.plaintext),
        mode: 'password',
        expectedRevision: current.envelope.revision,
        confirmed: false,
      };
      return { recoveryCode: rotated.recoveryCode };
    }
    throw vaultError('INVALID_STATE');
  }
}

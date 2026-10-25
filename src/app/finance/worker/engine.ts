import { createVault, unlockVault, type CreatedVault, type OpenVault } from '../crypto/credentials';
import { confirmVaultCustody } from '../crypto/custody';
import { encryptSnapshot } from '../crypto/payload';
import { validatePlaintext } from '../crypto/plaintext';
import type { PrivateCredential } from '../crypto/credentials';
import { randomBytes } from '../crypto/native-crypto';
import { MAX_ENVELOPE_BYTES, encodeBase64Url } from '../compatibility/protocol';
import type { OpenedFinancialBackup, ImportDestination } from '../import/backup';
import type { ImportPreview } from '../import/preview';
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

/** Financial entry points install this policy; the generic 6B.2 test profile stays separate. */
export interface VaultEnginePolicy {
  validate: typeof validatePlaintext;
  backups?: {
    open: (json: string, credential: PrivateCredential) => Promise<OpenedFinancialBackup>;
    preview: (opened: OpenedFinancialBackup) => ImportPreview;
    create: (opened: OpenedFinancialBackup, destination: ImportDestination) => Promise<CreatedVault>;
    restore: (
      opened: OpenedFinancialBackup,
      key: CryptoKey,
      envelope: VaultEnvelope,
      context: { ownerId: string; vaultId: string },
    ) => Promise<{ plaintext: OpenVault['plaintext']; envelope: VaultEnvelope }>;
    serialize: (envelope: VaultEnvelope) => string;
  };
}

/** VDKs and authoritative state remain Worker-owned; read returns a validated plaintext copy. */
export class VaultWorkerEngine {
  private identity?: WorkerIdentity;
  private generation = 0;
  private lastRequest = 0;
  private busy = false;
  private closed = false;
  private current?: OpenState;
  private draft?: Draft;
  private backupPreview?: { id: string; kind: 'import' | 'restore'; opened: OpenedFinancialBackup };

  constructor(
    private readonly core: VaultEngineCrypto = nativeCore,
    private readonly policy: VaultEnginePolicy = { validate: validatePlaintext },
  ) {}
  close(): void {
    this.closed = true;
    this.generation++;
    this.identity = undefined;
    this.current = undefined;
    this.draft = undefined;
    this.backupPreview = undefined;
    // Dropping JS objects/CryptoKey references is best effort, not zeroization.
  }
  private checkKey(open: OpenVault): void {
    if (open.rootKey.extractable || open.rootKey.algorithm.name !== 'HKDF' || open.rootKey.usages.join() !== 'deriveKey') throw vaultError('INVALID_STATE');
  }
  private open(): OpenState {
    if (!this.current || this.draft || this.backupPreview) throw vaultError('INVALID_STATE');
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
    if (this.backupPreview && method !== `${this.backupPreview.kind}-accept`) throw vaultError('INVALID_STATE');
    if (method === 'import-preview' || method === 'restore-preview') {
      const support = this.policy.backups;
      if (!support || this.draft || this.backupPreview || (method === 'import-preview' && this.current)) throw vaultError('INVALID_STATE');
      if (method === 'restore-preview' && this.open().mode !== 'password') throw vaultError('INVALID_STATE');
      const job = requireClosedRecord(value, ['backup', 'credential']);
      const credential = requireClosedRecord(job.credential, ['kind', 'value']);
      if (!['password', 'recovery'].includes(credential.kind as string)) throw vaultError('INVALID_FORMAT');
      const opened = await support.open(this.string(job.backup, MAX_ENVELOPE_BYTES), {
        kind: credential.kind as 'password' | 'recovery',
        value: this.string(credential.value),
      });
      this.ensureLive(request);
      if (method === 'restore-preview') assertEnvelopeContext(opened.envelope, this.current!.envelope);
      const summary = support.preview(opened);
      const id = encodeBase64Url(randomBytes(16));
      this.backupPreview = { id, kind: method === 'import-preview' ? 'import' : 'restore', opened };
      return { previewId: id, summary };
    }
    if (method === 'import-accept' || method === 'restore-accept') {
      const support = this.policy.backups;
      const preview = this.backupPreview;
      const job = requireClosedRecord(value, method === 'import-accept' ? ['previewId', 'password'] : ['previewId']);
      if (!support || !preview || job.previewId !== preview.id || method !== `${preview.kind}-accept`) throw vaultError('INVALID_STATE');
      if (method === 'import-accept') {
        if (this.current || this.draft) throw vaultError('INVALID_STATE');
        const destinationVaultId = encodeBase64Url(randomBytes(16));
        const created = await support.create(preview.opened, {
          ownerId: context.ownerId,
          vaultId: destinationVaultId,
          password: this.string(job.password),
          currentEnvelope: null,
        });
        this.ensureLive(request);
        this.checkKey(created);
        const envelope = validateEnvelope(created.envelope);
        assertEnvelopeContext(envelope, { ownerId: context.ownerId, vaultId: destinationVaultId });
        if (
          envelope.vaultId === preview.opened.envelope.vaultId ||
          [envelope.keyEpoch, envelope.credentialEpoch, envelope.revision, envelope.passwordWrap.slotEpoch, envelope.recoveryWrap.slotEpoch].some(
            epoch => epoch !== '1',
          )
        )
          throw vaultError('INVALID_STATE');
        this.draft = { ...created, envelope, plaintext: this.policy.validate(created.plaintext), mode: 'password', expectedRevision: '0', confirmed: false };
        this.backupPreview = undefined;
        return { recoveryCode: created.recoveryCode };
      }
      const current = this.current;
      if (!current || this.draft || current.mode !== 'password') throw vaultError('INVALID_STATE');
      const restored = await support.restore(preview.opened, current.rootKey, current.envelope, current.envelope);
      this.ensureLive(request);
      const envelope = validateEnvelope(restored.envelope);
      assertEnvelopeContext(envelope, current.envelope);
      this.draft = {
        rootKey: current.rootKey,
        plaintext: this.policy.validate(restored.plaintext),
        envelope,
        mode: 'password',
        expectedRevision: current.envelope.revision,
        confirmed: true,
      };
      this.backupPreview = undefined;
      return { envelope: validateEnvelope(envelope), expectedRevision: current.envelope.revision };
    }
    if (method === 'backup-export') {
      if (value !== null || !this.policy.backups) throw vaultError('INVALID_STATE');
      const current = this.open();
      this.policy.validate(current.plaintext);
      return this.policy.backups.serialize(current.envelope);
    }
    if (['probe', 'read', 'custody'].includes(method)) {
      if (value !== null) throw vaultError('INVALID_FORMAT');
      if (method === 'probe') {
        if (this.current || this.draft) throw vaultError('INVALID_STATE');
        await this.core.probe();
        return true;
      }
      if (method === 'read') return this.policy.validate(this.open().plaintext);
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
        plaintext: this.policy.validate(job.plaintext),
      });
      this.ensureLive(request);
      this.checkKey(created);
      const envelope = validateEnvelope(created.envelope);
      assertEnvelopeContext(envelope, { ownerId: context.ownerId, vaultId: job.vaultId as string });
      this.draft = { ...created, envelope, plaintext: this.policy.validate(created.plaintext), mode: 'password', expectedRevision: '0', confirmed: false };
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
      this.current = { ...opened, envelope, plaintext: this.policy.validate(opened.plaintext) };
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
      const plaintext = this.policy.validate(value);
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
        plaintext: this.policy.validate(recovered.plaintext),
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
        plaintext: this.policy.validate(rotated.plaintext),
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
        plaintext: this.policy.validate(rotated.plaintext),
        mode: 'password',
        expectedRevision: current.envelope.revision,
        confirmed: false,
      };
      return { recoveryCode: rotated.recoveryCode };
    }
    throw vaultError('INVALID_STATE');
  }
}

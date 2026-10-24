import {
  requireClosedRecord,
  normalizeVaultError,
  serializeOpaquePut,
  validateEnvelope,
  validateEpoch,
  vaultError,
  VaultError,
  type OpaqueReceipt,
  type VaultEnvelope,
  type VaultErrorCode,
} from '../compatibility/protocol';
import { validatePlaintext, type VaultPlaintext } from '../crypto/plaintext';
import type { PrivateCredential } from '../crypto/credentials';
import { requireVaultBrowserCapabilities } from '../worker/capabilities';
import { boundedWorkerValue, matchingWorkerIdentity, workerIdentity, type VaultWorkerMethod, type WorkerIdentity } from '../worker/messages';
import { sameVaultIdentity, VaultSessionLifecycle, type VaultLockReason, type VaultSessionIdentity } from './lifecycle';
import { DefinitiveOpaqueSaveError } from './opaque-save';
export { DefinitiveOpaqueSaveError, isDefinitiveOpaqueSaveCode, type DefinitiveOpaqueSaveCode } from './opaque-save';

export interface PreparedVaultSnapshot {
  envelope: VaultEnvelope;
  expectedRevision: string;
}
export interface VaultControllerOptions {
  ownerId: string;
  /** Injected trusted server boundary; this callback is not authentication itself. */
  verifyIdentity: () => Promise<VaultSessionIdentity>;
  /**
   * Return only a validated ACK. Throw DefinitiveOpaqueSaveError for a validated
   * backend denial; all other failures preserve an inactive exact-byte retry.
   */
  saveOpaque: (exactBody: string, identity: VaultSessionIdentity) => Promise<OpaqueReceipt>;
  onClear: () => void;
  makeWorker?: () => Worker;
  now?: () => number;
  /** Only synthetic unit harnesses should replace the real capability gate. */
  capabilityCheck?: () => void;
}

class WorkerChannel {
  private next = 0;
  private closed = false;
  private pending?: {
    id: number;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
    cleanup: () => void;
  };
  constructor(
    private readonly worker: Worker,
    private readonly generation: number,
    private readonly identity: WorkerIdentity,
    private readonly failed: () => void,
  ) {
    worker.onmessage = event => this.receive(event.data);
    worker.onerror = event => {
      event.preventDefault();
      this.close(true);
    };
    worker.onmessageerror = () => this.close(true);
  }
  private receive(value: unknown): void {
    if (this.closed) return;
    try {
      const record = requireClosedRecord(
        value,
        Object.hasOwn(value as object, 'error') ? ['id', 'generation', 'identity', 'error'] : ['id', 'generation', 'identity', 'value'],
      );
      if (
        !this.pending ||
        record.id !== this.pending.id ||
        record.generation !== this.generation ||
        !matchingWorkerIdentity(workerIdentity(record.identity), this.identity)
      )
        throw vaultError('INVALID_STATE');
      if (record.error === undefined) boundedWorkerValue(record.value);
      const entry = this.pending;
      this.pending = undefined;
      clearTimeout(entry.timer);
      entry.cleanup();
      if (record.error !== undefined) {
        const error = new VaultError(record.error as VaultErrorCode);
        if (error.code !== record.error) {
          entry.reject(vaultError('INVALID_STATE'));
          this.close(true);
          return;
        }
        entry.reject(error);
        return;
      }
      entry.resolve(record.value);
    } catch {
      this.close(true);
    }
  }
  request(method: VaultWorkerMethod, value: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed || this.pending || signal?.aborted) return Promise.reject(vaultError('INVALID_STATE'));
    boundedWorkerValue(value);
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const abort = () => this.close(true);
      const timer = setTimeout(() => this.close(true), 60_000);
      this.pending = { id, resolve, reject, timer, cleanup: () => signal?.removeEventListener('abort', abort) };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.worker.postMessage({ id, generation: this.generation, identity: { ...this.identity }, method, value });
      } catch {
        this.close(true);
      }
    });
  }
  close(notify = false): void {
    if (this.closed) return;
    this.closed = true;
    const entry = this.pending;
    this.pending = undefined;
    this.worker.terminate();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    if (entry) {
      clearTimeout(entry.timer);
      entry.cleanup();
      entry.reject(vaultError('INVALID_STATE'));
    }
    if (notify) this.failed();
  }
}

/** Memory-only controller; no storage, logs, caches or production route. */
export class VaultSessionController {
  readonly lifecycle: VaultSessionLifecycle;
  private channel?: WorkerChannel;
  private identity?: VaultSessionIdentity;
  private prepared?: { snapshot: PreparedVaultSnapshot; body: string };
  private phase: 'locked' | 'custody' | 'pending' | 'unconfirmed' | 'open' = 'locked';
  private mode?: 'password' | 'recovery-readonly';
  private operationTicket?: { generation: number };

  constructor(private readonly options: VaultControllerOptions) {
    this.lifecycle = new VaultSessionLifecycle(options.now, () => {
      this.channel?.close();
      this.channel = undefined;
      this.identity = undefined;
      this.prepared = undefined;
      this.phase = 'locked';
      this.mode = undefined;
      this.operationTicket = undefined;
      this.clear();
    });
  }
  private clear(): void {
    try {
      this.options.onClear();
    } catch {
      /* View errors cannot prevent Worker/key invalidation. */
    }
  }
  state(): { phase: string; mode: string | null; generation: number; canDisplay: boolean } {
    const canDisplay = this.lifecycle.canDisplay() && this.phase === 'open';
    return { phase: this.phase, mode: this.mode ?? null, generation: this.lifecycle.currentGeneration(), canDisplay };
  }
  lock(reason: VaultLockReason = 'logout'): void {
    this.lifecycle.lock(reason);
  }
  abort(): void {
    this.lock('abort');
  }
  setHidden(hidden: boolean): void {
    this.lifecycle.setHidden(hidden);
    if (hidden) this.clear();
  }
  noteActivity(): void {
    this.lifecycle.noteActivity();
  }
  tick(): void {
    this.lifecycle.tick();
  }

  private async verify(generation: number): Promise<VaultSessionIdentity> {
    let current: VaultSessionIdentity;
    try {
      current = await this.options.verifyIdentity();
    } catch {
      if (this.lifecycle.accepts(generation)) this.lock('invalid-session');
      throw vaultError('INVALID_STATE');
    }
    if (!this.lifecycle.accepts(generation)) throw vaultError('INVALID_STATE');
    if (!this.identity || current.valid !== true || !sameVaultIdentity(this.identity, current) || !this.lifecycle.validate(current)) {
      this.lock('identity-change');
      throw vaultError('INVALID_STATE');
    }
    return { ...current };
  }
  private async begin(ticket: { generation: number }): Promise<number> {
    const before = ticket.generation;
    const identity = await this.options.verifyIdentity();
    if (
      this.operationTicket !== ticket ||
      before !== this.lifecycle.currentGeneration() ||
      identity.ownerId !== this.options.ownerId ||
      identity.valid !== true
    )
      throw vaultError('INVALID_STATE');
    const checked = workerIdentity({ ownerId: identity.ownerId, sessionId: identity.sessionId, epoch: identity.epoch });
    const generation = this.lifecycle.begin(identity, before);
    this.identity = { ...identity };
    try {
      (this.options.capabilityCheck ?? requireVaultBrowserCapabilities)();
      const worker = (this.options.makeWorker ?? (() => new Worker(new URL('../worker/vault.worker.ts', import.meta.url), { type: 'module' })))();
      this.channel = new WorkerChannel(worker, generation, checked, () => {
        if (this.lifecycle.accepts(generation)) this.lock('worker-error');
      });
      if ((await this.channel.request('probe', null)) !== true) throw vaultError('CRYPTO_UNAVAILABLE');
      await this.verify(generation);
      this.assertCurrent(generation);
      return generation;
    } catch (cause) {
      if (this.lifecycle.accepts(generation)) this.lock('worker-error');
      throw cause;
    }
  }
  private assertCurrent(generation: number, channel?: WorkerChannel): void {
    if (!this.lifecycle.accepts(generation) || (channel && this.channel !== channel)) throw vaultError('INVALID_STATE');
  }
  private async run(generation: number, method: VaultWorkerMethod, value: unknown, signal?: AbortSignal): Promise<unknown> {
    const channel = this.channel;
    try {
      await this.verify(generation);
      this.assertCurrent(generation, channel);
      if (!channel) throw vaultError('INVALID_STATE');
      const result = await channel.request(method, value, signal);
      await this.verify(generation);
      this.assertCurrent(generation, channel);
      if (!this.lifecycle.canReceive(generation)) throw vaultError('INVALID_STATE');
      return result;
    } catch (cause) {
      if (this.lifecycle.accepts(generation)) this.lock(signal?.aborted ? 'abort' : 'worker-error');
      throw cause;
    }
  }
  private consume<T>(generation: number, consume: () => T): T {
    try {
      this.assertCurrent(generation);
      return consume();
    } catch (cause) {
      if (this.lifecycle.accepts(generation)) this.lock('worker-error');
      throw cause;
    }
  }
  private custody(value: unknown): { recoveryCode: string } {
    const record = requireClosedRecord(value, ['recoveryCode']);
    if (typeof record.recoveryCode !== 'string' || record.recoveryCode.length > 1024) throw vaultError('INVALID_FORMAT');
    this.phase = 'custody';
    this.mode = undefined;
    this.clear();
    return { recoveryCode: record.recoveryCode };
  }
  private prepare(value: unknown): PreparedVaultSnapshot {
    const record = requireClosedRecord(value, ['envelope', 'expectedRevision']);
    const envelope = validateEnvelope(record.envelope);
    if (envelope.ownerId !== this.options.ownerId) throw vaultError('AUTH_FAILED');
    const expectedRevision = record.expectedRevision === '0' ? '0' : validateEpoch(record.expectedRevision);
    const snapshot = { envelope, expectedRevision };
    this.prepared = { snapshot, body: serializeOpaquePut({ envelope, expectedRevision, operationId: envelope.operationId }) };
    this.phase = 'pending';
    this.mode = undefined;
    this.clear();
    return { envelope: validateEnvelope(envelope), expectedRevision };
  }
  private async operation<T>(
    admission: 'replace' | 'custody' | 'open' | 'password' | 'recovery' | 'pending',
    action: (ticket: { generation: number }) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (admission === 'replace') this.lock('navigation');
    else {
      if (this.operationTicket) throw vaultError('INVALID_STATE');
      const allowed =
        admission === 'pending'
          ? ['pending', 'unconfirmed'].includes(this.phase)
          : admission === 'custody'
            ? this.phase === 'custody'
            : this.phase === 'open' && (admission === 'open' || this.mode === (admission === 'password' ? 'password' : 'recovery-readonly'));
      if (!allowed) throw vaultError('INVALID_STATE');
    }
    const ticket = { generation: this.lifecycle.currentGeneration() };
    this.operationTicket = ticket;
    const abort = () => {
      if (this.operationTicket === ticket) this.lock('abort');
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) {
        abort();
        throw vaultError('INVALID_STATE');
      }
      const result = await action(ticket);
      this.assertCurrent(ticket.generation);
      if (this.operationTicket !== ticket || signal?.aborted) throw vaultError('INVALID_STATE');
      return result;
    } catch (cause) {
      if (this.operationTicket === ticket && this.lifecycle.accepts(ticket.generation) && this.phase !== 'unconfirmed') this.lock('worker-error');
      throw cause instanceof DefinitiveOpaqueSaveError ? cause : normalizeVaultError(cause);
    } finally {
      signal?.removeEventListener('abort', abort);
      if (this.operationTicket === ticket) this.operationTicket = undefined;
    }
  }
  async beginCreate(value: { vaultId: string; password: string; plaintext: VaultPlaintext }, signal?: AbortSignal): Promise<{ recoveryCode: string }> {
    const plaintext = validatePlaintext(value.plaintext);
    return this.operation(
      'replace',
      async ticket => {
        const generation = await this.begin(ticket);
        const result = await this.run(generation, 'create', { ...value, plaintext }, signal);
        return this.consume(generation, () => this.custody(result));
      },
      signal,
    );
  }
  async getCustody(): Promise<{ recoveryCode: string }> {
    return this.operation('custody', async ({ generation }) => {
      const result = await this.run(generation, 'custody', null);
      return this.consume(generation, () => this.custody(result));
    });
  }
  async confirmCustody(password: string, recoveryCode: string, signal?: AbortSignal): Promise<PreparedVaultSnapshot> {
    return this.operation(
      'custody',
      async ({ generation }) => {
        const result = await this.run(generation, 'confirm-custody', { password, recoveryCode }, signal);
        return this.consume(generation, () => this.prepare(result));
      },
      signal,
    );
  }
  async unlock(envelope: VaultEnvelope, credential: PrivateCredential, signal?: AbortSignal): Promise<{ mode: 'password' | 'recovery-readonly' }> {
    const checked = validateEnvelope(envelope);
    return this.operation(
      'replace',
      async ticket => {
        const generation = await this.begin(ticket);
        const result = await this.run(generation, 'unlock', { envelope: checked, credential: { ...credential } }, signal);
        return this.consume(generation, () => {
          const record = requireClosedRecord(result, ['mode']);
          if (!['password', 'recovery-readonly'].includes(record.mode as string) || !this.lifecycle.activate(generation)) throw vaultError('INVALID_STATE');
          this.mode = record.mode as 'password' | 'recovery-readonly';
          this.phase = 'open';
          return { mode: this.mode };
        });
      },
      signal,
    );
  }
  async read(signal?: AbortSignal): Promise<VaultPlaintext> {
    return this.operation(
      'open',
      async ({ generation }) => {
        const result = await this.run(generation, 'read', null, signal);
        return this.consume(generation, () => {
          const value = validatePlaintext(result);
          if (this.phase !== 'open' || !this.lifecycle.canDisplay()) throw vaultError('INVALID_STATE');
          return value;
        });
      },
      signal,
    );
  }
  async prepareWrite(plaintext: VaultPlaintext, signal?: AbortSignal): Promise<PreparedVaultSnapshot> {
    return this.operation(
      'password',
      async ({ generation }) => {
        const result = await this.run(generation, 'write', validatePlaintext(plaintext), signal);
        return this.consume(generation, () => this.prepare(result));
      },
      signal,
    );
  }
  async beginRecovery(recoveryCode: string, newPassword: string, signal?: AbortSignal): Promise<{ recoveryCode: string }> {
    return this.operation(
      'recovery',
      async ({ generation }) => {
        const result = await this.run(generation, 'recover', { recoveryCode, newPassword }, signal);
        return this.consume(generation, () => this.custody(result));
      },
      signal,
    );
  }
  async beginRekey(newPassword: string, signal?: AbortSignal): Promise<{ recoveryCode: string }> {
    return this.operation(
      'password',
      async ({ generation }) => {
        const result = await this.run(generation, 'rekey', { newPassword }, signal);
        return this.consume(generation, () => this.custody(result));
      },
      signal,
    );
  }
  async beginRotateRecovery(password: string, signal?: AbortSignal): Promise<{ recoveryCode: string }> {
    return this.operation(
      'password',
      async ({ generation }) => {
        const result = await this.run(generation, 'rotate-recovery', { password }, signal);
        return this.consume(generation, () => this.custody(result));
      },
      signal,
    );
  }
  async prepareRotatePassword(password: string, newPassword: string, confirmation: string, signal?: AbortSignal): Promise<PreparedVaultSnapshot> {
    return this.operation(
      'password',
      async ({ generation }) => {
        const result = await this.run(generation, 'rotate-password', { password, newPassword, confirmation }, signal);
        return this.consume(generation, () => this.prepare(result));
      },
      signal,
    );
  }

  async commit(): Promise<OpaqueReceipt> {
    return this.operation('pending', async ticket => {
      if (!this.prepared) throw vaultError('INVALID_STATE');
      const generation = ticket.generation;
      const draft = this.prepared;
      this.clear();
      try {
        const identity = await this.verify(generation);
        this.assertCurrent(generation);
        if (this.operationTicket !== ticket || this.prepared !== draft) throw vaultError('INVALID_STATE');
        let receipt: OpaqueReceipt;
        try {
          receipt = await this.options.saveOpaque(draft.body, identity);
        } catch (cause) {
          if (cause instanceof DefinitiveOpaqueSaveError) {
            if (this.operationTicket === ticket && this.lifecycle.accepts(generation)) this.lock('worker-error');
            throw cause;
          }
          if (this.operationTicket === ticket && this.lifecycle.accepts(generation) && this.prepared === draft) {
            this.phase = 'unconfirmed';
            this.clear();
          }
          throw vaultError('INVALID_STATE');
        }
        await this.verify(generation);
        this.assertCurrent(generation);
        const record = requireClosedRecord(receipt, ['operationId', 'revision']);
        if (record.operationId !== draft.snapshot.envelope.operationId || record.revision !== draft.snapshot.envelope.revision)
          throw vaultError('INVALID_STATE');
        await this.run(generation, 'ack', { operationId: record.operationId, revision: record.revision });
        this.assertCurrent(generation);
        if (this.operationTicket !== ticket || this.prepared !== draft || !this.lifecycle.activate(generation)) throw vaultError('INVALID_STATE');
        this.prepared = undefined;
        this.phase = 'open';
        this.mode = 'password';
        return { operationId: receipt.operationId, revision: receipt.revision };
      } catch (cause) {
        if (this.lifecycle.accepts(generation) && this.phase !== 'unconfirmed') this.lock('worker-error');
        throw cause;
      }
    });
  }
}

export interface VaultSessionIdentity {
  ownerId: string;
  sessionId: string;
  epoch: string;
  valid: boolean;
  headRevision?: string;
  headOperationId?: string | null;
}
export type VaultLockReason = 'logout' | 'identity-change' | 'navigation' | 'pagehide' | 'expired' | 'clock' | 'invalid-session' | 'worker-error' | 'abort';

export function sameVaultIdentity(left: VaultSessionIdentity, right: VaultSessionIdentity): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.sessionId === right.sessionId &&
    left.epoch === right.epoch &&
    left.headRevision === right.headRevision &&
    left.headOperationId === right.headOperationId &&
    left.valid === true &&
    right.valid === true
  );
}

/** Memory-only lifecycle; every disclosure checks the clock, not only timers. */
export class VaultSessionLifecycle {
  private generation = 0;
  private identity?: VaultSessionIdentity;
  private active = false;
  private engaged = false;
  private hidden = false;
  private needsIdentity = true;
  private lastActivity = 0;
  private hiddenAt = 0;
  private lastClock: number;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly onLock: (reason: VaultLockReason) => void = () => {},
  ) {
    this.lastClock = now();
  }

  private check(): boolean {
    const current = this.now();
    if (!Number.isFinite(current) || current < this.lastClock) {
      this.lock('clock');
      return false;
    }
    this.lastClock = current;
    if (this.engaged && (current - this.lastActivity >= 300_000 || (this.hidden && current - this.hiddenAt >= 60_000))) {
      this.lock('expired');
      return false;
    }
    return true;
  }

  begin(identity: VaultSessionIdentity, expectedGeneration?: number): number {
    if (expectedGeneration === undefined) this.lock('navigation');
    else if (expectedGeneration !== this.generation || this.engaged) throw new Error('INVALID_SESSION');
    if (!this.check() || identity.valid !== true || this.hidden) throw new Error('INVALID_SESSION');
    this.identity = { ...identity };
    this.engaged = true;
    this.lastActivity = this.lastClock;
    this.needsIdentity = false;
    return this.generation;
  }
  currentGeneration(): number {
    return this.generation;
  }
  adoptCommittedHead(generation: number, previous: VaultSessionIdentity, next: VaultSessionIdentity): boolean {
    if (
      !this.accepts(generation) ||
      !this.identity ||
      !sameVaultIdentity(this.identity, previous) ||
      previous.ownerId !== next.ownerId ||
      previous.sessionId !== next.sessionId ||
      previous.epoch !== next.epoch ||
      !next.valid
    )
      return false;
    this.identity = { ...next };
    return true;
  }
  accepts(generation: number): boolean {
    return this.check() && this.engaged && generation === this.generation;
  }
  validate(identity: VaultSessionIdentity): boolean {
    if (!this.check() || !this.identity || !sameVaultIdentity(this.identity, identity)) {
      this.lock('invalid-session');
      return false;
    }
    this.needsIdentity = false;
    return !this.hidden;
  }
  activate(generation: number): boolean {
    if (!this.accepts(generation) || this.hidden || this.needsIdentity) return false;
    this.active = true;
    return true;
  }
  canReceive(generation: number): boolean {
    return this.accepts(generation) && !this.hidden && !this.needsIdentity;
  }
  canDisplay(): boolean {
    return this.check() && this.active && !this.hidden && !this.needsIdentity;
  }
  noteActivity(): void {
    if (this.check() && this.engaged && !this.hidden && !this.needsIdentity) this.lastActivity = this.lastClock;
  }
  setHidden(hidden: boolean): void {
    this.check();
    if (hidden && !this.hidden) this.hiddenAt = this.lastClock;
    if (!hidden && this.hidden) {
      if (this.lastClock - this.hiddenAt >= 60_000) this.lock('expired');
      this.needsIdentity = true;
    }
    this.hidden = hidden;
  }
  tick(): void {
    this.check();
  }
  lock(reason: VaultLockReason): void {
    this.generation++;
    this.identity = undefined;
    this.active = false;
    this.engaged = false;
    this.needsIdentity = true;
    this.onLock(reason);
  }
}

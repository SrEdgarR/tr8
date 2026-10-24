/**
 * Stage 6A contract simulator. It has no HTTP route, database or production auth
 * adapter. Its in-memory commits are not evidence of PostgreSQL durability.
 * Never wire it into the application or use it to store real financial data.
 */
import {
  MAX_ENVELOPE_BYTES,
  OpaqueError,
  VaultError,
  assertOpaqueTransition,
  decodeBase64Url,
  hashOpaqueRequest,
  parseOpaquePut,
  requireClosedRecord,
  validateEnvelope,
  type OpaquePut,
  type OpaqueReceipt,
  type VaultEnvelope,
} from './protocol';

const RECENT_LOGIN_MS = 5 * 60_000;

export type PrototypeErrorCode = 'SESSION_REVOKED' | 'IDENTITY_DISABLED' | 'LIFECYCLE_CHANGED' | 'VAULT_RETIRED' | 'RESTORE_QUARANTINED' | 'COMMIT_UNCONFIRMED';

export class PrototypeError extends Error {
  constructor(readonly code: PrototypeErrorCode) {
    super(code);
    this.name = 'PrototypeError';
  }
}

/** Evidence supplied by a trusted server verifier, never by a request body. */
export interface PrototypeAuthenticationProof {
  ownerId: string;
  sessionId: string;
  method: string;
  /** Server-accredited login time in epoch milliseconds; never JWT iat. */
  authenticatedAtMs: number;
}

export interface VerifiedPrototypeIdentity {
  ownerId: string;
  sessionId: string;
  authentication?: PrototypeAuthenticationProof;
}

export interface PrototypeIdentitySeed {
  ownerId: string;
  enabled?: boolean;
  sessions: readonly { id: string; expiresAtMs: number }[];
}

export interface PrototypeCommitContext {
  ownerId: string;
  operationId: string;
  revision: string;
}

export interface PrototypeHooks {
  /** Runs after preparation, outside the commit lock, to exercise real races. */
  beforeCommit?: (context: PrototypeCommitContext) => Promise<void>;
  /** Synchronous fault injection before the atomic state replacement. */
  beforeReceiptCommit?: (context: PrototypeCommitContext) => void;
  /** A failure here represents a committed write whose acknowledgement was lost. */
  afterCommit?: (context: PrototypeCommitContext) => Promise<void>;
}

interface StoredReceipt {
  requestHash: string;
  receipt: OpaqueReceipt;
}

export interface PrototypeResetCommand {
  operationId: string;
  expectedLifecycleVersion: number;
  expectedVaultId: string;
}

export interface PrototypeResetReceipt {
  operationId: string;
  lifecycleVersion: number;
  retiredVaultId: string;
}

interface IdentityState {
  enabled: boolean;
  lifecycleVersion: number;
  fence: number;
  sessions: Map<string, { expiresAtMs: number; live: boolean }>;
  envelope: VaultEnvelope | null;
  receipts: Map<string, StoredReceipt>;
  resetReceipts: Map<string, { hash: string; receipt: PrototypeResetReceipt }>;
}

export interface PrototypeOptions {
  /** The test harness supplies verified identities, not a client-side decoder. */
  verifyIdentity: (authorization: string) => Promise<VerifiedPrototypeIdentity | null>;
  identities: readonly PrototypeIdentitySeed[];
  clock?: () => number;
  hooks?: PrototypeHooks;
}

function copyIdentity(identity: VerifiedPrototypeIdentity): VerifiedPrototypeIdentity {
  return { ownerId: identity.ownerId, sessionId: identity.sessionId, ...(identity.authentication ? { authentication: { ...identity.authentication } } : {}) };
}

function copyState(state: IdentityState): IdentityState {
  return {
    ...state,
    sessions: new Map([...state.sessions].map(([id, session]) => [id, { ...session }])),
    envelope: state.envelope ? validateEnvelope(state.envelope) : null,
    receipts: new Map([...state.receipts].map(([id, entry]) => [id, { requestHash: entry.requestHash, receipt: { ...entry.receipt } }])),
    resetReceipts: new Map([...state.resetReceipts].map(([id, entry]) => [id, { hash: entry.hash, receipt: { ...entry.receipt } }])),
  };
}

function parseBytes(input: Uint8Array): { bytes: Uint8Array<ArrayBuffer>; put: OpaquePut } {
  // TextEncoder / Workers can return a Uint8Array from another realm.
  if (!ArrayBuffer.isView(input) || Object.prototype.toString.call(input) !== '[object Uint8Array]') throw new OpaqueError('INVALID_ENVELOPE');
  if (input.byteLength > MAX_ENVELOPE_BYTES) throw new OpaqueError('ENVELOPE_TOO_LARGE');
  // Snapshot caller-owned bytes before any await or asynchronous hash.
  const bytes = new Uint8Array(input);
  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new OpaqueError('INVALID_ENVELOPE');
  }
  try {
    return { bytes, put: parseOpaquePut(body) };
  } catch (error) {
    if (error instanceof OpaqueError) throw error;
    if (error instanceof VaultError && error.code === 'SIZE_LIMIT') throw new OpaqueError('ENVELOPE_TOO_LARGE');
    throw new OpaqueError('INVALID_ENVELOPE');
  }
}

/** Bound the actual byte stream; Content-Length alone is never an admission rule. */
export async function readPrototypeBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_ENVELOPE_BYTES)) throw new OpaqueError('ENVELOPE_TOO_LARGE');
  if (request.headers.get('content-encoding') || request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || !request.body) {
    throw new OpaqueError('INVALID_ENVELOPE');
  }
  const reader = request.body.getReader();
  // A list of chunks would grow without a byte bound for empty or tiny chunks.
  // One contiguous admission buffer bounds our memory independently of framing.
  const bytes = new Uint8Array(MAX_ENVELOPE_BYTES);
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!ArrayBuffer.isView(value) || Object.prototype.toString.call(value) !== '[object Uint8Array]') throw new OpaqueError('INVALID_ENVELOPE');
      if (value.byteLength === 0) continue;
      if (value.byteLength > MAX_ENVELOPE_BYTES - size) {
        void reader.cancel().catch(() => {});
        throw new OpaqueError('ENVELOPE_TOO_LARGE');
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.slice(0, size);
}

/** Experimental single-process authority. The mutex models a future DB fence. */
export class ExperimentalMemoryVaultServer {
  private readonly identities = new Map<string, IdentityState>();
  // Retirement is global by context ID, including attempts by another owner.
  private readonly retiredVaults = new Set<string>();
  private readonly vaultOwners = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly verifyIdentity: PrototypeOptions['verifyIdentity'];
  private readonly clock: () => number;
  private readonly hooks: PrototypeHooks;
  private restoreReady = true;

  constructor(options: PrototypeOptions) {
    this.verifyIdentity = options.verifyIdentity;
    this.clock = options.clock ?? Date.now;
    this.hooks = { ...options.hooks };
    for (const identity of options.identities) {
      if (this.identities.has(identity.ownerId) || !identity.ownerId || new Set(identity.sessions.map(session => session.id)).size !== identity.sessions.length)
        throw new Error('INVALID_PROTOTYPE_SEED');
      this.identities.set(identity.ownerId, {
        enabled: identity.enabled ?? true,
        lifecycleVersion: 1,
        fence: 0,
        sessions: new Map(identity.sessions.map(session => [session.id, { expiresAtMs: session.expiresAtMs, live: true }])),
        envelope: null,
        receipts: new Map(),
        resetReceipts: new Map(),
      });
    }
  }

  private async locked<T>(ownerId: string, run: () => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(ownerId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => {
      release = resolve;
    });
    this.queues.set(ownerId, next);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.queues.get(ownerId) === next) this.queues.delete(ownerId);
    }
  }

  private async actor(authorization: string): Promise<VerifiedPrototypeIdentity> {
    let identity: VerifiedPrototypeIdentity | null;
    try {
      identity = await this.verifyIdentity(authorization);
    } catch {
      throw new OpaqueError('UNAUTHENTICATED');
    }
    if (!identity || !identity.ownerId || !identity.sessionId) throw new OpaqueError('UNAUTHENTICATED');
    return copyIdentity(identity);
  }

  private live(identity: VerifiedPrototypeIdentity): IdentityState {
    if (!this.restoreReady) throw new PrototypeError('RESTORE_QUARANTINED');
    const state = this.identities.get(identity.ownerId);
    if (!state?.enabled) throw new PrototypeError('IDENTITY_DISABLED');
    const session = state.sessions.get(identity.sessionId);
    const now = this.clock();
    if (!Number.isFinite(now) || !session?.live || !Number.isFinite(session.expiresAtMs) || session.expiresAtMs <= now)
      throw new PrototypeError('SESSION_REVOKED');
    return state;
  }

  private requireRecentLogin(identity: VerifiedPrototypeIdentity): void {
    const proof = identity.authentication;
    const now = this.clock();
    if (
      !proof ||
      proof.ownerId !== identity.ownerId ||
      proof.sessionId !== identity.sessionId ||
      !['password', 'google'].includes(proof.method) ||
      !Number.isFinite(proof.authenticatedAtMs) ||
      !Number.isFinite(now) ||
      proof.authenticatedAtMs > now ||
      proof.authenticatedAtMs <= now - RECENT_LOGIN_MS
    ) {
      throw new OpaqueError('REAUTHENTICATION_REQUIRED');
    }
  }

  private checkPut(state: IdentityState, identity: VerifiedPrototypeIdentity, put: OpaquePut, requestHash: string): OpaqueReceipt | null {
    if (put.envelope.ownerId !== identity.ownerId) throw new OpaqueError('FORBIDDEN');
    // Retired contexts cannot use an old receipt as a capability to revive data.
    if (this.retiredVaults.has(put.envelope.vaultId)) throw new PrototypeError('VAULT_RETIRED');
    const contextOwner = this.vaultOwners.get(put.envelope.vaultId);
    if (contextOwner && contextOwner !== identity.ownerId) throw new OpaqueError('FORBIDDEN');
    const prior = state.receipts.get(put.operationId);
    if (prior) {
      if (prior.requestHash !== requestHash) throw new OpaqueError('OPERATION_CONFLICT');
      return { ...prior.receipt };
    }
    assertOpaqueTransition(state.envelope, put);
    if (!state.envelope || state.envelope.keyEpoch !== put.envelope.keyEpoch) this.requireRecentLogin(identity);
    return null;
  }

  async read(authorization: string): Promise<{ envelope: VaultEnvelope | null; lifecycleVersion: number }> {
    const identity = await this.actor(authorization);
    return this.locked(identity.ownerId, () => {
      const state = this.live(identity);
      if (state.envelope && this.retiredVaults.has(state.envelope.vaultId)) throw new PrototypeError('VAULT_RETIRED');
      return { envelope: state.envelope ? validateEnvelope(state.envelope) : null, lifecycleVersion: state.lifecycleVersion };
    });
  }

  async put(authorization: string, input: Uint8Array): Promise<OpaqueReceipt> {
    const { bytes, put } = parseBytes(input);
    const identity = await this.actor(authorization);
    const requestHash = await hashOpaqueRequest(bytes);
    const prepared = await this.locked(identity.ownerId, () => {
      const state = this.live(identity);
      return { lifecycleVersion: state.lifecycleVersion, prior: this.checkPut(state, identity, put, requestHash) };
    });
    if (prepared.prior) return prepared.prior;
    const context = { ownerId: identity.ownerId, operationId: put.operationId, revision: put.envelope.revision };
    try {
      await this.hooks.beforeCommit?.(context);
    } catch {
      throw new OpaqueError('STORAGE_UNAVAILABLE');
    }
    const result = await this.locked(identity.ownerId, () => {
      const current = this.live(identity);
      if (current.lifecycleVersion !== prepared.lifecycleVersion) throw new PrototypeError('LIFECYCLE_CHANGED');
      const prior = this.checkPut(current, identity, put, requestHash);
      if (prior) return { receipt: prior, committed: false };
      const next = copyState(current);
      next.envelope = validateEnvelope(put.envelope);
      const receipt = { revision: put.envelope.revision, operationId: put.operationId };
      next.receipts.set(put.operationId, { requestHash, receipt });
      next.fence++;
      // No shared state is changed until both snapshot and receipt are ready.
      try {
        this.hooks.beforeReceiptCommit?.(context);
      } catch {
        throw new OpaqueError('STORAGE_UNAVAILABLE');
      }
      this.vaultOwners.set(put.envelope.vaultId, identity.ownerId);
      this.identities.set(identity.ownerId, next);
      return { receipt: { ...receipt }, committed: true };
    });
    if (result.committed) {
      try {
        await this.hooks.afterCommit?.(context);
      } catch {
        throw new PrototypeError('COMMIT_UNCONFIRMED');
      }
    }
    return result.receipt;
  }

  /** Trusted harness control, not a request endpoint or authentication API. */
  async revokeSession(ownerId: string, sessionId: string): Promise<void> {
    await this.locked(ownerId, () => {
      const current = this.identities.get(ownerId);
      if (!current) throw new OpaqueError('FORBIDDEN');
      const next = copyState(current);
      const session = next.sessions.get(sessionId);
      if (!session?.live) return;
      session.live = false;
      next.lifecycleVersion++;
      next.fence++;
      this.identities.set(ownerId, next);
    });
  }

  /** Trusted harness control; suspension shares the same per-identity fence. */
  async disableIdentity(ownerId: string): Promise<void> {
    await this.locked(ownerId, () => {
      const current = this.identities.get(ownerId);
      if (!current) throw new OpaqueError('FORBIDDEN');
      const next = copyState(current);
      next.enabled = false;
      next.lifecycleVersion++;
      next.fence++;
      this.identities.set(ownerId, next);
    });
  }

  /** Models context retirement only; full account deletion/purge is outside 6A. */
  async reset(authorization: string, command: PrototypeResetCommand): Promise<PrototypeResetReceipt> {
    let checked: PrototypeResetCommand;
    try {
      const record = requireClosedRecord(command, ['operationId', 'expectedLifecycleVersion', 'expectedVaultId']);
      if (!Number.isSafeInteger(record.expectedLifecycleVersion) || Number(record.expectedLifecycleVersion) < 1) throw new OpaqueError('INVALID_ENVELOPE');
      decodeBase64Url(record.operationId as string, 16);
      decodeBase64Url(record.expectedVaultId as string, 16);
      checked = {
        operationId: record.operationId as string,
        expectedLifecycleVersion: Number(record.expectedLifecycleVersion),
        expectedVaultId: record.expectedVaultId as string,
      };
    } catch {
      throw new OpaqueError('INVALID_ENVELOPE');
    }
    const identity = await this.actor(authorization);
    const hash = await hashOpaqueRequest(new TextEncoder().encode(JSON.stringify(checked)));
    return this.locked(identity.ownerId, () => {
      const current = this.live(identity);
      this.requireRecentLogin(identity);
      const prior = current.resetReceipts.get(checked.operationId);
      if (prior) {
        if (prior.hash !== hash) throw new OpaqueError('OPERATION_CONFLICT');
        return { ...prior.receipt };
      }
      if (current.lifecycleVersion !== checked.expectedLifecycleVersion) throw new PrototypeError('LIFECYCLE_CHANGED');
      if (!current.envelope || current.envelope.vaultId !== checked.expectedVaultId) throw new OpaqueError('FORBIDDEN');
      const next = copyState(current);
      next.envelope = null;
      next.lifecycleVersion++;
      next.fence++;
      for (const [id, session] of next.sessions) if (id !== identity.sessionId) session.live = false;
      const receipt = { operationId: checked.operationId, lifecycleVersion: next.lifecycleVersion, retiredVaultId: checked.expectedVaultId };
      next.resetReceipts.set(checked.operationId, { hash, receipt });
      this.retiredVaults.add(checked.expectedVaultId);
      this.identities.set(identity.ownerId, next);
      return { ...receipt };
    });
  }

  /** Closed by default after a simulated restore; no automatic release path. */
  quarantineRestore(): void {
    this.restoreReady = false;
  }
}

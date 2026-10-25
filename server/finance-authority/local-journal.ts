/**
 * 6B.5A LOCAL SYNTHETIC BENCH ONLY. No route, credentials or hosted admission.
 * SQLite demonstrates an independently persisted lifecycle journal, not cloud
 * durability. Never import this module into TR8, an Edge Function or a Worker.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, string | number | bigint | Uint8Array | null>;
export type LifecycleCommand = {
  operationId: string;
  ownerId: string;
  expectedEpoch: string;
  kind: 'reset' | 'revoke' | 'purge';
  vaultId: string | null;
  targetSessionId: string | null;
};
export type LifecycleReceipt = { operationId: string; epoch: string; digest: string };
export class JournalError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'INVALID_INPUT' | 'CONFLICT' | 'PENDING' | 'DENIED' | 'UNTRUSTED_AUTHORITY') {
    super(code);
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const opaque = /^[A-Za-z0-9_-]{21}[AQgw]$/;
function fail(code: ConstructorParameters<typeof JournalError>[0]): never {
  throw new JournalError(code);
}
function epoch(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) fail('INVALID_INPUT');
  return BigInt(value);
}
function canonical(value: LifecycleCommand): string {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_INPUT');
  const keys = ['operationId', 'ownerId', 'expectedEpoch', 'kind', 'vaultId', 'targetSessionId'];
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some(
      k =>
        typeof k !== 'string' ||
        !keys.includes(k) ||
        !Object.getOwnPropertyDescriptor(value, k)!.enumerable ||
        !('value' in Object.getOwnPropertyDescriptor(value, k)!),
    )
  )
    fail('INVALID_INPUT');
  if (typeof value.operationId !== 'string' || typeof value.ownerId !== 'string' || !opaque.test(value.operationId) || !uuid.test(value.ownerId))
    fail('INVALID_INPUT');
  epoch(value.expectedEpoch);
  if (value.kind === 'revoke') {
    if (value.vaultId !== null || typeof value.targetSessionId !== 'string' || !uuid.test(value.targetSessionId)) fail('INVALID_INPUT');
  } else if (value.kind === 'reset' || value.kind === 'purge') {
    if (typeof value.vaultId !== 'string' || !opaque.test(value.vaultId) || value.targetSessionId !== null) fail('INVALID_INPUT');
  } else fail('INVALID_INPUT');
  return JSON.stringify(Object.fromEntries(keys.map(key => [key, value[key as keyof LifecycleCommand]])));
}

export class LocalSyntheticJournal {
  private readonly db: DatabaseSync;
  private closed = false;
  /** Opening is not bootstrapping. Missing state never silently becomes trusted. */
  constructor(
    path: string,
    private readonly authorityId: string,
  ) {
    if (!uuid.test(authorityId) || !existsSync(path)) fail('UNTRUSTED_AUTHORITY');
    this.db = new DatabaseSync(path, { open: true });
    try {
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
      if (this.row('SELECT authority_id FROM authority WHERE singleton=1')?.authority_id !== authorityId) fail('UNTRUSTED_AUTHORITY');
    } catch {
      this.db.close();
      fail('UNTRUSTED_AUTHORITY');
    }
  }
  /** Explicit synthetic fixture provisioning; never called during normal open. */
  static provision(path: string, authorityId: string, ownerId: string, vaultId: string): void {
    if (existsSync(path) || !uuid.test(authorityId) || !uuid.test(ownerId) || !opaque.test(vaultId)) fail('INVALID_INPUT');
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE authority(singleton INTEGER PRIMARY KEY CHECK(singleton=1),authority_id TEXT NOT NULL);
      CREATE TABLE owners(owner_id TEXT PRIMARY KEY,epoch TEXT NOT NULL,purged INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE vaults(vault_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,retired INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE revoked(owner_id TEXT NOT NULL,session_id TEXT NOT NULL,PRIMARY KEY(owner_id,session_id));
      CREATE TABLE operations(operation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,command TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','committed')),next_epoch TEXT NOT NULL);
      CREATE UNIQUE INDEX one_pending_per_owner ON operations(owner_id) WHERE status='pending';
      BEGIN IMMEDIATE;`);
      db.prepare('INSERT INTO authority VALUES(1,?)').run(authorityId);
      db.prepare('INSERT INTO owners(owner_id,epoch) VALUES(?,?)').run(ownerId, '1');
      db.prepare('INSERT INTO vaults(vault_id,owner_id) VALUES(?,?)').run(vaultId, ownerId);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
  }
  private row(sql: string, ...args: string[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  private transaction<T>(work: () => T): T {
    if (this.closed) fail('UNAVAILABLE');
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* A closed or unavailable journal cannot grant access. */
      }
      if (error instanceof JournalError) throw error;
      fail('UNAVAILABLE');
    }
  }
  private owner(id: string): Row {
    const owner = this.row('SELECT * FROM owners WHERE owner_id=?', id);
    if (!owner || owner.purged !== 0) fail('DENIED');
    return owner;
  }
  /** Caller supplies a server-verified principal in a future adapter, never a browser owner field. */
  prepare(input: LifecycleCommand): LifecycleReceipt {
    const command = canonical(input);
    const value = JSON.parse(command) as LifecycleCommand;
    const digest = createHash('sha256').update(command).digest('hex');
    return this.transaction(() => {
      const owner = this.owner(value.ownerId);
      const prior = this.row('SELECT * FROM operations WHERE operation_id=?', value.operationId);
      if (prior) {
        if (prior.owner_id !== value.ownerId || prior.command !== command) fail('CONFLICT');
        return { operationId: value.operationId, epoch: String(prior.next_epoch), digest };
      }
      if (this.row("SELECT operation_id FROM operations WHERE owner_id=? AND status='pending'", value.ownerId)) fail('PENDING');
      if (owner.epoch !== value.expectedEpoch) fail('CONFLICT');
      const next = epoch(value.expectedEpoch) + 1n;
      if (next > 9223372036854775807n) fail('CONFLICT');
      if (value.vaultId) {
        const vault = this.row('SELECT * FROM vaults WHERE vault_id=?', value.vaultId);
        if (!vault || vault.owner_id !== value.ownerId || vault.retired !== 0) fail('DENIED');
      }
      this.db.prepare("INSERT INTO operations VALUES(?,?,?,?, 'pending',?)").run(value.operationId, value.ownerId, command, digest, String(next));
      return { operationId: value.operationId, epoch: String(next), digest };
    });
  }
  /** This local receipt models a verified matching DB acknowledgement, not an HTTP assertion. */
  commit(ownerId: string, ack: LifecycleReceipt): LifecycleReceipt {
    if (!uuid.test(ownerId) || !ack || !opaque.test(ack.operationId) || !/^[a-f0-9]{64}$/.test(ack.digest)) fail('INVALID_INPUT');
    epoch(ack.epoch);
    return this.transaction(() => {
      const op = this.row('SELECT * FROM operations WHERE operation_id=?', ack.operationId);
      if (!op || op.owner_id !== ownerId || op.next_epoch !== ack.epoch || op.digest !== ack.digest) fail('CONFLICT');
      if (op.status === 'committed') return { operationId: ack.operationId, epoch: ack.epoch, digest: ack.digest };
      const owner = this.owner(ownerId);
      const command = JSON.parse(String(op.command)) as LifecycleCommand;
      if (owner.epoch !== command.expectedEpoch) fail('CONFLICT');
      if (command.kind === 'revoke') this.db.prepare('INSERT OR IGNORE INTO revoked VALUES(?,?)').run(ownerId, command.targetSessionId!);
      else if (command.kind === 'reset') this.db.prepare('UPDATE vaults SET retired=1 WHERE vault_id=? AND owner_id=?').run(command.vaultId!, ownerId);
      else {
        this.db.prepare('UPDATE vaults SET retired=1 WHERE owner_id=?').run(ownerId);
        this.db.prepare('UPDATE owners SET purged=1 WHERE owner_id=?').run(ownerId);
      }
      this.db.prepare('UPDATE owners SET epoch=? WHERE owner_id=?').run(ack.epoch, ownerId);
      this.db.prepare("UPDATE operations SET status='committed' WHERE operation_id=?").run(ack.operationId);
      return { operationId: ack.operationId, epoch: ack.epoch, digest: ack.digest };
    });
  }
  /** A negative gate only. A pass never replaces Auth, RLS or current-session checks. */
  assertProjection(view: { ownerId: string; sessionId: string; vaultId: string; epoch: string }): void {
    if (!uuid.test(view.ownerId) || !uuid.test(view.sessionId) || !opaque.test(view.vaultId)) fail('INVALID_INPUT');
    epoch(view.epoch);
    this.transaction(() => {
      this.owner(view.ownerId);
      if (this.row("SELECT operation_id FROM operations WHERE owner_id=? AND status='pending'", view.ownerId)) fail('PENDING');
      // Current lifecycle before receipts or projection comparison.
      const vault = this.row('SELECT * FROM vaults WHERE vault_id=?', view.vaultId);
      if (
        !vault ||
        vault.retired !== 0 ||
        vault.owner_id !== view.ownerId ||
        this.row('SELECT session_id FROM revoked WHERE owner_id=? AND session_id=?', view.ownerId, view.sessionId)
      )
        fail('DENIED');
      if (this.owner(view.ownerId).epoch !== view.epoch) fail('CONFLICT');
    });
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}

/** Local synthetic SQLite adapter only. Never import into the browser or Edge runtime. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  SyntheticLifecycleJournal,
  JOURNAL_SCHEMA,
  JournalError,
  canonical,
  fail,
  uuid,
  opaque,
  type JournalSql,
  type Row,
  type LifecycleCommand,
  type LifecycleReceipt,
} from './journal-core';
export { JournalError, type LifecycleCommand, type LifecycleReceipt } from './journal-core';
function open(path: string, authorityId: string) {
  if (!uuid.test(authorityId) || !existsSync(path)) fail('UNTRUSTED_AUTHORITY');
  const db = new DatabaseSync(path);
  let closed = false;
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
    if (db.prepare('SELECT authority_id FROM authority WHERE singleton=1').get()?.authority_id !== authorityId) fail('UNTRUSTED_AUTHORITY');
  } catch {
    db.close();
    fail('UNTRUSTED_AUTHORITY');
  }
  const sql: JournalSql = {
    get: (query, ...args) => db.prepare(query).get(...args) as Row | undefined,
    all: (query, ...args) => db.prepare(query).all(...args) as Row[],
    run: (query, ...args) => {
      db.prepare(query).run(...args);
    },
    transaction: <T>(work: () => T): T => {
      if (closed) fail('UNAVAILABLE');
      try {
        db.exec('BEGIN IMMEDIATE');
        const value = work();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* Unavailable remains denied. */
        }
        if (error instanceof JournalError) throw error;
        fail('UNAVAILABLE');
      }
    },
  };
  return {
    sql,
    close: () => {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
export class LocalSyntheticJournal extends SyntheticLifecycleJournal {
  private readonly shutdown: () => void;
  constructor(path: string, authorityId: string) {
    const local = open(path, authorityId);
    super(local.sql, authorityId);
    this.shutdown = local.close;
  }
  static provision(path: string, authorityId: string, ownerId: string, vaultId: string) {
    if (existsSync(path) || !uuid.test(authorityId) || !uuid.test(ownerId) || !opaque.test(vaultId)) fail('INVALID_INPUT');
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA synchronous=FULL;' + JOURNAL_SCHEMA + 'BEGIN IMMEDIATE;');
      db.prepare('INSERT INTO authority VALUES(1,?)').run(authorityId);
      db.prepare('INSERT INTO owners(owner_id,epoch) VALUES(?,?)').run(ownerId, '1');
      db.prepare('INSERT INTO vaults(vault_id,owner_id) VALUES(?,?)').run(vaultId, ownerId);
      db.exec('COMMIT');
    } finally {
      db.close();
    }
  }
  prepare(input: LifecycleCommand): LifecycleReceipt {
    const value = canonical(input);
    return super.prepare(JSON.parse(value), createHash('sha256').update(value).digest('hex'));
  }
  close() {
    this.shutdown();
  }
}

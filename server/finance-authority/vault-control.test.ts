import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import vector from '../../src/app/finance/compatibility/fixtures/vault-vectors.json';
import { encodeBase64Url, type VaultEnvelope } from '../../src/app/finance/compatibility/protocol';
import {
  CONTROL_SCHEMA,
  CONTROL_PROTOCOL,
  VaultControlJournal,
  stable,
  sha256,
  envelopeHead,
  assertCurrentEnvelope,
  initialControlState,
  assertControlAccess,
  advance,
  type ControlCommand,
} from './vault-control';
import type { JournalSql, Row } from './journal-core';
const authority = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  owner = '37848d70-989a-4f69-b124-0c959d8b49a6';
const session = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const identity = { actorSessionId: session, sessionCreatedAtMs: 1, targetSessionId: null };
let db: DatabaseSync, journal: VaultControlJournal, sql: JournalSql;
export function opaqueBytes(n: number, length = 16) {
  return encodeBase64Url(new Uint8Array(length).fill(n));
}
export function fixtureEnvelope() {
  return { ...structuredClone(vector.envelope), ownerId: owner } as VaultEnvelope;
}
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(CONTROL_SCHEMA);
  db.prepare('INSERT INTO control_meta VALUES(1,?,?)').run(authority, CONTROL_PROTOCOL);
  db.prepare('INSERT INTO control_owners VALUES(?,?)').run(owner, stable({ ...initialControlState(owner), sessions: { [session]: '1' } }));
  sql = {
    get: (s, ...a) => db.prepare(s).get(...a) as Row | undefined,
    all: (s, ...a) => db.prepare(s).all(...a) as Row[],
    run: (s, ...a) => {
      db.prepare(s).run(...a);
    },
    transaction: <T>(f: () => T) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = f();
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  journal = new VaultControlJournal(sql, authority);
});
describe('6B.5D.2 independent identity lifecycle', () => {
  const second = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const lifecycle = (kind: ControlCommand['kind'], targetSessionId: string | null = null): ControlCommand => ({
    ...identity,
    ownerId: owner,
    operationId: opaqueBytes(20),
    expectedSequence: journal.state(owner).sequence,
    kind,
    expectedHead: journal.state(owner).head,
    head: null,
    targetSessionId,
  });
  async function commit(command: ControlCommand, at = 1000) {
    const op = journal.prepare(command, await sha256(stable(command)), at);
    return journal.commit(owner, command.operationId, op.digest);
  }
  it('requires explicit enrollment even when Supabase says the session is valid', () => {
    expect(() => assertControlAccess(initialControlState(owner), session)).toThrow('DENIED');
  });
  it('enrolls a new server-verified session and binds its generation', async () => {
    const command = { ...lifecycle('enroll'), actorSessionId: second, sessionCreatedAtMs: 100 };
    const after = await commit(command);
    expect(() => assertControlAccess(after, second)).not.toThrow();
    expect(after.sessions[second]).toBe('1');
  });
  it('revokes a session permanently, including after an Auth-row restoration', async () => {
    const after = await commit(lifecycle('revoke', session));
    expect(() => assertControlAccess(after, session)).toThrow('DENIED');
    const reenroll = { ...lifecycle('enroll'), operationId: opaqueBytes(21), sessionCreatedAtMs: 2000 };
    expect(() => advance(after, reenroll, 2001)).toThrow('DENIED');
  });
  it('supports self-revocation and still permits receipt-only finalization', async () => {
    const command = lifecycle('revoke', session);
    const op = journal.prepare(command, await sha256(stable(command)), 1000);
    const after = journal.commit(owner, command.operationId, op.digest);
    expect(() => assertControlAccess(after, session)).toThrow('DENIED');
    expect(journal.commit(owner, command.operationId, op.digest)).toEqual(after);
  });
  it.each(['logout-all', 'disable', 'delete', 'reset'] as const)('blocks all old sessions after %s even when SQL identity is restored', async kind => {
    await write(fixtureEnvelope());
    const after = await commit(lifecycle(kind));
    expect(() => assertControlAccess(after, session)).toThrow('DENIED');
    expect(after.sessions).toEqual({});
    expect(after.sessionEpoch).toBe('2');
    expect(after.sessionCutoffMs).toBe(1000);
    if (['reset', 'delete'].includes(kind)) {
      expect(after.head).toBeNull();
      expect(after.retiredVaults).toHaveLength(1);
    }
    if (kind === 'disable') expect(after.status).toBe('disabled');
    if (kind === 'delete') expect(after.status).toBe('deleted');
  });
  it('denies both known and previously unenrolled sessions predating global logout', async () => {
    const after = await commit(lifecycle('logout-all'));
    for (const id of [session, second]) {
      const c = { ...lifecycle('enroll'), actorSessionId: id, sessionCreatedAtMs: 999, operationId: opaqueBytes(21) };
      expect(() => advance(after, c, 1001)).toThrow('DENIED');
    }
  });
  it('accepts an actually new login after logout-all, without reviving old sessions', async () => {
    await commit(lifecycle('logout-all'));
    const fresh = { ...lifecycle('enroll'), operationId: opaqueBytes(21), actorSessionId: second, sessionCreatedAtMs: 2000 };
    const after = await commit(fresh, 2001);
    expect(() => assertControlAccess(after, second)).not.toThrow();
    expect(() => assertControlAccess(after, session)).toThrow('DENIED');
  });
  it.each(['disable', 'delete'] as const)('does not automatically reenable %s identities', async kind => {
    const after = await commit(lifecycle(kind));
    const c = { ...lifecycle('enroll'), operationId: opaqueBytes(21), actorSessionId: second, sessionCreatedAtMs: 2000 };
    expect(() => advance(after, c, 2001)).toThrow('DENIED');
  });
  it('never reuses a retired vault context after reset', async () => {
    const e = fixtureEnvelope();
    await write(e);
    await commit(lifecycle('reset'));
    await commit({ ...lifecycle('enroll'), operationId: opaqueBytes(21), actorSessionId: second, sessionCreatedAtMs: 2000 }, 2001);
    const command = { ...lifecycle('put'), actorSessionId: second, head: await envelopeHead(e, 'e'.repeat(64)), operationId: e.operationId };
    expect(() => advance(journal.state(owner), command, 2002)).toThrow('DENIED');
  });
  it('bounds security facts instead of silently dropping tombstones', () => {
    const before = journal.state(owner);
    before.sessions = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, '1']));
    expect(() => advance(before, { ...lifecycle('enroll'), actorSessionId: second, sessionCreatedAtMs: 1 }, 1000)).toThrow('UNAVAILABLE');
  });
});
afterEach(() => db.close());
async function write(envelope: VaultEnvelope) {
  const before = journal.state(owner);
  const command: ControlCommand = {
    ...identity,
    ownerId: owner,
    operationId: envelope.operationId,
    kind: 'put',
    expectedSequence: before.sequence,
    expectedHead: before.head,
    head: await envelopeHead(envelope, await sha256(stable(envelope))),
  };
  const op = journal.prepare(command, await sha256(stable(command)));
  journal.commit(owner, command.operationId, op.digest);
  return op;
}
function next(e: VaultEnvelope, n: number) {
  const copy = structuredClone(e);
  copy.operationId = opaqueBytes(n);
  copy.revision = String(BigInt(e.revision) + 1n);
  copy.payload.nonce = opaqueBytes(n, 12);
  copy.payload.keySalt = opaqueBytes(n, 32);
  return copy;
}
describe('6B.5D.1 authoritative encrypted head', () => {
  it('records only head metadata, never ciphertext or wrapped keys', async () => {
    const e = fixtureEnvelope();
    await write(e);
    const rows = JSON.stringify(db.prepare('SELECT * FROM control_intents').all());
    expect(rows).not.toContain(e.payload.ciphertext);
    expect(rows).not.toContain(e.passwordWrap.wrappedKey);
    expect(journal.state(owner).head?.revision).toBe('1');
  });
  it('accepts the exact current envelope independently of JSON key order', async () => {
    const e = fixtureEnvelope();
    await write(e);
    const reversed = Object.fromEntries(Object.entries(e).reverse()) as unknown as VaultEnvelope;
    await expect(assertCurrentEnvelope(journal.state(owner), reversed)).resolves.toBeUndefined();
  });
  it.each(['snapshot', 'password', 'recovery', 'root-key'])('rejects an old %s after a newer head commits', async change => {
    const old = fixtureEnvelope();
    await write(old);
    const e = next(old, 3);
    if (change !== 'snapshot') {
      e.credentialEpoch = '2';
      e.passwordWrap = { ...e.passwordWrap, slotEpoch: '2', salt: opaqueBytes(3), nonce: opaqueBytes(3, 12), wrappedKey: opaqueBytes(3, 48) };
      e.recoveryWrap = { ...e.recoveryWrap, slotEpoch: '2', salt: opaqueBytes(3, 32), nonce: opaqueBytes(4, 12), wrappedKey: opaqueBytes(4, 48) };
    }
    if (change === 'root-key') e.keyEpoch = '2';
    await write(e);
    await expect(assertCurrentEnvelope(journal.state(owner), old)).rejects.toThrow('CONFLICT');
    const forged = { ...structuredClone(e), payload: old.payload };
    await expect(assertCurrentEnvelope(journal.state(owner), forged)).rejects.toThrow('CONFLICT');
  });
  it('rejects a missing envelope and an envelope transplanted from another owner', async () => {
    const e = fixtureEnvelope();
    await write(e);
    await expect(assertCurrentEnvelope(journal.state(owner), null)).rejects.toThrow('CONFLICT');
    await expect(assertCurrentEnvelope(journal.state(owner), { ...e, ownerId: authority })).rejects.toThrow('CONFLICT');
  });
  it('rejects writes that decrease a key or credential epoch', async () => {
    const e = fixtureEnvelope();
    e.keyEpoch = '1';
    await write(e);
    const current = next(e, 3);
    current.keyEpoch = '2';
    current.credentialEpoch = '2';
    await write(current);
    const downgraded = next(current, 4);
    downgraded.keyEpoch = '1';
    const c: ControlCommand = {
      ...identity,
      kind: 'put',
      ownerId: owner,
      operationId: downgraded.operationId,
      expectedSequence: journal.state(owner).sequence,
      expectedHead: journal.state(owner).head,
      head: await envelopeHead(downgraded, 'f'.repeat(64)),
    };
    expect(() => journal.prepare(c, 'e'.repeat(64))).toThrow('CONFLICT');
  });
  it('rejects replay under another operation ID or another head', async () => {
    const e = fixtureEnvelope();
    const op = await write(e);
    expect(() => journal.prepare({ ...op.command, head: { ...op.command.head!, digest: 'f'.repeat(64) } }, op.digest)).toThrow('CONFLICT');
    expect(journal.prepare(op.command, op.digest)).toEqual({ ...op, status: 'committed' });
  });
  it('keeps a prepared head pending until an exact database acknowledgement', async () => {
    const e = fixtureEnvelope();
    const command: ControlCommand = {
      ...identity,
      ownerId: owner,
      operationId: e.operationId,
      expectedSequence: '1',
      kind: 'put',
      expectedHead: null,
      head: await envelopeHead(e, 'f'.repeat(64)),
    };
    const op = journal.prepare(command, await sha256(stable(command)));
    expect(journal.state(owner).head).toBeNull();
    expect(journal.pending(owner)).not.toBeNull();
    expect(() => journal.commit(owner, command.operationId, '0'.repeat(64))).toThrow('CONFLICT');
    expect(journal.pending(owner)?.digest).toBe(op.digest);
  });
  it('does not initialize missing or differently pinned storage', () => {
    expect(() => new VaultControlJournal(sql, owner)).toThrow('UNTRUSTED_AUTHORITY');
    db.prepare('DELETE FROM control_owners').run();
    expect(() => journal.state(owner)).toThrow('UNTRUSTED_AUTHORITY');
  });
});

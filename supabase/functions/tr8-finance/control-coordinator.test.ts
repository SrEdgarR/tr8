import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import vector from '../../../src/app/finance/compatibility/fixtures/vault-vectors.json';
import {
  CONTROL_SCHEMA,
  CONTROL_PROTOCOL,
  VaultControlJournal,
  initialControlState,
  stable,
  sha256,
  advance,
  type ControlState,
  type ControlIntent,
} from '../../../server/finance-authority/vault-control';
import type { JournalSql, Row } from '../../../server/finance-authority/journal-core';
import { CONTROL_OWNER, CONTROL_AUTHORITY, type ControlAuthority } from './control-client';
import { controlCoordinator } from './control-coordinator';
import { finalizeNegativeIntent } from './operator-recovery';
import { FinanceError, type FinanceRuntime, type FinanceActor } from './handler';
const session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  now = Date.now();
const actor: FinanceActor = { id: CONTROL_OWNER, session, expiresAt: now / 1000 + 3600, passwordAt: Math.floor(now / 1000) };
let db: DatabaseSync,
  journal: VaultControlJournal,
  authority: ControlAuthority,
  raw: FinanceRuntime,
  service: ReturnType<typeof controlCoordinator>,
  projection: ControlState,
  envelope: unknown,
  receipts: Map<string, ControlIntent>;
const body = () =>
  JSON.stringify({
    expectedRevision: '0',
    operationId: vector.envelope.operationId,
    envelope: { ...structuredClone(vector.envelope), ownerId: CONTROL_OWNER },
  });
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(CONTROL_SCHEMA);
  db.prepare('INSERT INTO control_meta VALUES(1,?,?)').run(CONTROL_AUTHORITY, CONTROL_PROTOCOL);
  projection = { ...initialControlState(CONTROL_OWNER), sessions: { [session]: '1' } };
  db.prepare('INSERT INTO control_owners VALUES(?,?)').run(CONTROL_OWNER, stable(projection));
  const sql: JournalSql = {
    get: (q, ...a) => db.prepare(q).get(...a) as Row | undefined,
    all: (q, ...a) => db.prepare(q).all(...a) as Row[],
    run: (q, ...a) => {
      db.prepare(q).run(...a);
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
  journal = new VaultControlJournal(sql, CONTROL_AUTHORITY);
  authority = {
    configured: true,
    caseId: 'resume',
    view: async () => ({ state: journal.state(CONTROL_OWNER), pending: journal.pending(CONTROL_OWNER) }),
    operation: async id => journal.operation(CONTROL_OWNER, id),
    prepare: async c => journal.prepare(c, await sha256(stable(c)), now),
    commit: async op => journal.commit(CONTROL_OWNER, op.command.operationId, op.digest),
  };
  envelope = null;
  receipts = new Map();
  raw = {
    enabled: true,
    origin: 'http://127.0.0.1:5174',
    authenticate: async () => actor,
    call: async (action, _actor, args) => {
      if (action === 'probe') return { sessionCreatedAtMs: 1 };
      if (action === 'operation') return receipts.get(args.p_operation_id as string) ?? null;
      if (stable(args.p_expected) !== stable(projection)) throw new FinanceError('FINANCE_CONFLICT', 409);
      if (action === 'read') return { state: structuredClone(projection), envelope: structuredClone(envelope) };
      if (action === 'authorize') return { authorized: true };
      if (action === 'apply') {
        const intent = args.p_intent as ControlIntent;
        projection = structuredClone(intent.next);
        envelope = args.p_envelope;
        receipts.set(intent.command.operationId, structuredClone(intent));
        return structuredClone(intent);
      }
      if (action === 'repair') {
        projection = structuredClone(args.p_expected as ControlState);
        envelope = args.p_envelope;
        return { repaired: true };
      }
      throw Error('Unknown SQL action');
    },
  };
  service = controlCoordinator(raw, authority, () => now);
});
describe('private recovery without the initiating Auth session', () => {
  async function prepared(kind: 'revoke' | 'put' = 'revoke') {
    if (kind === 'put') {
      const original = raw.call;
      raw.call = async (a, p, v) => {
        if (a === 'apply') throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
        return original(a, p, v);
      };
      await expect(service.put(actor, body())).rejects.toMatchObject({ status: 503 });
      return journal.pending(CONTROL_OWNER)!;
    }
    const command = {
      ownerId: CONTROL_OWNER,
      operationId: 'BBBBBBBBBBBBBBBBBBBBBA',
      expectedSequence: projection.sequence,
      kind: 'revoke' as const,
      expectedHead: projection.head,
      head: null,
      actorSessionId: session,
      sessionCreatedAtMs: 1,
      targetSessionId: session,
    };
    return journal.prepare(command, await sha256(stable(command)), now);
  }
  it('can finish self-revocation from the private SQL receipt without a user token', async () => {
    const op = await prepared();
    await raw.call('apply', actor, { p_expected: projection, p_intent: op, p_envelope: null });
    await expect(finalizeNegativeIntent(authority, op.command.operationId, async id => receipts.get(id) ?? null)).resolves.toMatchObject({ sequence: '2' });
    expect(journal.pending(CONTROL_OWNER)).toBeNull();
    expect(journal.state(CONTROL_OWNER).revokedSessions).toContain(session);
  });
  it('never finalizes an intent when the database did not commit it', async () => {
    const op = await prepared();
    await expect(finalizeNegativeIntent(authority, op.command.operationId, async () => null)).rejects.toMatchObject({ status: 503 });
    expect(journal.pending(CONTROL_OWNER)).not.toBeNull();
  });
  it('rejects metadata from an unrelated SQL operation', async () => {
    const op = await prepared();
    await expect(finalizeNegativeIntent(authority, op.command.operationId, async () => ({ ...op, digest: 'f'.repeat(64) }))).rejects.toMatchObject({
      status: 503,
    });
    expect(journal.pending(CONTROL_OWNER)).not.toBeNull();
  });
  it('cannot use the private recovery path to acknowledge financial writes', async () => {
    const op = await prepared('put');
    let read = false;
    await expect(
      finalizeNegativeIntent(authority, op.command.operationId, async () => {
        read = true;
        return op;
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(read).toBe(false);
  });
  it('remains closed if the independent authority cannot be queried', async () => {
    authority.view = async () => {
      throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
    };
    await expect(finalizeNegativeIntent(authority, 'BBBBBBBBBBBBBBBBBBBBBA', async () => null)).rejects.toMatchObject({ status: 503 });
  });
});
afterEach(() => db.close());
describe('6B.5D.3 interrupted operation recovery', () => {
  it('confirms an encrypted head only after SQL commits matching evidence', async () => {
    await expect(service.put(actor, body())).resolves.toMatchObject({ sequence: '2' });
    expect(journal.state(CONTROL_OWNER)).toEqual(projection);
    await expect(service.read(actor)).resolves.toMatchObject({ envelope: { revision: '1' } });
  });
  it('recovers a lost SQL reply using the stored receipt without another write', async () => {
    const original = raw.call;
    let applyCount = 0;
    raw.call = async (a, p, v) => {
      const r = await original(a, p, v);
      if (a === 'apply') {
        applyCount++;
        throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
      }
      return r;
    };
    await expect(service.put(actor, body())).rejects.toMatchObject({ status: 503 });
    expect(journal.pending(CONTROL_OWNER)).not.toBeNull();
    await expect(service.resume(actor, vector.envelope.operationId)).resolves.toMatchObject({ sequence: '2' });
    expect(applyCount).toBe(1);
    expect(journal.pending(CONTROL_OWNER)).toBeNull();
  });
  it('requires the original bytes if SQL never committed the pending encrypted write', async () => {
    const original = raw.call;
    raw.call = async (a, p, v) => {
      if (a === 'apply') throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
      return original(a, p, v);
    };
    await expect(service.put(actor, body())).rejects.toMatchObject({ status: 503 });
    await expect(service.resume(actor, vector.envelope.operationId)).rejects.toMatchObject({ code: 'ORIGINAL_ENVELOPE_REQUIRED' });
    raw.call = original;
    await expect(service.resume(actor, vector.envelope.operationId, body())).resolves.toMatchObject({ sequence: '2' });
  });
  it('does not accept altered bytes under a committed operation ID', async () => {
    await service.put(actor, body());
    const changed = JSON.parse(body());
    changed.envelope.payload.ciphertext = changed.envelope.payload.ciphertext.slice(0, -2) + 'AA';
    await expect(service.put(actor, JSON.stringify(changed))).rejects.toMatchObject({ status: 409 });
    expect(journal.state(CONTROL_OWNER)).toEqual(projection);
  });
  it('does not cancel a pending intent when the client goes away', async () => {
    const original = raw.call;
    raw.call = async (a, p, v) => {
      if (a === 'apply') throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
      return original(a, p, v);
    };
    await expect(service.put(actor, body())).rejects.toMatchObject({ status: 503 });
    await expect(service.read(actor)).rejects.toMatchObject({ code: 'RESTORE_QUARANTINED' });
    const later = controlCoordinator(raw, authority, () => now + 600000);
    await expect(later.read(actor)).rejects.toMatchObject({ code: 'RESTORE_QUARANTINED' });
  });
  it('resumes after the independent commit response is lost', async () => {
    const original = authority.commit;
    authority.commit = async intent => {
      await original(intent);
      throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
    };
    await expect(service.put(actor, body())).rejects.toMatchObject({ status: 503 });
    await expect(service.resume(actor, vector.envelope.operationId)).resolves.toMatchObject({ sequence: '2' });
    expect(receipts.size).toBe(1);
  });
  it('does not acknowledge an unrelated or forged SQL receipt', async () => {
    const original = raw.call;
    raw.call = async (a, p, v) => (a === 'apply' ? { ...(v.p_intent as object), digest: 'f'.repeat(64) } : original(a, p, v));
    await expect(service.put(actor, body())).rejects.toMatchObject({ status: 503 });
    expect(journal.pending(CONTROL_OWNER)).not.toBeNull();
  });
  it('discards a financial read if the authority becomes unavailable afterwards', async () => {
    await service.put(actor, body());
    let n = 0;
    const original = authority.view;
    authority.view = async () => {
      if (++n === 2) throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
      return original();
    };
    await expect(service.read(actor)).rejects.toMatchObject({ status: 503 });
  });
  it('denies a restored ordinary snapshot despite a valid logged-in actor', async () => {
    await service.put(actor, body());
    projection = { ...initialControlState(CONTROL_OWNER), sessions: { [session]: '1' } };
    envelope = null;
    await expect(service.read(actor)).rejects.toMatchObject({ status: 409 });
  });
  it('cannot repair from an old envelope or change the pinned authority', async () => {
    await service.put(actor, body());
    const current = projection;
    await expect(service.repair(actor, null)).rejects.toThrow('CONFLICT');
    expect(projection).toEqual(current);
  });
  it('blocks after identity disable even when the SQL enabled flag is restored', async () => {
    await service.identity(actor, 'disable', 'BBBBBBBBBBBBBBBBBBBBBA', '1', null);
    projection = { ...initialControlState(CONTROL_OWNER), sessions: { [session]: '1' } };
    await expect(service.read(actor)).rejects.toThrow('DENIED');
  });
  it('finalizes a self-revocation from another fresh login without returning vault bytes', async () => {
    const original = raw.call;
    raw.call = async (a, p, v) => {
      const r = await original(a, p, v);
      if (a === 'apply') throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
      return r;
    };
    await expect(service.identity(actor, 'revoke', 'BBBBBBBBBBBBBBBBBBBBBA', '1', session)).rejects.toMatchObject({ status: 503 });
    const recoveryActor = { ...actor, session: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
    await expect(service.resume(recoveryActor, 'BBBBBBBBBBBBBBBBBBBBBA')).resolves.toEqual({ operationId: 'BBBBBBBBBBBBBBBBBBBBBA', sequence: '2' });
    expect(() =>
      advance(journal.state(CONTROL_OWNER), {
        ...journal.operation(CONTROL_OWNER, 'BBBBBBBBBBBBBBBBBBBBBA')!.command,
        operationId: 'AAAAAAAAAAAAAAAAAAAAAA',
        expectedSequence: '2',
      }),
    ).toThrow('DENIED');
  });
});

import { describe, it, expect } from 'vitest';
import { advance, initialControlState, sha256, stable, type ControlIntent, type ControlState } from '../../../server/finance-authority/vault-control.ts';
import type { ControlAuthority } from './control-client.ts';
import { witnessedAuthority, type WitnessRecord, type WitnessStorage } from './witness.ts';
const owner = '37848d70-989a-4f69-b124-0c959d8b49a6',
  authorityId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  session = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
async function setup() {
  const initial = initialControlState(owner);
  let cloud = structuredClone(initial),
    pending: ControlIntent | null = null,
    etag = 1,
    failWrite = false;
  let record: WitnessRecord = { protocol: 1, authorityId, ownerId: owner, state: structuredClone(initial), pending: null };
  const command = {
    ownerId: owner,
    operationId: 'AQEBAQEBAQEBAQEBAQEBAQ',
    expectedSequence: initial.sequence,
    kind: 'enroll' as const,
    expectedHead: null,
    head: null,
    actorSessionId: session,
    sessionCreatedAtMs: 100,
    targetSessionId: null,
  };
  const intent: ControlIntent = {
    command,
    digest: await sha256(stable(command)),
    next: advance(initial, command, 1000),
    preparedAtMs: 1000,
    status: 'pending',
  };
  const base: ControlAuthority = {
    configured: true,
    caseId: 'staging',
    async view() {
      return { state: structuredClone(cloud), pending: structuredClone(pending) };
    },
    async operation() {
      return { ...intent, status: cloud.sequence === intent.next.sequence ? 'committed' : 'pending' };
    },
    async prepare() {
      pending = structuredClone(intent);
      return structuredClone(intent);
    },
    async commit() {
      cloud = structuredClone(intent.next);
      pending = null;
      return structuredClone(cloud);
    },
  };
  const storage: WitnessStorage = {
    async read() {
      return { etag: String(etag), record: structuredClone(record) };
    },
    async compareSwap(expected, next) {
      if (failWrite || expected !== String(etag)) throw Error('CAS failed');
      record = structuredClone(next);
      etag++;
    },
  };
  return {
    api: witnessedAuthority(base, storage, authorityId, owner),
    intent,
    initial,
    get record() {
      return record;
    },
    rollbackCloud(state: ControlState) {
      cloud = structuredClone(state);
      pending = null;
    },
    rollbackWitness() {
      record = { ...record, state: structuredClone(initial), pending: null };
      etag++;
    },
    set failWrite(v: boolean) {
      failWrite = v;
    },
  };
}
describe('independent live witness', () => {
  it('prepares both authorities before allowing SQL, then commits matching current heads', async () => {
    const s = await setup();
    await s.api.prepare(s.intent.command);
    expect(s.record.pending).toEqual(s.intent);
    expect((await s.api.view()).pending).toEqual(s.intent);
    await s.api.commit(s.intent);
    expect(s.record.pending).toBeNull();
    expect((await s.api.view()).state).toEqual(s.intent.next);
    await s.api.commit(s.intent);
  });
  it('blocks reads after either independent state is rolled back', async () => {
    for (const rollback of ['cloud', 'witness']) {
      const s = await setup();
      await s.api.prepare(s.intent.command);
      await s.api.commit(s.intent);
      if (rollback === 'cloud') s.rollbackCloud(s.initial);
      else s.rollbackWitness();
      await expect(s.api.view()).rejects.toMatchObject({ code: 'AUTHORITY_DIVERGED' });
    }
  });
  it('keeps the operation pending after witness outage during commit and resumes without applying SQL twice', async () => {
    const s = await setup();
    await s.api.prepare(s.intent.command);
    s.failWrite = true;
    await expect(s.api.commit(s.intent)).rejects.toThrow();
    const view = await s.api.view();
    expect(view.state).toEqual(s.initial);
    expect(view.pending).toEqual(s.intent);
    expect((await s.api.operation(s.intent.command.operationId))?.status).toBe('pending');
    s.failWrite = false;
    await s.api.commit(s.intent);
    expect((await s.api.view()).pending).toBeNull();
  });
  it('does not authorize SQL when preparing the independent witness fails', async () => {
    const s = await setup();
    s.failWrite = true;
    await expect(s.api.prepare(s.intent.command)).rejects.toThrow();
    expect((await s.api.view()).pending).not.toBeNull();
  });
  it('does not bootstrap a missing or foreign witness', async () => {
    const s = await setup();
    const missing: WitnessStorage = {
      async read() {
        throw Error('missing');
      },
      async compareSwap() {
        throw Error('must never write');
      },
    };
    const other = witnessedAuthority(s.api, missing, authorityId, owner);
    await expect(other.view()).rejects.toThrow('missing');
  });
});

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSyntheticJournal, type LifecycleCommand } from '../../../server/finance-authority/local-journal';
import {
  RESTORE_AUTHORITY,
  RESTORE_OWNER,
  RESTORE_VAULT,
  validateEvidence,
  createAuthorityClient,
  type AuthorityClient,
  type Evidence,
} from './authority-client';
import { coordinateFinance } from './coordinator';
import { FinanceError, type FinanceRuntime, type FinanceActor } from './handler';
const now = Date.now(),
  session = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor: FinanceActor = { id: RESTORE_OWNER, session, expiresAt: now / 1000 + 3600, passwordAt: Math.floor(now / 1000) };
const command = (kind: LifecycleCommand['kind'] = 'reset'): LifecycleCommand => ({
  operationId: 'BBBBBBBBBBBBBBBBBBBBBA',
  ownerId: RESTORE_OWNER,
  expectedEpoch: '1',
  kind,
  vaultId: kind === 'revoke' ? null : RESTORE_VAULT,
  targetSessionId: kind === 'revoke' ? other : null,
});
let dir: string, journal: LocalSyntheticJournal, authority: AuthorityClient, raw: FinanceRuntime, run: FinanceRuntime;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tr8-6b5c-'));
  const path = join(dir, 'journal.sqlite');
  LocalSyntheticJournal.provision(path, RESTORE_AUTHORITY, RESTORE_OWNER, RESTORE_VAULT);
  journal = new LocalSyntheticJournal(path, RESTORE_AUTHORITY);
  authority = {
    configured: true,
    caseId: 'reset',
    state: async () => validateEvidence(journal.snapshot(RESTORE_OWNER)),
    prepare: async c => journal.prepare(c),
    commit: async r => {
      journal.commit(RESTORE_OWNER, r);
    },
  };
  raw = {
    enabled: true,
    origin: 'http://127.0.0.1:5174',
    authenticate: async () => actor,
    call: vi.fn(async action => {
      if (action === 'metadata') return { epoch: '1', vaultId: RESTORE_VAULT, purged: false };
      if (action === 'read') return { envelope: null, epoch: '1' };
      if (['reset', 'revoke', 'purge'].includes(action))
        return { operationId: command().operationId, epoch: '2', retiredVaultId: action === 'revoke' ? null : RESTORE_VAULT };
      return { authorized: true };
    }),
  };
  run = coordinateFinance(raw, authority, () => now);
});
afterEach(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});
const args = () => ({ p_operation_id: command().operationId, p_expected_epoch: '1', p_vault_id: RESTORE_VAULT });
describe('independent authority / PostgreSQL coordinator fault boundaries', () => {
  it('never reads financial data when the authority is unavailable', async () => {
    authority.state = async () => {
      throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
    };
    await expect(run.call('read', actor, {})).rejects.toMatchObject({ status: 503 });
    expect(raw.call).not.toHaveBeenCalled();
  });
  it('checks both sides of the database read and fences its epoch', async () => {
    const state = vi.spyOn(authority, 'state');
    await expect(run.call('read', actor, {})).resolves.toEqual({ envelope: null, epoch: '1' });
    expect(state).toHaveBeenCalledTimes(2);
    expect(raw.call).toHaveBeenLastCalledWith(
      'read',
      actor,
      expect.objectContaining({ p_fence_epoch: '1', p_authority_id: RESTORE_AUTHORITY, p_case_id: 'reset' }),
    );
  });
  it('discards a result when reset commits during the database read', async () => {
    const original = raw.call;
    raw.call = async (a, p, v) => {
      const result = await original(a, p, v);
      if (a === 'read') {
        const r = journal.prepare(command());
        journal.commit(RESTORE_OWNER, r);
      }
      return result;
    };
    await expect(run.call('read', actor, {})).rejects.toMatchObject({ status: 403 });
  });
  it('discards a result if the second authority query fails', async () => {
    let calls = 0;
    const original = authority.state;
    authority.state = async () => {
      if (++calls === 2) throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
      return original();
    };
    await expect(run.call('read', actor, {})).rejects.toMatchObject({ status: 503 });
  });
  it('rejects an old SQL epoch even for a surviving unrevoked session', async () => {
    const r = journal.prepare(command('revoke'));
    journal.commit(RESTORE_OWNER, r);
    await expect(run.call('read', actor, {})).rejects.toMatchObject({ status: 409 });
    expect(raw.call).toHaveBeenCalledTimes(1);
  });
  it('persists intent before SQL and leaves access closed after SQL failure', async () => {
    const original = raw.call;
    raw.call = async (a, p, v) => {
      if (a === 'reset') throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
      return original(a, p, v);
    };
    await expect(run.call('reset', actor, args())).rejects.toMatchObject({ status: 503 });
    expect(journal.snapshot(RESTORE_OWNER).operations[0]?.status).toBe('pending');
    await expect(run.call('read', actor, {})).rejects.toMatchObject({ status: 503 });
  });
  it('retries the same pending intent after a lost SQL acknowledgement', async () => {
    const original = raw.call;
    let first = true;
    raw.call = async (a, p, v) => {
      const result = await original(a, p, v);
      if (a === 'reset' && first) {
        first = false;
        throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
      }
      return result;
    };
    await expect(run.call('reset', actor, args())).rejects.toMatchObject({ status: 503 });
    await expect(run.call('reset', actor, args())).resolves.toMatchObject({ epoch: '2' });
    expect(journal.snapshot(RESTORE_OWNER).operations).toHaveLength(1);
    expect(journal.snapshot(RESTORE_OWNER).operations[0]?.status).toBe('committed');
  });
  it('does not commit an intent when the SQL receipt identifies another operation', async () => {
    const original = raw.call;
    raw.call = async (a, p, v) => (a === 'reset' ? { operationId: 'AAAAAAAAAAAAAAAAAAAAAA', epoch: '2', retiredVaultId: RESTORE_VAULT } : original(a, p, v));
    await expect(run.call('reset', actor, args())).rejects.toMatchObject({ status: 503 });
    expect(journal.snapshot(RESTORE_OWNER).operations[0]?.status).toBe('pending');
  });
  it('keeps data closed after loss of the external commit response', async () => {
    authority.commit = async r => {
      journal.commit(RESTORE_OWNER, r);
      throw new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
    };
    await expect(run.call('reset', actor, args())).rejects.toMatchObject({ status: 503 });
    await expect(run.call('receipt', actor, {})).rejects.toMatchObject({ status: 403 });
  });
  it.each(['read', 'put', 'receipt'])('rejects restored %s before SQL when a session was revoked', async action => {
    const r = journal.prepare(command('revoke'));
    journal.commit(RESTORE_OWNER, r);
    await expect(run.call(action, { ...actor, session: other }, {})).rejects.toMatchObject({ status: 403 });
    expect(raw.call).not.toHaveBeenCalled();
  });
  it.each(['reset', 'purge'] as const)('rejects a restored context after %s', async kind => {
    const r = journal.prepare(command(kind));
    journal.commit(RESTORE_OWNER, r);
    await expect(run.call('read', actor, {})).rejects.toMatchObject({ status: 403 });
    expect(raw.call).not.toHaveBeenCalled();
  });
  it('never releases quarantine while an intent is pending', async () => {
    journal.prepare(command());
    await expect(run.call('reconcile', actor, { p_release: true })).rejects.toMatchObject({ status: 503 });
    expect(raw.call).not.toHaveBeenCalled();
  });
  it('requires a second unchanged authority observation before releasing', async () => {
    const original = raw.call;
    raw.call = async (a, p, v) => {
      const result = await original(a, p, v);
      if (a === 'repair') journal.prepare(command());
      return result;
    };
    await expect(run.call('reconcile', actor, { p_release: true })).rejects.toMatchObject({ status: 503 });
    expect(original).toHaveBeenCalledTimes(1);
  });
  it('repairs under quarantine without releasing by default', async () => {
    await expect(run.call('reconcile', actor, { p_release: false })).resolves.toMatchObject({ quarantined: true });
    expect(raw.call).toHaveBeenCalledTimes(1);
    expect(raw.call).toHaveBeenCalledWith('repair', actor, expect.anything());
  });
  it('denies other owners and expired sessions before querying either dependency', async () => {
    const state = vi.spyOn(authority, 'state');
    await expect(run.call('read', { ...actor, id: other }, {})).rejects.toMatchObject({ status: 403 });
    await expect(run.call('read', { ...actor, expiresAt: now / 1000 }, {})).rejects.toMatchObject({ status: 401 });
    expect(state).not.toHaveBeenCalled();
    expect(raw.call).not.toHaveBeenCalled();
  });
});
describe('complete lifecycle evidence validation', () => {
  it.each(['nonce', 'authority', 'case', 'cache', 'overflow'])('rejects HTTP evidence with invalid %s', async fault => {
    const get = (name: string) =>
      ({ TR8_FINANCE_AUTHORITY_ID: RESTORE_AUTHORITY, TR8_FINANCE_RESTORE_CASE: 'reset', TR8_FINANCE_AUTHORITY_SECRET: 'f'.repeat(64) })[name];
    const fetcher: typeof fetch = async (_input, init) => {
      const nonce = JSON.parse(String(init?.body)).nonce;
      return Response.json(
        {
          nonce: fault === 'nonce' ? 'AAAAAAAAAAAAAAAAAAAAAA' : nonce,
          authorityId: fault === 'authority' ? other : RESTORE_AUTHORITY,
          caseId: fault === 'case' ? 'purge' : 'reset',
          state: fault === 'overflow' ? 'x'.repeat(131073) : journal.snapshot(RESTORE_OWNER),
        },
        { headers: { 'Cache-Control': fault === 'cache' ? 'public, max-age=60' : 'no-store' } },
      );
    };
    await expect(createAuthorityClient(get, fetcher).state()).rejects.toMatchObject({ status: 503 });
  });
  it('accepts committed and pending evidence directly from SQLite', async () => {
    await expect(validateEvidence(journal.snapshot(RESTORE_OWNER))).resolves.toMatchObject({ epoch: '1' });
    const r = journal.prepare(command());
    await expect(validateEvidence(journal.snapshot(RESTORE_OWNER))).resolves.toMatchObject({ epoch: '1' });
    journal.commit(RESTORE_OWNER, r);
    await expect(validateEvidence(journal.snapshot(RESTORE_OWNER))).resolves.toMatchObject({ epoch: '2', retiredVaults: [RESTORE_VAULT] });
  });
  it.each(['missing-history', 'missing-tombstone', 'wrong-epoch', 'wrong-digest', 'duplicate', 'unknown-field'])(
    'rejects %s instead of repairing from it',
    async fault => {
      const r = journal.prepare(command());
      journal.commit(RESTORE_OWNER, r);
      const state = structuredClone(journal.snapshot(RESTORE_OWNER)) as unknown as Evidence & { extra?: boolean };
      if (fault === 'missing-history') state.operations = [];
      if (fault === 'missing-tombstone') state.retiredVaults = [];
      if (fault === 'wrong-epoch') state.epoch = '1';
      if (fault === 'wrong-digest') state.operations[0].receipt.digest = '0'.repeat(64);
      if (fault === 'duplicate') state.operations.push(state.operations[0]);
      if (fault === 'unknown-field') state.extra = true;
      await expect(validateEvidence(state)).rejects.toMatchObject({ status: 503 });
    },
  );
  it('never enables the client with an arbitrary URL/identity or absent secret', () => {
    const get = (name: string) => ({ TR8_FINANCE_AUTHORITY_ID: RESTORE_AUTHORITY, TR8_FINANCE_RESTORE_CASE: 'reset' })[name];
    expect(createAuthorityClient(get).configured).toBe(false);
  });
});

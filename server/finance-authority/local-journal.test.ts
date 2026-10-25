import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LocalSyntheticJournal, type LifecycleCommand } from './local-journal';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  session = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  authority = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const vault = 'AAAAAAAAAAAAAAAAAAAAAA',
  operation = 'BBBBBBBBBBBBBBBBBBBBBA';
let directory: string, path: string, journal: LocalSyntheticJournal;
const view = () => ({ ownerId: owner, sessionId: session, vaultId: vault, epoch: '1' });
const command = (kind: LifecycleCommand['kind'] = 'reset'): LifecycleCommand => ({
  operationId: operation,
  ownerId: owner,
  expectedEpoch: '1',
  kind,
  vaultId: kind === 'revoke' ? null : vault,
  targetSessionId: kind === 'revoke' ? session : null,
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'tr8-6b5-synthetic-'));
  path = join(directory, 'independent-authority.sqlite');
  LocalSyntheticJournal.provision(path, authority, owner, vault);
  journal = new LocalSyntheticJournal(path, authority);
});
afterEach(() => {
  journal?.close();
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('tr8-6b5-synthetic-'))
    throw Error('Unsafe synthetic cleanup target');
  rmSync(directory, { recursive: true, force: true });
});
describe('6B.5A independent local SQLite journal — not hosted authority', () => {
  it('opens a provisioned authority but never silently trusts an empty or different one', () => {
    expect(() => new LocalSyntheticJournal(join(directory, 'missing.sqlite'), authority)).toThrow('UNTRUSTED_AUTHORITY');
    expect(() => new LocalSyntheticJournal(path, owner)).toThrow('UNTRUSTED_AUTHORITY');
    expect(() => LocalSyntheticJournal.provision(path, authority, owner, vault)).toThrow('INVALID_INPUT');
    expect(() => journal.assertProjection(view())).not.toThrow();
  });
  it('durably prepares before DB mutation and refuses all access while pending', () => {
    const receipt = journal.prepare(command());
    expect(receipt.epoch).toBe('2');
    expect(() => journal.assertProjection(view())).toThrow('PENDING');
    journal.close();
    journal = new LocalSyntheticJournal(path, authority);
    expect(() => journal.assertProjection(view())).toThrow('PENDING');
    expect(journal.prepare(command())).toEqual(receipt);
  });
  it('never commits with an invented DB acknowledgement', () => {
    const receipt = journal.prepare(command());
    expect(() => journal.commit(owner, { ...receipt, digest: '0'.repeat(64) })).toThrow('CONFLICT');
    expect(() => journal.commit(owner, { ...receipt, epoch: '3' })).toThrow('CONFLICT');
    expect(() => journal.commit(session, receipt)).toThrow('CONFLICT');
    expect(() => journal.assertProjection(view())).toThrow('PENDING');
  });
  it('retirement is checked before an old receipt can be replayed', () => {
    const receipt = journal.prepare(command());
    journal.commit(owner, receipt);
    expect(journal.prepare(command())).toEqual(receipt);
    expect(journal.commit(owner, receipt)).toEqual(receipt);
    expect(() => journal.assertProjection(view())).toThrow('DENIED');
    expect(() => journal.assertProjection({ ...view(), epoch: '2' })).toThrow('DENIED');
  });
  it('persists revocations and epoch across process-like reopen', () => {
    const receipt = journal.prepare(command('revoke'));
    journal.commit(owner, receipt);
    journal.close();
    journal = new LocalSyntheticJournal(path, authority);
    expect(() => journal.assertProjection({ ...view(), epoch: '2' })).toThrow('DENIED');
    expect(() => journal.assertProjection({ ...view(), sessionId: authority })).toThrow('CONFLICT');
    expect(() => journal.assertProjection({ ...view(), sessionId: authority, epoch: '2' })).not.toThrow();
  });
  it('a purge closes the owner even with a previous committed receipt', () => {
    const receipt = journal.prepare(command('purge'));
    journal.commit(owner, receipt);
    expect(() => journal.assertProjection(view())).toThrow('DENIED');
    expect(() => journal.prepare(command('purge'))).toThrow('DENIED');
  });
  it.each(['reset', 'revoke', 'purge'] as const)('restoring a real separate SQLite projection cannot undo %s', kind => {
    const projection = join(directory, 'projection.sqlite'),
      backup = join(directory, 'old-projection.sqlite');
    let db = new DatabaseSync(projection);
    db.exec('CREATE TABLE projection(owner_id TEXT,session_id TEXT,vault_id TEXT,epoch TEXT);');
    db.prepare('INSERT INTO projection VALUES(?,?,?,?)').run(owner, session, vault, '1');
    db.close();
    copyFileSync(projection, backup);
    const receipt = journal.prepare(command(kind));
    db = new DatabaseSync(projection);
    db.prepare('UPDATE projection SET epoch=?').run(receipt.epoch);
    db.close();
    journal.commit(owner, receipt);
    copyFileSync(backup, projection);
    db = new DatabaseSync(projection);
    const restored = db.prepare('SELECT * FROM projection').get()!;
    db.close();
    expect(() =>
      journal.assertProjection({
        ownerId: String(restored.owner_id),
        sessionId: String(restored.session_id),
        vaultId: String(restored.vault_id),
        epoch: String(restored.epoch),
      }),
    ).toThrow('DENIED');
  });
  it('serializes two connections and never admits a second conflicting pending operation', () => {
    const other = new LocalSyntheticJournal(path, authority);
    try {
      const receipt = journal.prepare(command());
      expect(other.prepare(command())).toEqual(receipt);
      expect(() => other.prepare({ ...command('revoke'), operationId: 'CCCCCCCCCCCCCCCCCCCCCA' })).toThrow('PENDING');
      other.commit(owner, receipt);
      expect(() => journal.assertProjection(view())).toThrow('DENIED');
    } finally {
      other.close();
    }
  });
  it('rejects reused operation IDs with changed bytes or owner', () => {
    journal.prepare(command());
    expect(() => journal.prepare(command('purge'))).toThrow('CONFLICT');
    expect(() => journal.prepare({ ...command(), ownerId: session })).toThrow('DENIED');
  });
  it('does not accept projections ahead of or behind the independent epoch', () => {
    expect(() => journal.assertProjection({ ...view(), epoch: '2' })).toThrow('CONFLICT');
  });
  it('an unavailable authority cannot grant even formerly valid projections', () => {
    journal.close();
    expect(() => journal.assertProjection(view())).toThrow('UNAVAILABLE');
  });
  it('a failure between retirement and epoch commit rolls back all local changes', () => {
    const receipt = journal.prepare(command());
    const fault = new DatabaseSync(path);
    fault.exec("CREATE TRIGGER fail_epoch BEFORE UPDATE ON owners BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FAILURE'); END;");
    expect(() => journal.commit(owner, receipt)).toThrow('UNAVAILABLE');
    expect(fault.prepare('SELECT retired FROM vaults').get()?.retired).toBe(0);
    expect(fault.prepare('SELECT epoch FROM owners').get()?.epoch).toBe('1');
    expect(fault.prepare('SELECT status FROM operations').get()?.status).toBe('pending');
    expect(() => journal.assertProjection(view())).toThrow('PENDING');
    fault.exec('DROP TRIGGER fail_epoch');
    fault.close();
    journal.commit(owner, receipt);
    expect(() => journal.assertProjection(view())).toThrow('DENIED');
  });
  it('never rolls an exhausted epoch over to an old context', () => {
    const db = new DatabaseSync(path);
    db.prepare('UPDATE owners SET epoch=?').run('9223372036854775807');
    db.close();
    expect(() => journal.prepare({ ...command(), expectedEpoch: '9223372036854775807' })).toThrow('CONFLICT');
  });
  it.each([
    { expectedEpoch: '0' },
    { operationId: 'not-canonical' },
    { targetSessionId: session },
    { vaultId: null },
    { ownerId: session, extra: 'financial plaintext' },
  ])('rejects malformed or unexpected lifecycle data %j', change => {
    expect(() => journal.prepare({ ...command(), ...change } as LifecycleCommand)).toThrow();
    expect(() => journal.assertProjection(view())).not.toThrow();
  });
});

/** Account-mode acceptance against existing disposable TEST users only. */
import { readFile } from 'node:fs/promises';
const f = JSON.parse(await readFile('C:/Users/thede/.codex/tmp/tr8-stage2-private/http-fixtures.json', 'utf8'));
if (f.url !== 'https://kajcbwlnqcwcpbtqyieo.supabase.co' || f.users.owner.id !== '37848d70-989a-4f69-b124-0c959d8b49a6') throw Error('Test fixture only');
async function login(user) {
  const r = await fetch(f.url + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: f.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (!r.ok) throw Error('Fixture login');
  return (await r.json()).access_token;
}
async function rpc(token, body = {}) {
  const r = await fetch(f.url + '/rest/v1/rpc/tr8_account_finance', {
    method: 'POST',
    headers: { apikey: f.key, ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
}
const token = await login(f.users.owner),
  other = await login(f.users.otherOwner);
const before = await rpc(token);
if (before.status !== 200 || before.body.version !== '0') throw Error('Test finances must start empty');
const empty = {
  schemaVersion: 1,
  financialSpace: {
    domainSchemaVersion: 4,
    currencyCatalogVersion: 'currency-catalog-v1',
    currencyDefinitions: ['DOP', 'USD', 'EUR', 'BOB'].map(code => ({ code, minorUnitDigits: 2 })),
    accounts: [],
    operations: [],
    plans: [],
  },
};
const withAccount = structuredClone(empty);
withAccount.financialSpace.accounts.push({
  id: crypto.randomUUID(),
  name: 'QA cuenta normal',
  currency: 'BOB',
  type: 'cash',
  openingBalanceMinor: 10000,
  openingDate: '2026-10-25',
});
const writes = [empty, withAccount].map(snapshot => ({ p_snapshot: snapshot, p_expected_version: '0', p_operation_id: crypto.randomUUID() }));
const results = await Promise.all(writes.map(w => rpc(token, w)));
const winner = results.findIndex(r => r.status === 200);
if (winner < 0 || results.filter(r => r.status === 200).length !== 1 || !results.some(r => r.body.code === 'PT409')) throw Error('CAS race not enforced');
const replay = await rpc(token, writes[winner]);
if (replay.status !== 200 || replay.body.version !== '1') throw Error('Replay not idempotent');
const conflict = await rpc(token, { ...writes[winner], p_snapshot: writes[1 - winner].p_snapshot });
if (conflict.body.code !== 'PT409') throw Error('Operation bytes changed');
const foreign = await rpc(other);
if (foreign.status !== 200 || foreign.body.snapshot !== null || foreign.body.version !== '0') throw Error('Other account saw owner finances');
const anon = await rpc(null);
if (anon.status < 400) throw Error('Anonymous access');
console.log(
  JSON.stringify({
    readWithAccount: true,
    oneRaceWinner: true,
    exactRetry: true,
    changedOperationDenied: true,
    otherAccountIsolated: true,
    anonymousDenied: true,
  }),
);

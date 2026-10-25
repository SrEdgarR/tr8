/** One-shot hosted synthetic journal acceptance. No Supabase or financial data. */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const [phase, secretFile, reportFile] = process.argv.slice(2);
function outside(value) {
  if (!value || !isAbsolute(value)) throw Error('Private absolute paths required');
  const rel = relative(root, resolve(value));
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) throw Error('Private fixture must stay outside Git');
}
outside(secretFile);
outside(reportFile);
if (!['prepare', 'verify', 'closed'].includes(phase)) throw Error('Explicit prepare, verify or closed phase required');
const { ACCESS_TOKEN: token } = JSON.parse(await readFile(secretFile, 'utf8'));
if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Synthetic credential required');
const base = 'https://tr8-authority-test.sredgarpadilla.workers.dev';
const authorityId = 'f629a76f-842c-4f8e-8557-b4b7fa4563b1',
  ownerId = '37848d70-989a-4f69-b124-0c959d8b49a6',
  vaultId = 'AAAAAAAAAAAAAAAAAAAAAA';
const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const makeId = () => randomBytes(16).toString('base64url');
const checks = [];
async function call(path, payload, status, label, extra = {}) {
  const nonce = makeId();
  const r = await fetch(base + path, {
    method: 'POST',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify({ nonce, ...payload }),
  });
  const raw = await r.text();
  if (raw.length > 16384) throw Error('Unexpected service response');
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw Error('Invalid service response');
  }
  if (r.status !== status) throw Error(`${label}: expected ${status}, received ${r.status} (${data.error?.code ?? 'unknown'})`);
  if (data.nonce !== undefined && data.nonce !== nonce) throw Error('Mismatched challenge');
  if (data.authorityId !== undefined && data.authorityId !== authorityId) throw Error('Mismatched authority');
  if (r.headers.get('cache-control') !== 'no-store' || r.headers.has('access-control-allow-origin')) throw Error('Unsafe service response headers');
  checks.push({ label, status });
  return data;
}
const view = (sessionId, epoch) => ({ ownerId, vaultId, sessionId, epoch });
if (phase === 'closed') {
  const saved = JSON.parse(await readFile(reportFile, 'utf8'));
  if (saved.phase !== 'verified' || saved.authorityId !== authorityId) throw Error('Verified proof required before closure');
  await call('/v1/check', view(sessionB, '3'), 401, 'previous credential no longer grants service access');
  await writeFile(reportFile, JSON.stringify({ ...saved, credentialsRemoved: true, closureChecks: checks }, null, 2));
  console.log(JSON.stringify({ closed: true, previousCredentialDenied: true }));
} else if (phase === 'prepare') {
  await call('/v1/check', {}, 401, 'unauthenticated denied', { Authorization: '' });
  await call('/v1/bootstrap', { authorityId, ownerId: sessionA, vaultId }, 403, 'real or unknown owner denied');
  await call('/v1/bootstrap', { authorityId, ownerId, vaultId }, 403, 'browser origin denied', { Origin: 'https://tr8.vercel.app' });
  await call('/v1/bootstrap', { authorityId, ownerId, vaultId }, 200, 'explicit synthetic bootstrap');
  await call('/v1/check', view(sessionA, '1'), 200, 'initial projection accepted as negative gate only');
  const command = { operationId: makeId(), ownerId, expectedEpoch: '1', kind: 'revoke', vaultId: null, targetSessionId: sessionA };
  const { receipt } = await call('/v1/prepare', { command }, 200, 'durable revoke prepared');
  await call('/v1/check', view(sessionA, '1'), 409, 'pending intent fences projection');
  const retries = await Promise.all([
    call('/v1/prepare', { command }, 200, 'concurrent exact retry A'),
    call('/v1/prepare', { command }, 200, 'concurrent exact retry B'),
  ]);
  if (retries.some(r => JSON.stringify(r.receipt) !== JSON.stringify(receipt))) throw Error('Non-idempotent preparation');
  await writeFile(reportFile, JSON.stringify({ phase: 'prepared', authorityId, syntheticOnly: true, command, receipt, checks }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ phase: 'prepared', checks: checks.length, requiresRedeploymentBeforeVerify: true }));
} else {
  const saved = JSON.parse(await readFile(reportFile, 'utf8'));
  if (saved.phase !== 'prepared' || saved.authorityId !== authorityId || saved.syntheticOnly !== true) throw Error('Unexpected proof context');
  await call('/v1/check', view(sessionA, '1'), 409, 'pending intent survives immediate redeployment');
  await call('/v1/commit', { ownerId, receipt: { ...saved.receipt, epoch: '3' } }, 409, 'altered acknowledgement denied');
  await call('/v1/commit', { ownerId, receipt: saved.receipt }, 200, 'revoke committed');
  await call('/v1/check', view(sessionA, '2'), 403, 'revoked session stays denied');
  await call('/v1/check', view(sessionB, '1'), 409, 'old projection epoch denied');
  await call('/v1/check', view(sessionB, '2'), 200, 'other synthetic session sees current epoch');
  const command = { operationId: makeId(), ownerId, expectedEpoch: '2', kind: 'reset', vaultId, targetSessionId: null };
  const { receipt } = await call('/v1/prepare', { command }, 200, 'reset prepared');
  await call('/v1/check', view(sessionB, '2'), 409, 'reset intent closes access before mutation');
  await call('/v1/commit', { ownerId, receipt }, 200, 'retirement committed');
  await call('/v1/prepare', { command: saved.command }, 200, 'historical receipt remains only a receipt');
  await call('/v1/check', view(sessionB, '1'), 403, 'restored old context denied');
  await call('/v1/check', view(sessionB, '3'), 403, 'retired context cannot revive under new epoch');
  await call('/v1/bootstrap', { authorityId, ownerId, vaultId }, 200, 'bootstrap retry does not reset state');
  await call('/v1/check', view(sessionB, '3'), 403, 'bootstrap cannot erase retirement');
  const result = {
    ...saved,
    phase: 'verified',
    checks: [...saved.checks, ...checks],
    hostedSqlite: true,
    scope: 'Synthetic Cloudflare journal only; no PostgreSQL restore, real admission or full restore authority claim',
  };
  await writeFile(reportFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ phase: 'verified', checks: result.checks.length, realFinanceEnabled: false }));
}

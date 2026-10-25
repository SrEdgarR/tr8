/** Real Auth recovery acceptance, existing disposable TEST identity only.
 * No email is sent; the fixture keeps its existing account password.
 */
import { readFile, writeFile } from 'node:fs/promises';
const p = 'C:/Users/thede/.codex/tmp/tr8-finance-release-private/';
const f = JSON.parse(await readFile('C:/Users/thede/.codex/tmp/tr8-stage2-private/http-fixtures.json', 'utf8'));
if (
  f.url !== 'https://kajcbwlnqcwcpbtqyieo.supabase.co' ||
  f.users.owner.id !== '37848d70-989a-4f69-b124-0c959d8b49a6' ||
  !f.users.owner.email.endsWith('@example.test')
)
  throw Error('Test identity only');
const keys = JSON.parse(await readFile(p + 'staging-admin-keys.json', 'utf8'));
const key = keys.find(k => k.type === 'secret' && k.name === 'default')?.api_key;
if (!key?.startsWith('sb_secret_')) throw Error('Missing test operator key');
async function call(path, body, credential = f.key) {
  const response = await fetch(f.url + path, {
    method: 'POST',
    headers: { apikey: credential, Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  const data = await response.json();
  if (!response.ok) throw Error('Fixture request failed: ' + response.status + ' ' + (data.code ?? data.error?.code ?? ''));
  return data;
}
const link = await call('/auth/v1/admin/generate_link', { type: 'recovery', email: f.users.owner.email }, key);
const recovery = await call('/auth/v1/verify', { type: 'recovery', token_hash: link.hashed_token ?? link.properties?.hashed_token });
if (recovery.user?.id !== f.users.owner.id || !recovery.access_token) throw Error('Wrong recovery principal');
const r = await fetch(f.url + '/functions/v1/tr8-vault/account-password', {
  method: 'POST',
  headers: { Origin: 'http://127.0.0.1:5174', apikey: f.key, Authorization: 'Bearer ' + recovery.access_token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: f.users.owner.password }),
  signal: AbortSignal.timeout(30000),
  redirect: 'error',
});
const data = await r.json();
if (!r.ok || data.updated !== true) throw Error('Coordinated recovery failed: ' + r.status + ' ' + (data.error?.code ?? ''));
const revoked = await fetch(f.url + '/functions/v1/tr8-vault/session', {
  headers: { Origin: 'http://127.0.0.1:5174', apikey: f.key, Authorization: 'Bearer ' + recovery.access_token },
});
if (![401, 403].includes(revoked.status)) throw Error('Old recovery session survived');
const next = await call('/auth/v1/token?grant_type=password', { email: f.users.owner.email, password: f.users.owner.password });
if (next.user?.id !== f.users.owner.id) throw Error('Fixture login after recovery failed');
await writeFile(p + 'staging-session.json', JSON.stringify(next), { mode: 0o600 });
console.log(
  JSON.stringify({
    recoveryProof: true,
    coordinatedGlobalLogout: true,
    oldSessionDenied: true,
    loginAfterReset: true,
    fixturePasswordPreserved: true,
    emailSent: false,
  }),
);

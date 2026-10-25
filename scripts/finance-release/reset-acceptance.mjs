/** Retire only the disposable TEST vault after acceptance. Never a production URL. */
import { readFile } from 'node:fs/promises';
const f = JSON.parse(await readFile('C:/Users/thede/.codex/tmp/tr8-stage2-private/http-fixtures.json', 'utf8'));
if (f.url !== 'https://kajcbwlnqcwcpbtqyieo.supabase.co' || f.users.owner.id !== '37848d70-989a-4f69-b124-0c959d8b49a6') throw Error('Synthetic identity only');
async function login() {
  const r = await fetch(f.url + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: f.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: f.users.owner.email, password: f.users.owner.password }),
  });
  if (!r.ok) throw Error('Login failed');
  return (await r.json()).access_token;
}
async function call(token, path, body, status = 200) {
  const r = await fetch(f.url + '/functions/v1/tr8-vault' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: 'http://127.0.0.1:5174', apikey: f.key, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const value = await r.json();
  if (r.status !== status) throw Error('Unexpected response ' + r.status + ' ' + (value.error?.code ?? ''));
  return value;
}
const token = await login();
const before = await call(token, '');
const vaultId = before.state.head?.vaultId;
if (!vaultId) throw Error('Missing disposable vault');
await call(token, '/reset', { confirmation: 'incorrecta', vaultId }, 400);
await call(token, '/reset', { confirmation: 'ELIMINAR BÓVEDA', vaultId: 'AgICAgICAgICAgICAgICAg' }, 409);
const result = await call(token, '/reset', { confirmation: 'ELIMINAR BÓVEDA', vaultId });
if (result.reset !== true) throw Error('Missing acknowledgment');
await call(token, '/session', undefined, 401);
const fresh = await call(await login(), '');
if (fresh.envelope !== null || fresh.state.head !== null || !fresh.state.retiredVaults.includes(vaultId)) throw Error('Old vault not retired');
console.log(JSON.stringify({ typedConfirmationEnforced: true, staleTargetDenied: true, vaultRetired: true, oldSessionDenied: true, newSessionEmpty: true }));

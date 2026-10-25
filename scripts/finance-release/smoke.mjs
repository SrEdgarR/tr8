import { readFile, writeFile } from 'node:fs/promises';
const dir = 'C:/Users/thede/.codex/tmp/tr8-finance-release-private';
const fixtures = JSON.parse(await readFile('C:/Users/thede/.codex/tmp/tr8-stage2-private/http-fixtures.json', 'utf8'));
if (fixtures.url !== 'https://kajcbwlnqcwcpbtqyieo.supabase.co' || fixtures.users.owner.id !== '37848d70-989a-4f69-b124-0c959d8b49a6')
  throw Error('Synthetic account only');
const login = await fetch(fixtures.url + '/auth/v1/token?grant_type=password', {
  method: 'POST',
  headers: { apikey: fixtures.key, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: fixtures.users.owner.email, password: fixtures.users.owner.password }),
});
if (!login.ok) throw Error('Synthetic login failed');
const auth = await login.json();
await writeFile(dir + '/staging-session.json', JSON.stringify(auth), { mode: 0o600 });
const r = await fetch(fixtures.url + '/functions/v1/tr8-vault', {
  headers: { Origin: 'http://127.0.0.1:5174', apikey: fixtures.key, Authorization: 'Bearer ' + auth.access_token },
  signal: AbortSignal.timeout(30000),
});
const data = await r.json();
if (!r.ok) throw Error('Head: ' + r.status + ' ' + JSON.stringify(data));
if (data.state.ownerId !== fixtures.users.owner.id || data.state.status !== 'active') throw Error('Wrong head');
console.log(
  JSON.stringify({
    headRead: true,
    enrollment: true,
    sequence: data.state.sequence,
    empty: data.envelope === null,
    cors: r.headers.get('Access-Control-Allow-Origin'),
  }),
);

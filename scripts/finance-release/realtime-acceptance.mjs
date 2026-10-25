import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
const f = JSON.parse(await readFile('C:/Users/thede/.codex/tmp/tr8-stage2-private/http-fixtures.json', 'utf8'));
if (f.url !== 'https://kajcbwlnqcwcpbtqyieo.supabase.co' || f.users.owner.id !== '37848d70-989a-4f69-b124-0c959d8b49a6') throw Error('Synthetic identity only');
const client = createClient(f.url, f.key, { auth: { persistSession: false, autoRefreshToken: false } });
const login = await client.auth.signInWithPassword({ email: f.users.owner.email, password: f.users.owner.password });
if (login.error) throw Error('Fixture login failed');
const token = login.data.session.access_token;
async function edge(t, path, body) {
  const r = await fetch(f.url + '/functions/v1/tr8-vault' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: 'http://127.0.0.1:5174', apikey: f.key, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const d = await r.json();
  if (!r.ok) throw Error('Edge ' + r.status + ' ' + (d.error?.code ?? ''));
  return d;
}
const before = await edge(token, '');
if (before.envelope !== null) throw Error('Acceptance requires an empty test vault');
let resolveEvent, rejectEvent;
const event = new Promise((resolve, reject) => {
  resolveEvent = resolve;
  rejectEvent = reject;
});
const timer = setTimeout(() => rejectEvent(Error('Revocation hint timed out')), 20000);
const channel = client.channel('finance-release-acceptance');
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Realtime connection timed out')), 10000);
    channel
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tr8_finance_heads', filter: 'owner_id=eq.' + f.users.owner.id }, payload => {
        if (payload.new.session_epoch !== before.state.sessionEpoch) resolveEvent(payload.new);
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout);
          resolve();
        }
      });
  });
  const second = await fetch(f.url + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: f.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: f.users.owner.email, password: f.users.owner.password }),
  });
  if (!second.ok) throw Error('Second fixture login');
  const auth = await second.json();
  await edge(auth.access_token, '/reset', { confirmation: 'ELIMINAR BÓVEDA', vaultId: null });
  const hint = await event;
  if (hint.owner_id !== f.users.owner.id || hint.session_epoch === before.state.sessionEpoch) throw Error('Wrong hint');
  const denied = await fetch(f.url + '/functions/v1/tr8-vault/session', {
    headers: { Origin: 'http://127.0.0.1:5174', apikey: f.key, Authorization: 'Bearer ' + token },
  });
  if (denied.status !== 401) throw Error('Revoked session survived');
  console.log(JSON.stringify({ liveRealtimeHint: true, deliveredAfterSessionRevocation: true, oldSessionDenied: true, financialPlaintextSent: false }));
} finally {
  clearTimeout(timer);
  await client.removeChannel(channel);
}

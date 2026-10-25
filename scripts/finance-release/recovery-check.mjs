import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createBlobWitness } from '../../supabase/functions/tr8-finance/blob-witness.ts';
import { stable } from '../../server/finance-authority/vault-control.ts';
const p = 'C:/Users/thede/.codex/tmp/tr8-finance-release-private/';
const f = JSON.parse(await readFile('C:/Users/thede/.codex/tmp/tr8-stage2-private/http-fixtures.json', 'utf8'));
if (f.url !== 'https://kajcbwlnqcwcpbtqyieo.supabase.co' || f.users.owner.id !== '37848d70-989a-4f69-b124-0c959d8b49a6') throw Error('Test fixture only');
const auth = JSON.parse(await readFile(p + 'staging-session.json', 'utf8'));
const c = JSON.parse(Buffer.from(auth.access_token.split('.')[1], 'base64url'));
const { ACCESS_TOKEN } = JSON.parse(await readFile(p + 'staging-cf.json', 'utf8'));
const authority = 'c6d34957-82b7-40d7-a378-7aa71a5841f2';
const cr = await fetch('https://tr8-vault-staging.sredgarpadilla.workers.dev/v1/cases/staging/state', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + ACCESS_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ nonce: randomBytes(16).toString('base64url'), ownerId: f.users.owner.id }),
});
const cloud = await cr.json();
const { token } = JSON.parse(await readFile(p + 'blob.json', 'utf8'));
const { record: witness } = await createBlobWitness(token, authority, f.users.owner.id).read();
if (!cr.ok || cloud.pending || witness.pending || stable(cloud.state) !== stable(witness.state)) throw Error('Authorities disagree');
console.log(
  JSON.stringify({
    owner: f.users.owner.id,
    session: c.session_id,
    expiresAt: c.exp,
    passwordAt: c.amr.find(x => x.method === 'password').timestamp,
    state: cloud.state,
  }),
);

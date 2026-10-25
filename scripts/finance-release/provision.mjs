/** Explicit, operator-only provisioning. No read path can initialize a lost authority. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { put } from '@vercel/blob';
import { initialControlState, stable } from '../../server/finance-authority/vault-control.ts';
import { personalAuthority } from '../../supabase/functions/tr8-finance/personal-authority.ts';
const [phase, mode, dir] = process.argv.slice(2);
if (!['staging', 'personal'].includes(mode) || !dir?.replaceAll('\\', '/').endsWith('/.codex/tmp/tr8-finance-release-private'))
  throw Error('Explicit private release directory required');
const pins =
  mode === 'personal'
    ? { ownerId: '74368b81-39f8-4bc3-bbbf-f541b64df4cf', authorityId: 'f441d794-a20e-43be-a286-b7d29efcfe7c', worker: 'tr8-vault' }
    : { ownerId: '37848d70-989a-4f69-b124-0c959d8b49a6', authorityId: 'c6d34957-82b7-40d7-a378-7aa71a5841f2', worker: 'tr8-vault-staging' };
const file = name => dir + '/' + mode + '-' + name;
await mkdir(dir, { recursive: true });
if (phase === 'init') {
  const secret = randomBytes(32).toString('hex');
  const { token } = JSON.parse(await readFile(dir + '/blob.json', 'utf8'));
  await writeFile(file('cf.json'), JSON.stringify({ ACCESS_TOKEN: secret }), { flag: 'wx', mode: 0o600 });
  await writeFile(
    file('edge.env'),
    `TR8_LIVE_ENABLED=true\nTR8_LIVE_MODE=${mode}\nTR8_LIVE_AUTHORITY=${pins.authorityId}\nTR8_LIVE_CONTROL_SECRET=${secret}\nTR8_LIVE_BLOB_TOKEN=${token}\nTR8_FINANCE_ALLOWED_ORIGIN=${mode === 'personal' ? 'https://tr8.vercel.app' : 'http://127.0.0.1:5174'}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  await writeFile(file('initial.json'), stable(initialControlState(pins.ownerId)), { flag: 'wx' });
  console.log('Private configuration prepared: ' + mode);
} else if (phase === 'bootstrap') {
  const { ACCESS_TOKEN } = JSON.parse(await readFile(file('cf.json'), 'utf8'));
  const nonce = randomBytes(16).toString('base64url');
  const r = await fetch(`https://${pins.worker}.sredgarpadilla.workers.dev/v1/cases/${mode}/bootstrap`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce, authorityId: pins.authorityId, ownerId: pins.ownerId }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await r.json();
  if (r.status !== 200 || body.nonce !== nonce || body.bootstrapped !== true) throw Error('Bootstrap refused: ' + r.status);
  const { token } = JSON.parse(await readFile(dir + '/blob.json', 'utf8'));
  await put(
    `tr8/authority/${pins.authorityId}/${pins.ownerId}.json`,
    stable({ protocol: 1, authorityId: pins.authorityId, ownerId: pins.ownerId, state: initialControlState(pins.ownerId), pending: null }),
    { token, access: 'private', allowOverwrite: false, addRandomSuffix: false, contentType: 'application/json' },
  );
  console.log('Both empty metadata authorities provisioned: ' + mode);
} else if (phase === 'verify') {
  const vars = Object.fromEntries(
    (await readFile(file('edge.env'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  const { authority } = personalAuthority(key => vars[key]);
  const current = await authority.view();
  if (!authority.configured || current.pending || current.state.ownerId !== pins.ownerId) throw Error('Authorities not ready');
  const { ACCESS_TOKEN } = JSON.parse(await readFile(file('cf.json'), 'utf8'));
  const closed = await fetch(`https://${pins.worker}.sredgarpadilla.workers.dev/v1/cases/${mode}/bootstrap`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + ACCESS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: randomBytes(16).toString('base64url'), authorityId: pins.authorityId, ownerId: pins.ownerId }),
    signal: AbortSignal.timeout(20000),
  });
  if (closed.status !== 403) throw Error('Bootstrap must be closed');
  console.log(
    JSON.stringify({ mode, currentWitnessAgrees: true, bootstrapClosed: true, sequence: current.state.sequence, empty: current.state.head === null }),
  );
} else throw Error('Unknown phase');

import { readFile } from 'node:fs/promises';
import { put, get, del, BlobPreconditionFailedError } from '@vercel/blob';
const path = process.argv[2];
if (!path || !path.includes('.codex/tmp/tr8-finance-release-private/')) throw Error('Private fixture path required');
const { token } = JSON.parse(await readFile(path, 'utf8'));
const pathname = 'tr8/proof/' + crypto.randomUUID() + '.json';
let url;
try {
  const a = await put(pathname, JSON.stringify({ sequence: 1 }), { access: 'private', token, allowOverwrite: false });
  url = a.url;
  const b = await get(pathname, { access: 'private', token, useCache: false });
  if (!b || b.statusCode !== 200 || !b.stream) throw Error('Missing first record');
  const c = await put(pathname, JSON.stringify({ sequence: 2 }), { access: 'private', token, allowOverwrite: true, ifMatch: b.blob.etag });
  const d = await get(pathname, { access: 'private', token, useCache: false });
  if (!d || d.statusCode !== 200 || (await new Response(d.stream).json().then(v => v.sequence)) !== 2) throw Error('Read did not observe latest value');
  let staleDenied = false;
  try {
    await put(pathname, JSON.stringify({ sequence: 1 }), { access: 'private', token, allowOverwrite: true, ifMatch: b.blob.etag });
  } catch (e) {
    if (e instanceof BlobPreconditionFailedError) staleDenied = true;
    else throw e;
  }
  if (!staleDenied || c.etag === b.blob.etag) throw Error('CAS not enforced');
  console.log(JSON.stringify({ privateRead: true, immediateOverwriteRead: true, staleEtagDenied: true }));
} finally {
  if (url) await del(url, { token });
}

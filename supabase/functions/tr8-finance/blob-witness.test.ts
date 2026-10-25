import { it, expect, vi } from 'vitest';
import { createBlobWitness } from './blob-witness.ts';
import { initialControlState } from '../../../server/finance-authority/vault-control.ts';
const owner = '37848d70-989a-4f69-b124-0c959d8b49a6',
  authority = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const record = { protocol: 1 as const, ownerId: owner, authorityId: authority, state: initialControlState(owner), pending: null };
const token = 'vercel_blob_rw_SyntheticStore_fixture';
it('reads the private origin and supplies atomic CAS with native Fetch, no SDK decompressor', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(record, { headers: { etag: '"v1"' } }))
    .mockResolvedValueOnce(Response.json({ pathname: `tr8/authority/${authority}/${owner}.json`, etag: '"v2"' }));
  const storage = createBlobWitness(token, authority, owner, fetcher);
  expect(await storage.read()).toEqual({ etag: '"v1"', record });
  await storage.compareSwap('"v1"', record);
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toContain('.private.blob.vercel-storage.com/');
  expect(url).toContain('?cache=0');
  expect(options).toMatchObject({ cache: 'no-store', redirect: 'error', headers: { 'Accept-Encoding': 'identity' } });
  expect(fetcher.mock.calls[1][1]).toMatchObject({ method: 'PUT', headers: { 'x-if-match': '"v1"', 'x-allow-overwrite': '1', 'x-api-version': '12' } });
});
it('fails closed on missing origin, rate limit and stale ETag without retrying or initializing', async () => {
  for (const status of [404, 429, 503]) {
    const f = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    await expect(createBlobWitness(token, authority, owner, f).read()).rejects.toMatchObject({ code: 'WITNESS_UNAVAILABLE' });
    expect(f).toHaveBeenCalledTimes(1);
  }
  const f = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'precondition_failed' } }, { status: 412 }));
  await expect(createBlobWitness(token, authority, owner, f).compareSwap('"old"', record)).rejects.toMatchObject({ code: 'FINANCE_CONFLICT' });
  expect(f).toHaveBeenCalledTimes(1);
});

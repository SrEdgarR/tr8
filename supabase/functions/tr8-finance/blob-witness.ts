import { parseStrictJson, decodeUtf8 } from '../../../src/app/finance/compatibility/protocol.ts';
import { stable } from '../../../server/finance-authority/vault-control.ts';
import { FinanceError, readFinanceBytes } from './handler.ts';
import type { WitnessStorage } from './witness.ts';
/** Native Fetch, matching Blob SDK 2.4.0 / API v12. Avoids Node undici's
 * incompatible Brotli decoding in Edge; retains origin reads and atomic CAS. */
export function createBlobWitness(token: string, authorityId: string, ownerId: string, fetcher: typeof fetch = fetch): WitnessStorage {
  const pathname = `tr8/authority/${authorityId}/${ownerId}.json`;
  const storeId = token.split('_')[3] ?? '';
  async function call(url: string, init: RequestInit) {
    if (!/^[A-Za-z0-9]+$/.test(storeId)) throw new FinanceError('WITNESS_UNAVAILABLE', 503);
    return fetcher(url, {
      ...init,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity', ...init.headers },
    });
  }
  return {
    async read() {
      try {
        const r = await call(`https://${storeId.toLowerCase()}.private.blob.vercel-storage.com/${pathname}?cache=0`, { method: 'GET' });
        const etag = r.headers.get('etag');
        if (r.status !== 200 || !etag) throw Error();
        return { etag, record: parseStrictJson(decodeUtf8(await readFinanceBytes(r, 262144)), { maxBytes: 262144 }) };
      } catch {
        throw new FinanceError('WITNESS_UNAVAILABLE', 503);
      }
    },
    async compareSwap(etag, record) {
      try {
        const r = await call(`https://vercel.com/api/blob/?${new URLSearchParams({ pathname })}`, {
          method: 'PUT',
          body: stable(record),
          headers: {
            'x-api-version': '12',
            'x-vercel-blob-store-id': storeId,
            'x-vercel-blob-access': 'private',
            'x-add-random-suffix': '0',
            'x-allow-overwrite': '1',
            'x-if-match': etag,
            'x-content-type': 'application/json',
          },
        });
        const result = parseStrictJson(decodeUtf8(await readFinanceBytes(r, 65536)), { maxBytes: 65536 });
        if (!r.ok) {
          const error = result && typeof result === 'object' ? ('error' in result ? (result as { error: unknown }).error : null) : null;
          const code = error && typeof error === 'object' ? ('code' in error ? error.code : null) : null;
          if (r.status === 412 || code === 'precondition_failed') throw new FinanceError('FINANCE_CONFLICT', 409);
          throw Error();
        }
        if (
          !result ||
          typeof result !== 'object' ||
          !('pathname' in result) ||
          result.pathname !== pathname ||
          !('etag' in result) ||
          typeof result.etag !== 'string' ||
          result.etag === etag
        )
          throw Error();
      } catch (e) {
        if (e instanceof FinanceError && e.code === 'FINANCE_CONFLICT') throw e;
        throw new FinanceError('WITNESS_UNAVAILABLE', 503);
      }
    },
  };
}

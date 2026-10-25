import { decodeUtf8, parseStrictJson, requireClosedRecord, decodeBase64Url, validateEpoch } from '../../../src/app/finance/compatibility/protocol.ts';
import { JournalError } from '../../../server/finance-authority/journal-core.ts';
import { controlCoordinator } from './control-coordinator.ts';
import { createControlAuthority } from './control-client.ts';
import { FinanceError, readFinanceBytes } from './handler.ts';
import { createFinanceRuntime } from './runtime.ts';
export function createControlHandler(service: ReturnType<typeof controlCoordinator>) {
  return async (request: Request) => {
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(request.headers.get('Origin') === service.origin ? { 'Access-Control-Allow-Origin': service.origin, Vary: 'Origin' } : {}),
    };
    try {
      if (!service.enabled) throw new FinanceError('FINANCE_DISABLED', 503);
      if (!service.origin || request.headers.get('Origin') !== service.origin) throw new FinanceError('ORIGIN_DENIED', 403);
      const u = new URL(request.url),
        path = u.pathname.replace(/^\/functions\/v1/, '').replace(/^\/tr8-vault-control-test/, '');
      if (u.search || u.hash || request.headers.has('x-user-id')) throw new FinanceError('INVALID_INPUT');
      if (request.method === 'OPTIONS')
        return new Response(null, {
          status: 204,
          headers: { ...headers, 'Access-Control-Allow-Methods': 'GET,PUT,POST', 'Access-Control-Allow-Headers': 'authorization,apikey,content-type' },
        });
      const actor = await service.authenticate(request);
      if (request.method === 'GET' && path === '') return Response.json(await service.read(actor), { headers });
      if (
        !['POST', 'PUT'].includes(request.method) ||
        request.headers.has('Content-Encoding') ||
        request.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json'
      )
        throw new FinanceError('INVALID_INPUT');
      const source = decodeUtf8(await readFinanceBytes(request, 4500000));
      if (request.method === 'PUT' && path === '') return Response.json(await service.put(actor, source), { headers });
      const body = parseStrictJson(source, { maxBytes: 4500000 });
      if (request.method === 'POST' && path === '/identity') {
        const c = requireClosedRecord(body, ['operationId', 'kind', 'expectedSequence', 'targetSessionId']);
        decodeBase64Url(c.operationId as string, 16);
        validateEpoch(c.expectedSequence);
        if (!['enroll', 'revoke', 'logout-all', 'disable', 'delete', 'reset'].includes(c.kind as string)) throw new FinanceError('INVALID_INPUT');
        if (
          c.kind === 'revoke'
            ? typeof c.targetSessionId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(c.targetSessionId)
            : c.targetSessionId !== null
        )
          throw new FinanceError('INVALID_INPUT');
        return Response.json(
          await service.identity(
            actor,
            c.kind as Parameters<typeof service.identity>[1],
            c.operationId as string,
            c.expectedSequence as string,
            c.targetSessionId as string | null,
          ),
          { headers },
        );
      }
      if (request.method === 'POST' && path === '/resume') {
        const c = requireClosedRecord(body, ['operationId', 'originalPut']);
        decodeBase64Url(c.operationId as string, 16);
        if (c.originalPut !== null && typeof c.originalPut !== 'string') throw new FinanceError('INVALID_INPUT');
        return Response.json(await service.resume(actor, c.operationId as string, c.originalPut === null ? undefined : (c.originalPut as string)), { headers });
      }
      if (request.method === 'POST' && path === '/repair') {
        const c = requireClosedRecord(body, ['envelope']);
        return Response.json(await service.repair(actor, c.envelope), { headers });
      }
      throw new FinanceError('METHOD_NOT_ALLOWED', 405);
    } catch (error) {
      const e =
        error instanceof FinanceError
          ? error
          : error instanceof JournalError
            ? new FinanceError(
                error.code === 'DENIED' ? 'FINANCE_ACCESS_DENIED' : error.code === 'CONFLICT' ? 'FINANCE_CONFLICT' : 'RESTORE_QUARANTINED',
                error.code === 'DENIED' ? 403 : error.code === 'CONFLICT' ? 409 : 503,
              )
            : new FinanceError('INVALID_OR_UNAVAILABLE', 503);
      return Response.json({ error: { code: e.code } }, { status: e.status, headers });
    }
  };
}
export function createControlService(get: (key: string) => string | undefined) {
  const raw = createFinanceRuntime(
    key => (key === 'TR8_FINANCE_TESTING_ENABLED' ? get('TR8_VAULT_CONTROL_TESTING_ENABLED') : get(key)),
    fetch,
    Date.now,
    'tr8_server_vault_control',
  );
  return controlCoordinator(raw, createControlAuthority(get));
}

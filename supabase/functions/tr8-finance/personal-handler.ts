import { decodeUtf8, encodeBase64Url, parseStrictJson, requireClosedRecord, VaultError } from '../../../src/app/finance/compatibility/protocol.ts';
import { createControlHandler } from './control-handler.ts';
import { controlCoordinator } from './control-coordinator.ts';
import { personalAuthority } from './personal-authority.ts';
import { createFinanceRuntime } from './runtime.ts';
import { FinanceError, readFinanceBytes } from './handler.ts';
import { JournalError } from '../../../server/finance-authority/journal-core.ts';
import { assertControlAccess } from '../../../server/finance-authority/vault-control.ts';
export function createPersonalService(get: (key: string) => string | undefined) {
  const { pins, authority } = personalAuthority(get);
  const raw = createFinanceRuntime(get, fetch, Date.now, 'tr8_live_finance');
  const service = controlCoordinator(raw, authority, Date.now, pins);
  return {
    ...service,
    async read(actor: Parameters<typeof service.read>[0]) {
      let view = await authority.view();
      if (view.pending) {
        if (view.pending.command.kind !== 'enroll') throw new FinanceError('RESTORE_QUARANTINED', 503);
        await service.resume(actor, view.pending.command.operationId);
        view = await authority.view();
      }
      if (view.state.sessions[actor.session] !== view.state.sessionEpoch) {
        if (view.state.revokedSessions.includes(actor.session)) throw new FinanceError('SESSION_REVOKED', 403);
        await service.identity(actor, 'enroll', encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))), view.state.sequence, null);
      }
      return service.read(actor);
    },
    async sessionIdentity(actor: Parameters<typeof service.read>[0]) {
      await raw.call('probe', actor, { p_authority_id: pins.authorityId, p_case_id: authority.caseId });
      const view = await authority.view();
      assertControlAccess(view.state, actor.session);
      if (view.pending && (view.pending.command.kind !== 'put' || view.pending.command.actorSessionId !== actor.session))
        throw new FinanceError('RESTORE_QUARANTINED', 503);
      return { state: view.state };
    },
    async closeSession(actor: Parameters<typeof service.read>[0]) {
      const view = await authority.view();
      if (view.pending) throw new FinanceError('RESTORE_QUARANTINED', 503);
      if (view.state.sessions[actor.session] !== view.state.sessionEpoch) return { closed: true };
      await service.identity(actor, 'revoke', encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))), view.state.sequence, actor.session);
      return { closed: true };
    },
    async resetVault(actor: Parameters<typeof service.read>[0], expectedVaultId: string | null) {
      let before = await authority.view();
      if (before.pending) throw new FinanceError('RESTORE_QUARANTINED', 503);
      if ((before.state.head?.vaultId ?? null) !== expectedVaultId) throw new FinanceError('FINANCE_CONFLICT', 409);
      if (before.state.sessions[actor.session] !== before.state.sessionEpoch) {
        await service.identity(actor, 'enroll', encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))), before.state.sequence, null);
        before = await authority.view();
      }
      await service.identity(actor, 'reset', encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))), before.state.sequence, null);
      return { reset: true };
    },
    async changeAccountPassword(actor: Parameters<typeof service.read>[0], password: string) {
      if (typeof actor.recoveryAt !== 'number' || actor.recoveryAt < Date.now() / 1000 - 300) throw new FinanceError('REAUTHENTICATION_REQUIRED', 403);
      let before = await authority.view();
      if (before.pending) throw new FinanceError('RESTORE_QUARANTINED', 503);
      if (before.state.sessions[actor.session] !== before.state.sessionEpoch) {
        await service.identity(actor, 'enroll', encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))), before.state.sequence, null);
        before = await authority.view();
      }
      await service.identity(actor, 'logout-all', encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))), before.state.sequence, null);
      let serverKey = get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
      try {
        const keys = JSON.parse(get('SUPABASE_SECRET_KEYS') ?? '{}');
        if (typeof keys.default === 'string') serverKey = keys.default;
      } catch {
        /* No environment contents in errors. */
      }
      const response = await fetch(`${get('SUPABASE_URL')}/auth/v1/admin/users/${actor.id}`, {
        method: 'PUT',
        headers: { apikey: serverKey, Authorization: `Bearer ${serverKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new FinanceError('PASSWORD_UPDATE_UNCONFIRMED', 503);
      return { updated: true };
    },
  };
}
export function createPersonalHandler(service: ReturnType<typeof createPersonalService>) {
  const common = createControlHandler(service);
  return async (request: Request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/functions\/v1/, '').replace(/^\/tr8-vault/, '');
    // Repair is an operator operation. It is intentionally absent from the app API.
    if (path === '/repair') return Response.json({ error: { code: 'METHOD_NOT_ALLOWED' } }, { status: 405 });
    if (path !== '/logout' && path !== '/account-password' && path !== '/session' && path !== '/reset') {
      url.pathname = '/functions/v1/tr8-vault-control-test' + path;
      return common(new Request(url, request));
    }
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(request.headers.get('Origin') === service.origin ? { 'Access-Control-Allow-Origin': service.origin, Vary: 'Origin' } : {}),
    };
    try {
      if (!service.enabled) throw new FinanceError('FINANCE_DISABLED', 503);
      if (request.headers.get('Origin') !== service.origin) throw new FinanceError('ORIGIN_DENIED', 403);
      if (path === '/session' && request.method === 'GET' && !url.search && !request.headers.has('x-user-id'))
        return Response.json(await service.sessionIdentity(await service.authenticate(request)), { headers });
      if (request.method === 'OPTIONS')
        return new Response(null, {
          status: 204,
          headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'authorization,apikey,content-type' },
        });
      if (
        request.method !== 'POST' ||
        url.search ||
        request.headers.has('x-user-id') ||
        request.headers.has('Content-Encoding') ||
        request.headers.get('Content-Type') !== 'application/json'
      )
        throw new FinanceError('INVALID_INPUT');
      const source = decodeUtf8(await readFinanceBytes(request, 8192));
      const body = requireClosedRecord(parseStrictJson(source), path === '/logout' ? [] : path === '/reset' ? ['confirmation', 'vaultId'] : ['password']);
      if (path === '/reset' && body.confirmation !== 'ELIMINAR BÓVEDA') throw new FinanceError('INVALID_INPUT');
      if (path === '/reset' && body.vaultId !== null) {
        if (typeof body.vaultId !== 'string') throw new FinanceError('INVALID_INPUT');
        if (!/^[A-Za-z0-9_-]{21}[AQgw]$/.test(body.vaultId)) throw new FinanceError('INVALID_INPUT');
      }
      if (path === '/account-password' && (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 1024))
        throw new FinanceError('INVALID_INPUT');
      const actor = await service.authenticate(request);
      if (path === '/reset') return Response.json(await service.resetVault(actor, body.vaultId as string | null), { headers });
      if (path === '/account-password') return Response.json(await service.changeAccountPassword(actor, body.password as string), { headers });
      return Response.json(await service.closeSession(actor), { headers });
    } catch (e) {
      const error =
        e instanceof FinanceError
          ? e
          : e instanceof VaultError
            ? new FinanceError('INVALID_INPUT', 400)
            : e instanceof JournalError
              ? new FinanceError('FINANCE_ACCESS_DENIED', 403)
              : new FinanceError('INVALID_OR_UNAVAILABLE', 503);
      return Response.json({ error: { code: error.code } }, { status: error.status, headers });
    }
  };
}

import {
  MAX_ENVELOPE_BYTES,
  OpaqueError,
  VaultError,
  decodeBase64Url,
  decodeUtf8,
  parseOpaquePut,
  parseStrictJson,
  requireClosedRecord,
} from '../../../src/app/finance/compatibility/protocol.ts';

export class FinanceError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
export interface FinanceActor {
  id: string;
  session: string;
  expiresAt: number;
  passwordAt: number | null;
}
export interface FinanceRuntime {
  origin: string;
  enabled: boolean;
  authenticate(request: Request): Promise<FinanceActor>;
  call(action: string, actor: FinanceActor, args: Record<string, unknown>): Promise<unknown>;
}

export async function readFinanceBytes(message: Request | Response, limit = MAX_ENVELOPE_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  const declared = message.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new FinanceError('ENVELOPE_TOO_LARGE', 413);
  if (!message.body) throw new FinanceError('INVALID_INPUT');
  const bytes = new Uint8Array(limit);
  const reader = message.body.getReader();
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (!ArrayBuffer.isView(part.value) || Object.prototype.toString.call(part.value) !== '[object Uint8Array]') throw new FinanceError('INVALID_INPUT');
      if (part.value.byteLength > limit - length) {
        void reader.cancel().catch(() => {});
        throw new FinanceError('ENVELOPE_TOO_LARGE', 413);
      }
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.slice(0, length);
}

function response(value: unknown, status: number, origin?: string): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    },
  });
}
function epoch(value: string | null): string {
  if (!value || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) throw new FinanceError('INVALID_INPUT');
  return value;
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/** Synthetic-only backend: no UI activation, finance notifications or plaintext. */
export function createFinanceHandler(runtime: FinanceRuntime) {
  return async (request: Request): Promise<Response> => {
    let allowedOrigin: string | undefined;
    try {
      if (!runtime.enabled) throw new FinanceError('FINANCE_DISABLED', 503);
      if (!runtime.origin || request.headers.get('origin') !== runtime.origin) throw new FinanceError('ORIGIN_DENIED', 403);
      allowedOrigin = runtime.origin;
      const url = new URL(request.url);
      if (url.search || url.hash || request.headers.has('x-user-id')) throw new FinanceError('INVALID_INPUT');
      // The Supabase gateway strips /functions/v1 from the forwarded path.
      const path = url.pathname.replace(/^\/functions\/v1/, '');
      if (request.method === 'OPTIONS') {
        const method = request.headers.get('access-control-request-method');
        const headers = (request.headers.get('access-control-request-headers') ?? '')
          .toLowerCase()
          .split(',')
          .map(value => value.trim())
          .filter(Boolean);
        if (
          !['GET', 'PUT', 'POST'].includes(method ?? '') ||
          headers.some(header => !['authorization', 'apikey', 'content-type', 'x-tr8-finance-epoch'].includes(header))
        )
          throw new FinanceError('ORIGIN_DENIED', 403);
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': runtime.origin,
            'Access-Control-Allow-Methods': 'GET, PUT, POST',
            'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-tr8-finance-epoch',
            'Cache-Control': 'no-store',
            Vary: 'Origin',
          },
        });
      }
      const actor = await runtime.authenticate(request);
      if (request.method === 'GET' && path === '/tr8-finance') return response(await runtime.call('read', actor, {}), 200, allowedOrigin);
      const receipt = /^\/tr8-finance\/receipt\/([A-Za-z0-9_-]{22})\/([A-Za-z0-9_-]{22})$/.exec(path);
      if (request.method === 'GET' && receipt) {
        decodeBase64Url(receipt[1], 16);
        decodeBase64Url(receipt[2], 16);
        return response(
          await runtime.call('receipt', actor, {
            p_vault_id: receipt[1],
            p_operation_id: receipt[2],
            p_expected_epoch: epoch(request.headers.get('x-tr8-finance-epoch')),
          }),
          200,
          allowedOrigin,
        );
      }
      if (!(
        (request.method === 'PUT' && path === '/tr8-finance') ||
        (request.method === 'POST' && ['/tr8-finance/reset', '/tr8-finance/revoke'].includes(path))
      ))
        throw new FinanceError('METHOD_NOT_ALLOWED', 405);
      if (request.headers.get('content-encoding') || request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
        throw new FinanceError('INVALID_INPUT');
      const bytes = await readFinanceBytes(request);
      const body = decodeUtf8(bytes);
      if (request.method === 'PUT') {
        const put = parseOpaquePut(body);
        if (put.envelope.ownerId !== actor.id) throw new FinanceError('CONTEXT_DENIED', 403);
        return response(
          await runtime.call('put', actor, { p_body_base64: base64(bytes), p_expected_epoch: epoch(request.headers.get('x-tr8-finance-epoch')) }),
          200,
          allowedOrigin,
        );
      }
      const reset = path.endsWith('/reset');
      const command = requireClosedRecord(
        parseStrictJson(body, { maxBytes: 4096 }),
        reset ? ['operationId', 'expectedEpoch', 'expectedVaultId'] : ['operationId', 'expectedEpoch', 'sessionId'],
      );
      decodeBase64Url(command.operationId as string, 16);
      const args: Record<string, unknown> = {
        p_operation_id: command.operationId,
        p_expected_epoch: epoch(typeof command.expectedEpoch === 'string' ? command.expectedEpoch : null),
      };
      if (reset) {
        decodeBase64Url(command.expectedVaultId as string, 16);
        args.p_vault_id = command.expectedVaultId;
      } else {
        if (typeof command.sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(command.sessionId)) throw new FinanceError('INVALID_INPUT');
        args.p_target_session = command.sessionId;
      }
      return response(await runtime.call(reset ? 'reset' : 'revoke', actor, args), 200, allowedOrigin);
    } catch (cause) {
      const error =
        cause instanceof FinanceError
          ? cause
          : cause instanceof OpaqueError
            ? new FinanceError(cause.code, cause.code === 'FORBIDDEN' ? 403 : 400)
            : cause instanceof VaultError
              ? new FinanceError(cause.code === 'SIZE_LIMIT' ? 'ENVELOPE_TOO_LARGE' : 'INVALID_INPUT', cause.code === 'SIZE_LIMIT' ? 413 : 400)
              : new FinanceError('DEPENDENCY_UNAVAILABLE', 503);
      return response({ error: { code: error.code } }, error.status, allowedOrigin);
    }
  };
}

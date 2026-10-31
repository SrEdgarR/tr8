import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { McpBackendError, type McpDispatch } from './backend.js';
import { createTr8McpServer } from './server.js';
import { createTr8FinanceMcpServer } from './finance-server.js';

export interface McpHttpOptions {
  dispatch: (token: string) => McpDispatch;
  allowedOrigins?: string[];
  /** Local review only until database migration and publication are approved. */
  financeEnabled?: boolean;
  /** Distinct opaque tokens and a finance-only tool catalog; never a browser JWT. */
  oauthFinance?: { challenge: string };
}
const MAX_BODY = 256 * 1024;
const BODY_READ_TIMEOUT_MS = 5000;
class BodyReadInterrupted extends Error {}
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function failure(status: number, code: string, message: string, challenge?: string) {
  return Response.json(
    { error: { code, message } },
    {
      status,
      headers: { ...headers, ...(status === 401 || (status === 403 && challenge) ? { 'WWW-Authenticate': challenge ?? 'Bearer realm="TR8 MCP"' } : {}) },
    },
  );
}
async function body(request: Request) {
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const cancel = () => {
    // A hostile stream's cancel hook must not keep this request alive either.
    void reader.cancel().catch(() => undefined);
  };
  if (request.signal.aborted) {
    cancel();
    reader.releaseLock();
    throw new BodyReadInterrupted();
  }
  let interrupt!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = () => {
      reject(new BodyReadInterrupted());
      cancel();
    };
  });
  const timeout = setTimeout(interrupt, BODY_READ_TIMEOUT_MS);
  request.signal.addEventListener('abort', interrupt, { once: true });
  try {
    if (Number(request.headers.get('content-length')) > MAX_BODY) {
      cancel();
      throw new RangeError();
    }
    const read = async () => {
      // Bound memory even when a sender splits its body into tiny chunks. Race
      // once, rather than retaining an abort-promise listener for every chunk.
      const bytes = new Uint8Array(MAX_BODY);
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (size + part.value.byteLength > MAX_BODY) {
          cancel();
          throw new RangeError();
        }
        bytes.set(part.value, size);
        size += part.value.byteLength;
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    };
    return await Promise.race([read(), interrupted]);
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', interrupt);
    reader.releaseLock();
  }
}

export async function handleMcpRequest(request: Request, options: McpHttpOptions): Promise<Response> {
  const origin = request.headers.get('origin');
  const origins = options.allowedOrigins ?? ['https://tr8.vercel.app'];
  if (origin !== null && !origins.includes(origin)) return failure(403, 'ORIGIN_DENIED', 'Origen no autorizado.');
  const cors: Record<string, string> = origin
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'MCP-Protocol-Version,WWW-Authenticate' }
    : {};
  if (request.method === 'OPTIONS')
    return new Response(null, {
      status: 204,
      headers: {
        ...headers,
        ...cors,
        'Access-Control-Allow-Methods': 'POST,GET,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type,Accept,MCP-Protocol-Version,MCP-Session-Id',
      },
    });
  const authorization = request.headers.get('authorization') ?? '';
  const credential = options.oauthFinance ? /^Bearer tr8_oauth_a_[a-f0-9]{64}$/ : /^Bearer tr8_mcp_[a-f0-9]{64}$/;
  if (!credential.test(authorization)) return failure(401, 'PT401', 'Se requiere una conexión MCP de TR8.', options.oauthFinance?.challenge);
  if (options.oauthFinance && ['access_token', 'token', 'authorization'].some(name => new URL(request.url).searchParams.has(name)))
    return failure(400, 'INVALID_REQUEST', 'La credencial solo se admite en la cabecera Authorization.');
  if (!['POST', 'GET', 'DELETE'].includes(request.method)) return failure(405, 'METHOD_NOT_ALLOWED', 'Método no admitido.');
  let dispatch: McpDispatch;
  let readOnly = false;
  try {
    dispatch = options.dispatch(authorization.slice(7));
    const context = await dispatch(options.oauthFinance ? 'finance_context' : 'context', {});
    if (options.oauthFinance) {
      if (!context || typeof context !== 'object' || !('access' in context) || !['read', 'write'].includes(String(context.access)))
        throw new McpBackendError('UNAVAILABLE');
      readOnly = context.access === 'read';
    }
  } catch (cause) {
    const error = cause instanceof McpBackendError ? cause : new McpBackendError('UNAVAILABLE');
    const status = error.code === 'PT401' ? 401 : error.code === 'PT403' ? 403 : error.code === 'PT429' ? 429 : 503;
    return failure(status, error.code, error.message, options.oauthFinance?.challenge);
  }
  let parsedBody: unknown;
  if (request.method === 'POST') {
    if (!request.headers.get('content-type')?.includes('application/json')) return failure(415, 'CONTENT_TYPE', 'Usa application/json.');
    try {
      parsedBody = await body(request);
    } catch (cause) {
      if (cause instanceof BodyReadInterrupted) return failure(408, 'REQUEST_TIMEOUT', 'No se recibió la solicitud MCP a tiempo.');
      return failure(cause instanceof RangeError ? 413 : 400, 'INVALID_REQUEST', 'Solicitud MCP inválida o demasiado grande.');
    }
  }
  const server = options.oauthFinance
    ? createTr8FinanceMcpServer(dispatch, { readOnly })
    : createTr8McpServer(dispatch, { financeEnabled: options.financeEnabled });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, { parsedBody });
    for (const [name, value] of Object.entries({ ...headers, ...cors })) response.headers.set(name, value);
    return response;
  } catch {
    return failure(500, 'INTERNAL_ERROR', 'No se pudo procesar la solicitud MCP.');
  } finally {
    await server.close();
  }
}

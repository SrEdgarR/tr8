import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { McpBackendError, type McpDispatch } from './backend.js';
import { createTr8McpServer } from './server.js';

export interface McpHttpOptions {
  dispatch: (token: string) => McpDispatch;
  allowedOrigins?: string[];
}
const MAX_BODY = 256 * 1024;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function failure(status: number, code: string, message: string) {
  return Response.json(
    { error: { code, message } },
    { status, headers: { ...headers, ...(status === 401 ? { 'WWW-Authenticate': 'Bearer realm="TR8 MCP"' } : {}) } },
  );
}
async function body(request: Request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new RangeError();
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
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
  if (!/^Bearer tr8_mcp_[a-f0-9]{64}$/.test(authorization)) return failure(401, 'PT401', 'Se requiere una conexión MCP de TR8.');
  if (!['POST', 'GET', 'DELETE'].includes(request.method)) return failure(405, 'METHOD_NOT_ALLOWED', 'Método no admitido.');
  let dispatch: McpDispatch;
  try {
    dispatch = options.dispatch(authorization.slice(7));
    await dispatch('context', {});
  } catch (cause) {
    const error = cause instanceof McpBackendError ? cause : new McpBackendError('UNAVAILABLE');
    const status = error.code === 'PT401' ? 401 : error.code === 'PT403' ? 403 : error.code === 'PT429' ? 429 : 503;
    return failure(status, error.code, error.message);
  }
  let parsedBody: unknown;
  if (request.method === 'POST') {
    if (!request.headers.get('content-type')?.includes('application/json')) return failure(415, 'CONTENT_TYPE', 'Usa application/json.');
    try {
      parsedBody = await body(request);
    } catch (cause) {
      return failure(cause instanceof RangeError ? 413 : 400, 'INVALID_REQUEST', 'Solicitud MCP inválida o demasiado grande.');
    }
  }
  const server = createTr8McpServer(dispatch);
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

import { createMcpDispatch } from '../server/mcp/backend.js';
import { handleMcpRequest } from '../server/mcp/http.js';

async function handle(request: Request): Promise<Response> {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    return Response.json(
      { error: { code: 'UNAVAILABLE', message: 'La conexión MCP no está configurada.' } },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  return handleMcpRequest(request, { dispatch: token => createMcpDispatch(token, { url, key }) });
}
export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const OPTIONS = handle;

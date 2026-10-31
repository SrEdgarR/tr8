import { createMcpDispatch } from '../../server/mcp/backend.js';
import { handleMcpRequest } from '../../server/mcp/http.js';
import { oauthResourceChallenge } from '../../server/mcp/oauth/router.js';

async function handle(request: Request): Promise<Response> {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (process.env.TR8_MCP_OAUTH_REVIEW_ENABLED !== 'true' || process.env.TR8_MCP_FINANCE_REVIEW_ENABLED !== 'true' || !url || !key)
    return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  return handleMcpRequest(request, {
    dispatch: token => createMcpDispatch(token, { url, key, financeEnabled: true, oauthFinance: true }),
    financeEnabled: true,
    oauthFinance: { challenge: oauthResourceChallenge() },
  });
}
export const POST = handle;
export const GET = handle;
export const DELETE = handle;
export const OPTIONS = handle;

import { oauthAuthorizationMetadata, oauthProtectedResourceMetadata } from '../server/mcp/oauth/router.js';

export function GET(request: Request): Response {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' };
  if (process.env.TR8_MCP_OAUTH_REVIEW_ENABLED !== 'true' || process.env.TR8_MCP_FINANCE_REVIEW_ENABLED !== 'true')
    return new Response(null, { status: 404, headers });
  const document = new URL(request.url).searchParams.get('document');
  if (document !== 'authorization' && document !== 'resource') return new Response(null, { status: 404, headers });
  return Response.json(document === 'authorization' ? oauthAuthorizationMetadata() : oauthProtectedResourceMetadata(), { headers });
}
export function HEAD(request: Request): Response {
  const response = GET(request);
  return new Response(null, { status: response.status, headers: response.headers });
}

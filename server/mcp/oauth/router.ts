import express from 'express';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import type { OAuthServerDispatch } from './backend.js';
import { createOAuthProvider } from './provider.js';
export { oauthAuthorizationMetadata, oauthProtectedResourceMetadata, oauthResourceChallenge } from './provider.js';

export function createOAuthProtocolRouter(options: { enabled?: boolean; dispatch: OAuthServerDispatch }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!options.enabled) {
      response.status(503).json({ error: 'temporarily_unavailable', error_description: 'La conexión OAuth de TR8 todavía está desactivada.' });
      return;
    }
    next();
  });
  // These endpoints accept OAuth form bodies, never JSON or URL query tokens.
  app.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 20 }));
  app.use((request, response, next) => {
    if (request.path !== '/api/oauth/authorize' && Object.keys(request.query).length) {
      response.status(400).json({ error: 'invalid_request', error_description: 'Envía los parámetros OAuth en el cuerpo de la solicitud.' });
      return;
    }
    if (request.method === 'POST' && !request.is('application/x-www-form-urlencoded')) {
      response.status(415).json({ error: 'invalid_request', error_description: 'Usa application/x-www-form-urlencoded.' });
      return;
    }
    const allowed =
      request.path === '/api/oauth/authorize'
        ? ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource']
        : request.path === '/api/oauth/token'
          ? ['grant_type', 'client_id', 'code', 'code_verifier', 'redirect_uri', 'resource', 'refresh_token', 'scope']
          : ['client_id', 'token', 'token_type_hint'];
    const parameters = request.method === 'GET' ? request.query : request.body;
    if (
      parameters &&
      (typeof parameters !== 'object' ||
        Array.isArray(parameters) ||
        Object.entries(parameters).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string'))
    ) {
      response.status(400).json({ error: 'invalid_request', error_description: 'Los parámetros OAuth no son válidos.' });
      return;
    }
    next();
  });
  const provider = createOAuthProvider(options.dispatch);
  // Do not trust forwarded IPs supplied by callers. SQL holds the durable
  // budgets; this SDK limiter is additional process-local protection only.
  // Vercel adds Forwarded too. Both headers are intentionally ignored: keep
  // socket-IP keys rather than trusting caller-supplied proxy identities.
  const rateLimit = { validate: { xForwardedForHeader: false, forwardedHeader: false } };
  app.use('/api/oauth/authorize', authorizationHandler({ provider, rateLimit }));
  app.use('/api/oauth/token', tokenHandler({ provider, rateLimit }));
  app.use('/api/oauth/revoke', revocationHandler({ provider, rateLimit }));
  app.use((_request, response) => {
    response.status(404).json({ error: 'invalid_request' });
  });
  // Express/body parser details may contain the submitted body. Never serialize them.
  app.use((_error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    void next; // Express recognizes an error handler only when it has four arguments.
    response.status(400).json({ error: 'invalid_request', error_description: 'Solicitud OAuth inválida o demasiado grande.' });
  });
  return app;
}

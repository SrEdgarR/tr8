import express from 'express';
import { createOAuthBackend, oauthBackendError } from './backend.js';
import { createOAuthProtocolRouter } from './router.js';

/**
 * Export the Express app itself so Vercel recognizes its Node listener and does
 * not install request/response helpers ahead of the bounded OAuth body parser.
 * Static API files avoid injecting a dynamic route parameter into OAuth query.
 */
export function createOAuthEntry() {
  let backend: ReturnType<typeof createOAuthBackend> | undefined;
  let configuredUrl: string | undefined;
  let configuredKey: string | undefined;
  const app = express();
  app.disable('x-powered-by');
  // SDK limiters are created once at initialization, outside the request stack.
  const router = createOAuthProtocolRouter({
    enabled: true,
    dispatch: async (action, input) => {
      const url = process.env.VITE_SUPABASE_URL;
      const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      if (process.env.TR8_MCP_OAUTH_REVIEW_ENABLED !== 'true' || process.env.TR8_MCP_FINANCE_REVIEW_ENABLED !== 'true' || !url || !key)
        throw oauthBackendError('temporarily_unavailable');
      // Only static backend configuration is cached, never a user's state.
      if (!backend || configuredUrl !== url || configuredKey !== key) {
        backend = createOAuthBackend({ url, key });
        configuredUrl = url;
        configuredKey = key;
      }
      return backend(action, input);
    },
  });
  app.use((request, response, next) => {
    const url = process.env.VITE_SUPABASE_URL;
    const key = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    const enabled = process.env.TR8_MCP_OAUTH_REVIEW_ENABLED === 'true' && process.env.TR8_MCP_FINANCE_REVIEW_ENABLED === 'true' && Boolean(url && key);
    if (!enabled) {
      response.setHeader('Cache-Control', 'no-store');
      response.status(503).json({ error: 'temporarily_unavailable' });
      return;
    }
    next();
  });
  app.use(router);
  return app;
}

export default createOAuthEntry();

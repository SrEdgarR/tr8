import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { z } from 'zod';
import type { OAuthServerDispatch } from './backend.js';

export const OAUTH_ISSUER = 'https://tr8.vercel.app';
export const OAUTH_RESOURCE = `${OAUTH_ISSUER}/api/mcp/finance`;
export const OAUTH_RESOURCE_METADATA = `${OAUTH_ISSUER}/.well-known/oauth-protected-resource/api/mcp/finance`;
export const OAUTH_SCOPES = ['finance:read', 'finance:write'] as const;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const scopesSchema = z
  .array(z.enum(OAUTH_SCOPES))
  .min(1)
  .max(2)
  .refine(value => value.includes('finance:read') && new Set(value).size === value.length);
const token = z.string().regex(/^tr8_oauth_a_[a-f0-9]{64}$/);
const refreshToken = z.string().regex(/^tr8_oauth_r_[a-f0-9]{64}$/);
const code = z.string().regex(/^tr8_oauth_c_[a-f0-9]{64}$/);
const attempt = z.string().regex(/^tr8_oauth_p_[a-f0-9]{64}$/);
const instant = z.iso.datetime({ offset: true });
const challenge = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const verifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
const safeRedirect = z
  .string()
  .url()
  .refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  });
const clientSchema = z
  .object({
    client_id: id,
    client_name: z.string().min(1).max(120),
    redirect_uris: z.array(safeRedirect).min(1).max(10),
    token_endpoint_auth_method: z.literal('none'),
    grant_types: z
      .array(z.enum(['authorization_code', 'refresh_token']))
      .min(1)
      .max(2),
    response_types: z.tuple([z.literal('code')]),
  })
  .strict();
const beginResponse = z.object({ attempt, expires_at: instant }).strict();
const tokenResponse = z
  .object({
    access_token: token,
    token_type: z.literal('Bearer'),
    expires_in: z.number().int().min(1).max(900),
    refresh_token: refreshToken,
    scope: z.string().refine(value => scopesSchema.safeParse(value.split(' ')).success),
  })
  .strict();
const verifiedResponse = z
  .object({ client_id: id, scopes: scopesSchema, expires_at: instant, resource: z.literal(OAUTH_RESOURCE), grant_id: z.uuid() })
  .strict();

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ServerError('TR8 no pudo comprobar la respuesta de autorización.');
  return result.data;
}
function requiredResource(value: URL | undefined) {
  if (value?.href !== OAUTH_RESOURCE) throw new InvalidTargetError('Este acceso requiere el recurso financiero de TR8.');
  return OAUTH_RESOURCE;
}
function requestedScopes(value: string[] | undefined) {
  const result = scopesSchema.safeParse(value?.length ? value : ['finance:read']);
  if (!result.success) throw new InvalidScopeError('Selecciona permisos financieros compatibles.');
  return result.data;
}
function requiredCode(value: string) {
  if (!code.safeParse(value).success) throw new InvalidGrantError('El código no es válido.');
  return value;
}

/** Only the opaque financial token family is accepted; Supabase JWTs and MCP PATs are excluded. */
export async function verifyOAuthAccessToken(dispatch: OAuthServerDispatch, value: string, now = Date.now()): Promise<AuthInfo> {
  if (!token.safeParse(value).success) throw new InvalidTokenError('Se requiere un acceso OAuth financiero de TR8.');
  const result = checked(verifiedResponse, await dispatch('verify', { token: value, resource: OAUTH_RESOURCE }));
  const expiry = Math.floor(Date.parse(result.expires_at) / 1000);
  if (!Number.isFinite(now) || expiry <= Math.floor(now / 1000) || expiry > Math.floor(now / 1000) + 900)
    throw new InvalidTokenError('El acceso OAuth ha caducado.');
  return {
    token: value,
    clientId: result.client_id,
    scopes: result.scopes,
    expiresAt: expiry,
    resource: new URL(OAUTH_RESOURCE),
    extra: { grantId: result.grant_id },
  };
}

/**
 * The maintained SDK owns OAuth protocol handling. SQL owns single-use codes,
 * S256 verification, token rotation, audience/client binding and live grants.
 * Browser Supabase sessions are never returned to the OAuth client.
 */
export function createOAuthProvider(dispatch: OAuthServerDispatch): OAuthServerProvider {
  return {
    // The SDK otherwise removes code_verifier after a separate challenge check.
    // SQL must verify and consume the code atomically, so it performs the PKCE check.
    skipLocalPkceValidation: true,
    clientsStore: {
      async getClient(clientId) {
        if (!id.safeParse(clientId).success) return undefined;
        const raw = await dispatch('get_client', { client_id: clientId });
        if (raw === null) return undefined;
        const client = checked(clientSchema, raw);
        if (
          client.client_id !== clientId ||
          !client.grant_types.includes('authorization_code') ||
          new Set(client.redirect_uris).size !== client.redirect_uris.length
        )
          throw new InvalidClientError('El cliente no está disponible.');
        return client as OAuthClientInformationFull;
      },
    },
    async authorize(client, params, response) {
      const resource = requiredResource(params.resource);
      if (!client.redirect_uris.includes(params.redirectUri) || !safeRedirect.safeParse(params.redirectUri).success)
        throw new InvalidRequestError('La dirección de retorno no está autorizada.');
      if (
        !challenge.safeParse(params.codeChallenge).success ||
        (params.state !== undefined &&
          (params.state.length > 512 || Array.from(params.state).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)))
      )
        throw new InvalidRequestError('La solicitud de autorización no es válida.');
      const result = checked(
        beginResponse,
        await dispatch('begin', {
          client_id: client.client_id,
          redirect_uri: params.redirectUri,
          code_challenge: params.codeChallenge,
          scopes: requestedScopes(params.scopes),
          resource,
          ...(params.state === undefined ? {} : { state: params.state }),
        }),
      );
      const target = new URL('/oauth/consent', OAUTH_ISSUER);
      target.searchParams.set('attempt', result.attempt);
      response.redirect(302, target.href);
    },
    async challengeForAuthorizationCode(client, value) {
      const result = checked(
        z.object({ code_challenge: challenge }).strict(),
        await dispatch('challenge', { client_id: client.client_id, code: requiredCode(value) }),
      );
      return result.code_challenge;
    },
    async exchangeAuthorizationCode(client, value, codeVerifier, redirectUri, target) {
      const resource = requiredResource(target);
      if (!verifier.safeParse(codeVerifier).success || !redirectUri || !client.redirect_uris.includes(redirectUri))
        throw new InvalidGrantError('El código o su comprobación no son válidos.');
      return checked(
        tokenResponse,
        await dispatch('exchange', {
          client_id: client.client_id,
          code: requiredCode(value),
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          resource,
        }),
      );
    },
    async exchangeRefreshToken(client, value, scopes, target) {
      const resource = requiredResource(target);
      if (!refreshToken.safeParse(value).success) throw new InvalidGrantError('El acceso de renovación no es válido.');
      if (scopes !== undefined) requestedScopes(scopes);
      return checked(
        tokenResponse,
        await dispatch('refresh', { client_id: client.client_id, refresh_token: value, resource, ...(scopes === undefined ? {} : { scopes }) }),
      );
    },
    verifyAccessToken: value => verifyOAuthAccessToken(dispatch, value),
    async revokeToken(client, input) {
      // Unknown or already revoked tokens are deliberately a successful no-op.
      if (!token.safeParse(input.token).success && !refreshToken.safeParse(input.token).success) return;
      const result = await dispatch('revoke', {
        client_id: client.client_id,
        token: input.token,
        ...(input.token_type_hint === undefined ? {} : { token_type_hint: input.token_type_hint }),
      });
      checked(z.object({}).strict(), result);
    },
  };
}

export function oauthAuthorizationMetadata() {
  return {
    issuer: OAUTH_ISSUER,
    authorization_endpoint: `${OAUTH_ISSUER}/api/oauth/authorize`,
    token_endpoint: `${OAUTH_ISSUER}/api/oauth/token`,
    revocation_endpoint: `${OAUTH_ISSUER}/api/oauth/revoke`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  };
}
export function oauthProtectedResourceMetadata() {
  return {
    resource: OAUTH_RESOURCE,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'TR8 · Finanzas',
  };
}
export function oauthResourceChallenge() {
  return `Bearer realm="TR8 Finanzas", resource_metadata="${OAUTH_RESOURCE_METADATA}", scope="finance:read"`;
}

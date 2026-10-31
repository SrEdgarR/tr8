import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { verifiedAccessToken } from '../../data/verified-access-token';
import { DataError } from '../../data/errors';

export const OAUTH_FINANCE_RESOURCE = 'https://tr8.vercel.app/api/mcp/finance';
const attemptSchema = z.string().regex(/^tr8_oauth_p_[a-f0-9]{64}$/);
const scopes = z
  .array(z.enum(['finance:read', 'finance:write']))
  .min(1)
  .max(2)
  .refine(values => new Set(values).size === values.length && values.includes('finance:read'));
const instant = z.iso.datetime({ offset: true });
const redirect = z
  .url()
  .max(2048)
  .refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  });
const connection = z
  .object({
    credential_id: z.uuid(),
    name: z.string().min(1).max(80),
    access: z.enum(['read', 'write']),
    grant_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    expires_at: instant,
    accounts: z
      .array(
        z
          .object({ account_id: z.string().min(1).max(128), start_at: instant, name: z.string().min(1).max(240), currency: z.string().regex(/^[A-Z]{3}$/) })
          .strict(),
      )
      .min(1)
      .max(100),
    mailbox_ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20),
    expense_categories: z.array(z.string().max(32)).max(10),
    income_categories: z.array(z.string().max(32)).max(10),
  })
  .strict()
  .refine(grant => grant.access === 'read' || grant.mailbox_ids.length > 0);
const detailsSchema = z
  .object({
    attempt: attemptSchema,
    client_id: z.string().min(1).max(200),
    client_name: z.string().min(1).max(120),
    redirect_uri: redirect,
    scopes,
    resource: z.literal(OAUTH_FINANCE_RESOURCE),
    expires_at: instant,
    connections: z.array(connection).max(100),
  })
  .strict();
const approvalSchema = z
  .object({ redirect_uri: redirect, state: z.string().max(2048).nullable(), code: z.string().regex(/^tr8_oauth_c_[a-f0-9]{64}$/) })
  .strict();
const denialSchema = z.object({ redirect_uri: redirect, state: z.string().max(2048).nullable(), error: z.literal('access_denied') }).strict();
const grantSchema = z
  .object({
    grant_id: z.uuid(),
    client_name: z.string().min(1).max(120),
    client_id: z.string().min(1).max(200),
    credential_id: z.uuid(),
    scopes,
    created_at: instant,
    expires_at: instant,
    revoked_at: instant.nullable(),
  })
  .strict();

export type OAuthConsentDetails = z.infer<typeof detailsSchema>;
export type OAuthApproval = z.infer<typeof approvalSchema>;
export type OAuthDenial = z.infer<typeof denialSchema>;
export type OAuthConnectionGrant = z.infer<typeof grantSchema>;
export interface OAuthConsentApi {
  ownerId: string;
  details(attempt: string): Promise<OAuthConsentDetails>;
  approve(attempt: string, credentialId: string, grantFingerprint: string): Promise<OAuthApproval>;
  deny(attempt: string): Promise<OAuthDenial>;
  list(): Promise<OAuthConnectionGrant[]>;
  revoke(grantId: string): Promise<void>;
}

function invalid() {
  return new DataError('No pudimos comprobar esta solicitud de autorización. Vuelve a iniciarla desde tu asistente.');
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const checked = schema.safeParse(value);
  if (!checked.success) throw invalid();
  return checked.data;
}
export function createOAuthConsentApi(client: SupabaseClient, ownerId: string): OAuthConsentApi {
  async function request(action: string, input: Record<string, unknown>) {
    const token = await verifiedAccessToken(client, ownerId);
    try {
      const { data, error } = await client.rpc('tr8_mcp_oauth_consent', { p_action: action, p_input: input }).setHeader('Authorization', `Bearer ${token}`);
      if (error) {
        if (['42501', 'PT401', 'PGRST301', 'PGRST303'].includes(error.code)) throw new DataError('Confirma tu sesión de TR8 para revisar este acceso.');
        if (['PT403', 'PT404', 'PT409'].includes(error.code)) throw invalid();
        throw new DataError('No se pudo confirmar la autorización. Consulta sus accesos antes de volver a intentarlo.');
      }
      const identity = await client.auth.getUser();
      if (identity.error || identity.data.user?.id !== ownerId) throw new DataError('Tu sesión cambió. Vuelve a abrir la solicitud de autorización.');
      return data as unknown;
    } catch (cause) {
      if (cause instanceof DataError) throw cause;
      throw new DataError('No se pudo confirmar la autorización. Vuelve a consultar antes de reintentar.');
    }
  }
  const attempt = (value: string) => parsed(attemptSchema, value);
  return {
    ownerId,
    async details(value) {
      const result = parsed(detailsSchema, await request('details', { attempt: attempt(value) }));
      if (result.attempt !== value || new Set(result.connections.map(c => c.credential_id)).size !== result.connections.length) throw invalid();
      return result;
    },
    async approve(value, credentialId, grantFingerprint) {
      return parsed(
        approvalSchema,
        await request('approve', {
          attempt: attempt(value),
          credential_id: parsed(z.uuid(), credentialId),
          grant_fingerprint: parsed(z.string().regex(/^[a-f0-9]{64}$/), grantFingerprint),
        }),
      );
    },
    async deny(value) {
      return parsed(denialSchema, await request('deny', { attempt: attempt(value) }));
    },
    async list() {
      const result = parsed(z.object({ items: z.array(grantSchema).max(100), next_cursor: z.null() }).strict(), await request('list', {}));
      if (new Set(result.items.map(g => g.grant_id)).size !== result.items.length) throw invalid();
      return result.items;
    },
    async revoke(grantId) {
      const id = parsed(z.uuid(), grantId);
      const result = parsed(z.object({ grant_id: z.uuid(), revoked: z.literal(true) }).strict(), await request('revoke', { grant_id: id }));
      if (result.grant_id !== id) throw invalid();
    },
  };
}

/** A one-use authorization code can only return to the exact reviewed URI. */
export function consentRedirect(details: OAuthConsentDetails, result: OAuthApproval | OAuthDenial): string {
  if (result.redirect_uri !== details.redirect_uri) throw invalid();
  const target = new URL(parsed(redirect, result.redirect_uri));
  if ('code' in result) target.searchParams.set('code', parsed(approvalSchema, result).code);
  else target.searchParams.set('error', parsed(denialSchema, result).error);
  if (result.state !== null) target.searchParams.set('state', result.state);
  return target.href;
}

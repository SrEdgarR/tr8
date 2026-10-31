import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { DataError } from '../../data/errors';
import { verifiedAccessToken } from '../../data/verified-access-token';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../domain/categories';

const id = z
  .string()
  .min(1)
  .max(128)
  .refine(value => value.trim() === value);
const instant = z.iso.datetime({ offset: true });
const version = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/)
  .refine(value => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));
const distinct = <T>(items: T[]) => new Set(items).size === items.length;
const draftSchema = z
  .object({
    credential_id: z.uuid(),
    access: z.enum(['read', 'write']),
    accounts: z
      .array(z.object({ account_id: id, start_at: instant }).strict())
      .min(1)
      .max(100)
      .refine(items => distinct(items.map(item => item.account_id))),
    mailbox_ids: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(20)
      .refine(distinct),
    expense_categories: z.array(z.enum(EXPENSE_CATEGORIES)).max(EXPENSE_CATEGORIES.length).refine(distinct),
    income_categories: z.array(z.enum(INCOME_CATEGORIES)).max(INCOME_CATEGORIES.length).refine(distinct),
  })
  .strict()
  .refine(grant => grant.access === 'read' || grant.mailbox_ids.length > 0);
const grantSchema = draftSchema.safeExtend({ enabled: z.literal(true) }).strict();
const grantsSchema = z.object({ items: z.array(grantSchema).max(100), next_cursor: z.null() }).strict();
const reviewSchema = z
  .object({
    notice_id: z.uuid(),
    status: z.enum(['review', 'dismissed']),
    review_reason: z.string().min(1).max(100),
    account_id: id,
    kind: z.enum(['purchase', 'income', 'own_transfer', 'card_payment', 'refund', 'reversal', 'unknown']),
    bank_status: z.enum(['posted', 'pending', 'rejected', 'cancelled', 'unknown']),
    amount: z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .max(100)
      .nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    date: z.iso.date().nullable(),
    occurred_at: instant.nullable(),
    time_zone: z.string().min(1).max(100).nullable(),
    description: z.string().max(240).nullable(),
    category: z.string().max(32).nullable(),
    created_at: instant,
  })
  .strict();
const reviewPageSchema = z.object({ items: z.array(reviewSchema).max(100), next_cursor: z.uuid().nullable(), version }).strict();
export type FinanceMcpGrantDraft = z.infer<typeof draftSchema>;
export type FinanceMcpGrant = z.infer<typeof grantSchema>;
export type FinanceMcpReview = z.infer<typeof reviewSchema>;
export type FinanceMcpReviewPage = z.infer<typeof reviewPageSchema>;
export interface FinanceMcpApi {
  ownerId: string;
  listGrants(): Promise<FinanceMcpGrant[]>;
  setGrant(draft: FinanceMcpGrantDraft): Promise<FinanceMcpGrant>;
  revokeGrant(credentialId: string): Promise<void>;
  listReviews(page?: { cursor?: string; limit?: number }): Promise<FinanceMcpReviewPage>;
  dismissReview(noticeId: string): Promise<FinanceMcpReview>;
}

const invalid = () => new DataError('No pudimos comprobar la respuesta financiera. Actualiza antes de continuar.');
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid();
  return result.data;
}
function requestError(code: unknown) {
  if (['42501', 'PT401', 'PGRST301', 'PGRST303'].includes(String(code)))
    return new DataError('Confirma tu sesión de TR8 para administrar el acceso financiero.');
  if (['PT403', 'PT404'].includes(String(code))) return new DataError('Este permiso o aviso no está disponible para tu cuenta.');
  if (code === 'PT409') return new DataError('Los datos cambiaron. Actualiza la lista antes de continuar.');
  return new DataError('No se pudo confirmar la operación. Actualiza antes de reintentar.');
}
function sameGrant(actual: FinanceMcpGrant, expected: FinanceMcpGrantDraft) {
  const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(item => b.includes(item));
  return (
    actual.credential_id === expected.credential_id &&
    actual.access === expected.access &&
    actual.accounts.length === expected.accounts.length &&
    actual.accounts.every(account =>
      expected.accounts.some(entry => entry.account_id === account.account_id && Date.parse(entry.start_at) === Date.parse(account.start_at)),
    ) &&
    sameSet(actual.mailbox_ids, expected.mailbox_ids) &&
    sameSet(actual.expense_categories, expected.expense_categories) &&
    sameSet(actual.income_categories, expected.income_categories)
  );
}

/** Management uses the signed-in person's session, never a delegated MCP key. No network calls on construction. */
export function createFinanceMcpApi(client: SupabaseClient, ownerId: string): FinanceMcpApi {
  async function request(action: string, input: Record<string, unknown>) {
    const token = await verifiedAccessToken(client, ownerId);
    try {
      const { data, error } = await client.rpc('tr8_mcp_finance_manage', { p_action: action, p_input: input }).setHeader('Authorization', `Bearer ${token}`);
      if (error) throw requestError(error.code);
      const current = await client.auth.getUser();
      if (current.error || current.data.user?.id !== ownerId) throw new DataError('Tu sesión cambió. Vuelve a iniciar sesión.');
      return data as unknown;
    } catch (cause) {
      if (cause instanceof DataError) throw cause;
      throw requestError(undefined);
    }
  }
  return {
    ownerId,
    async listGrants() {
      const result = parse(grantsSchema, await request('list', {}));
      if (!distinct(result.items.map(item => item.credential_id))) throw invalid();
      return result.items;
    },
    async setGrant(draft) {
      const normalized = draftSchema.safeParse(draft);
      if (!normalized.success) throw new DataError('Revisa la conexión, las cuentas, las fechas y los permisos seleccionados.');
      const result = parse(grantSchema, await request('set_grant', normalized.data));
      if (!sameGrant(result, normalized.data)) throw invalid();
      return result;
    },
    async revokeGrant(credentialId) {
      if (!z.uuid().safeParse(credentialId).success) throw new DataError('Selecciona una conexión válida.');
      const result = parse(
        z.object({ credential_id: z.uuid(), enabled: z.literal(false) }).strict(),
        await request('revoke_grant', { credential_id: credentialId }),
      );
      if (result.credential_id !== credentialId) throw invalid();
    },
    async listReviews(page = {}) {
      const input = z
        .object({ cursor: z.uuid().optional(), limit: z.number().int().min(1).max(100).optional() })
        .strict()
        .safeParse(page);
      if (!input.success) throw new DataError('Selecciona una página válida.');
      const result = parse(reviewPageSchema, await request('list_reviews', input.data));
      if (!distinct(result.items.map(item => item.notice_id))) throw invalid();
      return result;
    },
    async dismissReview(noticeId) {
      if (!z.uuid().safeParse(noticeId).success) throw new DataError('Selecciona un aviso válido.');
      const result = parse(reviewSchema, await request('dismiss_review', { notice_id: noticeId }));
      if (result.notice_id !== noticeId || result.status !== 'dismissed') throw invalid();
      return result;
    },
  };
}

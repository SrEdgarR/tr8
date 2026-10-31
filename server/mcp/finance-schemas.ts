import { z } from 'zod';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '../../src/app/finance/domain/categories.js';

const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const mailboxId = z.string().regex(/^[a-f0-9]{64}$/);
export const financeNoticeInstant = z.iso.datetime({ offset: true }).regex(/T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/);
const maximumVersion = BigInt(Number.MAX_SAFE_INTEGER) - 1n;
const version = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/)
  .refine(value => /^(0|[1-9][0-9]{0,15})$/.test(value) && BigInt(value) <= maximumVersion);
const categories = [...new Set([...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES])];

function localDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day);
}
function isIanaZone(value: string) {
  if (value !== 'UTC' && !/^[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Reject multiline email content and likely complete bank/card numbers; never log the rejected text. */
function minimalDescription(value: string) {
  if (/[\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) return false;
  // Known credential markers are rejected; a concept is not a general-purpose secret detector.
  if (
    /(bearer\s+\S+|tr8_mcp_|sb_secret_|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\b(?:otp|pin|cvv|cvc|password|contrase[nñ]a|c[oó]digo de (?:acceso|seguridad|verificaci[oó]n))\b.{0,20}[0-9]{3,})/i.test(
      value,
    )
  )
    return false;
  if (
    [...value].some(character => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff);
    })
  )
    return false;
  return !(value.match(/\d(?:[ -]*\d){11,}/g) ?? []).length;
}

/** Standalone MCP schemas deliberately avoid importing the financial/crypto runtime graph. */
export const financeNoticeSchema = z
  .object({
    request_id: z.uuid(),
    expected_version: version,
    source: z.object({ provider: z.literal('gmail'), mailbox_id: mailboxId, message_id: opaqueId, bank_transaction_id: mailboxId.optional() }).strict(),
    account_id: z.string().trim().min(1).max(128),
    kind: z.enum(['purchase', 'income', 'own_transfer', 'card_payment', 'refund', 'reversal', 'unknown']).default('unknown'),
    status: z.enum(['posted', 'pending', 'rejected', 'cancelled', 'unknown']).default('unknown'),
    amount: z
      .string()
      .max(100)
      .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
      .refine(value => !/^0(?:\.0+)?$/.test(value))
      .optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    occurred_at: financeNoticeInstant.optional(),
    time_zone: z.string().max(100).refine(isIanaZone).optional(),
    date: z.iso.date().refine(localDate).optional(),
    description: z.string().max(240).refine(minimalDescription).trim().min(1).optional(),
    category: z.enum(categories).optional(),
  })
  .strict();

export type FinanceNoticeInput = z.infer<typeof financeNoticeSchema>;

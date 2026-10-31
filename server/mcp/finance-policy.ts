import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, type ExpenseCategory, type IncomeCategory } from '../../src/app/finance/domain/categories.js';
import { isLocalDate } from '../../src/app/finance/domain/dates.js';
import { parseAmountMinor } from '../../src/app/finance/domain/money.js';
import { operationDestinationAmount, operationDestinationCurrency } from '../../src/app/finance/domain/operations.js';
import { validateFinancialSnapshot } from '../../src/app/finance/domain/snapshot.js';
import { addEntry, prepareEntryOperation } from '../../src/app/finance/domain/workspace.js';
import type { FinancialSnapshot, WorkspaceOperation } from '../../src/app/finance/domain/workspace-types.js';
import { financeNoticeInstant, financeNoticeSchema, type FinanceNoticeInput } from './finance-schemas.js';
export { financeNoticeSchema, type FinanceNoticeInput } from './finance-schemas.js';
const categories = [...new Set([...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES])];
export interface FinanceNoticeGrant {
  accounts: readonly { account_id: string; start_at: string }[];
  mailbox_ids: readonly string[];
  income_categories: readonly IncomeCategory[];
  expense_categories: readonly ExpenseCategory[];
}
export type FinanceReviewReason =
  | 'unsupported_kind'
  | 'unconfirmed_status'
  | 'missing_amount'
  | 'missing_currency'
  | 'missing_occurred_at'
  | 'missing_time_zone'
  | 'missing_description'
  | 'missing_bank_transaction_id'
  | 'before_import_start'
  | 'captured_balance'
  | 'future_notice'
  | 'credit_income_requires_review'
  | 'refund_requires_review'
  | 'possible_duplicate'
  | 'operation_limit'
  | 'balance_range';

interface PreparedNoticeBase {
  notice: FinanceNoticeInput;
  amountMinor?: number;
  date?: string;
}
export type PreparedFinanceNotice =
  | (PreparedNoticeBase & { decision: 'review'; reasons: FinanceReviewReason[] })
  | (PreparedNoticeBase & { decision: 'eligible'; reasons: []; operation: WorkspaceOperation; nextSnapshot: FinancialSnapshot });

export class FinanceNoticeError extends Error {
  constructor(public readonly code: 'INVALID_INPUT' | 'PT403') {
    super(code === 'PT403' ? 'Esta conexión no tiene permiso para esa cuenta o buzón.' : 'Revisa los datos mínimos del aviso financiero.');
    this.name = 'FinanceNoticeError';
  }
}

function localDate(occurredAt: string, zone: string) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', calendar: 'iso8601' }).formatToParts(
    new Date(occurredAt),
  );
  const part = (kind: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === kind)?.value;
  const result = `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}`;
  if (!isLocalDate(result)) throw new FinanceNoticeError('INVALID_INPUT');
  return result;
}

/** Date is sufficient for zone formatting, but cutover comparisons retain all six fractional digits. */
function instantMicros(value: string) {
  const parsed = financeNoticeInstant.safeParse(value);
  const milliseconds = Date.parse(value);
  if (!parsed.success || !Number.isFinite(milliseconds)) throw new FinanceNoticeError('INVALID_INPUT');
  const fraction = /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '';
  return BigInt(milliseconds) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3));
}

/**
 * Pure preparation only. Authorization, durable source/request deduplication,
 * per-owner serialization and the actual ledger commit belong to the RPC.
 * The encrypted vault is never decrypted or mutated by this policy.
 */
export function prepareFinanceNotice(
  snapshot: FinancialSnapshot,
  candidate: unknown,
  grant: FinanceNoticeGrant,
  now: Date | string = new Date(),
): PreparedFinanceNotice {
  const parsed = financeNoticeSchema.safeParse(candidate);
  if (!parsed.success) throw new FinanceNoticeError('INVALID_INPUT');
  const notice = parsed.data;
  const authorized = grant.accounts.filter(item => item.account_id === notice.account_id);
  if (authorized.length !== 1 || !grant.mailbox_ids.includes(notice.source.mailbox_id)) throw new FinanceNoticeError('PT403');
  const start = financeNoticeInstant.safeParse(authorized[0]!.start_at);
  if (!start.success) throw new FinanceNoticeError('PT403');
  let checked: FinancialSnapshot;
  try {
    checked = validateFinancialSnapshot(snapshot);
  } catch {
    throw new FinanceNoticeError('INVALID_INPUT');
  }
  const account = checked.financialSpace.accounts.find(item => item.id === notice.account_id);
  if (!account) throw new FinanceNoticeError('PT403');
  if (notice.currency !== undefined && notice.currency !== account.currency) throw new FinanceNoticeError('INVALID_INPUT');
  const currency = checked.financialSpace.currencyDefinitions.find(item => item.code === account.currency)!;
  let amountMinor: number | undefined;
  if (notice.amount !== undefined) {
    try {
      amountMinor = parseAmountMinor(notice.amount, currency.minorUnitDigits);
    } catch {
      throw new FinanceNoticeError('INVALID_INPUT');
    }
  }
  const category = notice.category ?? 'other';
  const allowed = notice.kind === 'income' ? INCOME_CATEGORIES : notice.kind === 'purchase' ? EXPENSE_CATEGORIES : categories;
  if (!(allowed as readonly string[]).includes(category)) throw new FinanceNoticeError('INVALID_INPUT');
  const granted =
    notice.kind === 'income'
      ? grant.income_categories
      : notice.kind === 'purchase'
        ? grant.expense_categories
        : [...grant.income_categories, ...grant.expense_categories];
  if ((notice.kind === 'income' || notice.kind === 'purchase' || notice.category !== undefined) && !(granted as readonly string[]).includes(category))
    throw new FinanceNoticeError('PT403');
  const derivedDate = notice.occurred_at && notice.time_zone ? localDate(notice.occurred_at, notice.time_zone) : undefined;
  if (notice.date !== undefined && derivedDate !== undefined && notice.date !== derivedDate) throw new FinanceNoticeError('INVALID_INPUT');
  const date = derivedDate ?? notice.date;
  if (typeof now !== 'string' && !Number.isFinite(now.getTime())) throw new FinanceNoticeError('INVALID_INPUT');
  const nowMicros = typeof now === 'string' ? instantMicros(now) : BigInt(now.getTime()) * 1000n;
  const occurredMicros = notice.occurred_at ? instantMicros(notice.occurred_at) : undefined;
  const reasons: FinanceReviewReason[] = [];
  if (notice.kind !== 'purchase' && notice.kind !== 'income') reasons.push('unsupported_kind');
  if (notice.status !== 'posted') reasons.push('unconfirmed_status');
  if (amountMinor === undefined) reasons.push('missing_amount');
  if (!notice.currency) reasons.push('missing_currency');
  if (!notice.occurred_at) reasons.push('missing_occurred_at');
  if (!notice.time_zone) reasons.push('missing_time_zone');
  if (!notice.description) reasons.push('missing_description');
  if (!notice.source.bank_transaction_id) reasons.push('missing_bank_transaction_id');
  if (occurredMicros !== undefined && occurredMicros < instantMicros(start.data)) reasons.push('before_import_start');
  if (date && (date <= account.openingDate || (account.type === 'credit' && account.creditCard?.baseline && date <= account.creditCard.baseline.asOfDate)))
    reasons.push('captured_balance');
  if (occurredMicros !== undefined && occurredMicros > nowMicros) reasons.push('future_notice');
  if (notice.kind === 'income' && account.type === 'credit') reasons.push('credit_income_requires_review');
  if (notice.kind === 'income' && category === 'refund') reasons.push('refund_requires_review');
  const base = {
    notice: { ...notice, ...(derivedDate ? { date: derivedDate } : {}) },
    ...(amountMinor === undefined ? {} : { amountMinor }),
    ...(date ? { date } : {}),
  };
  if (
    !reasons.length &&
    checked.financialSpace.operations.some(
      operation =>
        operation.date === date &&
        (operation.kind === 'card-payment' && operation.toAccountId === account.id ? operationDestinationCurrency(operation) : operation.currency) ===
          notice.currency &&
        (operation.kind === 'card-payment' && operation.toAccountId === account.id ? operationDestinationAmount(operation) : operation.amountMinor) ===
          amountMinor &&
        [
          operation.kind === 'income' || operation.kind === 'expense'
            ? operation.accountId
            : operation.kind === 'refund'
              ? operation.destinationAccountId
              : operation.fromAccountId,
          operation.kind === 'transfer' || operation.kind === 'card-payment' ? operation.toAccountId : undefined,
        ].includes(account.id),
    )
  )
    reasons.push('possible_duplicate');
  if (!reasons.length && checked.financialSpace.operations.length >= 10000) reasons.push('operation_limit');
  if (reasons.length) return { ...base, decision: 'review', reasons };
  try {
    const entry = {
      id: notice.request_id,
      kind: notice.kind === 'purchase' ? 'expense' : 'income',
      accountId: account.id,
      date,
      amountMinor,
      description: notice.description,
      note: '',
      category,
    };
    const operation = prepareEntryOperation(checked, entry);
    if (checked.financialSpace.operations.some(existing => existing.id === operation.id))
      return { ...base, decision: 'review', reasons: ['possible_duplicate'] };
    let nextSnapshot: FinancialSnapshot;
    try {
      nextSnapshot = addEntry(checked, entry);
    } catch {
      return { ...base, decision: 'review', reasons: ['balance_range'] };
    }
    return { ...base, decision: 'eligible', reasons: [], operation, nextSnapshot };
  } catch {
    throw new FinanceNoticeError('INVALID_INPUT');
  }
}

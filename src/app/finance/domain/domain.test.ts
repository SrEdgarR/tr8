import { describe, expect, it } from 'vitest';
import vector from '../compatibility/fixtures/vault-vectors.json';
import {
  CURRENCY_CATALOG,
  CURRENCY_CATALOG_VERSION,
  addAccount,
  addEntry,
  addPairedOperation,
  addRefund,
  addPlan,
  resolvePlan,
  projectSnapshot,
  filterHistory,
  remainingRefundMinor,
  summarizeRefundPeriod,
  calculateFinancialBalances,
  aggregateFinancialActivityByCurrency,
  emptyFinancialSnapshot,
  validateFinancialSpace,
  validateFinancialSnapshot,
  validateFinancialPlaintext,
  upgradeSnapshot,
  parseFinancialPlaintext,
  serializeFinancialPlaintext,
  parseAmountMinor,
  formatMoneyMinor,
  isLocalDate,
  type FinancialSnapshot,
  type WorkspaceOperation,
} from './index';

function accounts(): FinancialSnapshot {
  let snapshot = emptyFinancialSnapshot();
  for (const account of [
    { id: 'bank', name: 'Synthetic bank', type: 'debit', currency: 'DOP', openingBalanceMinor: 100000, openingDate: '2026-10-01' },
    { id: 'cash', name: 'Synthetic cash', type: 'cash', currency: 'DOP', openingBalanceMinor: 20000, openingDate: '2026-10-01' },
    { id: 'card', name: 'Synthetic card', type: 'credit', currency: 'DOP', openingBalanceMinor: 30000, openingDate: '2026-10-01', creditLimitMinor: 100000 },
  ])
    snapshot = addAccount(snapshot, account);
  return snapshot;
}
function entry(
  snapshot: FinancialSnapshot,
  id: string,
  kind: 'income' | 'expense',
  accountId: string,
  amountMinor: number,
  date = '2026-10-02',
): FinancialSnapshot {
  return addEntry(snapshot, {
    id,
    kind,
    accountId,
    amountMinor,
    date,
    description: 'Synthetic ' + id,
    category: kind === 'income' ? 'salary' : 'food',
    note: '',
  });
}
function paired(
  snapshot: FinancialSnapshot,
  id: string,
  kind: 'transfer' | 'card-payment',
  fromAccountId: string,
  toAccountId: string,
  amountMinor: number,
  date = '2026-10-04',
): FinancialSnapshot {
  return addPairedOperation(snapshot, { id, kind, fromAccountId, toAccountId, amountMinor, date, description: 'Synthetic ' + id, note: '' });
}
function populated(): FinancialSnapshot {
  let snapshot = entry(accounts(), 'income', 'income', 'bank', 40000);
  snapshot = entry(snapshot, 'purchase', 'expense', 'card', 10000, '2026-10-03');
  snapshot = paired(snapshot, 'transfer', 'transfer', 'bank', 'cash', 15000);
  snapshot = paired(snapshot, 'payment', 'card-payment', 'cash', 'card', 5000, '2026-10-05');
  return addRefund(snapshot, {
    id: 'refund',
    originalExpenseId: 'purchase',
    destinationAccountId: 'bank',
    amountMinor: 2000,
    date: '2026-10-07',
    description: 'Synthetic refund',
    note: '',
  });
}
function balances(snapshot: FinancialSnapshot, asOf = '2026-10-25') {
  return calculateFinancialBalances(snapshot.financialSpace.accounts, snapshot.financialSpace.operations, asOf, snapshot.financialSpace.currencyDefinitions);
}
function planOperation(id = 'planned', date = '2026-10-29', amountMinor = 10000): Extract<WorkspaceOperation, { kind: 'expense' }> {
  return { id, kind: 'expense', accountId: 'bank', currency: 'DOP', amountMinor, date, description: 'Synthetic plan', category: 'food', note: '' };
}

describe('financial domain: exact integer money and local dates', () => {
  it('uses versioned explicit currency definitions without a global conversion', () => {
    const snapshot = emptyFinancialSnapshot();
    expect(snapshot.financialSpace).toEqual({
      domainSchemaVersion: 4,
      currencyCatalogVersion: CURRENCY_CATALOG_VERSION,
      currencyDefinitions: CURRENCY_CATALOG,
      accounts: [],
      operations: [],
      plans: [],
    });
    expect(CURRENCY_CATALOG.map(x => x.code)).toEqual(['DOP', 'USD', 'EUR', 'BOB']);
    expect(validateFinancialSnapshot(snapshot)).toEqual(snapshot);
  });
  it.each([
    ['0.01', 1],
    ['1,23', 123],
    ['0001.20', 120],
    ['90071992547409.91', Number.MAX_SAFE_INTEGER],
  ])('parses %s without binary floating-point arithmetic', (input, expected) => {
    expect(parseAmountMinor(input, 2)).toBe(expected);
  });
  it.each(['1e3', '1,000.00', '1.000,00', '+1.00', '1.001', 'NaN', 'Infinity', '0', '-0', '-0.00', '90071992547409.92'])(
    'rejects ambiguous or out-of-range amount %s',
    input => {
      expect(() => parseAmountMinor(input, 2)).toThrow();
    },
  );
  it('handles integer precisions, signed openings and zero explicitly', () => {
    expect(parseAmountMinor('3', 0)).toBe(3);
    expect(parseAmountMinor('0.123456', 6)).toBe(123456);
    expect(parseAmountMinor('-1,23', 2, { allowNegative: true })).toBe(-123);
    expect(parseAmountMinor('0.00', 2, { allowZero: true })).toBe(0);
    expect(() => parseAmountMinor('-0.00', 2, { allowNegative: true, allowZero: true })).toThrow();
    expect(() => parseAmountMinor('1', 7)).toThrow();
    expect(formatMoneyMinor(Number.MAX_SAFE_INTEGER, { code: 'DOP', minorUnitDigits: 2 })).toContain('91');
    expect(() => formatMoneyMinor(-0, { code: 'DOP', minorUnitDigits: 2 })).toThrow();
  });
  it('uses strict Gregorian date components without converting local dates to instants', () => {
    expect(isLocalDate('2026-10-25')).toBe(true);
    expect(isLocalDate('2024-02-29')).toBe(true);
    for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '2026-01-01T00:00:00Z'])
      expect(isLocalDate(value)).toBe(false);
  });
});

describe('financial domain: balances, references and connected operations', () => {
  it('keeps credit debt, liquid money and capacity distinct, with paired operations counted once', () => {
    const snapshot = populated();
    expect(balances(snapshot).accounts).toEqual([
      { accountId: 'bank', type: 'debit', currency: 'DOP', balanceMinor: 127000 },
      { accountId: 'cash', type: 'cash', currency: 'DOP', balanceMinor: 30000 },
      { accountId: 'card', type: 'credit', currency: 'DOP', balanceMinor: 35000, availableCreditMinor: 65000 },
    ]);
    expect(balances(snapshot).currencies).toEqual([
      { currency: 'DOP', liquidMinor: 157000, creditDebtMinor: 35000, availableCreditMinor: 65000, netWorthMinor: 122000, availableCapacityMinor: 222000 },
    ]);
    expect(
      aggregateFinancialActivityByCurrency(snapshot.financialSpace.accounts, snapshot.financialSpace.operations, snapshot.financialSpace.currencyDefinitions),
    ).toEqual([{ currency: 'DOP', incomeMinor: 40000, expenseMinor: 10000 }]);
    expect(balances(snapshot, '2026-10-03').accounts.find(x => x.accountId === 'card')?.balanceMinor).toBe(40000);
  });
  it('preserves valid overdrafts and credit in favor instead of imposing unstated spending rules', () => {
    let snapshot = emptyFinancialSnapshot();
    snapshot = addAccount(snapshot, {
      id: 'negative-bank',
      name: 'Overdrawn',
      type: 'debit',
      currency: 'BOB',
      openingBalanceMinor: -5000,
      openingDate: '2026-10-01',
    });
    snapshot = addAccount(snapshot, {
      id: 'credit-favor',
      name: 'In favor',
      type: 'credit',
      currency: 'BOB',
      openingBalanceMinor: -1000,
      openingDate: '2026-10-01',
      creditLimitMinor: 10000,
    });
    snapshot = addAccount(snapshot, {
      id: 'over-limit',
      name: 'Over limit',
      type: 'credit',
      currency: 'BOB',
      openingBalanceMinor: 20000,
      openingDate: '2026-10-01',
      creditLimitMinor: 10000,
    });
    expect(balances(snapshot).accounts.map(x => [x.balanceMinor, x.availableCreditMinor])).toEqual([
      [-5000, undefined],
      [-1000, 11000],
      [20000, 0],
    ]);
  });
  it('returns separate summaries for currencies and rejects implicit FX transfers', () => {
    const snapshot = addAccount(accounts(), { id: 'usd', name: 'USD', type: 'debit', currency: 'USD', openingBalanceMinor: 9999, openingDate: '2026-10-01' });
    expect(balances(snapshot).currencies.map(x => [x.currency, x.netWorthMinor])).toEqual([
      ['DOP', 90000],
      ['USD', 9999],
    ]);
    expect(() => paired(snapshot, 'fx', 'transfer', 'bank', 'usd', 100)).toThrow();
  });
  it.each([
    ['same account', 'transfer', 'bank', 'bank'],
    ['credit advance', 'transfer', 'card', 'cash'],
    ['payment to liquid', 'card-payment', 'bank', 'cash'],
    ['transfer to credit', 'transfer', 'bank', 'card'],
    ['missing origin', 'transfer', 'missing', 'cash'],
  ])('rejects invalid paired movement: %s', (_label, kind, from, to) => {
    expect(() => paired(accounts(), 'invalid', kind as 'transfer' | 'card-payment', from, to, 100)).toThrow();
  });
  it('requires canonical references, positive safe amounts, matching categories and valid opening chronology', () => {
    const snapshot = accounts();
    for (const amount of [0, -1, -0, 0.1, Number.MAX_SAFE_INTEGER + 1]) expect(() => entry(snapshot, 'bad', 'expense', 'bank', amount)).toThrow();
    expect(() => entry(snapshot, 'bad', 'expense', ' bank', 1)).toThrow();
    expect(() => entry(snapshot, 'bad', 'expense', 'bank', 1, '2026-09-30')).toThrow();
    expect(() =>
      addEntry(snapshot, {
        id: 'bad',
        kind: 'income',
        accountId: 'bank',
        amountMinor: 1,
        date: '2026-10-02',
        description: 'Synthetic',
        category: 'food',
        note: '',
      }),
    ).toThrow();
    expect(() => balances(snapshot, '2026-09-30')).toThrow();
  });
  it('rejects duplicate accounts and movement IDs but allows distinct collection namespaces', () => {
    const snapshot = entry(accounts(), 'bank', 'income', 'bank', 1);
    expect(snapshot.financialSpace.operations[0].id).toBe('bank');
    expect(() => entry(snapshot, 'bank', 'income', 'bank', 1)).toThrow();
    expect(() => addAccount(snapshot, snapshot.financialSpace.accounts[0])).toThrow();
  });
  it('validates every daily closing balance even when a later day offsets overflow', () => {
    let snapshot = addAccount(emptyFinancialSnapshot(), {
      id: 'bank',
      name: 'Range',
      type: 'debit',
      currency: 'DOP',
      openingBalanceMinor: Number.MAX_SAFE_INTEGER - 1,
      openingDate: '2026-10-01',
    });
    const space = structuredClone(snapshot.financialSpace);
    space.operations = [{ ...planOperation('over', '2026-10-02', 2), kind: 'income', category: 'salary' }, { ...planOperation('offset', '2026-10-03', 2) }];
    expect(() => validateFinancialSpace(space)).toThrow();
    // Calendar dates have no intra-day order; the same day's exact net is valid.
    space.operations[1].date = '2026-10-02';
    snapshot = validateFinancialSnapshot({ ...snapshot, financialSpace: space });
    expect(balances(snapshot).accounts[0].balanceMinor).toBe(Number.MAX_SAFE_INTEGER - 1);
  });
  it('checks aggregate overflow even when each individual account fits', () => {
    const snapshot = addAccount(emptyFinancialSnapshot(), {
      id: 'one',
      name: 'One',
      type: 'cash',
      currency: 'DOP',
      openingBalanceMinor: Number.MAX_SAFE_INTEGER,
      openingDate: '2026-10-01',
    });
    expect(() => addAccount(snapshot, { id: 'two', name: 'Two', type: 'debit', currency: 'DOP', openingBalanceMinor: 1, openingDate: '2026-10-01' })).toThrow();
  });
  it('tracks refund remainder and attributes corrections to the purchase period only after receipt', () => {
    const snapshot = populated();
    expect(remainingRefundMinor(snapshot, 'purchase')).toBe(8000);
    expect(summarizeRefundPeriod(snapshot, '2026-10-01', '2026-10-03', '2026-10-06')).toEqual([
      { currency: 'DOP', incomeMinor: 40000, grossExpenseMinor: 10000, refundedMinor: 0, netExpenseMinor: 10000 },
    ]);
    expect(summarizeRefundPeriod(snapshot, '2026-10-01', '2026-10-03', '2026-10-07')).toEqual([
      { currency: 'DOP', incomeMinor: 40000, grossExpenseMinor: 10000, refundedMinor: 2000, netExpenseMinor: 8000 },
    ]);
    expect(() =>
      addRefund(snapshot, {
        id: 'too-much',
        originalExpenseId: 'purchase',
        destinationAccountId: 'bank',
        amountMinor: 8001,
        date: '2026-10-08',
        description: 'Synthetic',
        note: '',
      }),
    ).toThrow();
    expect(() =>
      addRefund(snapshot, {
        id: 'too-early',
        originalExpenseId: 'purchase',
        destinationAccountId: 'card',
        amountMinor: 1,
        date: '2026-10-02',
        description: 'Synthetic',
        note: '',
      }),
    ).toThrow();
    expect(() =>
      addRefund(snapshot, {
        id: 'not-purchase',
        originalExpenseId: 'income',
        destinationAccountId: 'bank',
        amountMinor: 1,
        date: '2026-10-08',
        description: 'Synthetic',
        note: '',
      }),
    ).toThrow();
    const toCard = addRefund(snapshot, {
      id: 'card-refund',
      originalExpenseId: 'purchase',
      destinationAccountId: 'card',
      amountMinor: 1000,
      date: '2026-10-08',
      description: 'Synthetic',
      note: '',
    });
    expect(balances(toCard).accounts.find(x => x.accountId === 'card')?.balanceMinor).toBe(34000);
  });
});

describe('financial domain: plans remain separate from the real ledger', () => {
  it('projects future plans only; pending today and overdue plans do not alter real or projected money', () => {
    let snapshot = addPlan(populated(), { id: 'future', operation: planOperation() });
    snapshot = addPlan(snapshot, { id: 'today', operation: planOperation('today-op', '2026-10-25', 3000) });
    snapshot = addPlan(snapshot, { id: 'overdue', operation: planOperation('past-op', '2026-10-20', 9000) });
    expect(balances(snapshot).currencies[0].netWorthMinor).toBe(122000);
    const projected = projectSnapshot(snapshot, '2026-10-25', '2026-10-31');
    expect(projected.current.currencies[0].netWorthMinor).toBe(122000);
    expect(projected.projected.currencies[0].netWorthMinor).toBe(112000);
    expect(projected.points.map(x => [x.date, x.phase])).toEqual([
      ['2026-10-25', 'actual'],
      ['2026-10-29', 'projected'],
      ['2026-10-31', 'projected'],
    ]);
    expect(projectSnapshot(snapshot, '2026-10-25', '2026-10-31', 'card').projected.accounts).toHaveLength(1);
  });
  it('confirms a plan and its real operation in one immutable snapshot exactly once', () => {
    const snapshot = addPlan(populated(), { id: 'future', operation: planOperation() });
    const before = structuredClone(snapshot);
    const confirmed = resolvePlan(snapshot, { type: 'confirm', planId: 'future', date: '2026-10-25' });
    expect(snapshot).toEqual(before);
    expect(confirmed.financialSpace.operations).toHaveLength(before.financialSpace.operations.length + 1);
    expect(confirmed.financialSpace.plans?.[0]).toMatchObject({ status: 'confirmed', resolvedDate: '2026-10-25', resultOperationId: 'planned' });
    expect(balances(confirmed).currencies[0].netWorthMinor).toBe(112000);
    expect(resolvePlan(confirmed, { type: 'confirm', planId: 'future', date: '2026-10-26' })).toBe(confirmed);
    expect(() => resolvePlan(confirmed, { type: 'cancel', planId: 'future', date: '2026-10-25' })).toThrow();
  });
  it('postpones, keeps or cancels without creating real operations', () => {
    const snapshot = addPlan(populated(), { id: 'future', operation: planOperation() });
    expect(resolvePlan(snapshot, { type: 'keep', planId: 'future' })).toBe(snapshot);
    const postponed = resolvePlan(snapshot, { type: 'postpone', planId: 'future', date: '2026-11-02' });
    expect(projectSnapshot(postponed, '2026-10-25', '2026-10-31').projected.currencies[0].netWorthMinor).toBe(122000);
    const cancelled = resolvePlan(postponed, { type: 'cancel', planId: 'future', date: '2026-10-25' });
    expect(cancelled.financialSpace.operations).toEqual(snapshot.financialSpace.operations);
    expect(projectSnapshot(cancelled, '2026-10-25', '2026-11-05').projected.currencies[0].netWorthMinor).toBe(122000);
    expect(resolvePlan(cancelled, { type: 'cancel', planId: 'future', date: '2026-10-26' })).toBe(cancelled);
    expect(() => resolvePlan(cancelled, { type: 'confirm', planId: 'future', date: '2026-10-25' })).toThrow();
    const hiddenAction = { planId: 'future' };
    Object.defineProperty(hiddenAction, 'type', { value: 'keep', enumerable: false });
    expect(() => resolvePlan(snapshot, hiddenAction)).toThrow();
  });
  it('rejects reserved ID collisions, planned refunds and false confirmation receipts', () => {
    let snapshot = addPlan(populated(), { id: 'future', operation: planOperation() });
    expect(() => addPlan(snapshot, { id: 'another', operation: planOperation() })).toThrow();
    expect(() => addPlan(snapshot, { id: 'purchase', operation: planOperation('purchase') })).toThrow();
    expect(() =>
      addPlan(snapshot, {
        id: 'planned-refund',
        operation: {
          id: 'planned-refund-op',
          kind: 'refund',
          currency: 'DOP',
          amountMinor: 1,
          date: '2026-10-29',
          originalExpenseId: 'purchase',
          destinationAccountId: 'bank',
          description: 'Synthetic',
          note: '',
        },
      }),
    ).toThrow();
    snapshot = resolvePlan(snapshot, { type: 'confirm', planId: 'future', date: '2026-10-25' });
    const bad = structuredClone(snapshot);
    bad.financialSpace.operations.at(-1)!.description = 'Tampered';
    expect(() => validateFinancialSnapshot(bad)).toThrow();
  });
  it('fails overflowing projection without changing a valid pending plan or real balance', () => {
    const base = addAccount(emptyFinancialSnapshot(), {
      id: 'bank',
      name: 'Range',
      type: 'debit',
      currency: 'DOP',
      openingBalanceMinor: Number.MAX_SAFE_INTEGER - 1,
      openingDate: '2026-10-01',
    });
    const snapshot = addPlan(base, { id: 'overflow', operation: { ...planOperation('overflow-op', '2026-10-29', 2), kind: 'income', category: 'salary' } });
    expect(() => projectSnapshot(snapshot, '2026-10-25', '2026-10-31')).toThrow();
    expect(balances(snapshot).accounts[0].balanceMinor).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(snapshot.financialSpace.plans?.[0].status).toBe('pending');
  });
});

describe('financial domain: closed snapshots, history and explicit compatibility', () => {
  it('opens the public legacy v1 fixture unchanged and upgrades only explicitly', () => {
    expect(validateFinancialPlaintext(vector.plaintext)).toEqual(vector.plaintext);
    expect(() => validateFinancialSnapshot(vector.plaintext)).toThrow();
    const upgraded = upgradeSnapshot(vector.plaintext);
    expect(upgraded.financialSpace.domainSchemaVersion).toBe(4);
    expect(upgraded.financialSpace.currencyCatalogVersion).toBe(CURRENCY_CATALOG_VERSION);
    expect(upgraded.financialSpace.plans).toEqual([]);
    expect(upgraded.financialSpace.accounts).toEqual(vector.plaintext.financialSpace.accounts);
    expect(upgraded.financialSpace.operations.map(({ id, currency, amountMinor }) => ({ id, currency, amountMinor }))).toEqual(
      vector.plaintext.financialSpace.operations.map(({ id, currency, amountMinor }) => ({ id, currency, amountMinor })),
    );
    expect(upgraded.financialSpace.operations[0]).toMatchObject({ description: 'Movimiento anterior', note: '', category: 'other' });
    expect(parseFinancialPlaintext(serializeFinancialPlaintext(upgraded))).toEqual(upgraded);
  });
  it('keeps historical catalogs readable and rejects order, precision and version changes', () => {
    const legacy = emptyFinancialSnapshot();
    legacy.financialSpace = {
      domainSchemaVersion: 2,
      currencyCatalogVersion: 'pulso-currencies-v1',
      currencyDefinitions: [{ code: 'DOP', minorUnitDigits: 2 }],
      accounts: [],
      operations: [],
    };
    expect(validateFinancialSnapshot(legacy)).toEqual(legacy);
    expect(upgradeSnapshot(legacy).financialSpace.currencyDefinitions).toEqual(CURRENCY_CATALOG);
    for (const change of [
      { currencyCatalogVersion: 'unknown' },
      { currencyDefinitions: [...CURRENCY_CATALOG].reverse() },
      { currencyDefinitions: CURRENCY_CATALOG.map((x, i) => ({ ...x, minorUnitDigits: i === 0 ? 3 : x.minorUnitDigits })) },
      { domainSchemaVersion: 5 },
    ])
      expect(() =>
        validateFinancialSnapshot({ ...emptyFinancialSnapshot(), financialSpace: { ...emptyFinancialSnapshot().financialSpace, ...change } }),
      ).toThrow();
  });
  it('requires plans only in v4 and refunds only from v3', () => {
    const v4 = emptyFinancialSnapshot();
    const withoutPlans = { ...v4.financialSpace };
    delete withoutPlans.plans;
    expect(() => validateFinancialSpace(withoutPlans)).toThrow();
    expect(() => validateFinancialSpace({ ...v4.financialSpace, domainSchemaVersion: 3 })).toThrow();
    expect(validateFinancialSpace({ ...withoutPlans, domainSchemaVersion: 3 }).domainSchemaVersion).toBe(3);
    const withRefund = { ...populated().financialSpace };
    delete withRefund.plans;
    expect(() => validateFinancialSpace({ ...withRefund, domainSchemaVersion: 2 })).toThrow();
  });
  it('rejects unknown fields, accessors, prototypes, sparse arrays, invalid Unicode, negative zero and oversized snapshots', () => {
    const snapshot = accounts();
    for (const candidate of [
      { ...snapshot, unknown: true },
      { ...snapshot, schemaVersion: 2 },
      { ...snapshot, financialSpace: { ...snapshot.financialSpace, unknown: true } },
      { ...snapshot, financialSpace: { ...snapshot.financialSpace, accounts: new Array(1) } },
      { ...snapshot, financialSpace: { ...snapshot.financialSpace, accounts: [{ ...snapshot.financialSpace.accounts[0], openingBalanceMinor: -0 }] } },
      { ...snapshot, financialSpace: { ...snapshot.financialSpace, accounts: [{ ...snapshot.financialSpace.accounts[0], name: '\uD800' }] } },
      { ...snapshot, financialSpace: Object.assign(Object.create({ hidden: true }), snapshot.financialSpace) },
    ])
      expect(() => validateFinancialPlaintext(candidate)).toThrow();
    let getterCalls = 0;
    const getter = { ...snapshot.financialSpace };
    Object.defineProperty(getter, 'operations', {
      enumerable: true,
      get() {
        getterCalls++;
        return [];
      },
    });
    expect(() => validateFinancialSpace(getter)).toThrow();
    expect(getterCalls).toBe(0);
    const oversized = { ...snapshot, financialSpace: { ...snapshot.financialSpace, extra: 'X'.repeat(1_048_576) } };
    expect(() => validateFinancialPlaintext(oversized)).toThrow();
    expect(() =>
      addAccount({ ...snapshot, extra: true } as FinancialSnapshot, {
        id: 'new',
        name: 'New',
        type: 'cash',
        currency: 'DOP',
        openingBalanceMinor: 0,
        openingDate: '2026-10-01',
      }),
    ).toThrow();
  });
  it('accepts a full 1 MiB valid financial snapshot and rejects one additional byte', () => {
    const snapshot = accounts();
    snapshot.financialSpace.operations = Array.from({ length: 1000 }, (_, index) => ({
      id: 'bounded-' + index,
      kind: 'income',
      accountId: 'bank',
      currency: 'DOP',
      amountMinor: 1,
      date: '2026-10-02',
      description: 'Synthetic bounded movement',
      category: 'salary',
      note: '',
    }));
    let remaining = 1_048_576 - new TextEncoder().encode(JSON.stringify(snapshot)).length;
    for (const operation of snapshot.financialSpace.operations) {
      const fill = Math.min(remaining, 1024);
      operation.note = 'X'.repeat(fill);
      remaining -= fill;
      if (remaining === 0) break;
    }
    expect(remaining).toBe(0);
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBe(1_048_576);
    expect(validateFinancialSnapshot(snapshot).financialSpace.operations).toHaveLength(1000);
    snapshot.financialSpace.operations.at(-1)!.description += 'X';
    expect(() => validateFinancialSnapshot(snapshot)).toThrow();
  });
  it('bounds account collections and rejects malformed legacy versions without repairing them', () => {
    const snapshot = emptyFinancialSnapshot();
    snapshot.financialSpace.accounts = Array.from({ length: 1001 }, (_, index) => ({
      id: 'a' + index,
      name: 'Synthetic',
      type: 'debit',
      currency: 'DOP',
      openingBalanceMinor: 0,
      openingDate: '2026-10-01',
    }));
    expect(() => validateFinancialSnapshot(snapshot)).toThrow();
    const old = structuredClone(vector.plaintext);
    old.financialSpace.operations[0].date = '2026-09-01';
    expect(validateFinancialPlaintext(old)).toEqual(old);
    expect(() => upgradeSnapshot(old)).toThrow();
    expect(old.financialSpace.operations).toHaveLength(vector.plaintext.financialSpace.operations.length);
    const unknown = structuredClone(vector.plaintext) as unknown as Record<string, unknown>;
    unknown.extra = true;
    expect(() => upgradeSnapshot(unknown)).toThrow();
  });
  it('filters a validated history without mutating or mixing the ledger', () => {
    const snapshot = populated(),
      before = structuredClone(snapshot);
    expect(filterHistory(snapshot, { accountId: 'cash' }).map(x => x.id)).toEqual(['payment', 'transfer']);
    expect(filterHistory(snapshot, { from: '2026-10-03', to: '2026-10-05' }).map(x => x.id)).toEqual(['payment', 'transfer', 'purchase']);
    expect(() => filterHistory(snapshot, { from: '2026-10-05', to: '2026-10-01' })).toThrow();
    expect(() => filterHistory(snapshot, { currency: 'XXX' })).toThrow();
    expect(snapshot).toEqual(before);
  });
});

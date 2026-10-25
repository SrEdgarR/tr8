// Pure in-memory contracts. These types are not a repository or a remote schema.
export interface CurrencyDefinition {
  code: string;
  minorUnitDigits: number;
}

interface AccountBase {
  id: string;
  name: string;
  currency: string;
  openingBalanceMinor: number;
  openingDate: string;
}

export type FinancialAccount = (AccountBase & { type: 'debit' | 'cash' }) | (AccountBase & { type: 'credit'; creditLimitMinor: number });

interface OperationBase {
  id: string;
  currency: string;
  amountMinor: number;
  date: string;
}

export type FinancialOperation = OperationBase &
  (
    | { kind: 'income'; accountId: string }
    | { kind: 'expense'; accountId: string }
    | {
        kind: 'refund';
        originalExpenseId: string;
        destinationAccountId: string;
      }
    | {
        kind: 'transfer';
        fromAccountId: string;
        toAccountId: string;
      }
    | {
        kind: 'card-payment';
        fromAccountId: string;
        toAccountId: string;
      }
  );

export interface FinancialAccountBalance {
  accountId: string;
  type: FinancialAccount['type'];
  currency: string;
  // Liquid balance or card debt; negative card debt represents credit in favor.
  balanceMinor: number;
  availableCreditMinor?: number;
}

export interface CurrencySummary {
  currency: string;
  liquidMinor: number;
  creditDebtMinor: number;
  availableCreditMinor: number;
  netWorthMinor: number;
  availableCapacityMinor: number;
}

export interface CurrencyActivity {
  currency: string;
  incomeMinor: number;
  expenseMinor: number;
}

export interface FinancialBalances {
  date: string;
  accounts: FinancialAccountBalance[];
  currencies: CurrencySummary[];
}

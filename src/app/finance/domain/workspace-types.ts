import type { TransactionCategory } from './categories';
import type { CurrencyDefinition, FinancialAccount, FinancialOperation } from './types';

export type WorkspaceOperation = FinancialOperation & {
  description: string;
  note: string;
  category?: TransactionCategory;
};

export type FinancialPlan = { id: string; operation: WorkspaceOperation } & (
  { status: 'pending' } | { status: 'cancelled'; resolvedDate: string } | { status: 'confirmed'; resolvedDate: string; resultOperationId: string }
);

export interface FinancialSpace {
  domainSchemaVersion: 2 | 3 | 4;
  currencyCatalogVersion: string;
  currencyDefinitions: CurrencyDefinition[];
  accounts: FinancialAccount[];
  operations: WorkspaceOperation[];
  plans?: FinancialPlan[];
}

export interface FinancialSnapshot {
  schemaVersion: 1;
  financialSpace: FinancialSpace;
}

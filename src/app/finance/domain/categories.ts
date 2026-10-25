export const EXPENSE_CATEGORIES = ['food', 'transport', 'home', 'health', 'leisure', 'shopping', 'services', 'other'] as const;
export const INCOME_CATEGORIES = ['salary', 'freelance', 'business', 'investment', 'gift', 'refund', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];
export type TransactionCategory = ExpenseCategory | IncomeCategory;

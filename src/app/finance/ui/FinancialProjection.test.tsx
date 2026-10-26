import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FinancialDashboard } from './FinancePage';
import FinancialProjection from './FinancialProjection';
import { addAccount, emptyFinancialSnapshot, prepareEntryOperation } from '../domain/workspace';
import { addPlan, resolvePlan } from '../domain/plans';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());
function fixture() {
  let snapshot = addAccount(emptyFinancialSnapshot(), {
    id: 'bank-dop',
    name: 'Ahorro QA',
    type: 'debit',
    currency: 'DOP',
    openingDate: '2026-01-01',
    openingBalanceMinor: 100000,
  });
  snapshot = addAccount(snapshot, {
    id: 'bank-usd',
    name: 'USD QA',
    type: 'debit',
    currency: 'USD',
    openingDate: '2026-01-01',
    openingBalanceMinor: 20000,
  });
  return addPlan(snapshot, {
    id: 'plan-qa',
    operation: prepareEntryOperation(snapshot, {
      id: 'expense-qa',
      kind: 'expense',
      accountId: 'bank-dop',
      amountMinor: 10000,
      date: '2026-10-28',
      description: 'Gasto previsto QA',
      category: 'other',
      note: '',
    }),
  });
}
function calculate() {
  fireEvent.click(screen.getByText('Proyección', { exact: true }));
  fireEvent.change(screen.getByLabelText('Proyectar hasta'), { target: { value: '2026-10-31' } });
  fireEvent.click(screen.getByRole('button', { name: 'Calcular proyección' }));
}

it('offers projection only inside Plans and calculates it without saving financial data', () => {
  const snapshot = fixture(),
    original = structuredClone(snapshot),
    save = vi.fn();
  render(<FinancialDashboard finance={{ busy: false, save }} snapshot={snapshot} security={null} />);
  expect(screen.queryByText('Proyección', { exact: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Planes' }));
  expect(screen.getByText('Proyección', { exact: true }).closest('details')).not.toHaveAttribute('open');
  calculate();
  expect(screen.getByText('DOP · Patrimonio proyectado').nextElementSibling).toHaveTextContent('DOP 900,00');
  expect(screen.getByText('USD · Patrimonio proyectado').nextElementSibling).toHaveTextContent('USD 200,00');
  expect(save).not.toHaveBeenCalled();
  expect(snapshot).toEqual(original);
  fireEvent.click(screen.getByRole('button', { name: 'Resumen' }));
  expect(screen.queryByText('Proyección', { exact: true })).not.toBeInTheDocument();
});

it('uses the current snapshot when a plan is cancelled or postponed after calculating', () => {
  const snapshot = fixture();
  const view = render(<FinancialProjection snapshot={snapshot} />);
  calculate();
  const projected = () => screen.getByText('DOP · Patrimonio proyectado').nextElementSibling;
  expect(projected()).toHaveTextContent('DOP 900,00');
  view.rerender(<FinancialProjection snapshot={resolvePlan(snapshot, { type: 'cancel', planId: 'plan-qa', date: '2026-10-26' })} />);
  expect(projected()).toHaveTextContent('DOP 1.000,00');
  view.rerender(<FinancialProjection snapshot={resolvePlan(snapshot, { type: 'postpone', planId: 'plan-qa', date: '2026-11-01' })} />);
  expect(projected()).toHaveTextContent('DOP 1.000,00');
  view.rerender(<FinancialProjection snapshot={resolvePlan(snapshot, { type: 'confirm', planId: 'plan-qa', date: '2026-10-26' })} />);
  expect(projected()).toHaveTextContent('DOP 900,00');
});

it('retains the one-year limit and clears the previous result when the horizon changes', () => {
  render(<FinancialProjection snapshot={fixture()} />);
  calculate();
  fireEvent.change(screen.getByLabelText('Proyectar hasta'), { target: { value: '2028-01-01' } });
  expect(screen.queryByText('DOP · Patrimonio proyectado')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Calcular proyección' }));
  expect(screen.getByRole('alert')).toHaveTextContent('hasta un año');
});

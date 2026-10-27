import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FinancialDashboard } from './FinancePage';
import PersonalFinancePage from './PersonalFinancePage';
import MovementEditor from './MovementEditor';
import MovementDeleteDialog from './MovementDeleteDialog';
import type { AccountFinanceApi, AccountFinanceRecord, AccountFinanceWrite } from './account-api';
import type { FinanceApi } from './api';
import { addAccount, addEntry, emptyFinancialSnapshot, prepareEntryOperation } from '../domain/workspace';
import { addPairedOperation, addRefund } from '../domain/connected-operations';
import { addPlan, resolvePlan } from '../domain/plans';
import { saveCreditCard } from '../domain/credit-card-workspace';
import { updateFinancialOperation } from '../domain/operation-edit';
import type { FinancialSnapshot } from '../domain/workspace-types';

function snapshot() {
  let s = emptyFinancialSnapshot();
  for (const id of ['cash', 'bank'])
    s = addAccount(s, {
      id,
      name: id === 'cash' ? 'Efectivo QA' : 'Banco QA',
      type: 'cash',
      currency: 'DOP',
      openingBalanceMinor: 10000,
      openingDate: '2026-01-01',
    });
  s = addEntry(s, {
    id: 'income',
    kind: 'income',
    accountId: 'cash',
    amountMinor: 800,
    date: '2026-02-01',
    description: 'Ingreso QA',
    category: 'salary',
    note: '',
  });
  s = addEntry(s, {
    id: 'expense',
    kind: 'expense',
    accountId: 'cash',
    amountMinor: 300,
    date: '2026-02-02',
    description: 'Gasto QA',
    category: 'food',
    note: '',
  });
  return addPairedOperation(s, {
    id: 'transfer',
    kind: 'transfer',
    fromAccountId: 'cash',
    toAccountId: 'bank',
    amountMinor: 400,
    date: '2026-02-03',
    description: 'Transferencia QA',
    note: '',
  });
}
function mount(initial = snapshot(), options: { readOnly?: boolean; busy?: boolean } = {}) {
  const save = vi.fn();
  function Fixture() {
    const [value, setValue] = useState(initial);
    return (
      <FinancialDashboard
        snapshot={value}
        readOnly={options.readOnly}
        finance={{
          busy: options.busy ?? false,
          save: async next => {
            save(next);
            setValue(next);
          },
        }}
        security={null}
      />
    );
  }
  const view = render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'Movimientos' }));
  return { save, view };
}
const vault: FinanceApi = {
  ownerId: 'owner',
  enabled: false,
  syntheticOnly: false,
  head: vi.fn(),
  identity: vi.fn(),
  save: vi.fn(),
  reauthenticate: vi.fn(),
  subscribe: () => () => {},
};

describe('acciones de movimientos', () => {
  it('permite corregir un ingreso con DOP y vuelve al historial sin duplicar el movimiento', async () => {
    const original = snapshot(),
      h = mount(original);
    fireEvent.click(screen.getByRole('button', { name: 'Editar movimiento Ingreso QA' }));
    expect(screen.getByLabelText('Importe · DOP')).toHaveValue('8.00');
    fireEvent.change(screen.getByLabelText('Descripción'), { target: { value: 'Ingreso corregido' } });
    fireEvent.change(screen.getByLabelText('Importe · DOP'), { target: { value: '10,50' } });
    fireEvent.change(screen.getByLabelText('Cuenta de destino'), { target: { value: 'bank' } });
    fireEvent.change(screen.getByLabelText('Categoría'), { target: { value: 'freelance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.save).toHaveBeenCalledTimes(1);
    const next = h.save.mock.calls[0][0] as FinancialSnapshot;
    expect(next.financialSpace.operations).toHaveLength(3);
    expect(next.financialSpace.operations[0]).toMatchObject({
      id: 'income',
      description: 'Ingreso corregido',
      amountMinor: 1050,
      currency: 'DOP',
      accountId: 'bank',
      category: 'freelance',
    });
    expect(next.financialSpace.operations.slice(1)).toEqual(original.financialSpace.operations.slice(1));
    expect(screen.getByText('Ingreso corregido')).toBeInTheDocument();
  });
  it('edita transferencias, limpia destinos incompatibles y retira ambas patas solo tras confirmación escrita', async () => {
    const original = snapshot(),
      h = mount(original);
    fireEvent.click(screen.getByRole('button', { name: 'Editar movimiento Transferencia QA' }));
    expect(screen.getByLabelText('Cuenta de destino')).toHaveValue('bank');
    fireEvent.change(screen.getByLabelText('Cuenta de origen'), { target: { value: 'bank' } });
    expect(screen.getByLabelText('Cuenta de destino')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Cuenta de destino'), { target: { value: 'cash' } });
    fireEvent.change(screen.getByLabelText('Importe · DOP'), { target: { value: '9.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.save.mock.calls[0][0].financialSpace.operations[2]).toMatchObject({
      id: 'transfer',
      amountMinor: 900,
      fromAccountId: 'bank',
      toAccountId: 'cash',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar movimiento Transferencia QA' }));
    expect(screen.getByText(/operación completa de las dos cuentas/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Eliminar movimiento definitivamente' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Escribe ELIMINAR para confirmar'), { target: { value: 'ELIMINAR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar movimiento definitivamente' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(h.save).toHaveBeenCalledTimes(2);
    expect(h.save.mock.calls[1][0].financialSpace.operations).toEqual(original.financialSpace.operations.slice(0, 2));
  });
  it('cancelar una eliminación y las vistas de lectura o guardado no alteran el historial', () => {
    const h = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar movimiento Gasto QA' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(h.save).not.toHaveBeenCalled();
    h.view.unmount();
    const readonly = mount(snapshot(), { readOnly: true });
    expect(screen.getByRole('button', { name: 'Editar movimiento Gasto QA' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Eliminar movimiento Gasto QA' })).toBeDisabled();
    readonly.view.unmount();
    mount(snapshot(), { busy: true });
    expect(screen.getByRole('button', { name: 'Editar movimiento Gasto QA' })).toBeDisabled();
  });
  it('protege cortes capturados y reembolsos con instrucciones, manteniendo edición de texto', async () => {
    let original = addAccount(snapshot(), {
      id: 'card',
      name: 'Tarjeta QA',
      type: 'credit',
      currency: 'DOP',
      openingBalanceMinor: 1000,
      openingDate: '2026-01-01',
      creditLimitMinor: 10000,
    });
    original = addEntry(original, {
      id: 'card-expense',
      kind: 'expense',
      accountId: 'card',
      amountMinor: 200,
      date: '2026-02-02',
      description: 'Compra de tarjeta',
      category: 'food',
      note: '',
    });
    original = saveCreditCard(original, {
      id: 'group',
      name: 'Tarjeta QA',
      statementDay: 20,
      paymentDay: 2,
      asOfDate: '2026-02-26',
      balances: [{ accountId: 'card', currency: 'DOP', creditLimitMinor: 10000, statementPendingMinor: 1000 }],
    });
    const h = mount(original);
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar movimiento Compra de tarjeta' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Completar la deuda al corte después');
    expect(screen.queryByLabelText('Escribe ELIMINAR para confirmar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Editar movimiento Compra de tarjeta' }));
    expect(screen.getByLabelText('Importe · DOP')).toBeDisabled();
    expect(screen.getByLabelText('Fecha del movimiento')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Descripción'), { target: { value: 'Compra anotada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(h.save.mock.calls[0][0].financialSpace.accounts).toEqual(original.financialSpace.accounts);
    h.view.unmount();
    const refunded = addRefund(snapshot(), {
      id: 'refund',
      originalExpenseId: 'expense',
      destinationAccountId: 'cash',
      date: '2026-02-03',
      amountMinor: 100,
      description: 'Reembolso QA',
      note: '',
    });
    mount(refunded);
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar movimiento Gasto QA' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Elimina primero esos reembolsos');
    expect(screen.getByRole('button', { name: 'Eliminar movimiento definitivamente' })).toBeDisabled();
  });
  it('avisa y cancela únicamente el plan confirmado asociado al eliminar su movimiento', async () => {
    let original = snapshot();
    original = addPlan(original, {
      id: 'plan',
      operation: prepareEntryOperation(original, {
        id: 'plan-operation',
        kind: 'expense',
        accountId: 'cash',
        amountMinor: 100,
        date: '2026-03-01',
        description: 'Movimiento de plan',
        category: 'other',
        note: '',
      }),
    });
    original = resolvePlan(original, { type: 'confirm', planId: 'plan', date: '2026-03-01' });
    const h = mount(original);
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar movimiento Movimiento de plan' }));
    expect(screen.getByText(/plan confirmado asociado quedará cancelado/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Escribe ELIMINAR para confirmar'), { target: { value: 'ELIMINAR' } });
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar movimiento definitivamente' }));
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(h.save.mock.calls[0][0].financialSpace.plans[0].status).toBe('cancelled');
  });
  it('rechaza el editor y la confirmación si el movimiento cambió mientras estaban abiertos', () => {
    const original = snapshot(),
      operation = original.financialSpace.operations[0],
      changed = updateFinancialOperation(original, operation, { ...operation, description: 'Nueva versión' }),
      save = vi.fn();
    const edit = render(<MovementEditor snapshot={original} operation={operation} busy={false} onSave={save} onClose={vi.fn()} />);
    edit.rerender(<MovementEditor snapshot={changed} operation={operation} busy={false} onSave={save} onClose={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('cambió');
    expect(screen.getByRole('button', { name: 'Guardar cambios' })).toBeDisabled();
    edit.unmount();
    const removal = render(<MovementDeleteDialog snapshot={original} operation={operation} busy={false} onSave={save} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Escribe ELIMINAR para confirmar'), { target: { value: 'ELIMINAR' } });
    removal.rerender(<MovementDeleteDialog snapshot={changed} operation={operation} busy={false} onSave={save} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Eliminar movimiento definitivamente' })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
  });
  it('conserva la edición exacta para reintentar un guardado incierto con la misma versión e identidad', async () => {
    const original = snapshot();
    let current: AccountFinanceRecord = { snapshot: original, version: '7', operationId: '20000000-0000-4000-8000-000000000001' };
    const account: AccountFinanceApi = {
      ownerId: 'owner',
      load: vi.fn(async () => current),
      save: vi.fn(async (write: AccountFinanceWrite) => {
        current = { snapshot: write.snapshot, version: '8', operationId: write.operationId };
        return current;
      }),
    };
    vi.mocked(account.save).mockRejectedValueOnce(new Error('NETWORK_UNCERTAIN'));
    render(<PersonalFinancePage accountApi={account} vaultApi={vault} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Movimientos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Editar movimiento Gasto QA' }));
    fireEvent.change(screen.getByLabelText('Importe · DOP'), { target: { value: '6.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar cambios' }));
    await screen.findByRole('heading', { name: 'Guardado por comprobar' });
    expect(screen.getByRole('button', { name: 'Editar movimiento Gasto QA' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar guardado' }));
    await waitFor(() => expect(account.save).toHaveBeenCalledTimes(2));
    expect(vi.mocked(account.save).mock.calls[0][0]).toEqual(vi.mocked(account.save).mock.calls[1][0]);
    expect(vi.mocked(account.save).mock.calls[0][0]).toMatchObject({
      expectedVersion: '7',
      snapshot: { financialSpace: { operations: expect.arrayContaining([expect.objectContaining({ id: 'expense', amountMinor: 650 })]) } },
    });
    expect(current.snapshot.financialSpace.operations.filter(o => o.id !== 'expense')).toEqual(
      original.financialSpace.operations.filter(o => o.id !== 'expense'),
    );
    expect(vault.head).not.toHaveBeenCalled();
    expect(within(screen.getByRole('button', { name: 'Movimientos' })).getByText('Movimientos')).toBeInTheDocument();
  });
});

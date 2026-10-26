import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AccountDeleteDialog from './AccountDeleteDialog';
import { addAccount, addEntry, emptyFinancialSnapshot } from '../domain/workspace';
import { saveCreditCard } from '../domain/credit-card-workspace';
import type { FinancialSnapshot } from '../domain/workspace-types';

function snapshot() {
  let result = emptyFinancialSnapshot();
  for (const [id, name] of [
    ['account', 'Ahorro QA'],
    ['other', 'Otra cuenta'],
  ])
    result = addAccount(result, { id, name, type: 'debit', currency: 'DOP', openingBalanceMinor: 10000, openingDate: '2026-10-01' });
  return result;
}
function mount(initial = snapshot(), accountId = 'account') {
  const onSave = vi.fn<(snapshot: FinancialSnapshot) => Promise<void> | void>().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const props = { snapshot: initial, accountId, busy: false, onSave, onClose };
  const view = render(<AccountDeleteDialog {...props} />);
  return { props, onSave, onClose, view };
}
function fill(value: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Escribe el nombre exacto de la cuenta' }), { target: { value } });
}

describe('account deletion confirmation', () => {
  it('requires the exact name and does not save or close before confirmation', async () => {
    const h = mount();
    const button = screen.getByRole('button', { name: 'Eliminar cuenta definitivamente' });
    expect(button).toBeDisabled();
    expect(within(screen.getByRole('list', { name: 'Saldos que se eliminarán' })).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.queryByText(/Otra cuenta · DOP/)).not.toBeInTheDocument();
    fill('ahorro qa');
    expect(button).toBeDisabled();
    fill('Ahorro QA ');
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest('form')!);
    expect(h.onSave).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
    fill('Ahorro QA');
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(h.onClose).toHaveBeenCalledOnce());
    expect(h.onSave).toHaveBeenCalledOnce();
    const next = h.onSave.mock.calls[0][0];
    expect(next.financialSpace.accounts).toEqual([h.props.snapshot.financialSpace.accounts[1]]);
    expect(next.financialSpace.operations).toEqual(h.props.snapshot.financialSpace.operations);
  });

  it('previews both currencies of a grouped card and keeps the ordinary accounts', async () => {
    const grouped = saveCreditCard(snapshot(), {
      name: 'Visa QA',
      statementDay: 20,
      paymentDay: 2,
      asOfDate: '2026-10-26',
      balances: [
        { currency: 'DOP', creditLimitMinor: 1000000, totalDebtMinor: 12000 },
        { currency: 'USD', creditLimitMinor: 100000, totalDebtMinor: 2500 },
      ],
    });
    const cardId = grouped.financialSpace.accounts.find(account => account.type === 'credit')!.id;
    const h = mount(grouped, cardId);
    const list = screen.getByRole('list', { name: 'Saldos que se eliminarán' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('Visa QA · DOP')).toBeInTheDocument();
    expect(within(list).getByText('Visa QA · USD')).toBeInTheDocument();
    expect(screen.getByText(/todas sus monedas/)).toBeInTheDocument();
    fill('Visa QA');
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar cuenta definitivamente' }));
    await waitFor(() => expect(h.onClose).toHaveBeenCalledOnce());
    expect(h.onSave.mock.calls[0][0].financialSpace.accounts).toEqual(snapshot().financialSpace.accounts);
  });

  it('blocks deletion with linked movements and preserves the ledger', () => {
    const initial = addEntry(snapshot(), {
      id: 'entry',
      kind: 'expense',
      accountId: 'account',
      amountMinor: 50,
      date: '2026-10-02',
      description: 'QA',
      note: '',
      category: 'other',
    });
    const h = mount(initial);
    expect(screen.getByRole('alert')).toHaveTextContent('1 movimiento vinculado');
    expect(screen.getByRole('alert')).toHaveTextContent('Conservamos su historial');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Eliminar cuenta definitivamente' });
    expect(button).toBeDisabled();
    fireEvent.submit(button.closest('form')!);
    expect(h.onSave).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('sends one write and waits for its confirmation before closing', async () => {
    const h = mount();
    let release!: () => void;
    h.onSave.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    );
    fill('Ahorro QA');
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar cuenta definitivamente' }));
    fireEvent.submit(screen.getByRole('button', { name: 'Eliminando…' }).closest('form')!);
    expect(h.onSave).toHaveBeenCalledOnce();
    expect(h.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cerrar ventana' })).toBeDisabled();
    release();
    await waitFor(() => expect(h.onClose).toHaveBeenCalledOnce());
  });

  it('keeps the confirmation open on a failed save and denies a missing account', async () => {
    const h = mount();
    h.onSave.mockRejectedValueOnce(new Error('No se pudo confirmar la operación.'));
    fill('Ahorro QA');
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar cuenta definitivamente' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo confirmar');
    expect(h.onClose).not.toHaveBeenCalled();
    h.view.rerender(<AccountDeleteDialog {...h.props} accountId="missing" />);
    expect(screen.getByText(/La cuenta ya no está disponible/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Eliminar cuenta definitivamente' })).toBeDisabled();
    expect(h.onSave).toHaveBeenCalledOnce();
  });
});

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import PersonalFinancePage from './PersonalFinancePage';
import type { AccountFinanceApi, AccountFinanceWrite } from './account-api';
import type { FinanceApi } from './api';
import { emptyFinancialSnapshot } from '../domain/workspace';
function setup() {
  const account: AccountFinanceApi = {
    ownerId: 'owner',
    load: vi.fn(async () => ({ snapshot: emptyFinancialSnapshot(), version: '0', operationId: null })),
    save: vi.fn(async (w: AccountFinanceWrite) => ({ snapshot: w.snapshot, version: '1', operationId: w.operationId })),
  };
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
  render(<PersonalFinancePage accountApi={account} vaultApi={vault} />);
  return { account, vault };
}
describe('account finances by default', () => {
  it('opens the dashboard without asking for or contacting the encrypted vault', async () => {
    const h = setup();
    await screen.findByRole('heading', { name: 'Panorama financiero' });
    expect(screen.queryByLabelText('Contraseña privada')).not.toBeInTheDocument();
    expect(h.vault.head).not.toHaveBeenCalled();
    expect(h.account.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Bóveda opcional' }));
    await screen.findByText('En preparación');
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Finanzas' }));
    await screen.findByRole('heading', { name: 'Panorama financiero' });
  });
  it('retries the same financial write after an uncertain response and releases the modal', async () => {
    const h = setup();
    vi.mocked(h.account.save).mockRejectedValueOnce(Error('network'));
    await screen.findByRole('heading', { name: 'Panorama financiero' });
    fireEvent.click(screen.getByRole('button', { name: 'Nueva cuenta' }));
    expect(screen.getByLabelText('Moneda de la cuenta')).toHaveValue('DOP');
    fireEvent.change(screen.getByLabelText('Nombre de la cuenta'), { target: { value: 'Cuenta ficticia' } });
    fireEvent.change(screen.getByLabelText('Saldo inicial'), { target: { value: '100,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await screen.findByRole('heading', { name: 'Guardado por comprobar' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar guardado' }));
    await screen.findByRole('heading', { name: 'Cuenta ficticia' });
    const calls = vi.mocked(h.account.save).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toEqual(calls[0][0]);
    expect(h.vault.save).not.toHaveBeenCalled();
  });
});

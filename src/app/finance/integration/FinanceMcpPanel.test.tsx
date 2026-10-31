import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import FinanceMcpPanel from './FinanceMcpPanel';
import type { FinanceMcpApi, FinanceMcpGrant, FinanceMcpReview } from './api';

const credential = '11111111-1111-4111-8111-111111111111',
  noticeId = '22222222-2222-4222-8222-222222222222';
const accounts = [
  { id: 'dop', name: 'Ahorro ficticio', currency: 'DOP' },
  { id: 'usd', name: 'Tarjeta ficticia', currency: 'USD' },
];
const connections = [{ id: credential, name: 'Asistente ficticio' }];
const grant = (): FinanceMcpGrant => ({
  credential_id: credential,
  enabled: true,
  access: 'read',
  accounts: [{ account_id: 'dop', start_at: '2026-10-30T12:00:00Z' }],
  mailbox_ids: ['a'.repeat(64)],
  income_categories: ['other'],
  expense_categories: ['other'],
});
const review = (): FinanceMcpReview => ({
  notice_id: noticeId,
  status: 'review',
  review_reason: 'possible_duplicate',
  account_id: 'dop',
  kind: 'purchase',
  bank_status: 'posted',
  amount: '20.20',
  currency: 'DOP',
  date: '2026-10-30',
  occurred_at: '2026-10-30T12:00:00Z',
  time_zone: 'America/Santo_Domingo',
  description: 'Compra ficticia',
  category: null,
  created_at: '2026-10-30T12:01:00Z',
});
function api(): FinanceMcpApi {
  return {
    ownerId: 'owner-a',
    listGrants: vi.fn(async () => []),
    listReviews: vi.fn(async () => ({ items: [], next_cursor: null, version: '1' })),
    setGrant: vi.fn(async draft => ({ ...draft, enabled: true })),
    revokeGrant: vi.fn(async () => undefined),
    dismissReview: vi.fn(async () => ({ ...review(), status: 'dismissed' as const })),
  };
}
async function open() {
  await userEvent.click(screen.getByRole('button', { name: 'Permisos financieros y revisión' }));
  await screen.findByText('Ninguna conexión tiene acceso financiero. Los permisos de proyectos y tareas no lo conceden.');
}

describe('financial assistant review preview', () => {
  it('stays disabled by default without contacting any API or offering an activation action', () => {
    const service = api();
    render(<FinanceMcpPanel api={service} accounts={accounts} connections={connections} />);
    expect(screen.getByRole('status')).toHaveTextContent('Vista previa · Importación automática desactivada');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(service.listGrants).not.toHaveBeenCalled();
    expect(service.listReviews).not.toHaveBeenCalled();
    expect(service.setGrant).not.toHaveBeenCalled();
  });
  it('collapses settings by default and only loads financial permission/review metadata when opened', async () => {
    const service = api();
    render(<FinanceMcpPanel enabled api={service} accounts={accounts} connections={connections} />);
    expect(service.listGrants).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Permisos financieros y revisión' })).toHaveAttribute('aria-expanded', 'false');
    await open();
    expect(service.listGrants).toHaveBeenCalledTimes(1);
    expect(service.listReviews).toHaveBeenCalledWith({ limit: 50 });
    expect(service.setGrant).not.toHaveBeenCalled();
  });
  it('saves only explicitly selected account/cutover/mailbox/category scopes after consent', async () => {
    const service = api();
    render(<FinanceMcpPanel enabled api={service} accounts={accounts} connections={connections} />);
    await open();
    await userEvent.click(screen.getByText('Autorizar o reemplazar un permiso'));
    expect(screen.getByRole('button', { name: 'Guardar permiso financiero' })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Acceso financiero'), 'write');
    await userEvent.selectOptions(screen.getByLabelText('Conexión del asistente'), credential);
    await userEvent.click(screen.getByLabelText('Ahorro ficticio · DOP'));
    fireEvent.change(screen.getByLabelText('Inicio autorizado · Ahorro ficticio · DOP'), { target: { value: '2026-11-01T12:30' } });
    await userEvent.type(screen.getByLabelText('Buzones autorizados · Identificadores opacos'), 'a'.repeat(64));
    await userEvent.click(screen.getByLabelText('Autorizo únicamente estas cuentas, buzones y permisos. La importación automática seguirá desactivada.'));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar permiso financiero' }));
    await waitFor(() =>
      expect(service.setGrant).toHaveBeenCalledExactlyOnceWith({
        credential_id: credential,
        access: 'write',
        accounts: [{ account_id: 'dop', start_at: new Date('2026-11-01T12:30').toISOString() }],
        mailbox_ids: ['a'.repeat(64)],
        income_categories: ['other'],
        expense_categories: ['other'],
      }),
    );
    expect(screen.getByText('Permiso financiero guardado. La importación automática continúa desactivada.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Guardar permiso financiero' })).toBeDisabled();
  });
  it('authorizes read-only accounts without asking for mailboxes, categories or import dates', async () => {
    const service = api();
    render(<FinanceMcpPanel enabled api={service} accounts={accounts} connections={connections} />);
    await open();
    await userEvent.click(screen.getByText('Autorizar o reemplazar un permiso'));
    await userEvent.selectOptions(screen.getByLabelText('Conexión del asistente'), credential);
    await userEvent.click(screen.getByLabelText('Ahorro ficticio · DOP'));
    expect(screen.queryByLabelText(/Inicio autorizado/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Buzones autorizados · Identificadores opacos')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Categorías de gastos autorizadas' })).not.toBeInTheDocument();
    const started = Date.now();
    await userEvent.click(screen.getByLabelText('Autorizo únicamente la consulta de estas cuentas. La importación automática seguirá desactivada.'));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar permiso financiero' }));
    await waitFor(() => expect(service.setGrant).toHaveBeenCalledTimes(1));
    const saved = vi.mocked(service.setGrant).mock.calls[0]![0];
    expect(saved).toEqual({
      credential_id: credential,
      access: 'read',
      accounts: [{ account_id: 'dop', start_at: expect.any(String) }],
      mailbox_ids: [],
      income_categories: [],
      expense_categories: [],
    });
    expect(Date.parse(saved.accounts[0]!.start_at)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(saved.accounts[0]!.start_at)).toBeLessThanOrEqual(Date.now());
    expect(screen.queryByLabelText('Tarjeta ficticia · USD')).not.toBeChecked();
  });
  it('still requires an explicit mailbox for write access', async () => {
    const service = api();
    render(<FinanceMcpPanel enabled api={service} accounts={accounts} connections={connections} />);
    await open();
    await userEvent.click(screen.getByText('Autorizar o reemplazar un permiso'));
    await userEvent.selectOptions(screen.getByLabelText('Conexión del asistente'), credential);
    await userEvent.selectOptions(screen.getByLabelText('Acceso financiero'), 'write');
    await userEvent.click(screen.getByLabelText('Ahorro ficticio · DOP'));
    fireEvent.change(screen.getByLabelText('Inicio autorizado · Ahorro ficticio · DOP'), { target: { value: '2026-11-01T12:30' } });
    await userEvent.click(screen.getByLabelText('Autorizo únicamente estas cuentas, buzones y permisos. La importación automática seguirá desactivada.'));
    fireEvent.submit(screen.getByRole('button', { name: 'Guardar permiso financiero' }).closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Añade los identificadores opacos');
    expect(service.setGrant).not.toHaveBeenCalled();
  });
  it('clears consent when the scope changes and never silently grants the other currency account', async () => {
    const service = api();
    render(<FinanceMcpPanel enabled api={service} accounts={accounts} connections={connections} />);
    await open();
    await userEvent.click(screen.getByText('Autorizar o reemplazar un permiso'));
    const consent = screen.getByLabelText('Autorizo únicamente la consulta de estas cuentas. La importación automática seguirá desactivada.');
    await userEvent.click(consent);
    await userEvent.selectOptions(screen.getByLabelText('Acceso financiero'), 'write');
    expect(consent).not.toBeChecked();
    expect(screen.getByLabelText('Tarjeta ficticia · USD')).not.toBeChecked();
    expect(service.setGrant).not.toHaveBeenCalled();
  });
  it('dismisses only the selected review after confirmation without calling any ledger or grant write', async () => {
    const service = api();
    vi.mocked(service.listReviews).mockResolvedValue({ items: [review()], next_cursor: null, version: '1' });
    render(<FinanceMcpPanel enabled api={service} accounts={accounts} connections={connections} />);
    await open();
    await userEvent.click(screen.getByRole('button', { name: 'Descartar aviso' }));
    expect(service.dismissReview).not.toHaveBeenCalled();
    const confirmation = screen.getByRole('group', { name: 'Confirmar descarte del aviso' });
    expect(confirmation).toHaveTextContent('no elimina movimientos ni modifica tus saldos');
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Confirmar descarte' }));
    await waitFor(() => expect(service.dismissReview).toHaveBeenCalledExactlyOnceWith(noticeId));
    expect(screen.getByText('Descartado')).toBeInTheDocument();
    expect(service.setGrant).not.toHaveBeenCalled();
  });
  it('requires a separate confirmation before revoking financial access', async () => {
    const service = api();
    vi.mocked(service.listGrants).mockResolvedValue([grant()]);
    render(<FinanceMcpPanel enabled api={service} accounts={accounts} connections={connections} />);
    await userEvent.click(screen.getByRole('button', { name: 'Permisos financieros y revisión' }));
    await screen.findByText('Asistente ficticio', { selector: 'strong' });
    await userEvent.click(screen.getByRole('button', { name: 'Revocar acceso financiero' }));
    expect(service.revokeGrant).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirmar revocación' }));
    await waitFor(() => expect(service.revokeGrant).toHaveBeenCalledExactlyOnceWith(credential));
    expect(screen.queryByText('Asistente ficticio', { selector: 'strong' })).not.toBeInTheDocument();
  });
  it('ignores replies from a closed disclosure or previous account identity', async () => {
    const service = api();
    let resolve!: (value: FinanceMcpReview[]) => void;
    vi.mocked(service.listReviews).mockImplementation(async () => ({
      items: await new Promise<FinanceMcpReview[]>(done => {
        resolve = done;
      }),
      next_cursor: null,
      version: '1',
    }));
    const view = render(<FinanceMcpPanel enabled api={service} accounts={accounts} connections={connections} />);
    await userEvent.click(screen.getByRole('button', { name: 'Permisos financieros y revisión' }));
    view.rerender(<FinanceMcpPanel enabled api={{ ...api(), ownerId: 'owner-b' }} accounts={accounts} connections={connections} />);
    await act(async () => {
      resolve([review()]);
    });
    expect(screen.queryByText('Compra ficticia')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Permisos financieros y revisión' })).toHaveAttribute('aria-expanded', 'false');
  });
});

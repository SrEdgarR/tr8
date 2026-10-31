import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import OAuthConsentPage from './OAuthConsentPage';
import OAuthConnectionsPanel from './OAuthConnectionsPanel';
import type { OAuthConsentApi, OAuthConsentDetails } from './consent-api';

const attempt = `tr8_oauth_p_${'a'.repeat(64)}`,
  code = `tr8_oauth_c_${'b'.repeat(64)}`,
  credential = '11111111-1111-4111-8111-111111111111';
const fingerprint = 'd'.repeat(64);
const redirect = 'https://client.example/callback';
function details(): OAuthConsentDetails {
  return {
    attempt,
    client_id: 'synthetic-dot',
    client_name: 'Asistente ficticio',
    redirect_uri: redirect,
    scopes: ['finance:read', 'finance:write'],
    resource: 'https://tr8.vercel.app/api/mcp/finance',
    expires_at: new Date(Date.now() + 300000).toISOString(),
    connections: [
      {
        credential_id: credential,
        grant_fingerprint: fingerprint,
        name: 'Permiso de ejemplo',
        access: 'write',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        accounts: [{ account_id: 'dop', name: 'Ahorros ficticios', currency: 'DOP', start_at: '2026-01-02T00:00:00Z' }],
        mailbox_ids: ['c'.repeat(64)],
        expense_categories: ['other'],
        income_categories: ['other'],
      },
    ],
  };
}
function setup(patch: Partial<OAuthConsentApi> = {}) {
  const api: OAuthConsentApi = {
    ownerId: 'owner-a',
    details: vi.fn(async () => details()),
    approve: vi.fn(async () => ({ redirect_uri: redirect, state: 'test-state', code })),
    deny: vi.fn(async () => ({ redirect_uri: redirect, state: 'test-state', error: 'access_denied' as const })),
    list: vi.fn(async () => []),
    revoke: vi.fn(),
    ...patch,
  };
  const onComplete = vi.fn();
  const view = render(<OAuthConsentPage api={api} attempt={attempt} onComplete={onComplete} />);
  return { api, onComplete, view };
}
async function authorizeChoice() {
  await screen.findByText('Asistente ficticio');
  fireEvent.change(screen.getByLabelText('Permiso financiero de TR8'), { target: { value: credential } });
  fireEvent.click(screen.getByRole('checkbox', { name: /Autorizo al asistente/ }));
}
describe('explicit financial OAuth approval', () => {
  it('requires an existing financial grant and explicit consent, and never approves on page load', async () => {
    const h = setup();
    await screen.findByText('Asistente ficticio');
    expect(h.api.approve).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Autorizar asistente' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Permiso financiero de TR8'), { target: { value: credential } });
    expect(await screen.findByText('Ahorros ficticios · DOP')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Autorizar asistente' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /Autorizo al asistente/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar asistente' }));
    await waitFor(() => expect(h.api.approve).toHaveBeenCalledExactlyOnceWith(attempt, credential, fingerprint));
    await waitFor(() => expect(h.onComplete).toHaveBeenCalledTimes(1));
    expect(new URL(h.onComplete.mock.calls[0]![0]).searchParams.get('code')).toBe(code);
  });
  it('cancels without creating a grant or sharing a browser session', async () => {
    const h = setup();
    await screen.findByText('Asistente ficticio');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar conexión' }));
    await waitFor(() => expect(h.onComplete).toHaveBeenCalledTimes(1));
    expect(h.api.approve).not.toHaveBeenCalled();
    expect(new URL(h.onComplete.mock.calls[0]![0]).searchParams.get('error')).toBe('access_denied');
  });
  it('explains read-only access without mailbox, category or import-date requirements', async () => {
    const value = details();
    value.scopes = ['finance:read'];
    Object.assign(value.connections[0]!, { access: 'read', mailbox_ids: [], expense_categories: [], income_categories: [] });
    const h = setup({ details: vi.fn(async () => value) });
    await authorizeChoice();
    expect(screen.getByText(/Solo consulta del historial/)).toHaveTextContent('sin acceso a buzones ni permiso para registrar movimientos');
    expect(screen.queryByText(/Avisos desde/)).not.toBeInTheDocument();
    expect(screen.queryByText(/buzones autorizados/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Las categorías del permiso limitan/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar asistente' }));
    await waitFor(() => expect(h.api.approve).toHaveBeenCalledExactlyOnceWith(attempt, credential, fingerprint));
  });
  it('ignores a late approval after the logged-in account changes', async () => {
    let resolve!: (value: Awaited<ReturnType<OAuthConsentApi['approve']>>) => void;
    const h = setup({
      approve: vi.fn(
        () =>
          new Promise<Awaited<ReturnType<OAuthConsentApi['approve']>>>(value => {
            resolve = value;
          }),
      ),
    });
    await authorizeChoice();
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar asistente' }));
    h.view.rerender(<OAuthConsentPage api={{ ...h.api, ownerId: 'owner-b' }} attempt={attempt} onComplete={h.onComplete} />);
    await act(async () => {
      resolve({ redirect_uri: redirect, state: 's', code });
    });
    expect(h.onComplete).not.toHaveBeenCalled();
  });
  it('does not duplicate an approval when clicked twice while pending', async () => {
    const h = setup({ approve: vi.fn(() => new Promise<Awaited<ReturnType<OAuthConsentApi['approve']>>>(() => {})) });
    await authorizeChoice();
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar asistente' }));
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar asistente' }));
    expect(h.api.approve).toHaveBeenCalledTimes(1);
  });
  it('refuses an altered callback instead of navigating with the code', async () => {
    const h = setup({ approve: vi.fn(async () => ({ redirect_uri: 'https://attacker.example/callback', state: 's', code })) });
    await authorizeChoice();
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar asistente' }));
    await screen.findByRole('alert');
    expect(h.onComplete).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: /Autorizo al asistente/ })).not.toBeChecked();
  });
  it('blocks approval of an expired attempt', async () => {
    setup({ details: vi.fn(async () => ({ ...details(), expires_at: '2000-01-01T00:00:00Z' })) });
    await screen.findByText('La solicitud caducó. Inicia una nueva conexión desde el asistente.');
    expect(screen.getByRole('button', { name: 'Autorizar asistente' })).toBeDisabled();
  });
  it('does not create a financial permission when none are compatible', async () => {
    const h = setup({ details: vi.fn(async () => ({ ...details(), connections: [] })) });
    await screen.findByText(/No hay permisos financieros compatibles/);
    expect(screen.getByRole('button', { name: 'Autorizar asistente' })).toBeDisabled();
    expect(h.api.approve).not.toHaveBeenCalled();
  });
});

it('loads OAuth grants only on expansion and requires confirmation before revocation', async () => {
  const grantId = '22222222-2222-4222-8222-222222222222';
  const api: OAuthConsentApi = {
    ownerId: 'owner-a',
    details: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    list: vi.fn(async () => [
      {
        grant_id: grantId,
        client_name: 'Asistente de prueba',
        client_id: 'synthetic',
        credential_id: credential,
        scopes: ['finance:read' as const],
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        revoked_at: null,
      },
    ]),
    revoke: vi.fn(async () => {}),
  };
  render(<OAuthConnectionsPanel api={api} />);
  expect(api.list).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Asistentes conectados' }));
  await screen.findByText('Asistente de prueba');
  fireEvent.click(screen.getByRole('button', { name: 'Revocar acceso de Asistente de prueba' }));
  expect(api.revoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar revocación' }));
  await waitFor(() => expect(api.revoke).toHaveBeenCalledExactlyOnceWith(grantId));
});

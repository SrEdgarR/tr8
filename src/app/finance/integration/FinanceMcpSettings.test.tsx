import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { McpCredential, McpCredentialsApi } from '../../data/mcp';
import type { FinanceMcpApi } from './api';
import FinanceMcpSettings from './FinanceMcpSettings';

const workspace = '11111111-1111-4111-8111-111111111111',
  otherWorkspace = '22222222-2222-4222-8222-222222222222';
const accounts = [{ id: 'dop', name: 'Ahorro ficticio', currency: 'DOP' }];
const credential = (id: string, name: string, patch: Partial<McpCredential> = {}): McpCredential => ({
  id,
  name,
  workspace_id: workspace,
  access: 'read',
  created_at: '2026-10-01T00:00:00Z',
  expires_at: '2099-01-01T00:00:00Z',
  revoked_at: null,
  last_used_at: null,
  ...patch,
});
function setup() {
  const connectionsApi: McpCredentialsApi = { ownerId: 'owner-a', list: vi.fn(async () => []), create: vi.fn(), revoke: vi.fn() };
  const api: FinanceMcpApi = {
    ownerId: 'owner-a',
    listGrants: vi.fn(async () => []),
    listReviews: vi.fn(async () => ({ items: [], next_cursor: null, version: '1' })),
    setGrant: vi.fn(),
    revokeGrant: vi.fn(),
    dismissReview: vi.fn(),
  };
  return { api, connectionsApi };
}
async function load() {
  await userEvent.click(screen.getByRole('button', { name: 'Cargar conexiones de este espacio' }));
}
async function expand() {
  await userEvent.click(screen.getByRole('button', { name: 'Permisos financieros y revisión' }));
  await screen.findByText('Ninguna conexión tiene acceso financiero. Los permisos de proyectos y tareas no lo conceden.');
  await userEvent.click(screen.getByText('Autorizar o reemplazar un permiso'));
}

describe('financial MCP settings workspace boundary', () => {
  it('makes no API calls or offers credential actions when disabled by default', () => {
    const service = setup();
    render(<FinanceMcpSettings {...service} accounts={accounts} workspaceId={workspace} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(service.connectionsApi.list).not.toHaveBeenCalled();
    expect(service.api.listGrants).not.toHaveBeenCalled();
  });
  it('loads existing active credentials only on request and filters revoked, expired and foreign workspace connections', async () => {
    const service = setup();
    vi.mocked(service.connectionsApi.list).mockResolvedValue([
      credential('a', 'Elegible'),
      credential('b', 'Ajena', { workspace_id: otherWorkspace }),
      credential('c', 'Revocada', { revoked_at: '2026-10-29T00:00:00Z' }),
      credential('d', 'Caducada', { expires_at: '2020-01-01T00:00:00Z' }),
    ]);
    render(<FinanceMcpSettings enabled {...service} accounts={accounts} workspaceId={workspace} />);
    expect(service.connectionsApi.list).not.toHaveBeenCalled();
    await load();
    await expand();
    const select = screen.getByLabelText('Conexión del asistente');
    expect(select).toHaveTextContent('Elegible');
    expect(select).not.toHaveTextContent('Ajena');
    expect(select).not.toHaveTextContent('Revocada');
    expect(select).not.toHaveTextContent('Caducada');
    expect(service.connectionsApi.create).not.toHaveBeenCalled();
    expect(service.connectionsApi.revoke).not.toHaveBeenCalled();
    expect(service.api.setGrant).not.toHaveBeenCalled();
  });
  it('clears previous workspace UI immediately and discards its late metadata response', async () => {
    const service = setup();
    let resolve!: (rows: McpCredential[]) => void;
    vi.mocked(service.connectionsApi.list).mockImplementation(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    );
    const view = render(<FinanceMcpSettings enabled {...service} accounts={accounts} workspaceId={workspace} />);
    await load();
    view.rerender(<FinanceMcpSettings enabled {...service} accounts={accounts} workspaceId={otherWorkspace} />);
    await act(async () => {
      resolve([credential('a', 'Anterior')]);
    });
    expect(screen.queryByRole('button', { name: 'Permisos financieros y revisión' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cargar conexiones de este espacio' })).toBeEnabled();
    expect(screen.queryByText('Anterior')).not.toBeInTheDocument();
  });
  it('removes loaded grants/connections when the identity changes and refuses mismatched API owners', async () => {
    const service = setup();
    vi.mocked(service.connectionsApi.list).mockResolvedValue([credential('a', 'Anterior')]);
    const view = render(<FinanceMcpSettings enabled {...service} accounts={accounts} workspaceId={workspace} />);
    await load();
    await expand();
    expect(screen.getByLabelText('Conexión del asistente')).toHaveTextContent('Anterior');
    view.rerender(
      <FinanceMcpSettings enabled api={{ ...service.api, ownerId: 'owner-b' }} connectionsApi={service.connectionsApi} accounts={[]} workspaceId={workspace} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Tu sesión cambió');
    expect(screen.queryByText('Anterior')).not.toBeInTheDocument();
    expect(service.connectionsApi.list).toHaveBeenCalledTimes(1);
  });
  it('offers a retry after a sanitized load failure without granting anything', async () => {
    const service = setup();
    vi.mocked(service.connectionsApi.list).mockRejectedValueOnce(Error('secret diagnostic')).mockResolvedValueOnce([]);
    render(<FinanceMcpSettings enabled {...service} accounts={accounts} workspaceId={workspace} />);
    await load();
    expect(await screen.findByRole('alert')).not.toHaveTextContent('secret diagnostic');
    await load();
    expect(
      await screen.findByText('No hay conexiones activas en este espacio. Administra tus conexiones MCP antes de conceder permisos financieros.'),
    ).toBeInTheDocument();
    expect(service.api.setGrant).not.toHaveBeenCalled();
    expect(service.connectionsApi.create).not.toHaveBeenCalled();
  });
});

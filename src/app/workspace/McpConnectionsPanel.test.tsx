import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import McpConnectionsPanel from './McpConnectionsPanel';
import type { CreatedMcpCredential, McpCredential, McpCredentialsApi } from '../data/mcp';
const workspace = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const secret = `tr8_mcp_${'a'.repeat(64)}`;
function credential(change: Partial<McpCredential> = {}): McpCredential {
  return {
    id,
    name: 'Mi agente',
    workspace_id: workspace,
    access: 'read',
    created_at: '2026-10-26T00:00:00Z',
    expires_at: '2030-11-25T00:00:00Z',
    revoked_at: null,
    last_used_at: null,
    ...change,
  };
}
function api() {
  return {
    ownerId: 'owner-a',
    list: vi.fn(async () => [] as McpCredential[]),
    create: vi.fn(async () => ({ ...credential(), token: secret })),
    revoke: vi.fn(async () => credential({ revoked_at: '2026-10-27T00:00:00Z' })),
  } satisfies McpCredentialsApi;
}
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Agentes de IA · MCP' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Actualizar conexiones' })).toBeEnabled());
}

it('is collapsed without any request, and opens with read-only permission and a 30-day expiry', async () => {
  const h = api();
  render(<McpConnectionsPanel api={h} workspaceId={workspace} workspaceName="Mi espacio personal" />);
  expect(screen.getByRole('button', { name: 'Agentes de IA · MCP' })).toHaveAttribute('aria-expanded', 'false');
  expect(h.list).not.toHaveBeenCalled();
  expect(h.create).not.toHaveBeenCalled();
  await open();
  expect(h.list).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Permisos')).toHaveValue('read');
  expect(screen.getByLabelText('Caducidad')).toHaveValue('30');
  expect(h.create).not.toHaveBeenCalled();
});
it('creates one scoped key explicitly and removes it from the screen on collapse', async () => {
  const h = api();
  render(<McpConnectionsPanel api={h} workspaceId={workspace} workspaceName="Mi espacio personal" />);
  await open();
  fireEvent.change(screen.getByLabelText('Nombre del agente'), { target: { value: 'Mi agente' } });
  const create = screen.getByRole('button', { name: 'Crear conexión MCP' });
  fireEvent.click(create);
  fireEvent.click(create);
  expect(await screen.findByLabelText('Clave MCP')).toHaveValue(secret);
  expect(h.create).toHaveBeenCalledExactlyOnceWith({ name: 'Mi agente', workspace_id: workspace, access: 'read', expires_in_days: 30 });
  expect(screen.getByLabelText('Clave MCP')).toHaveAttribute('type', 'password');
  fireEvent.click(screen.getByRole('button', { name: 'Agentes de IA · MCP' }));
  expect(screen.queryByLabelText('Clave MCP')).not.toBeInTheDocument();
  await open();
  expect(screen.queryByLabelText('Clave MCP')).not.toBeInTheDocument();
  expect(h.create).toHaveBeenCalledTimes(1);
});
it('shows only this workspace and requires confirmation before revoking a connection', async () => {
  const h = api();
  h.list.mockResolvedValue([
    credential(),
    credential({ id: '33333333-3333-4333-8333-333333333333', name: 'Otro espacio', workspace_id: '44444444-4444-4444-8444-444444444444' }),
  ]);
  render(<McpConnectionsPanel api={h} workspaceId={workspace} workspaceName="Mi espacio personal" />);
  await open();
  expect(screen.queryByText('Otro espacio')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Revocar conexión Mi agente' }));
  expect(h.revoke).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog', { name: 'Revocar conexión MCP' });
  expect(dialog).toHaveTextContent('Mi agente');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
  expect(h.revoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Revocar conexión Mi agente' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revocar conexión' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(h.revoke).toHaveBeenCalledExactlyOnceWith(id);
  expect(screen.getByRole('button', { name: 'Revocar conexión Mi agente' })).toBeDisabled();
});
it('discards a pending key when the authenticated workspace scope is replaced', async () => {
  const h = api();
  let resolve!: (value: CreatedMcpCredential) => void;
  h.create.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const view = render(<McpConnectionsPanel key="owner-a" api={h} workspaceId={workspace} workspaceName="Espacio A" />);
  await open();
  fireEvent.change(screen.getByLabelText('Nombre del agente'), { target: { value: 'Mi agente' } });
  fireEvent.click(screen.getByRole('button', { name: 'Crear conexión MCP' }));
  const next = api();
  view.rerender(<McpConnectionsPanel key="owner-b" api={{ ...next, ownerId: 'owner-b' }} workspaceId={workspace} workspaceName="Espacio B" />);
  await act(async () => resolve({ ...credential(), token: secret }));
  expect(screen.queryByLabelText('Clave MCP')).not.toBeInTheDocument();
  expect(document.body).not.toHaveTextContent(secret);
  expect(next.list).not.toHaveBeenCalled();
});
it('does not expose unexpected error messages and keeps config examples free of the real key', async () => {
  const h = api();
  h.list.mockRejectedValueOnce(Error(secret));
  render(<McpConnectionsPanel api={h} workspaceId={workspace} workspaceName="Mi espacio personal" />);
  fireEvent.click(screen.getByRole('button', { name: 'Agentes de IA · MCP' }));
  expect(await screen.findByRole('alert')).not.toHaveTextContent(secret);
  fireEvent.click(screen.getByText('Cómo conectar tu agente'));
  expect(screen.getByLabelText('Ejemplo de configuración MCP')).toHaveTextContent('<TU_CLAVE_TR8>');
  expect(screen.getByLabelText('Ejemplo de configuración MCP')).not.toHaveTextContent(secret);
});

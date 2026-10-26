import type { SupabaseClient } from '@supabase/supabase-js';
import { expect, it, vi } from 'vitest';
import { createMcpRepository, type McpCredential } from './mcp';
const owner = 'owner-a';
const workspace = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const secret = `tr8_mcp_${'a'.repeat(64)}`;
const metadata = (): McpCredential => ({
  id,
  name: 'Mi agente',
  workspace_id: workspace,
  access: 'read',
  created_at: '2026-10-26T00:00:00Z',
  expires_at: '2026-11-25T00:00:00Z',
  revoked_at: null,
  last_used_at: null,
});
function setup(result: unknown) {
  const rpc = vi.fn(async () => ({ data: result, error: null as { code: string; message: string } | null }));
  const getUser = vi.fn(async () => ({ data: { user: { id: owner } }, error: null }));
  const client = { rpc, auth: { getUser } } as unknown as SupabaseClient;
  return { api: createMcpRepository(client, owner), rpc, getUser };
}

it('does not contact Supabase on construction and lists metadata only under a stable identity', async () => {
  const h = setup([metadata()]);
  expect(h.rpc).not.toHaveBeenCalled();
  expect(await h.api.list()).toEqual([metadata()]);
  expect(h.rpc).toHaveBeenCalledExactlyOnceWith('tr8_mcp_credentials', { p_action: 'list', p_input: {} });
  expect(h.getUser).toHaveBeenCalledTimes(2);
});
it('creates an explicitly scoped key once and retains the server-confirmed permissions', async () => {
  const h = setup({ ...metadata(), token: secret });
  const draft = { name: ' Mi agente ', workspace_id: workspace, access: 'read' as const, expires_in_days: 30 };
  expect(await h.api.create(draft)).toEqual({ ...metadata(), token: secret });
  expect(h.rpc).toHaveBeenCalledExactlyOnceWith('tr8_mcp_credentials', { p_action: 'create', p_input: { ...draft, name: 'Mi agente' } });
});
it('rejects unexpected secrets in list responses and mismatched scope on creation', async () => {
  const list = setup([{ ...metadata(), token: secret }]);
  await expect(list.api.list()).rejects.toThrow('No pudimos comprobar');
  const created = setup({ ...metadata(), access: 'write', token: secret });
  await expect(created.api.create({ name: 'Mi agente', workspace_id: workspace, access: 'read', expires_in_days: 30 })).rejects.toThrow('No pudimos comprobar');
});
it('refuses invalid drafts before any request and requires revocation to be acknowledged for the requested id', async () => {
  const h = setup(metadata());
  await expect(h.api.create({ name: '', workspace_id: workspace, access: 'read', expires_in_days: 30 })).rejects.toThrow('Revisa');
  expect(h.rpc).not.toHaveBeenCalled();
  await expect(h.api.revoke(id)).rejects.toThrow('No pudimos comprobar');
  h.rpc.mockResolvedValue({ data: { ...metadata(), revoked_at: '2026-10-27T00:00:00Z' }, error: null });
  expect((await h.api.revoke(id)).revoked_at).toBe('2026-10-27T00:00:00Z');
});
it('discards a response after the authenticated user changes', async () => {
  const h = setup({ ...metadata(), token: secret });
  h.getUser.mockResolvedValueOnce({ data: { user: { id: owner } }, error: null }).mockResolvedValueOnce({ data: { user: { id: 'owner-b' } }, error: null });
  await expect(h.api.create({ name: 'Mi agente', workspace_id: workspace, access: 'read', expires_in_days: 30 })).rejects.toThrow('Tu sesión cambió');
});
it('never reflects database messages or key material in errors', async () => {
  const h = setup(null);
  h.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: secret } });
  try {
    await h.api.list();
    throw Error('expected failure');
  } catch (cause) {
    expect(String(cause)).toContain('No se pudo confirmar');
    expect(String(cause)).not.toContain(secret);
  }
  h.rpc.mockRejectedValueOnce(Error(secret));
  await expect(h.api.list()).rejects.toThrow('No se pudo confirmar');
});

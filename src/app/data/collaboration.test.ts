import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { createCollaborationRepository } from './collaboration';

const role = {
  id: 'role-a',
  workspace_id: 'team-a',
  name: 'Lectura',
  template_key: null,
  version: 1,
  permissions: ['project.read', 'task.read'],
  created_at: '2026-10-23T12:00:00Z',
  updated_at: '2026-10-23T12:00:00Z',
};
function setup() {
  const rpc = vi.fn();
  return { rpc, repository: createCollaborationRepository({ rpc } as unknown as SupabaseClient) };
}

describe('frontera de colaboración', () => {
  it('recorre cursores de roles sin perder el ámbito y no trata una página vacía como un registro', async () => {
    const { rpc, repository } = setup();
    rpc
      .mockResolvedValueOnce({ data: { items: [role], next_cursor: 'opaque-cursor' }, error: null })
      .mockResolvedValueOnce({ data: { items: [], next_cursor: null }, error: null });
    await expect(repository.roles('team-a')).resolves.toEqual([role]);
    expect(rpc.mock.calls).toEqual([
      ['tr8_v2_list_roles', { p_workspace_id: 'team-a', p_cursor: null, p_limit: 100 }],
      ['tr8_v2_list_roles', { p_workspace_id: 'team-a', p_cursor: 'opaque-cursor', p_limit: 100 }],
    ]);
  });

  it.each([
    { items: [{ ...role, permissions: ['task.read', 42] }], next_cursor: null },
    { items: [role], next_cursor: 1 },
    { items: {}, next_cursor: null },
    [role],
  ])('rechaza una respuesta de roles sin contrato completo (%j)', async data => {
    const { rpc, repository } = setup();
    rpc.mockResolvedValue({ data, error: null });
    await expect(repository.roles('team-a')).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('rechaza un cursor repetido en lugar de entrar en un bucle infinito', async () => {
    const { rpc, repository } = setup();
    rpc.mockResolvedValue({ data: { items: [], next_cursor: 'same-cursor' }, error: null });
    await expect(repository.roles('team-a')).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('no devuelve una lista parcial cuando el acceso se pierde durante la paginación', async () => {
    const { rpc, repository } = setup();
    rpc
      .mockResolvedValueOnce({ data: { items: [role], next_cursor: 'next' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: 'PT404', message: 'Unavailable' } });
    await expect(repository.roles('team-a')).rejects.toMatchObject({ code: 'PT404' });
  });

  it('las capacidades ausentes o malformadas no conceden permisos', async () => {
    const { rpc, repository } = setup();
    rpc.mockResolvedValue({
      data: { items: [{ project_id: 'project-a', access_level: 'owner', permissions: ['task.edit'] }], next_cursor: null },
      error: null,
    });
    await expect(repository.projectCapabilities('team-a')).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });

  it('solo acepta un borrado confirmado del recurso solicitado', async () => {
    const { rpc, repository } = setup();
    rpc
      .mockResolvedValueOnce({ data: { id: 'another-role', deleted: true }, error: null })
      .mockResolvedValueOnce({ data: { id: role.id, deleted: true }, error: null });
    await expect(repository.deleteRole('team-a', role)).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
    await expect(repository.deleteRole('team-a', role)).resolves.toMatchObject({ id: role.id, deleted: true });
    expect(rpc).toHaveBeenLastCalledWith('tr8_v2_delete_role', { p_workspace_id: 'team-a', p_id: role.id, p_version: 1 });
  });
});

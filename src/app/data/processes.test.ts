import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { processFixture } from '../test/processes';
import { createProcessesRepository } from './processes';

function clientFor(data: unknown, error: unknown = null) {
  const query = Object.assign(Promise.resolve({ data, error }), { abortSignal: vi.fn().mockReturnThis() });
  const rpc = vi.fn().mockReturnValue(query);
  return { rpc, query, repository: createProcessesRepository({ rpc } as unknown as SupabaseClient) };
}
describe('estado de procesos', () => {
  it('consulta un espacio explícito con cancelación y devuelve solo el contrato mínimo', async () => {
    const data = processFixture();
    Object.assign(data.jobs[0], { private_payload: 'not for the client' });
    const { rpc, query, repository } = clientFor(data);
    const signal = new AbortController().signal;
    const result = await repository.processStatus('workspace-a', signal);
    expect(rpc).toHaveBeenCalledExactlyOnceWith('tr8_v2_get_process_status', { p_workspace_id: 'workspace-a' });
    expect(query.abortSignal).toHaveBeenCalledExactlyOnceWith(signal);
    expect(result.jobs[0]).not.toHaveProperty('private_payload');
    expect(result.channels).toEqual({ email: false, google: false });
  });
  it('rechaza respuestas incompletas, canales inesperados, duplicados y reintentos inválidos', async () => {
    const missingCount = processFixture();
    delete (missingCount.counts as Partial<typeof missingCount.counts>).unknown;
    const channel = processFixture();
    Object.assign(channel.channels, { email: true });
    const duplicate = processFixture();
    duplicate.jobs.push(duplicate.jobs[0]);
    const attempts = processFixture();
    attempts.jobs[0].attempts = 9;
    const invalidDate = processFixture();
    invalidDate.jobs[0].finished_at = 'tomorrow';
    const tooMany = processFixture();
    tooMany.jobs = Array(21).fill(tooMany.jobs[0]);
    for (const data of [null, missingCount, channel, duplicate, attempts, invalidDate, tooMany])
      await expect(clientFor(data).repository.processStatus('workspace-a')).rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' });
  });
  it('conserva los errores de acceso sin exponer el diagnóstico interno y rechaza un ámbito vacío', async () => {
    const denied = clientFor(null, { code: '42501', message: 'private worker internals' });
    await expect(denied.repository.processStatus('workspace-a')).rejects.toMatchObject({ code: '42501' });
    await expect(denied.repository.processStatus('workspace-a')).rejects.not.toThrow('private worker internals');
    const empty = clientFor(processFixture());
    await expect(empty.repository.processStatus('')).rejects.toThrow('Selecciona un espacio');
    expect(empty.rpc).not.toHaveBeenCalled();
  });
});

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FinancialVaultSessionController } from '../session/financial-controller';
import type { FinancialVaultControllerOptions } from '../session/financial-controller';
import { deferred, syntheticCore, SyntheticWorker, testIdentity, testPassword, testRecovery } from '../worker/test-fixtures';
import { parseOpaquePut, type VaultEnvelope } from '../compatibility/protocol';
import { emptyFinancialSnapshot } from '../domain/workspace';
import type { FinanceApi } from './api';
import { useFinance } from './useFinance';
import FinancePage from './FinancePage';

const seam = vi.hoisted(() => ({ worker: null as (() => Worker) | null }));
vi.mock('../session/financial-controller', async importOriginal => {
  const actual = await importOriginal<typeof import('../session/financial-controller')>();
  return {
    ...actual,
    FinancialVaultSessionController: class extends actual.FinancialVaultSessionController {
      constructor(options: FinancialVaultControllerOptions) {
        super({ ...options, makeWorker: () => seam.worker!(), capabilityCheck: () => {} });
      }
    },
  };
});
beforeEach(async () => {
  const core = await syntheticCore();
  const opened = await core.unlock({} as never, {} as never, { kind: 'password', value: testPassword });
  core.unlock = async (_a, _b, c) => ({
    ...opened,
    plaintext: emptyFinancialSnapshot() as never,
    mode: c.kind === 'recovery' ? 'recovery-readonly' : 'password',
  });
  seam.worker = () => new SyntheticWorker(core) as unknown as Worker;
});
function api() {
  let envelope: VaultEnvelope | null = null;
  let invalidate = () => {};
  const bodies: string[] = [];
  const value: FinanceApi = {
    ownerId: testIdentity.ownerId,
    enabled: true,
    syntheticOnly: true,
    head: vi.fn(async () => ({ envelope, epoch: '1' })),
    identity: vi.fn(async () => ({ ...testIdentity })),
    save: vi.fn(async body => {
      bodies.push(body);
      const put = parseOpaquePut(body);
      envelope = put.envelope;
      return { operationId: put.operationId, revision: put.envelope.revision };
    }),
    reauthenticate: vi.fn(async () => {}),
    subscribe: fn => {
      invalidate = fn;
      return () => {};
    },
  };
  return { value, bodies, invalidate: () => invalidate() };
}
async function create(h: ReturnType<typeof renderHook<ReturnType<typeof useFinance>, unknown>>) {
  await waitFor(() => expect(h.result.current.view.stage).toBe('empty'));
  await act(async () => h.result.current.create(testPassword));
  expect(h.result.current.view.stage).toBe('custody');
  await act(async () => h.result.current.custody(testPassword, testRecovery));
  expect(h.result.current.view.stage).toBe('open');
}
describe('Financial React disclosure leases', () => {
  it('clears a resolved disclosure when the tab becomes hidden', async () => {
    const a = api();
    const h = renderHook(() => useFinance(a.value));
    await create(h);
    act(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(h.result.current.view.snapshot).toBeNull();
    expect(h.result.current.view.recovery).toBeNull();
    act(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(h.result.current.view.stage).toBe('locked');
  });
  it('creates only after complete custody and clears React data on lock', async () => {
    const a = api();
    const h = renderHook(() => useFinance(a.value));
    await create(h);
    expect(a.bodies).toHaveLength(1);
    expect(h.result.current.view.snapshot).not.toBeNull();
    act(() => h.result.current.lock());
    expect(h.result.current.view.snapshot).toBeNull();
    expect(h.result.current.view.recovery).toBeNull();
    expect(h.result.current.view.stage).toBe('locked');
  });
  it('does not revive a late read after explicit lock', async () => {
    const a = api();
    const h = renderHook(() => useFinance(a.value));
    await create(h);
    const read = deferred<ReturnType<typeof emptyFinancialSnapshot>>();
    const readCall = vi.spyOn(FinancialVaultSessionController.prototype, 'read').mockImplementation(() => read.promise as never);
    let pending: Promise<unknown>;
    act(() => {
      pending = h.result.current.unlock({ kind: 'password', value: testPassword });
    });
    await waitFor(() => expect(readCall).toHaveBeenCalled());
    act(() => h.result.current.lock());
    await act(async () => {
      read.resolve(emptyFinancialSnapshot());
      await pending!;
    });
    expect(h.result.current.view.stage).toBe('locked');
    expect(h.result.current.view.snapshot).toBeNull();
  });
  it('does not begin work after a delayed trusted head crosses a session invalidation', async () => {
    const a = api();
    const h = renderHook(() => useFinance(a.value));
    await waitFor(() => expect(h.result.current.view.stage).toBe('empty'));
    const head = deferred<{ envelope: null; epoch: string }>();
    vi.mocked(a.value.head).mockReturnValueOnce(head.promise);
    const begin = vi.spyOn(FinancialVaultSessionController.prototype, 'beginCreate');
    let pending: Promise<unknown>;
    act(() => {
      pending = h.result.current.create(testPassword);
    });
    act(() => a.invalidate());
    await act(async () => {
      head.resolve({ envelope: null, epoch: '1' });
      await pending!;
    });
    expect(begin).not.toHaveBeenCalled();
    expect(h.result.current.view.recovery).toBeNull();
  });
  it('keeps only the exact retry after an ambiguous save', async () => {
    const a = api();
    const h = renderHook(() => useFinance(a.value));
    await waitFor(() => expect(h.result.current.view.stage).toBe('empty'));
    await act(async () => h.result.current.create(testPassword));
    const save = a.value.save;
    let first = '';
    a.value.save = save;
    vi.mocked(save).mockImplementationOnce(async body => {
      first = body;
      throw Error('OFFLINE');
    });
    await act(async () => h.result.current.custody(testPassword, testRecovery));
    expect(h.result.current.view.stage).toBe('pending');
    expect(h.result.current.view.snapshot).toBeNull();
    await act(async () => h.result.current.retry());
    expect(a.bodies[0]).toBe(first);
    expect(h.result.current.view.stage).toBe('open');
  });
  it('production gate never instantiates a controller or requests data', async () => {
    const a = api();
    a.value.enabled = false;
    const h = renderHook(() => useFinance(a.value));
    await waitFor(() => expect(h.result.current.view.stage).toBe('unavailable'));
    expect(a.value.head).not.toHaveBeenCalled();
    expect(h.result.current.controller.current).toBeNull();
  });
});

describe('Financial forms and domain commands', () => {
  it('requires the exact reset phrase and clears the account password after the request', async () => {
    const a = api();
    const reset = vi.fn(async () => {});
    a.value.resetVault = reset;
    render(<FinancePage api={a.value} />);
    await screen.findByRole('button', { name: 'Crear bóveda' });
    fireEvent.change(screen.getByLabelText('Contraseña de TR8 para reiniciar la bóveda'), { target: { value: 'fixture-account-password' } });
    const confirmation = screen.getByLabelText('Escribe ELIMINAR BÓVEDA');
    fireEvent.change(confirmation, { target: { value: 'otra cosa' } });
    const button = screen.getByRole('button', { name: 'Eliminar bóveda y cerrar sesión', hidden: true });
    fireEvent.submit(button.closest('form')!);
    expect(reset).not.toHaveBeenCalled();
    fireEvent.change(confirmation, { target: { value: 'ELIMINAR BÓVEDA' } });
    fireEvent.submit(button.closest('form')!);
    await waitFor(() => expect(reset).toHaveBeenCalledWith('fixture-account-password', 'ELIMINAR BÓVEDA'));
    await waitFor(() => expect(screen.getByLabelText('Contraseña de TR8 para reiniciar la bóveda')).toHaveValue(''));
  });
  it('creates an account, rejects ambiguous money and confirms a plan exactly once', async () => {
    const a = api();
    render(<FinancePage api={a.value} />);
    await screen.findByRole('button', { name: 'Crear bóveda' });
    fireEvent.change(screen.getByLabelText('Contraseña privada', { exact: true }), { target: { value: testPassword } });
    fireEvent.change(screen.getByLabelText('Repite la contraseña privada'), { target: { value: testPassword } });
    fireEvent.click(screen.getByRole('button', { name: 'Crear bóveda' }));
    await screen.findByRole('heading', { name: 'Guarda tu código de recuperación' });
    fireEvent.change(screen.getByLabelText('Contraseña privada elegida'), { target: { value: testPassword } });
    fireEvent.change(screen.getByLabelText('Reescribe el código completo'), { target: { value: testRecovery } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar custodia y guardar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Nueva cuenta' }));
    fireEvent.change(screen.getByLabelText('Nombre de la cuenta'), { target: { value: 'Cuenta ficticia' } });
    fireEvent.change(screen.getByLabelText('Saldo inicial'), { target: { value: '1e3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Usa un importe decimal');
    expect(a.bodies).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Saldo inicial'), { target: { value: '100,00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await screen.findByRole('heading', { name: 'Cuenta ficticia' });
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo movimiento' }));
    fireEvent.change(screen.getByLabelText('Descripción'), { target: { value: 'Plan ficticio' } });
    fireEvent.change(screen.getByLabelText(/Importe/), { target: { value: '25,00' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar plan' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Planes' }));
    expect(screen.getByText('Plan ficticio')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar acción' }));
    await screen.findByRole('heading', { name: 'Disponibilidad por moneda' });
    fireEvent.click(screen.getByRole('button', { name: 'Planes' }));
    expect(screen.getByText('Confirmado')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirmar' })).not.toBeInTheDocument();
    expect(a.bodies).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear' }));
    expect(screen.queryByText('Plan ficticio')).not.toBeInTheDocument();
    expect(screen.queryByText('Cuenta ficticia')).not.toBeInTheDocument();
  });
});

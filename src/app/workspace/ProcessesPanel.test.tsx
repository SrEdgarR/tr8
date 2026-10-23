import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProcessesApi } from '../data/processes';
import { processFixture } from '../test/processes';
import ProcessesPanel from './ProcessesPanel';

function mount(api: ProcessesApi, disabled = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ProcessesPanel api={api} disabled={disabled} workspaceName="Mi espacio personal" />
    </QueryClientProvider>,
  );
}
describe('panel de procesos en configuración', () => {
  it('distingue la preparación interna de las integraciones apagadas', async () => {
    const load = vi.fn().mockResolvedValue(processFixture());
    mount({ scopeKey: ['processes-test'], load });
    await screen.findByText('Cambio de tarea');
    expect(screen.getByText('Procesamiento automático activo')).toBeInTheDocument();
    expect(screen.getByText('Preparado')).toBeInTheDocument();
    expect(screen.getByText(/No envía correos ni crea eventos externos/)).toBeInTheDocument();
    expect(screen.getByText('Desactivado')).toBeInTheDocument();
    expect(screen.getByText('Desconectado')).toBeInTheDocument();
    expect(load).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
  });
  it('oculta los datos anteriores si falla una actualización y permite reintentar', async () => {
    const load = vi.fn().mockResolvedValue(processFixture());
    mount({ scopeKey: ['processes-error-test'], load });
    await screen.findByText('Cambio de tarea');
    load.mockRejectedValueOnce(new Error('Ya no tienes acceso'));
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar procesos' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ya no tienes acceso');
    expect(screen.queryByRole('list', { name: 'Tus procesos recientes' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar procesos' }));
    await screen.findByText('Cambio de tarea');
  });
  it('no consulta un espacio al que ya no hay acceso', async () => {
    const load = vi.fn().mockResolvedValue(processFixture());
    mount({ scopeKey: ['processes-denied-test'], load }, true);
    expect(load).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Actualizar procesos' })).toBeDisabled();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
  it('explica el presupuesto y un resultado incierto sin mostrarlo como entrega exitosa', async () => {
    const status = processFixture();
    status.budget.blocked = true;
    status.counts.succeeded = 0;
    status.counts.unknown = 1;
    status.jobs[0].state = 'unknown';
    status.jobs[0].reason = 'outcome_unknown';
    mount({ scopeKey: ['processes-budget-test'], load: vi.fn().mockResolvedValue(status) });
    await waitFor(() => expect(screen.getByText('Por comprobar')).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('Tus proyectos y tareas se pueden seguir guardando');
    expect(screen.queryByText('Preparado')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

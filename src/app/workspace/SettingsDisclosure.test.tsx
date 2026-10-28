import { useEffect } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SettingsDisclosure from './SettingsDisclosure';
import CalendarSettings from './CalendarZoneSettings';

describe('settings loading and drafts', () => {
  it('mounts collapsed content only after opening and preserves its draft when collapsed again', () => {
    const mount = vi.fn();
    const change = vi.fn();
    function Draft() {
      useEffect(mount, []);
      return <input aria-label="Borrador" defaultValue="" />;
    }
    render(
      <SettingsDisclosure title="Preferencias" description="Texto" icon={null} onExpandedChange={change}>
        <Draft />
      </SettingsDisclosure>,
    );
    expect(mount).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Borrador')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preferencias' }));
    fireEvent.change(screen.getByLabelText('Borrador'), { target: { value: 'Mi borrador' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preferencias' }));
    expect(screen.getByLabelText('Borrador')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Preferencias' }));
    expect(screen.getByLabelText('Borrador')).toHaveValue('Mi borrador');
    expect(mount).toHaveBeenCalledTimes(1);
    expect(change.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('does not mount connection or process panels in unvisited categories and keeps opened drafts', () => {
    const connections = vi.fn();
    const processes = vi.fn();
    function Connections() {
      useEffect(connections, []);
      return <input aria-label="Conexión en edición" defaultValue="" />;
    }
    function Processes() {
      useEffect(processes, []);
      return <p>Proceso abierto</p>;
    }
    render(<CalendarSettings integrations={<Connections />} processes={<Processes />} />);
    expect(connections).not.toHaveBeenCalled();
    expect(processes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Conexiones' }));
    fireEvent.change(screen.getByLabelText('Conexión en edición'), { target: { value: 'Pendiente' } });
    fireEvent.click(screen.getByRole('button', { name: 'General' }));
    expect(screen.getByLabelText('Conexión en edición')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Conexiones' }));
    expect(screen.getByLabelText('Conexión en edición')).toHaveValue('Pendiente');
    expect(connections).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Actividad' }));
    expect(processes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Procesos en segundo plano' }));
    expect(processes).toHaveBeenCalledTimes(1);
  });
});

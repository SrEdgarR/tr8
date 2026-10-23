import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { timeZoneClock } from './CalendarTime';
import TimeZonePicker from './TimeZonePicker';
import * as zones from './timeZones';

const newYork: zones.TimeZoneOption = {
  id: 'us-ny',
  timeZone: 'America/New_York',
  label: 'Nueva York · Estados Unidos',
  countryCode: 'US',
  countryName: 'Estados Unidos',
  city: 'Nueva York',
};
const losAngeles: zones.TimeZoneOption = {
  id: 'us-la',
  timeZone: 'America/Los_Angeles',
  label: 'Los Ángeles · Estados Unidos',
  countryCode: 'US',
  countryName: 'Estados Unidos',
  city: 'Los Ángeles',
};
const laPaz: zones.TimeZoneOption = {
  id: 'bo-lp',
  timeZone: 'America/La_Paz',
  label: 'La Paz · Bolivia',
  countryCode: 'BO',
  countryName: 'Bolivia',
  city: 'La Paz',
};
const catalog: zones.TimeZoneCatalog = {
  countries: [
    { name: 'Estados Unidos', names: ['estados unidos', 'united states', 'us'], options: [newYork, losAngeles] },
    { name: 'Bolivia', names: ['bolivia', 'bo'], options: [laPaz] },
  ],
  entries: [
    { option: newYork, names: ['nueva york', 'new york', 'america new york'], context: 'estados unidos' },
    { option: losAngeles, names: ['los angeles', 'america los angeles'], context: 'estados unidos' },
    { option: laPaz, names: ['la paz', 'america la paz'], context: 'bolivia' },
  ],
};

function Harness({ initial = '', disabled = false, onChange = vi.fn() }: { initial?: string; disabled?: boolean; onChange?: (zone: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <TimeZonePicker
      label="Zona del calendario"
      value={value}
      disabled={disabled}
      onChange={next => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('selector de zona por país o ciudad', () => {
  beforeEach(() => {
    vi.spyOn(zones, 'loadTimeZoneCatalog').mockResolvedValue(catalog);
  });

  it('un país con varias zonas ofrece alternativas y no elige una de manera implícita', async () => {
    const onChange = vi.fn();
    render(<Harness initial="Estados Unidos" onChange={onChange} />);
    const input = screen.getByRole('combobox', { name: 'Zona del calendario' });
    fireEvent.focus(input);
    expect(await screen.findByText('Estados Unidos: 2 zonas horarias. Elige una opción.')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(input).toHaveValue('Estados Unidos');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Fecha y hora de la zona seleccionada')).toHaveTextContent('Selecciona una zona de los resultados');
  });

  it('reconoce un país de una zona, guarda la opción IANA al seleccionarla y muestra su fecha, hora y desplazamiento', async () => {
    const onChange = vi.fn();
    render(<Harness initial="Bolivia" onChange={onChange} />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Zona del calendario' }));
    const option = await screen.findByRole('option', { name: /La Paz · Bolivia/ });
    expect(option).toHaveTextContent('America/La_Paz');
    expect(option).toHaveTextContent('UTC-04:00');
    fireEvent.click(option);
    const input = screen.getByRole('combobox', { name: 'Zona del calendario' });
    expect(input).toHaveValue('America/La_Paz');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).toHaveBeenCalledExactlyOnceWith('America/La_Paz');
    const preview = screen.getByLabelText('Fecha y hora de la zona seleccionada');
    expect(preview).toHaveTextContent(timeZoneClock('America/La_Paz').date);
    expect(preview).toHaveTextContent(/\d{2}:\d{2}:\d{2} · UTC-04:00/);
    expect(preview).toHaveTextContent('America/La_Paz');
    expect(preview).not.toHaveAttribute('aria-live');
  });

  it('resuelve nombres con acentos y conserva una consulta desconocida sin convertirla en zona', async () => {
    render(<Harness initial="Los Ángeles" />);
    const input = screen.getByRole('combobox', { name: 'Zona del calendario' });
    fireEvent.focus(input);
    expect(await screen.findByRole('option', { name: /Los Ángeles · Estados Unidos/ })).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'Ciudad inexistente xyz' } });
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('No encontramos ese lugar. Prueba una ciudad cercana o escribe su zona IANA.')).toBeInTheDocument();
    expect(input).toHaveValue('Ciudad inexistente xyz');
  });

  it('permite recorrer las opciones con flechas y elegir con Intro sin enviar el formulario', async () => {
    render(<Harness initial="Estados Unidos" />);
    const input = screen.getByRole('combobox', { name: 'Zona del calendario' });
    fireEvent.focus(input);
    await screen.findByRole('listbox', { name: 'Zonas horarias encontradas' });
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveAttribute('aria-activedescendant', options[1].id);
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(false);
    expect(input).toHaveValue('America/New_York');
    expect(input).toHaveAttribute('aria-expanded', 'false');
  });

  it('Escape cierra los resultados sin propagar el cierre a la ventana de la tarea', async () => {
    const parentKeyDown = vi.fn();
    render(
      <div onKeyDown={parentKeyDown}>
        <Harness initial="Bolivia" />
      </div>,
    );
    const input = screen.getByRole('combobox', { name: 'Zona del calendario' });
    fireEvent.focus(input);
    await screen.findByRole('option', { name: /La Paz · Bolivia/ });
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false);
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(input).toHaveValue('Bolivia');
  });

  it('si falla el catálogo permite escribir una zona IANA válida y reabrir la búsqueda para reintentar', async () => {
    vi.mocked(zones.loadTimeZoneCatalog).mockRejectedValueOnce(new Error('Sin conexión')).mockResolvedValue(catalog);
    render(<Harness />);
    const input = screen.getByRole('combobox', { name: 'Zona del calendario' });
    fireEvent.focus(input);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No se pudo cargar la búsqueda'));
    fireEvent.change(input, { target: { value: 'Asia/Kathmandu' } });
    expect(screen.getByLabelText('Fecha y hora de la zona seleccionada')).toHaveTextContent('UTC+05:45');
    fireEvent.blur(input);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Bolivia' } });
    expect(await screen.findByRole('option', { name: /La Paz · Bolivia/ })).toBeInTheDocument();
    expect(zones.loadTimeZoneCatalog).toHaveBeenCalledTimes(2);
  });

  it('mantiene un selector deshabilitado sin resultados interactivos pero muestra la hora de su zona válida', () => {
    render(<Harness initial="UTC" disabled />);
    expect(screen.getByRole('combobox', { name: 'Zona del calendario' })).toBeDisabled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(within(screen.getByLabelText('Fecha y hora de la zona seleccionada')).getByText('UTC')).toBeInTheDocument();
    expect(zones.loadTimeZoneCatalog).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  addCivilDays,
  blockLastDate,
  dateInTimeZone,
  instantMicroseconds,
  localDateTime,
  localInstantChoices,
  monthDays,
  moveBlock,
  resolveLocalInstant,
  validCivilDate,
  validTimeZone,
} from './CalendarTime';

describe('fechas civiles y zonas del calendario', () => {
  it('suma días civiles en cambios horarios, bisiestos y fin de año', () => {
    expect(addCivilDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addCivilDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addCivilDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(validCivilDate('2026-02-29')).toBe(false);
    expect(validCivilDate('2026-13-01')).toBe(false);
    expect(validCivilDate('2026-1-01')).toBe(false);
    expect(validCivilDate('0000-01-01')).toBe(false);
    expect(validTimeZone('EST')).toBe(false);
    expect(validTimeZone('+04:00')).toBe(false);
  });

  it('forma una cuadrícula completa con lunes al inicio sin sumar milisegundos locales', () => {
    const days = monthDays('2026-11-15');
    expect(days[0]).toBe('2026-10-26');
    expect(days.at(-1)).toBe('2026-12-06');
    expect(days).toHaveLength(42);
  });

  it('rechaza horas inexistentes en saltos DST y de línea de fecha', () => {
    expect(localInstantChoices('2026-03-08T02:30', 'America/New_York')).toEqual([]);
    expect(localInstantChoices('2026-10-04T02:15', 'Australia/Lord_Howe')).toEqual([]);
    expect(localInstantChoices('2011-12-30T12:00', 'Pacific/Apia')).toEqual([]);
    expect(() => resolveLocalInstant('2026-03-08T02:30', 'America/New_York', '')).toThrow(/no existe/);
  });

  it('exige escoger el desplazamiento en horas repetidas', () => {
    const choices = localInstantChoices('2026-11-01T01:30', 'America/New_York');
    expect(choices.map(choice => choice.instant)).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
    expect(choices.map(choice => choice.label)).toEqual(['UTC−04:00', 'UTC−05:00']);
    expect(() => resolveLocalInstant('2026-11-01T01:30', 'America/New_York', '')).toThrow(/desplazamiento/);
    expect(resolveLocalInstant('2026-11-01T01:30', 'America/New_York', choices[1].instant)).toBe(choices[1].instant);
    expect(localInstantChoices('2026-04-05T01:45', 'Australia/Lord_Howe').map(choice => choice.offsetMinutes)).toEqual([660, 630]);
  });

  it('mantiene instantes al cambiar la visualización y reconoce zonas con minutos', () => {
    const instant = '2026-10-24T02:00:00.000Z';
    expect(dateInTimeZone(instant, 'America/La_Paz')).toBe('2026-10-23');
    expect(dateInTimeZone(instant, 'Asia/Tokyo')).toBe('2026-10-24');
    expect(localDateTime(instant, 'America/La_Paz')).toBe('2026-10-23T22:00');
    expect(resolveLocalInstant('2026-10-24T07:45', 'Asia/Kathmandu', '')).toBe(instant);
  });

  it('mover un bloque conserva duración real incluso al cruzar DST', () => {
    expect(moveBlock('2026-10-31T05:30:00Z', '2026-10-31T07:30:00Z', '2026-11-01T05:30:00Z')).toEqual({
      start: '2026-11-01T05:30:00.000Z',
      end: '2026-11-01T07:30:00.000Z',
    });
  });

  it('conserva microsegundos exactos al mover y formatea correctamente instantes anteriores a 1970', () => {
    const start = '2026-10-24T10:00:30.123456-04:00';
    const end = '2026-10-24T11:00:45.654321-04:00';
    const moved = moveBlock(start, end, '2026-11-01T05:30:00.222333Z');
    expect(moved).toEqual({ start: '2026-11-01T05:30:00.222333Z', end: '2026-11-01T06:30:15.753198Z' });
    expect(instantMicroseconds(moved.end) - instantMicroseconds(moved.start)).toBe(instantMicroseconds(end) - instantMicroseconds(start));
    expect(blockLastDate('2026-10-24T00:00:00.000000Z', 'UTC')).toBe('2026-10-23');
    expect(blockLastDate('2026-10-24T00:00:00.000001Z', 'UTC')).toBe('2026-10-24');
    expect(moveBlock('1969-12-31T23:59:59.123456Z', '1969-12-31T23:59:59.654321Z', '1969-12-31T23:59:58.100000Z')).toEqual({
      start: '1969-12-31T23:59:58.100Z',
      end: '1969-12-31T23:59:58.630865Z',
    });
  });
});

/** Civil dates are calendar labels, never instants in the browser's time zone. */
export function validCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function civilDateObject(value: string): Date {
  if (!validCivilDate(value)) throw new Error('Escribe una fecha válida.');
  return new Date(`${value}T12:00:00.000Z`);
}

export function addCivilDays(value: string, amount: number): string {
  const date = civilDateObject(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function monthStart(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

export function addCivilMonths(value: string, amount: number): string {
  const date = civilDateObject(monthStart(value));
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 10);
}

export function monthDays(value: string): string[] {
  const start = monthStart(value);
  const weekday = civilDateObject(start).getUTCDay();
  const gridStart = addCivilDays(start, -(weekday === 0 ? 6 : weekday - 1));
  const days: string[] = [];
  const next = addCivilMonths(start, 1);
  for (let day = gridStart; day < next || days.length % 7 !== 0; day = addCivilDays(day, 1)) days.push(day);
  return days;
}

export function formatCivilDate(value: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }): string {
  return new Intl.DateTimeFormat('es', { ...options, timeZone: 'UTC' }).format(civilDateObject(value));
}

export function validTimeZone(value: string): boolean {
  if (!value || value.trim() !== value || (value !== 'UTC' && !/^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(value))) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const localFormatters = new Map<string, Intl.DateTimeFormat>();

function localParts(instant: number, timeZone: string): Record<string, number> {
  let formatter = localFormatters.get(timeZone);
  if (!formatter) {
    if (localFormatters.size >= 32) localFormatters.clear();
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    localFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}

export function dateInTimeZone(instant: string | number | Date, timeZone: string): string {
  const parts = localParts(new Date(instant).getTime(), timeZone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function localDateTime(instant: string, timeZone: string): string {
  const parts = localParts(new Date(instant).getTime(), timeZone);
  return `${dateInTimeZone(instant, timeZone)}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function formatTime(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(instant));
}

export interface LocalInstantChoice {
  instant: string;
  offsetMinutes: number;
  label: string;
}

/** Return every matching instant. A DST gap has none; a repeated hour has two. */
export function localInstantChoices(value: string, timeZone: string): LocalInstantChoice[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !validCivilDate(value.slice(0, 10)) || !validTimeZone(timeZone)) return [];
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  if (hour > 23 || minute > 59) return [];
  const localMs = new Date(`${value}:00.000Z`).getTime();
  const offsets = new Set<number>();
  // Sample both sides of transitions, including half-hour changes and date-line skips.
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = localMs + hours * 60 * 60 * 1000;
    const parts = localParts(sample, timeZone);
    const displayed = new Date(0);
    displayed.setUTCFullYear(parts.year, parts.month - 1, parts.day);
    displayed.setUTCHours(parts.hour, parts.minute, parts.second, 0);
    offsets.add(displayed.getTime() - sample);
  }
  return [...offsets]
    .map(offset => ({ instant: new Date(localMs - offset).toISOString(), offsetMinutes: offset / 60000 }))
    .filter(choice => localDateTime(choice.instant, timeZone) === value)
    .sort((a, b) => a.instant.localeCompare(b.instant))
    .map(choice => {
      const minutes = Math.abs(choice.offsetMinutes);
      return {
        ...choice,
        label: `UTC${choice.offsetMinutes >= 0 ? '+' : '−'}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
      };
    });
}

export function resolveLocalInstant(value: string, timeZone: string, selectedInstant: string): string {
  const choices = localInstantChoices(value, timeZone);
  if (!choices.length) throw new Error('Esta hora no existe en la zona elegida. Selecciona otra hora.');
  if (choices.length === 1) return choices[0].instant;
  const selected = choices.find(choice => choice.instant === selectedInstant);
  if (!selected) throw new Error('Esta hora se repite por el cambio horario. Elige su desplazamiento UTC.');
  return selected.instant;
}

export function instantMicroseconds(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new Error('El instante del bloque no es válido.');
  const base = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(base)) throw new Error('El instante del bloque no es válido.');
  return BigInt(base) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0'));
}

export function blockLastDate(end: string, timeZone: string): string {
  const lastMicrosecond = instantMicroseconds(end) - 1n;
  let milliseconds = lastMicrosecond / 1000n;
  if (lastMicrosecond % 1000n < 0) milliseconds -= 1n;
  return dateInTimeZone(Number(milliseconds), timeZone);
}

function microsecondsIso(value: bigint): string {
  let seconds = value / 1000000n;
  let fraction = value % 1000000n;
  if (fraction < 0) {
    seconds -= 1n;
    fraction += 1000000n;
  }
  const base = new Date(Number(seconds * 1000n)).toISOString().slice(0, 19);
  const digits = fraction.toString().padStart(6, '0');
  return `${base}.${digits.endsWith('000') ? digits.slice(0, 3) : digits}Z`;
}

export function moveBlock(start: string, end: string, nextStart: string): { start: string; end: string } {
  const duration = instantMicroseconds(end) - instantMicroseconds(start);
  const next = instantMicroseconds(nextStart);
  if (duration <= 0) throw new Error('El bloque horario no es válido.');
  return { start: microsecondsIso(next), end: microsecondsIso(next + duration) };
}

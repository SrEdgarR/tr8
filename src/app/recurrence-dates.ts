import type { RecurrenceRule } from './recurrence-types';
import { validCivilDate, validTimeZone } from './workspace/CalendarTime';

const DAY = 86_400_000;
const ordinal = (value: string) => Date.parse(`${value}T00:00:00.000Z`) / DAY;
function civil(value: number): string | null {
  const result = new Date(value * DAY).toISOString();
  return /^\d{4}-/.test(result) ? result.slice(0, 10) : null;
}
const weekday = (value: number) => ((((value + 3) % 7) + 7) % 7) + 1;

export function validRecurrenceRule(value: unknown): value is RecurrenceRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  if (Object.keys(rule).length !== 5 || !['frequency', 'interval', 'weekdays', 'time_zone', 'until_date'].every(key => key in rule)) return false;
  const maximum = rule.frequency === 'daily' ? 365 : rule.frequency === 'weekly' ? 52 : rule.frequency === 'monthly' ? 12 : 0;
  if (
    !maximum ||
    typeof rule.interval !== 'number' ||
    !Number.isInteger(rule.interval) ||
    rule.interval < 1 ||
    rule.interval > maximum ||
    !Array.isArray(rule.weekdays)
  )
    return false;
  if (
    rule.weekdays.some(day => typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7) ||
    new Set(rule.weekdays).size !== rule.weekdays.length
  )
    return false;
  if (rule.frequency === 'weekly' ? !rule.weekdays.length : rule.weekdays.length !== 0) return false;
  return (
    typeof rule.time_zone === 'string' &&
    validTimeZone(rule.time_zone) &&
    (rule.until_date === null || (typeof rule.until_date === 'string' && validCivilDate(rule.until_date)))
  );
}

/** Calendar-date preview only. The server is authoritative and creates one occurrence on completion. */
export function nextRecurrenceDate(rule: RecurrenceRule, anchorDate: string, afterDate: string): string | null {
  if (!validRecurrenceRule(rule) || !validCivilDate(anchorDate) || !validCivilDate(afterDate) || (rule.until_date && rule.until_date < anchorDate)) return null;
  const anchor = ordinal(anchorDate),
    after = ordinal(afterDate);
  let candidate: string | null = null;
  if (rule.frequency === 'daily') {
    candidate = civil(anchor + Math.max(0, Math.floor((after - anchor) / rule.interval) + 1) * rule.interval);
  } else if (rule.frequency === 'weekly') {
    const anchorMonday = anchor - weekday(anchor) + 1;
    const start = Math.max(anchor, after + 1);
    for (let offset = 0; offset <= rule.interval * 7 + 7; offset++) {
      const day = start + offset;
      if (Math.floor((day - anchorMonday) / 7) % rule.interval === 0 && rule.weekdays.includes(weekday(day))) {
        candidate = civil(day);
        break;
      }
    }
  } else {
    const [year, month, day] = anchorDate.split('-').map(Number);
    const [afterYear, afterMonth] = afterDate.split('-').map(Number);
    const anchorMonth = year * 12 + month - 1;
    let step = Math.max(0, Math.floor((afterYear * 12 + afterMonth - 1 - anchorMonth) / rule.interval));
    for (let attempt = 0; attempt < 3; attempt++, step++) {
      const index = anchorMonth + step * rule.interval,
        y = Math.floor(index / 12),
        m = (index % 12) + 1;
      if (y > 9999) return null;
      const first = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
      const monthEnd = new Date(0);
      monthEnd.setUTCFullYear(y, m, 0);
      const days = monthEnd.getUTCDate();
      const value = `${first.slice(0, 8)}${String(Math.min(day, days)).padStart(2, '0')}`;
      if (value >= anchorDate && value > afterDate) {
        candidate = value;
        break;
      }
    }
  }
  return candidate && (!rule.until_date || candidate <= rule.until_date) ? candidate : null;
}

export function previewRecurrenceDates(rule: RecurrenceRule, anchorDate: string, afterDate: string, count = 3): string[] {
  const dates: string[] = [];
  if (!Number.isSafeInteger(count) || count < 0 || count > 20) return dates;
  let after = afterDate;
  for (let n = 0; n < count; n++) {
    const next = nextRecurrenceDate(rule, anchorDate, after);
    if (!next) break;
    dates.push(next);
    after = next;
  }
  return dates;
}

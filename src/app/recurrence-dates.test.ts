import { describe, expect, it } from 'vitest';
import type { RecurrenceRule } from './recurrence-types';
import { nextRecurrenceDate, previewRecurrenceDates, validRecurrenceRule } from './recurrence-dates';
const daily: RecurrenceRule = { frequency: 'daily', interval: 1, weekdays: [], time_zone: 'America/La_Paz', until_date: null };
const weekly: RecurrenceRule = { ...daily, frequency: 'weekly', weekdays: [1, 5] };
const monthly: RecurrenceRule = { ...daily, frequency: 'monthly' };
describe('civil recurrence previews', () => {
  it('keeps daily cadence anchored while skipping elapsed dates', () => {
    expect(nextRecurrenceDate({ ...daily, interval: 3 }, '2026-10-01', '2026-10-29')).toBe('2026-10-31');
    expect(nextRecurrenceDate(daily, '2026-10-29', '2026-10-29')).toBe('2026-10-30');
    expect(nextRecurrenceDate(daily, '2026-11-01', '2026-10-29')).toBe('2026-11-01');
  });
  it('keeps civil dates stable around DST in different zones', () => {
    for (const time_zone of ['America/New_York', 'Europe/Madrid', 'America/La_Paz']) {
      expect(nextRecurrenceDate({ ...daily, time_zone }, '2026-03-07', '2026-03-07')).toBe('2026-03-08');
      expect(nextRecurrenceDate({ ...daily, time_zone }, '2026-10-31', '2026-10-31')).toBe('2026-11-01');
    }
  });
  it('uses ISO weekdays and the original Monday-based week for intervals', () => {
    expect(previewRecurrenceDates({ ...weekly, interval: 2 }, '2026-01-05', '2026-01-05')).toEqual(['2026-01-09', '2026-01-19', '2026-01-23']);
    expect(nextRecurrenceDate({ ...weekly, interval: 2 }, '2026-01-05', '2026-01-10')).toBe('2026-01-19');
    expect(nextRecurrenceDate({ ...weekly, weekdays: [7] }, '2026-01-05', '2026-01-10')).toBe('2026-01-11');
  });
  it('clamps months without drifting after February or a short month', () => {
    expect(previewRecurrenceDates(monthly, '2026-01-31', '2026-01-31')).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
    expect(previewRecurrenceDates(monthly, '2028-01-31', '2028-01-31')).toEqual(['2028-02-29', '2028-03-31', '2028-04-30']);
    expect(nextRecurrenceDate({ ...monthly, interval: 2 }, '2026-12-31', '2026-12-31')).toBe('2027-02-28');
    expect(nextRecurrenceDate({ ...monthly, interval: 12 }, '2024-02-29', '2027-02-28')).toBe('2028-02-29');
  });
  it('includes the final date and stops after it', () => {
    const rule = { ...daily, until_date: '2026-10-31' };
    expect(previewRecurrenceDates(rule, '2026-10-29', '2026-10-29')).toEqual(['2026-10-30', '2026-10-31']);
    expect(nextRecurrenceDate(rule, '2026-10-29', '2026-10-31')).toBeNull();
    expect(nextRecurrenceDate({ ...daily, until_date: '2026-10-28' }, '2026-10-29', '2026-10-29')).toBeNull();
  });
  it('finishes safely at the supported calendar boundary', () => {
    expect(nextRecurrenceDate(monthly, '9999-10-31', '9999-11-30')).toBe('9999-12-31');
    for (const rule of [daily, weekly, monthly]) expect(nextRecurrenceDate(rule, '9999-12-31', '9999-12-31')).toBeNull();
    expect(nextRecurrenceDate(monthly, '2026-02-30', '2026-03-01')).toBeNull();
  });
  it.each([
    { ...daily, frequency: 'yearly' },
    { ...daily, interval: 0 },
    { ...daily, interval: 366 },
    { ...weekly, interval: 53 },
    { ...monthly, interval: 13 },
    { ...weekly, weekdays: [] },
    { ...weekly, weekdays: [1, 1] },
    { ...weekly, weekdays: [0] },
    { ...daily, weekdays: [1] },
    { ...daily, time_zone: 'Mars/Unknown' },
    { ...daily, until_date: '2026-02-30' },
    { ...daily, extra: true },
  ])('rejects malformed rules (%#)', rule => expect(validRecurrenceRule(rule)).toBe(false));
  it('bounds previews and preserves input data', () => {
    const before = structuredClone(weekly);
    previewRecurrenceDates(weekly, '2026-01-05', '2026-01-05');
    expect(weekly).toEqual(before);
    expect(previewRecurrenceDates(daily, '2026-01-01', '2026-01-01', 21)).toEqual([]);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { validTimeZone } from './CalendarTime';
import { loadTimeZoneCatalog, searchTimeZones, type TimeZoneCatalog } from './timeZones';

let catalog: TimeZoneCatalog;
beforeAll(async () => {
  catalog = await loadTimeZoneCatalog();
});

describe('offline country and city time-zone search', () => {
  it('loads one memoized local catalog with broad city coverage', async () => {
    expect(loadTimeZoneCatalog()).toBe(loadTimeZoneCatalog());
    expect(await loadTimeZoneCatalog()).toBe(catalog);
    expect(catalog.entries.length).toBeGreaterThan(30_000);
  });

  it('returns a choice for a single-zone country instead of interpreting it as an IANA identifier', () => {
    const result = searchTimeZones(catalog, 'Bolivia');
    expect(result.countryMatch).toEqual({ name: 'Bolivia', timeZoneCount: 1 });
    expect(result.options.map(option => option.timeZone)).toEqual(['America/La_Paz']);
    expect(result.options[0].countryCode).toBe('BO');
  });

  it('enumerates every country zone rather than assuming a capital city', () => {
    const result = searchTimeZones(catalog, 'España');
    expect(result.countryMatch?.timeZoneCount).toBe(3);
    expect(result.options.map(option => option.timeZone)).toEqual(expect.arrayContaining(['Europe/Madrid', 'Africa/Ceuta', 'Atlantic/Canary']));
    expect(new Set(result.options.map(option => option.timeZone)).size).toBe(result.total);
  });

  it.each(['España', 'Espana', 'Spain', 'ES'])('recognizes the country name %s', query => {
    expect(searchTimeZones(catalog, query).countryMatch?.name).toBe('España');
  });

  it.each(['Perú', 'Peru', '  PERÚ  '])('normalizes accents, case and whitespace for %s', query => {
    expect(searchTimeZones(catalog, query).options.map(option => option.timeZone)).toEqual(['America/Lima']);
  });

  it.each(['Estados Unidos', 'United States', 'USA', 'EE.UU.'])('preserves multi-zone choice for %s', query => {
    const result = searchTimeZones(catalog, query);
    expect(result.countryMatch?.timeZoneCount).toBeGreaterThan(10);
    expect(result.total).toBeGreaterThan(result.options.length);
    expect(result.options).toHaveLength(12);
    expect(searchTimeZones(catalog, query, { limit: 100 }).options).toHaveLength(result.total);
  });

  it.each([
    ['Cochabamba', 'America/La_Paz', 'BO'],
    ['Barcelona', 'Europe/Madrid', 'ES'],
    ['Santa Cruz de la Sierra', 'America/La_Paz', 'BO'],
    ['Bogotá', 'America/Bogota', 'CO'],
    ['Bogota', 'America/Bogota', 'CO'],
    ['Nueva York', 'America/New_York', 'US'],
    ['Londres', 'Europe/London', 'GB'],
    ['London', 'Europe/London', 'GB'],
    ['Tokyo', 'Asia/Tokyo', 'JP'],
    ['Munich', 'Europe/Berlin', 'DE'],
    ['Pristina', 'Europe/Belgrade', 'XK'],
  ])('maps %s to its geographical IANA zone', (query, zone, countryCode) => {
    expect(searchTimeZones(catalog, query, { limit: 100 }).options).toEqual(expect.arrayContaining([expect.objectContaining({ timeZone: zone, countryCode })]));
  });

  it('keeps homonymous cities distinct and labels their region and country', () => {
    const result = searchTimeZones(catalog, 'Santiago', { limit: 100 });
    expect(new Set(result.options.map(option => option.countryCode)).size).toBeGreaterThan(1);
    expect(result.options.some(option => option.countryCode === 'CL' && option.timeZone === 'America/Santiago')).toBe(true);
    expect(new Set(result.options.map(option => option.id)).size).toBe(result.options.length);
    for (const option of result.options) expect(option.label).toContain(option.countryName);
  });

  it('supports a city plus country to disambiguate similar city names', () => {
    const result = searchTimeZones(catalog, 'Santa Cruz Bolivia');
    expect(result.options.some(option => option.countryCode === 'BO' && option.timeZone === 'America/La_Paz')).toBe(true);
    expect(result.options.every(option => option.countryCode === 'BO')).toBe(true);
  });

  it('recognizes the IANA identifier and UTC without an external geocoder', () => {
    expect(searchTimeZones(catalog, 'America/La_Paz').options[0].timeZone).toBe('America/La_Paz');
    expect(searchTimeZones(catalog, 'UTC').options[0].timeZone).toBe('UTC');
  });

  it('filters zones unsupported by the current Intl runtime', () => {
    expect(catalog.entries.every(entry => validTimeZone(entry.option.timeZone))).toBe(true);
    expect(catalog.countries.every(country => country.options.every(option => validTimeZone(option.timeZone)))).toBe(true);
  });

  it('does not guess from unrecognized or incomplete input', () => {
    expect(searchTimeZones(catalog, '')).toEqual({ options: [], total: 0 });
    expect(searchTimeZones(catalog, 'L')).toEqual({ options: [], total: 0 });
    expect(searchTimeZones(catalog, 'Ciudad inventada xyz 2045')).toEqual({ options: [], total: 0 });
    expect(searchTimeZones(catalog, '<script>alert(1)</script>')).toEqual({ options: [], total: 0 });
  });

  it('bounds result output independently of arbitrary input length or invalid limits', () => {
    expect(searchTimeZones(catalog, 'Estados Unidos', { limit: -1 }).options).toHaveLength(1);
    expect(searchTimeZones(catalog, 'Estados Unidos', { limit: Number.NaN }).options).toHaveLength(12);
    expect(searchTimeZones(catalog, 'Estados Unidos', { limit: 100_000 }).options.length).toBeLessThanOrEqual(100);
  });
});

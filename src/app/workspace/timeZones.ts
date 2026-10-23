import { validTimeZone } from './CalendarTime';

export interface TimeZoneOption {
  id: string;
  timeZone: string;
  label: string;
  countryCode?: string;
  countryName?: string;
  city?: string;
}

interface SearchEntry {
  option: TimeZoneOption;
  names: string[];
  context: string;
}

interface CountryEntry {
  name: string;
  names: string[];
  options: TimeZoneOption[];
}

export interface TimeZoneCatalog {
  readonly countries: readonly CountryEntry[];
  readonly entries: readonly SearchEntry[];
}

export interface TimeZoneSearchResult {
  options: TimeZoneOption[];
  total: number;
  countryMatch?: { name: string; timeZoneCount: number };
}

/** Search labels and accents, never infer a location from an offset or language. */
function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const countryAliases: Record<string, string[]> = {
  US: ['USA', 'EEUU', 'EE UU', 'Estados Unidos de América', 'United States of America'],
  GB: ['UK', 'Reino Unido', 'United Kingdom', 'Gran Bretaña', 'Great Britain'],
  KR: ['Corea del Sur', 'South Korea'],
  KP: ['Corea del Norte', 'North Korea'],
};

let catalogPromise: Promise<TimeZoneCatalog> | undefined;

/** One lazy, local asset. Typing never sends country/city searches to a service. */
export function loadTimeZoneCatalog(): Promise<TimeZoneCatalog> {
  catalogPromise ??= import('./timeZonesCatalog')
    .then(({ default: data }) => {
      const spanish = new Intl.DisplayNames(['es'], { type: 'region' });
      const english = new Intl.DisplayNames(['en'], { type: 'region' });
      const countries = new Map<string, CountryEntry>();
      for (const [code, fallback] of data.countries) {
        const name = spanish.of(code) || fallback;
        countries.set(code, {
          name,
          names: [...new Set([code, name, english.of(code) || fallback, fallback, ...(countryAliases[code] || [])].map(normalize))],
          options: [],
        });
      }
      const supportedZones = new Map<string, boolean>();
      const isSupported = (zone: string) => {
        if (!supportedZones.has(zone)) supportedZones.set(zone, validTimeZone(zone));
        return supportedZones.get(zone);
      };
      const entries: SearchEntry[] = [];
      const zoneOptions: Array<TimeZoneOption | undefined> = [];
      for (const [countryCode, timeZone, city] of data.zones) {
        const country = countries.get(countryCode);
        if (!country || !isSupported(timeZone)) {
          zoneOptions.push(undefined);
          continue;
        }
        const option = { id: `zone:${countryCode}:${timeZone}`, timeZone, label: `${city} · ${country.name}`, countryCode, countryName: country.name, city };
        zoneOptions.push(option);
        if (!country.options.some(existing => existing.timeZone === timeZone)) country.options.push(option);
        entries.push({ option, names: [normalize(city), normalize(timeZone), normalize(timeZone.split('/').at(-1) || '')], context: country.names.join(' ') });
      }
      data.cities.split('\n').forEach((row, index) => {
        const [city, countryCode, zoneIndex, regionIndex, aliases] = row.split('\t');
        const zone = zoneOptions[Number(zoneIndex)];
        const country = countries.get(countryCode);
        if (!zone || !country) return;
        const region = regionIndex === '' ? '' : data.regions[Number(regionIndex)];
        const option = {
          id: `city:${index}`,
          timeZone: zone.timeZone,
          label: `${city} · ${region ? `${region}, ` : ''}${country.name}`,
          countryCode,
          countryName: country.name,
          city,
        };
        entries.push({
          option,
          names: [normalize(city), ...(aliases ? aliases.split('|') : [])],
          context: normalize(`${region} ${country.names.join(' ')} ${zone.timeZone}`),
        });
      });
      const utc = { id: 'zone:UTC', timeZone: 'UTC', label: 'Tiempo universal coordinado (UTC)', city: 'UTC' };
      entries.push({ option: utc, names: ['utc', 'tiempo universal coordinado', 'coordinated universal time'], context: '' });
      return { countries: [...countries.values()].filter(country => country.options.length > 0), entries };
    })
    .catch(error => {
      catalogPromise = undefined;
      throw error;
    });
  return catalogPromise;
}

/** Countries enumerate their zones; a city never silently chooses among homonyms. */
export function searchTimeZones(catalog: TimeZoneCatalog, query: string, { limit = 12 }: { limit?: number } = {}): TimeZoneSearchResult {
  const normalized = normalize(query);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 12;
  if (normalized.length < 2) return { options: [], total: 0 };
  const country = catalog.countries.find(entry => entry.names.includes(normalized));
  if (country)
    return {
      options: country.options.slice(0, safeLimit),
      total: country.options.length,
      countryMatch: { name: country.name, timeZoneCount: country.options.length },
    };
  const tokens = normalized.split(' ');
  const results: Array<{ option: TimeZoneOption; score: number; order: number }> = [];
  for (const [order, entry] of catalog.entries.entries()) {
    const exact = entry.names.includes(normalized);
    const prefix = entry.names.some(name => name.startsWith(normalized));
    const text = `${entry.names.join(' ')} ${entry.context}`;
    if (!exact && !prefix && !tokens.every(token => text.includes(token))) continue;
    results.push({ option: entry.option, score: exact ? 0 : prefix ? 1 : 2, order });
  }
  // Country prefixes remain useful before the user has typed the full name.
  for (const candidate of catalog.countries) {
    if (!candidate.names.some(name => name.startsWith(normalized))) continue;
    for (const option of candidate.options) if (!results.some(result => result.option.id === option.id)) results.push({ option, score: 1, order: -1 });
  }
  results.sort((a, b) => a.score - b.score || a.order - b.order);
  return { options: results.slice(0, safeLimit).map(result => result.option), total: results.length };
}

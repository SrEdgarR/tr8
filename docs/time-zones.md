# Time-zone place search

TR8 ships an offline country/city search catalog as a separate dynamic-import
asset. Loading the calendar's time-zone picker downloads this local static asset;
searches never call a geocoder, request location permission, or send city names
to another service. There are no API keys, paid services or new dependencies.

The generated snapshot contains **34,179 cities** and **425 country/zone pairs**.
Its source is approximately 1.10 MB, approximately **338 KB gzip**, outside the
initial application bundle. Unsupported zones are excluded using the browser's
`Intl.DateTimeFormat`; dates, offsets and daylight-saving rules use that same
runtime, rather than a fixed offset copied from the catalog.

Country names are localized with `Intl.DisplayNames` in Spanish and English.
Matching ignores case and accents. A country lists its IANA zones, never just the
capital's zone; a city result includes region/country to distinguish homonyms.
The catalog enumerates zones with different histories, even if their clocks
currently agree. An explicit result selection is required for place input.
Exact supported IANA identifiers remain available for smaller places not covered
by this city extract.

## Data provenance and attribution

- **GeoNames**: city names, up to two bounded Latin alternate names for large
  cities, first-level administrative region names and IANA zone assignments,
  derived from [cities15000.zip](https://download.geonames.org/export/dump/cities15000.zip)
  and [admin1CodesASCII.txt](https://download.geonames.org/export/dump/admin1CodesASCII.txt),
  downloaded on 2026-10-23. The extract includes places with population over 15,000
  and capitals; it is not an exhaustive worldwide geocoder. Modified/compacted
  for TR8, with coordinates, population, elevation and unrelated attributes
  removed. Data by [GeoNames](https://www.geonames.org/), licensed under
  [Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
  See the [source field documentation and license](https://download.geonames.org/export/dump/readme.txt).
- **IANA Time Zone Database 2026e**: country-to-zone associations and country
  fallback names from [zone.tab](https://data.iana.org/time-zones/tzdb-2026e/zone.tab)
  and [iso3166.tab](https://data.iana.org/time-zones/tzdb-2026e/iso3166.tab).
  These tables are in the public domain. `zone.tab` is used specifically for its
  one-country-per-row associations, preserving separate selectable zones for
  countries that share a representative zone in `zone1970.tab`. It is not used
  for clock calculations or to take a position on territorial claims.
  GeoNames' `XK` records for Kosovo are retained with their source zone assignment,
  although this user-assigned code is absent from IANA's ISO country table.
- **Unicode CLDR**: Spanish exemplar city labels, extracted from
  [timeZoneNames.json](https://github.com/unicode-org/cldr-json/blob/91c267402229a59e3ef2774544f001bf959e8809/cldr-json/cldr-dates-full/main/es/timeZoneNames.json)
  at commit `91c267402229a59e3ef2774544f001bf959e8809`.
  Copyright © 1991–2026 Unicode, Inc.; [Unicode License V3](../scripts/timezones/UNICODE-LICENSE.txt).

GeoNames data is supplied as is, without a guarantee of accuracy or completeness.
The result's IANA identifier and live clock preview let users verify the choice.
Country/city input is a search hint; it does not establish the user's location.

## Regeneration

Use Node.js 22.12+ and a temporary directory outside the repository. Download the
five source files above, unzip `cities15000.zip` to obtain `cities15000.txt`, and
save the CLDR source as `timeZoneNames-es.json`. Then run:

```powershell
node scripts/timezones/build-catalog.mjs --source-dir C:\path\to\source-extracts
node node_modules/vitest/vitest.mjs run src/app/workspace/timeZones.test.ts
```

The deterministic generator writes `src/app/workspace/timeZonesCatalog.ts` and
prints source SHA-256 hashes and compressed sizes. The generated artifact embeds
the hashes of the exact input snapshot. GeoNames daily extracts change in place;
retain those exact input files privately to reproduce an older snapshot, or
review the updated data/hashes/size when regenerating from a newer extract. No
source ZIP or raw extract should be committed. Update this document's snapshot
date, counts and CLDR/IANA version when refreshing the dataset.

Generated entries are grouped by country and zone for compression; cities within
each zone retain population order. Runtime search does not silently choose the
most populous homonym. The generated artifact is marked `prettier-ignore` so
formatting cannot expand the offline index into a much larger source file.

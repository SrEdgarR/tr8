import type { CurrencyDefinition } from './types';

// DEC-038. A catalog revision is part of the encrypted domain, never a global currency.
export const CURRENCY_CATALOG_VERSION = 'currency-catalog-v1';
export const CURRENCY_CATALOG: readonly CurrencyDefinition[] = Object.freeze([
  Object.freeze({ code: 'DOP', minorUnitDigits: 2 }),
  Object.freeze({ code: 'USD', minorUnitDigits: 2 }),
  Object.freeze({ code: 'EUR', minorUnitDigits: 2 }),
  Object.freeze({ code: 'BOB', minorUnitDigits: 2 }),
]);

export function catalogDefinitions(version: string): readonly CurrencyDefinition[] {
  if (version === CURRENCY_CATALOG_VERSION) return CURRENCY_CATALOG;
  // Preserve the exact interpretation of the provisional P5-A catalog.
  if (version === 'pulso-currencies-v1') return [{ code: 'DOP', minorUnitDigits: 2 }];
  // Keep the explicit TEST ONLY P3 catalog readable during local schema migration.
  if (version === 'pulso-p3-fixture-currencies-v1')
    return [
      { code: 'DOP', minorUnitDigits: 2 },
      { code: 'USD', minorUnitDigits: 2 },
    ];
  throw new Error('La versión del catálogo de monedas no es compatible.');
}

export function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error('La información financiera no es válida.');
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key)))
    throw new Error('Hay campos financieros desconocidos o incompletos.');
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('La información financiera no es válida.');
  }
  return value as Record<string, unknown>;
}

export function financialText(value: unknown, maximumBytes = 1024, empty = false): string {
  if (
    typeof value !== 'string' ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) ||
    (!empty && !value.trim()) ||
    new TextEncoder().encode(value).length > maximumBytes
  )
    throw new Error('El texto financiero no es válido o es demasiado largo.');
  return value;
}

export function collection(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1)
    throw new Error('La colección financiera no es válida o supera el límite.');
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i) || !('value' in Object.getOwnPropertyDescriptor(value, String(i))!)) throw new Error('La colección financiera no es válida.');
  }
  return value;
}

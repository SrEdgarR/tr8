export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'No se pudo completar la operación. Inténtalo de nuevo.';
}

export function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export class DataError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DataError';
  }
}

export function dataError(cause: unknown): DataError {
  if (cause instanceof DataError) return cause;
  const record = typeof cause === 'object' && cause !== null ? (cause as Record<string, unknown>) : {};
  const code = typeof record.code === 'string' ? record.code : undefined;
  const message = typeof record.message === 'string' ? record.message : String(cause);
  if (code === 'PT422' && message === 'Task comments must be removed before moving this task')
    return new DataError(
      'Esta tarea tiene una conversación. Para proteger su privacidad, no se puede trasladar a otro proyecto. Puedes duplicarla sin copiar los comentarios.',
      code,
    );
  if (code === 'PT422')
    return new DataError(
      'Retira los archivos y las cargas pendientes desde Archivos antes de eliminar este proyecto. También puedes archivarlo para conservarlos.',
      code,
    );
  if (code === 'PT409')
    return new DataError(
      'Este registro cambió en otra pestaña o dispositivo. Se han actualizado los datos; revisa los cambios antes de volver a guardar.',
      code,
    );
  if (code === 'PT404' || code === 'PGRST116') return new DataError('El registro ya no existe o no tienes acceso. Actualiza la página.', code);
  if (code === '42501' || code === 'PGRST301' || code === 'PGRST303')
    return new DataError('La sesión no tiene permiso para acceder a estos datos. Comprueba tu cuenta e inicia sesión otra vez.', code);
  if (code === '55000') return new DataError('Restaura el proyecto archivado antes de editar sus tareas.', code);
  if (code === '23503') return new DataError('El proyecto ya no está disponible para esta tarea. Actualiza los datos.', code);
  if (code === '23505') return new DataError('Ya existe un registro con esa referencia. Actualiza los datos y vuelve a intentarlo.', code);
  if (code === '23514' || code === '22023' || code === '22P02')
    return new DataError('Revisa los campos: el título, las fechas o el estado no son válidos.', code);
  if (code === 'PGRST205' || code === 'PGRST202') return new DataError('La base de datos aún no está preparada para esta versión de la aplicación.', code);
  if (/fetch|network|load failed|connection|timeout|aborted/i.test(message))
    return new DataError(
      'No se pudo confirmar la operación por un problema de conexión. Conservamos el formulario: comprueba la conexión y vuelve a intentarlo.',
      code,
    );
  return new DataError('No se pudo completar la operación. Tus cambios no se han confirmado; vuelve a intentarlo.', code);
}

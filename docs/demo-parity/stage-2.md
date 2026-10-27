# Inicio y resúmenes — etapa 2

Referencia: [demo original de Gr8r Studio](https://gr8r-taskmanagement.vercel.app/).
La entrega recupera Inicio, Vista general, resumen de proyecto y resumen de equipo
con los datos reales autorizados de TR8. Conserva la identidad visual de etapa 1.

## Pantallas

- **Inicio:** saludo y fecha local; indicadores de proyectos activos, tareas
  abiertas, completadas y vencidas; tareas personales por pestañas; tabla de
  progreso; vencimientos de hoy, mañana y próximos siete días; actividad reciente.
- **Vista general:** cartera de proyectos con estado, progreso, tareas abiertas y
  vencidas, próximo vencimiento de tarea, distribución por estado y carga visible
  por responsable en equipos.
- **Proyecto → Resumen:** descripción, progreso, estados, tareas pendientes con
  fecha, detalles reales, carga por responsable y actividad reciente autorizada.
  Lista, tablero, calendario, actividad y configuración siguen disponibles.
- **Equipo:** resumen de proyectos, tareas, progreso y carga, antes de la
  administración existente de miembros, roles e invitaciones.
- Los indicadores enlazan con listas filtradas por abiertas, completadas,
  vencidas o asignadas a mí. Cada enlace conserva el espacio seleccionado.

## Alcance de los datos

`dashboard-model.ts` deriva los resúmenes del mismo snapshot paginado que usa TR8.
Filtra proyectos del espacio actual, permisos de lectura, archivos y tareas sin
proyecto visible. Un proyecto visible sin permiso para sus tareas muestra
indisponibilidad, no un progreso inventado. Los resúmenes generales excluyen
proyectos archivados; el resumen individual puede consultar uno archivado en
modo de lectura, conservando su acceso vigente.

En el espacio personal, Mis tareas incluye sus tareas visibles. En equipos usa
la identidad `member.user_id === currentUserId` y filtra por su ID de miembro.
Sin directorio autorizado no atribuye tareas a otra persona. Nombres y avatares
proceden del directorio existente; carga, fallo o revocación retiran los nombres
anteriores. La carga cuenta solo tareas abiertas visibles y distingue tareas sin
responsable. No representa acceso al proyecto ni carga global del equipo.

La actividad conserva `audit.read` y el contexto vigente del proyecto/espacio.
La variante compacta muestra seis entradas, comparte la consulta existente y
enlaza con el historial completo. No crea notificaciones ni envía correos.

No existe una fecha exacta de finalización de tarea: se muestra **el total actual
completado**, sin afirmar «completadas esta semana». Las fechas de proyecto son
creación y actualización; el vencimiento derivado se identifica como **fecha de
una tarea**, nunca fecha objetivo del proyecto. Hitos, líder, fechas propias,
Timeline y dependencias pertenecen a etapas posteriores y no se simulan.

## Verificación y publicación

- 825 pruebas de aplicación y 560 de servidor, Edge y MCP aprobadas.
- 38 casos nuevos: cálculos y fechas civiles; aislamiento por espacio/proyecto;
  lectura parcial y revocación; directorio fallido; identidad personal; enlaces,
  filtros, actualización del snapshot y navegación sin acumulación.
- TypeScript, ESLint, formato y compilación de producción.
- Ensayo visual aislado con datos ficticios en memoria: Inicio, Vista general,
  proyecto y equipo, actualización de indicadores al completar una tarea,
  escritorio y móvil a 390 × 844. No usa Supabase ni guarda fixtures en producción.
- Verificación productiva de los paneles y de Finanzas, comparación de hashes de
  proyectos, tareas, espacios y documentos financieros y comprobación de altas
  externas cerradas.

Esta entrega no cambia el esquema, RLS, RPCs, claves, configuraciones de Auth,
integraciones ni planes. No añade dependencias, consultas al directorio, procesos
programados, proveedores o servicios. Mantiene Supabase Free y Vercel Hobby.

La reversión del cliente es compatible con el esquema existente: no necesita
restaurar ni eliminar datos. La etapa siguiente acordada es productividad y
vistas: separación de Mis tareas/Tareas, favoritos, tabla y vistas configurables.

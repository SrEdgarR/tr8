# Etapa 3 · Calendario interno

Estado: implementación y pruebas aisladas completadas; verificación visual y publicación pendientes. Se mantienen Supabase Free, Vercel Hobby y las altas e invitaciones externas desactivadas.

## Funciones

- Calendario general de los espacios autorizados y pestaña de calendario dentro de cada proyecto. Vistas de mes y agenda, con navegación por meses, regreso a hoy y consulta paginada.
- Filtros de espacio, proyecto, estado, responsable, «Mías» e inclusión de proyectos archivados. El calendario interno muestra todas las tareas autorizadas; «Mías» es opcional.
- Vencimientos de día completo y bloques horarios independientes. Una tarea puede generar dos elementos distinguibles, sin duplicar la tarea. La fecha de inicio se muestra únicamente si no hay vencimiento ni bloque. Las tareas sin ninguna fecha aparecen en «Sin programar».
- Preferencia personal de zona horaria IANA, inicialmente vacía y confirmada explícitamente. El cambio de visualización conserva los instantes de los bloques y las fechas civiles de vencimiento.
- Programación en el detalle de una tarea existente, guardada por separado del contenido y del responsable. Se puede crear, mover conservando la duración, editar o quitar un bloque. El vencimiento se modifica en su campo habitual.

La primera versión ofrece al crear una tarea la indicación de programarla después de guardarla. No simula un guardado atómico mediante dos solicitudes. Las opciones de proyectos y responsables del calendario general describen su alcance: proyectos del espacio abierto y elementos cargados; la navegación por espacios y proyectos permite abrir otro conjunto. «Cargar más» amplía las páginas disponibles.

No se conectan Google, correo, procesos en segundo plano ni Pulso. No se habilitan cuentas externas ni se crean colaboradores reales.

## Fechas y permisos

`start_date` y `due_date` conservan su contrato anterior como fechas civiles `YYYY-MM-DD`. No se convierten a UTC ni se desplazan al cambiar de zona. El bloque añade `scheduled_start_at`, `scheduled_end_at` y `scheduled_time_zone`: tres valores completos o tres nulos, con fin posterior al inicio.

Los instantes se reciben como texto RFC3339 con desplazamiento explícito; PostgREST no interpreta una hora local sin zona antes de autorizar la operación. Se almacenan como `timestamptz`, con una zona IANA separada y precisión de hasta seis decimales. El cliente conserva los instantes originales al cambiar solo la zona y utiliza microsegundos enteros para mover un bloque sin perder duración.

La edición de hora local rechaza horas inexistentes por cambio estacional y pide elegir el desplazamiento si hay dos instantes posibles. Los días y meses civiles se calculan mediante operaciones de calendario, no sumando 24 horas a un instante local. El fin de un bloque y de una ventana es exclusivo.

Programar requiere identidad habilitada, membresía activa, `project.read`, `task.read`, `task.edit`, acceso `write`, proyecto no archivado y versión esperada. La base de datos aplica los mismos bloqueos y reglas de autorización de las etapas anteriores. La programación genera actividad `task.scheduled`; las funciones anteriores conservan el bloque al editar contenido, asignar responsables o limpiar responsabilidades tras una revocación.

El servidor comprueba autorización en cada página y guardado. La interfaz vuelve a consultar cada 30 segundos y al actualizar; no promete expulsión visual instantánea mediante push. Un fallo de acceso oculta los elementos anteriores, cancela el ámbito viejo y permite comprobar el acceso de nuevo sin bloquear innecesariamente el espacio personal por una pérdida de acceso en otro equipo.

## Contrato público

| RPC `tr8_v2_*`             | Entrada y resultado                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `get_calendar_preferences` | Sin destinatario arbitrario; devuelve la zona, versión y tiempo del actor                  |
| `set_calendar_preferences` | `p_version`, `p_time_zone`; confirma preferencia propia y nueva versión                    |
| `schedule_task`            | Espacio, tarea, versión y triple RFC3339/IANA o nulo; devuelve la tarea persistida         |
| `list_calendar`            | Espacios explícitos, rango civil, zona, filtros y cursor; devuelve `items` y `next_cursor` |
| `list_unscheduled`         | Mismos ámbitos y filtros, sin rango ni zona; tareas sin fecha ni bloque                    |

Se admiten entre 1 y 50 espacios explícitos por consulta, hasta 250 proyectos o responsables en filtros, ventanas de hasta 93 días y páginas de hasta 250 elementos (la interfaz solicita 100). Si un espacio solicitado no está autorizado, la solicitud falla cerrada. Los filtros de proyectos invisibles no revelan su existencia.

La salida es una proyección mínima: tarea y versión, título, estado, prioridad, fechas, proyecto y espacio autorizados, responsable visible y capacidad de edición. No descarga descripciones completas ni datos financieros. Para abrir o reprogramar, se navega al detalle autorizado de la tarea en su espacio.

Los elementos usan `(task_id, kind)` y orden estable por comienzo local, UUID y tipo. Los cursores incluyen un ámbito normalizado de filtros, zona y ventana; no conceden acceso y no prometen un snapshot común entre páginas. Los bloques se seleccionan por solapamiento de instantes; las fechas se comparan directamente con el rango civil.

Los wrappers públicos son `SECURITY INVOKER`; la autoridad reside en funciones privadas con `search_path` fijo, actor vigente y grants explícitos. Las tablas siguen sin escritura directa desde clientes.

## Migración, comprobación y recuperación

La migración aditiva `20261023174407_calendar_internal_stage3.sql` conserva las firmas y definiciones anteriores, OIDs, secuencia y todos los campos históricos. Las tareas existentes comienzan sin bloque y las cuentas sin preferencia de zona; no se reinterpretan fechas ni se programa contenido automáticamente.

Antes de producción se exige copia privada actual y ensayo de restauración. `scripts/stage3/build-restore-rehearsal.mjs` restaura contenido, responsables y metadatos en el entorno sintético designado, compara cada campo, ejecuta la migración y termina con `ROLLBACK`. La secuencia exportada se prueba en una secuencia temporal; no se rebobina la del entorno de prueba.

La copia no contiene contraseñas, sesiones ni claves privilegiadas. No sustituye una copia completa de Auth ni PITR. Una vuelta al cliente de etapa 2 conserva compatibilidad con el esquema ampliado; no exige eliminar los campos nuevos ni restaurar políticas antiguas. Restaurar contenido después de escrituras nuevas requiere reconciliar los cambios posteriores al respaldo.

## Registro de pruebas · 23 de octubre de 2026

- Base de código: `28575a589fae5de8a7064dac09eb8da7c9da2e54`. Copia nueva privada de un proyecto, una tarea, identidad mínima y 12 tablas privadas; secuencia 274, `is_called=true`.
- Restauración de esa copia y migración ensayadas con rollback. Comparación campo por campo aprobada, sin residuos de la cuenta real en prueba.
- SQL: 125 aserciones nuevas, 176 de etapa 1 y 113 de etapa 2, todas aprobadas. La migración está instalada en `tr8-test`; las migraciones aplicadas no se reescriben.
- HTTP real en prueba: 324 aserciones en 203 solicitudes, con Auth y clave pública. Cubiertos cursores, espacios múltiples, fechas civiles, DST, permisos, archivos, limpieza de responsables y revocación con el JWT anterior. Una programación simultánea ganó y otra recibió `PT409`. Se restauraron los roles de los participantes sintéticos.
- Aplicación: 165 pruebas aprobadas, TypeScript, ESLint, Prettier, comprobación estática y build. Sin dependencias nuevas; permanece el aviso previo del bundler sobre el tamaño de JavaScript.
- Revisión independiente: 85 pruebas focales aprobadas y sin bloqueantes de seguridad abiertos. Se verificaron borradores y conflictos remotos antes y después de guardar el bloque, así como la retirada de elementos de otros espacios al perder permisos.
- Advisors de prueba: sin nuevas advertencias de esquema, permisos o rendimiento. Continúa la advertencia previa de protección de contraseñas filtradas que exige Pro; se mantiene Free.

La prueba visual y la comprobación final de producción se registrarán antes del cierre de la entrega.

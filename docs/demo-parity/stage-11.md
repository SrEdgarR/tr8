# Tareas recurrentes — etapa 11

En el detalle de una tarea pendiente con vencimiento, «Configurar repetición»
permite elegir frecuencia diaria, semanal o mensual, intervalo, zona horaria y
una fecha final opcional. La regla semanal permite varios días. El panel muestra
las próximas fechas estimadas y admite pausar o editar la ocurrencia actual.
Las anteriores permanecen como historial de la serie.

## Fechas y generación

La decisión del propietario es crear la siguiente al completar la actual.
No se generan pendientes por reloj ni se acumula una lista de fechas atrasadas.
Se busca una fecha estrictamente posterior a la ocurrencia actual y al día de
finalización en la zona elegida, respetando el intervalo original.

El día original se conserva en las reglas mensuales: 31 de enero pasa al último
día de febrero y vuelve al 31 en marzo. La fecha final es inclusiva. Las reglas
diarias admiten intervalos de 1–365 días, las semanales 1–52 semanas y las
mensuales 1–12 meses. Las fechas son civiles y no se desplazan por cambios de
horario de verano.

La primera entrega copia título, descripción, prioridad, etiquetas, estimación
y subtareas con casillas restablecidas. Conserva el desplazamiento válido de la
fecha inicial respecto al vencimiento. No copia bloques horarios, comentarios,
archivos ni dependencias. Solo las tareas materializadas aparecen en calendario.
Duplicar una tarea no duplica su regla de repetición.

Un trigger común cubre las finalizaciones individuales, masivas, de MCP y del
trabajador entrante de Google Tasks. La inserción del sucesor participa en la
misma transacción y pasa por los mecanismos existentes de notificaciones y
sincronización. Su envío a Google conserva las opciones y el alcance que cada
usuario ya habilitó; no amplía OAuth ni exporta el historial completo.

## Permisos, pausas y conflictos

Configurar requiere editar y crear tareas en ese proyecto. La generación vuelve
a comprobar los permisos actuales del autor de la regla: una persona con permiso
para completar no recibe permiso adicional para crear. Si el autor pierde acceso
o capacidad de creación, la finalización se conserva y la serie queda «Por revisar».
Un editor con capacidad de crear puede guardar explícitamente la regla para
reactivarla. El responsable solo se hereda si el autor puede asignar y el miembro
sigue siendo elegible; en otro caso el sucesor queda sin responsable.

Archivar la tarea o el proyecto pausa la serie. Restaurarlos no la reactiva.
Trasladar la ocurrencia actual también la pausa; su regla anterior no se expone
en el destino. En esta entrega no se reasocia esa identidad: para iniciar una
serie en el destino se usa una tarea nueva o duplicada.

Los guardados usan versiones esperadas de tarea y serie, identidad de creación
de la tarea y UUID de solicitud. Un reintento conserva la solicitud exacta;
un conflicto exige revisar los datos y no sustituye un borrador silenciosamente.
Los recibos se retienen siete días con limpieza oportunista, hasta 1.000 por
pasada; hay un máximo de 1.000 solicitudes nuevas por usuario/espacio en 24 horas.

Un registro durable de ocurrencias identifica UUID y fecha de creación. Reabrir,
recompletar o borrar la siguiente no genera otra copia. Las filas del registro no
dependen de que siga existiendo la tarea; borrar una tarea no habilita recrearla.
Una serie finalizada no vuelve a empezar sobre su última ocurrencia.

## Persistencia y alcance

La migración añade tres tablas privadas —series, ocurrencias y recibos— y una
RPC de configuración para sesiones vigentes de navegador. Usa RLS y deniega el
acceso directo a las tablas. No cambia columnas, valores ni versiones de las
tareas existentes. La metadata visual se combina en el cliente y no altera los
contratos de tareas de Google o MCP. El MCP actual puede completar tareas con
regla, pero no ofrece todavía herramientas para configurar recurrencia.

La caché se separa por cuenta, espacio y revisión de permisos. Un fallo de los
indicadores no oculta el trabajo existente; un acceso revocado retira los datos
sensibles. Configurar repetición no descarta el borrador de etiquetas o subtareas
del detalle.

No se añade cron, proveedor, dependencia ni suscripción. Se mantienen los planes
gratuitos, el registro público cerrado y las altas e invitaciones externas
desactivadas.

## Verificación

Las pruebas SQL cubren 79 condiciones con fixtures y rollback: fechas, mes
corto, autoridad actual, responsable, pausas, archivo, traslado, versiones,
reintentos, sesiones, reapertura, eliminación y finalización desde bulk/Google.
Las pruebas de repositorio y componentes verifican DTO estrictos, paginación,
cancelación, permisos, borradores, resultados tardíos y controles de repetición.

El ensayo HTTP real en TEST pasó 59 comprobaciones: preparación, contrato del
repositorio, configuración diaria/semanal/mensual, finalización, resultados
perdidos, concurrencia, reapertura, sucesor eliminado, UUID reutilizado,
acciones masivas y retirada de permisos. Se eliminaron exactamente los fixtures;
las huellas de proyectos, tareas, espacios, usuarios, finanzas, configuración y
conexiones Google quedaron iguales a las anteriores al ensayo.

La migración `20261029142332_recurring_tasks_stage11.sql` se aplicó con el mismo
contenido en TEST y producción. SHA256:
`E9A3D21E6B01B6C89BC2BF0DF4379BA3B28D85114E55E9A4BD543101474935EF`.
El timestamp local y el historial de TEST se alinearon con la identidad
productiva sin cambiar el SQL aplicado. La comparación inmediata anterior y
posterior confirmó los mismos proyectos, tareas, finanzas y espacios de
producción, con las invitaciones externas desactivadas.

La regresión local pasó 1.465 pruebas de aplicación y 560 de servidor/Edge/MCP,
los cuatro ámbitos de TypeScript, ESLint, Prettier, la comprobación estática y
la compilación de producción. El asesor de seguridad no añade advertencias;
las tres tablas privadas muestran el INFO esperado de RLS sin políticas de
acceso directo. El aviso previo de contraseñas filtradas permanece sin cambios.

La revisión en navegador sobre el harness local sintético verificó edición,
días semanales, vista previa, guardado, pausa y reactivación, además del editor
dentro del detalle real de tareas. Permitió corregir el solapamiento de iconos
y valores. El harness guarda solo en memoria; esta revisión visual no modificó
datos de producción ni creó tareas en las cuentas Google reales.

# Acciones masivas de tareas — etapa 10

Lista y Tabla permiten seleccionar tareas y cambiar su estado, prioridad o
responsable, archivarlas o eliminarlas. Funciona en un proyecto, Tareas y Mis
tareas, con los mismos datos y permisos actuales. El tablero conserva sus
operaciones individuales.

## Selección y confirmación

Las casillas permiten seleccionar hasta 50 tareas. «Seleccionar tareas visibles»
abarca únicamente las filas que pasan los filtros y pertenecen a grupos
desplegados. Si hay más de 50, se indican las primeras 50 seleccionadas. El
estado intermedio de la casilla y la selección con teclado son accesibles.

Cambiar filtros, agrupación, vista guardada, vista, proyecto o ámbito de permisos
retira la selección. Si se actualiza una versión seleccionada, se pide revisar
la selección antes de enviar; no se sustituye silenciosamente la versión esperada.
Mientras se aplica un lote o queda un resultado incierto se bloquean las acciones
que podrían preparar otro lote en esa vista.

«Revisar acción» abre un diálogo con el valor elegido y las tareas exactas,
proyectos y versiones. Todas las acciones requieren confirmación; eliminar
además exige escribir `ELIMINAR N`, con la cantidad concreta. Solo se eliminan
las tareas elegidas y los datos asociados que ya elimina la operación individual,
incluida su conversación. Archivar conserva su contenido para restaurarlo.

## Permisos y resultados

Estado, prioridad y archivo requieren `task.edit`; asignar requiere `task.assign`
y eliminar `task.delete`. Los permisos son independientes. La interfaz comprueba
solo lectura, espacio, acceso y archivo de proyecto/tarea. El servidor vuelve a
validarlos por elemento. Un miembro activo en el directorio no basta como
responsable: debe poder leer ese proyecto y sus tareas.

Cada lote es una sola RPC, no una secuencia de peticiones del navegador. Se
capturan ID de tarea, ID de proyecto y versión. Una tarea trasladada no se modifica
en su nuevo proyecto a partir de una selección antigua. Se bloquean los proyectos
y tareas en un orden consistente y se conserva la serialización con la revocación
de permisos.

La respuesta muestra «Aplicada» o el motivo seguro del rechazo para cada tarea.
Una tarea sin acceso y una inexistente comparten el mismo resultado. Un conflicto
no sobrescribe otra versión. Los rechazos esperados pueden producir resultados
parciales; un fallo inesperado aborta la transacción completa. No se presenta el
lote como una operación de todo o nada ante rechazos individuales.

La actualización posterior conserva los resultados aunque archivar, eliminar o
cambiar un estado retire todas las filas de la vista. El snapshot y las cachés de
productividad, conversación, planificación, búsqueda, calendario y procesos se
actualizan. No se cambian otras tareas para reconstruir la vista.

## Reintentos y presupuesto

La solicitud congela UUID, fecha, acción, valores y versiones. Tras un error de
transporte o una respuesta inválida puede existir un guardado confirmado en el
servidor. «Reintentar el mismo lote» utiliza exactamente la misma solicitud, sin
reintentos automáticos. Escape permite posponer esa comprobación; el aviso
«Retomar comprobación» conserva el lote en memoria mientras permanezca esa vista.
No se guarda el contenido de la selección en almacenamiento persistente.

El servidor conserva recibos privados mínimos con hash y resultados por ID, sin
títulos ni descripciones. Un recibo no concede acceso: cada replay comprueba los
permisos actuales. Reutilizar una identidad con otros datos se rechaza. Las nuevas
solicitudes y reintentos caducan a las 24 horas, con cinco minutos de tolerancia
para un reloj adelantado. Después hay que consultar los datos y confirmar un
nuevo plan; un UUID de tarea reutilizado no habilita un replay antiguo.

Los recibos se retienen siete días y se limpian oportunistamente por actor/espacio,
en grupos de hasta 1.000, sin añadir cron. Hay un máximo móvil de 1.000 solicitudes
nuevas por actor/espacio en 24 horas, comprobado antes de mutar. Los replays
reconocidos no consumen ni quedan bloqueados por ese límite. No hay un tope
vitalicio. La tabla es privada, con RLS y sin acceso directo de clientes.

Se reutilizan las mutaciones existentes, su auditoría, notificaciones y trabajos
Google. La prioridad sigue siendo un campo de TR8; no se anuncia como campo
sincronizado con Google Tasks. La RPC nueva solo admite sesiones de navegador
vigentes; no amplía los permisos ni las herramientas del MCP.

## Migración y verificación

La migración `20261028180434_bulk_tasks_stage10.sql` añade una tabla privada y
funciones nuevas; no modifica los proyectos, tareas ni finanzas existentes.
Su SHA256 es `B9D62421EAABF14EB9E110105B4CA1FF5E2372199A324FB6BF490A14A0316C44`.
Se aplicó el mismo SQL en TEST y producción y se alineó su identidad de historial
con la revisión productiva, conservando los bytes y las migraciones anteriores.

Las pruebas SQL nuevas verifican 86 condiciones con fixtures y rollback. El
ensayo HTTP real añade cuatro comprobaciones de preparación y 34 de contrato y
persistencia, incluidas solicitudes simultáneas idénticas, confirmación perdida,
resultados parciales, roles de solo asignación, archivo, eliminación, permisos
retirados y sesión terminada. Al terminar se retiraron las identidades, sesiones,
espacios, tareas y trabajos ficticios. Las huellas y recuentos de datos ajenos y
la configuración de TEST quedaron iguales.

Las pruebas de componentes cubren el límite, filas visibles, agrupación,
selección con teclado, versiones nuevas, permisos, solo lectura, cambio de ámbito,
confirmación, resultados parciales, StrictMode y el refresco que vacía la vista.
El repositorio rechaza entradas y respuestas incoherentes sin declarar éxitos.
La regresión completa y CI verifican además las funciones anteriores.

La regresión local final comprueba 1.384 pruebas de aplicación y 560 de
servidor/Edge/MCP. También pasan los cuatro ámbitos de TypeScript, ESLint, formato,
comprobación estática de migración y compilación de producción. El aviso previo
de Supabase sobre protección de contraseñas filtradas no cambia con esta entrega;
la nueva tabla mantiene su acceso directo denegado y RLS activo.

Se mantienen Supabase Free, Vercel Hobby, Finanzas y las altas e invitaciones
externas cerradas. No se añaden dependencias ni proveedores. La publicación
compara las huellas de proyectos, tareas, espacios y finanzas.

El recorrido visual manual en escritorio/móvil sigue sujeto a la disponibilidad
del navegador. Las pruebas de DOM, SQL y HTTP no se presentan como revisión
visual completa ni como una prueba sobre las tareas reales del propietario.

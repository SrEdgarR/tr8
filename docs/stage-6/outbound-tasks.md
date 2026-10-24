# Etapa 6b · Tareas nuevas de TR8 en Google Tasks

## Comportamiento

La conexión Google sigue siendo única para Calendar y Tasks. La opción de enviar
tareas nuevas tiene una lista de destino seleccionada y una fecha de activación.
Las tareas existentes conservan sus identificadores, proyectos y contenido; no
hay una copia masiva al activar la opción. Una sola lista seleccionada se ofrece
como destino; si hay varias, el usuario debe elegir una.

Se envían las nuevas tareas personales y las nuevas tareas de equipos asignadas
al usuario conectado, con acceso vigente al proyecto. La tarea permanece en su
proyecto original de TR8 cuando vuelve a observarse desde Google. Las tareas
creadas primero en Google continúan entrando en el proyecto personal Google Tasks.
Cambiar de lista de destino solo afecta a creaciones posteriores.

Se sincronizan título, día planificado (`start_date`) y completado. Google Tasks
solo representa pendiente/completada: los estados intermedios de TR8 se conservan
mientras Google siga indicando pendiente. No se envían descripciones, datos
financieros, vencimientos ni bloques horarios. La API de Tasks no permite leer o
escribir la hora del teléfono. Las notas de Google permanecen independientes,
salvo un marcador opaco de vinculación que TR8 añade al crear su propia tarea.

Una tarea vinculada a Tasks no genera además un evento en el calendario Google
TR8. Las tareas anteriores que ya usaban Calendar conservan su comportamiento.
Pausar o desactivar nuevas exportaciones conserva los vínculos ya establecidos;
desconectar Google detiene ambas integraciones.

## Identidad y recuperación

Google Tasks crea el ID remoto al recibir `tasks.insert`; ese método no ofrece un
parámetro documentado de idempotencia. Por eso, una restricción local o repetir
un POST tras un timeout no bastaría para garantizar que no aparezcan duplicados.

Antes de enviar un POST, una transacción registra el vínculo, su marcador único,
la proyección que se pretende enviar y un trabajo durable. El trabajador reserva
presupuesto y comprueba la concesión, el acceso y la revisión. Justo antes del
HTTP, persiste que el resultado puede ser incierto. Solo entonces realiza un
intento de creación.

La respuesta válida adjunta el ID de Google al mismo vínculo. Si se pierde la
respuesta, las siguientes ejecuciones recorren la lista por páginas y buscan el
marcador. Una coincidencia recupera la identidad; una ausencia o varias
coincidencias dejan el caso pendiente de revisión. Nunca se repite la creación a
ciegas. La importación habitual reconoce el marcador y evita crear otra tarea
local durante la recuperación. El título no se utiliza como identidad.

Los cambios locales ocurridos durante el POST se sincronizan después de adjuntar
el ID; una eliminación o pérdida de acceso solicita la limpieza de la copia
conocida. Los trabajos vencidos no pueden confirmar escrituras de una concesión
nueva. Se conservan identidades eliminadas para impedir resurrecciones al releer
páginas antiguas. Las ediciones usan `If-Match` y mantienen la revisión explícita
de conflictos cuando ambas aplicaciones cambiaron datos incompatibles.

## Permisos y presupuesto

Se reutiliza el permiso Tasks ya concedido y su credencial cifrada de servidor.
Los clientes no reciben tokens de Google ni acceso directo al esquema privado.
Las modificaciones recibidas desde Google vuelven a comprobar los permisos del
usuario para editar o eliminar la tarea del proyecto de origen.

Los trabajos usan las colas y el presupuesto existentes: 500 solicitudes al día y
10 000 al mes como límites de la aplicación compartidos con Calendar. Las lecturas
periódicas siguen cada 15 minutos; la sincronización manual solicita una revisión
sin prometer una respuesta instantánea de Google. No se añaden servicios de pago,
no se habilitan altas externas y no se activa el correo opcional.

## Referencias y comprobaciones

- [Google Tasks: creación](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/insert).
- [Recurso Task: fechas, notas y estados](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks).
- Pruebas de proveedor y trabajador: HTTP incierto, recuperación paginada y límites.
- Pruebas SQL: identidad única, permisos, conservación, conflictos y concurrencia.
- Pruebas de interfaz: activación, destino, versiones antiguas y casos inciertos.

La publicación y la aceptación real del proveedor se registran por separado de
estas pruebas técnicas; una prueba simulada no acredita un resultado en Google.

## Registro técnico de publicación

La migración `20261023234903_google_tasks_outbound_stage6b.sql` se instaló primero
en prueba y después en producción, con el envío de tareas nuevas desactivado.
Su SHA-256 al instalar es
`66c8a150d8049bd30148dadea8263616f00bea2fd121efe05f89cad4ec3a61b8`.
Se comprobó que los proyectos y tareas anteriores conservaran exactamente sus
datos en ambas bases. Las funciones Google se publicaron después de la migración.

Pasaron 337 pruebas de aplicación, 348 de Edge y 120 comprobaciones SQL nuevas,
además de las suites actuales de colaboración, calendario, procesos y Google.
También pasaron los controles de tipos, lint, formato, comprobaciones estáticas y
compilación. La suite histórica `personal_app.sql` corresponde al esquema anterior
a espacios de trabajo y no se aplica al esquema actual.

La aceptación real detectó una colisión entre una variable y un alias de tabla
en el programador. Se corrigió mediante la migración adicional
`20261024000148_google_tasks_outbound_scheduler_fix.sql`, conservando inmutable la
migración anterior y añadiendo una prueba con el programador habilitado. Ambas
bases registran ahora 13 migraciones; se conserva la cola de trabajos pendientes.

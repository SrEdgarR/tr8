# Etapa 6 · Google Tasks

El código añade importación de Google Tasks y sincronización de título, fecha
planificada y estado sobre esas mismas tareas. La migración es inerte hasta
completar un consentimiento que confirme Calendar y Tasks. No amplía las altas,
no cambia planes ni migra proyectos existentes. Esta especificación describe el
contrato implementado; no acredita instalación ni aceptación real del proveedor.

## Alcance

Una tarea creada en Google Tasks se importa a un proyecto personal Google Tasks,
creado con el primer elemento válido. No se importan notas ni tareas asignadas
desde Docs o Chat. Se conserva descripción, vencimiento y bloque horario locales.
La fecha `due` de Google se representa como `start_date`: es el día planificado,
no un plazo. Google Tasks API no expone la hora seleccionada en sus aplicaciones.

Las tareas existentes de TR8 conservan su exportación Calendar. Una identidad
vinculada a Google Tasks nunca genera una copia Calendar, incluso si la lista o
la integración se pausan. La ampliación [6b](outbound-tasks.md) añade creación
opcional de futuras tareas de TR8 mediante un intento de POST y recuperación
durable por marcador; las ediciones y eliminaciones conservan el mismo ID remoto.

## OAuth y permisos

Se reutiliza el cliente, callback y sobre cifrado de Calendar. El nuevo intento
persiste `tasks_requested`. Calendar y Tasks deben estar presentes en el intercambio
con refresh token nuevo antes de habilitar `google_connections.tasks_granted` y
`google_tasks_sync.enabled`. Una reconexión conserva la generación del calendario
existente y comprueba acceso al mismo recurso desde Edge.

`begin` cancela las concesiones activas de ambas colas antes de sustituir el grant;
los trabajadores antiguos no pueden guardar tokens ni confirmar trabajos. Un
consentimiento denegado conserva la credencial y capacidades anteriores. Pausar
Tasks no revoca el grant compartido; desconectar Google detiene Tasks antes de
que Calendar limpie sus propias copias y revoque el grant completo.

## Estado público

`tr8_v6_get_google_tasks_status()` es un wrapper invoker para `authenticated` y
exige cuenta habilitada y sesión existente en `auth.sessions`. Devuelve:

```text
{configured,enabled,state,version,last_sync_at,next_sync_at,pending,failed,
 conflicts,reason,lists:[{id,title,selected}],
 conflict_items:[{id,title,google_title,reason}]}
```

`enabled` indica capacidad Tasks autorizada y credencial presente. La pausa se
representa con `state:paused`, manteniendo `enabled:true`; el trabajador usa
`google_tasks_sync.enabled` como interruptor separado. `state` admite
disconnected, connected, paused, needs_reauthorization y error. `conflict_items.id`
es un UUID de vínculo, no un identificador de otra cuenta. Las listas se limitan
a las descubiertas desde el grant de ese usuario; sus IDs no son secretos OAuth.

Acciones propias: `tasks_status`, `tasks_reconcile`, `tasks_pause`, `tasks_resume`,
`tasks_select_list` y `tasks_resolve`. Salvo estado, exigen UUID estable
`request_id` y `expected_version`. Elegir lista añade `list_id,selected`; resolver
conflicto añade `link_id,resolution:local|google`. Desmarcar una lista conserva sus
tareas y enlaces, e invalida sus trabajos salientes. Reanudar no pide OAuth nuevo.

## Trabajador

`tr8_server_google` conserva su firma y ACL del servidor; delega en `v6_server`,
que mantiene las acciones Calendar en `v5_server`. Las acciones Tasks son:

| Acción                 | Payload adicional al job_id/lease_token                     | Resultado                                                                                                                 |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| tasks_claim            | limit 1..2, sin concesión                                   | [{job_id,lease_token,kind}]                                                                                               |
| tasks_prepare          | ninguno                                                     | {valid,kind,connection_id,user_id,generation,calendar_id,credential_envelope,time_zone,list_id?,page_token?,link?,local?} |
| tasks_reserve_request  | purpose                                                     | {allowed,receipt_id? ,reason?}                                                                                            |
| tasks_save_credentials | credential_envelope                                         | boolean                                                                                                                   |
| tasks_apply_lists      | page_token,items:[{id,title}],next_page_token               | {applied,more?}                                                                                                           |
| tasks_apply_page       | page_token,items:[remote],next_page_token                   | {applied,more?,imported?,updated?,deleted?,conflicts?,skipped?}                                                           |
| tasks_compare_remote   | remote                                                      | {valid,action,link_id?,etag?,patch?,prepared_hash?}                                                                       |
| tasks_finish           | outcome,remote?,prepared_hash?,retry_after_seconds?,reason? | boolean                                                                                                                   |

Clases de trabajo: discover, pull, patch y delete. `link` contiene id UUID y
remote_task_id. `local` contiene id UUID, title, completed boolean y start_date.
El elemento activo `remote` contiene exactamente id,etag,title,completed boolean,
start_date civil o null,deleted:false,assigned boolean. Un borrado permite solo
id y deleted:true. No se aceptan notas ni respuestas arbitrarias del proveedor.
La primera página usa `page_token:null`; cada aplicación compara el cursor usado
con el cursor durable antes de avanzar a `next_page_token`. Una respuesta
`applied:false` no certifica consumo de esa página.

`tasks_compare_remote.action` admite patch, delete, none y conflict. `patch`
contiene title,status completed|needsAction y due YYYY-MM-DD|null. El trabajador
captura `prepared_hash` junto con la decisión y lo entrega a finish después de
una escritura conocida; volver a preparar antes del HTTP no puede sustituirlo.
Si el local cambia durante el HTTP, la confirmación guarda la base efectivamente
enviada y conserva el siguiente cambio como dirty, con trabajo pendiente.
Para none/conflict no se adjunta remote a finish: compare ya aplica/guarda la
lectura y el conflicto; no se debe presentar una lectura como escritura saliente.

Las dos colas comparten el bloqueo de conexión y comprueban concesiones de la
otra cola antes de reclamar. Se permite una concesión activa por conexión, 60 s,
ocho intentos, y como máximo dos jobs por invocación. Cada HTTP reserva primero
la cota Google común de 500/día y 10.000/mes. Propósitos Tasks: tasks_lists,
tasks_list,tasks_get,tasks_patch,tasks_delete; la renovación usa refresh.

El cron existente considera ambas colas. Cada 15 minutos se exploran las listas
seleccionadas, con páginas de hasta 25 tareas. Se descubre la primera lista al
conectar, y las posteriores sincronizaciones manuales refrescan las listas. Se
selecciona automáticamente solo la primera descubierta. La selección posterior
es explícita. Todas las páginas incluyen completadas, ocultas y eliminadas, y
no incluyen asignadas. No se infieren borrados por ausencia en una página.

## Conflictos y conservación

La proyección canónica tiene título, booleano de terminación y fecha planificada.
Se comparan hashes de la base remota y la base local confirmadas. Una modificación
remota con local intacto se importa; una local con remoto intacto se exporta;
dos resultados iguales se confirman sin HTTP adicional; resultados distintos
se conservan como conflicto. PATCH/DELETE requieren If-Match del GET vigente.
La descripción, vencimiento y programación locales no participan ni se cambian.

Una eliminación explícita de Google retira únicamente la tarea importada limpia.
Una eliminación local encola DELETE por ID exacto. Si existen cambios en ambos
lados, la tarea y la proyección remota se conservan para elegir. Elegir Google
aplica la lectura más reciente, y elegir local envía su proyección si el recurso
existe. Si Google ya lo eliminó y se elige conservar TR8, el vínculo queda
retained: se conserva la tarea local sin POST incierto ni copia Calendar nueva.
Si la fecha planificada remota supera un vencimiento local, se presenta conflicto
de fecha para respetar la restricción de datos existente.

Los enlaces sobreviven a tareas borradas, pausas y fallos. Se mantienen IDs,
instancia local y generaciones; no se usa cascada hacia los datos de dominio.
No se activan planes de pago, altas externas, correo ni escritura en equipos.

## Verificación

`supabase/tests/google_tasks_stage6.sql` contiene fixtures sintéticos con rollback
y no ejecuta HTTP. Comprueba permisos, sesión viva, opt-in OAuth, cercas cruzadas,
páginas, deduplicación, eco, conflictos, edición concurrente durante HTTP,
eliminaciones por identificador y preservación de tareas/configuración previas.
Los parseos SQL/PLpgSQL locales son evidencia de sintaxis, no sustituyen ejecutar
esas pruebas en PostgreSQL ni probar el consentimiento y API de Google reales.

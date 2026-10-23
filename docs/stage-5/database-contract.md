# Etapa 5 · Contrato de base de datos y trabajador Google

Estado: esquema y funciones instalados en producción; consentimiento personal
completado el 23 de octubre de 2026 a las 21:09 UTC. El propietario informó que
la audiencia OAuth está **En producción**. La conexión está `connected`,
generación 1: `provision` terminó a las 21:10:03 UTC y `reconcile_scan` a las
21:11:01 UTC. El conector Google confirmó un único calendario TR8 en la cuenta
correcta y la coincidencia de su ID con la base de datos; ese ID no se publica.
La integración reservó dos solicitudes, `oauth` y `calendar_create`. No hay
enlaces ni tareas con fecha u horario, por lo que esta evidencia no acredita
entrega de eventos, renovación real de tokens ni limpieza o desconexión real.
Los recibos históricos y el despliegue se distinguen en el README de esta etapa.

## Fronteras

La migración `20261023195952_google_calendar_stage5.sql` es aditiva. Conserva
filas, OIDs, secuencia, responsables, fechas, preferencias, configuración de
altas y definiciones/permisos de las APIs de etapas anteriores. La captura
Google se agrega a la outbox de etapa 4 mediante un trigger independiente.
`process_jobs` continúa limitado a `internal`; su éxito no significa entrega
externa, y `get_process_status.channels.google` conserva ese significado.

El ajuste `20261023202750_google_calendar_reeligibility.sql` sustituye únicamente
`v5_scan(uuid)`. Si una tarea vuelve a ser elegible después de una eliminación
confirmada, conserva el enlace de TR8, retira el identificador remoto anterior
y asigna uno nuevo antes de encolar su copia. `remote_missing` sigue requiriendo
la reconstrucción elegida por el usuario; `retained` no se reactiva por una exploración.

No se generan conexiones ni trabajos históricos al instalar. Un usuario que
conecte voluntariamente Google inicia una exploración paginada de sus tareas.
Pulso y el correo permanecen excluidos. No se habilitan altas externas ni planes
de pago.

Siete tablas privadas, todas con RLS y sin lectura/escritura directa de `anon`,
`authenticated` o `service_role`:

- `google_config`: configuración administrativa por entorno, cotas y contadores.
- `google_connections`: cuenta TR8, generación, estado, calendario identificado,
  versión y sobre cifrado de credenciales.
- `google_oauth_attempts`: hashes de estado/navegador, sesión, origen exacto,
  PKCE y resultado OAuth cifrados, caducidad de diez minutos y consumo único.
- `google_event_links`: referencias mínimas de tarea/instancia, ID remoto
  aleatorio persistido, hashes de proyección y lápidas de limpieza.
- `google_jobs`: trabajos Google con revisión deseada, concesión y cursor.
- `google_requests`: recibos idempotentes de acciones propias, sin secretos.
- `google_request_receipts`: reservas de solicitudes reales al proveedor.

Los sobres tienen forma cerrada `{v:1,kid,iv,ciphertext}`; los tres últimos
campos son cadenas, IV de 12 bytes en base64url y ciphertext autenticado en
base64url. `kid` admite hasta 64 caracteres y ciphertext hasta 44.000, alineado
con el máximo de texto claro del adaptador. El servidor administra AES-GCM y la clave versionada fuera de
Postgres. La BD nunca recibe tokens ni verificadores PKCE en texto plano. Los
hashes OAuth son SHA-256 en base64url de 43 caracteres. AAD y cifrado pertenecen
al adaptador Edge, no a SQL.

## RPC de la interfaz

`tr8_v2_get_google_status()` es un wrapper `SECURITY INVOKER`, ejecutable solo
por `authenticated`. Su implementación privada exige cuenta habilitada y
`session_id` del JWT presente en `auth.sessions`, del mismo usuario y sin
`not_after` vencido. Un JWT antiguo de sesión retirada no permite leer estado.

Devuelve únicamente:

```text
{configured,state,generation,version,last_sync_at,pending,failed,reason}
```

Sin conexión devuelve `disconnected`, generación/versión cero y contadores cero.
Si falta configuración, `configured=false` y `reason=config_pending`. Nunca
incluye IDs de Google, credenciales, concesiones, otros usuarios ni títulos.

Estados: `disconnected`, `authorizing`, `provisioning`,
`provisioning_unknown`, `connected`, `needs_reauthorization`, `disconnecting`,
`cleanup_failed`, `error`.

La migración `20261023211313_google_calendar_provisioning_status.sql`, aplicada
en producción y comprobada con 22 aserciones específicas, modifica solo
`v5_status(uuid)`. Cuando la conexión almacena `provisioning_unknown` pero existe un
trabajo `provision` de esa misma conexión y generación, `leased` y con concesión
vigente, el estado público se proyecta como `provisioning` y sin motivo de
error. La conexión y su concesión se leen en una única instantánea SQL.
`config_pending` conserva su prioridad si falta configuración. Al confirmarse un
resultado incierto o vencer la concesión se muestra `provisioning_unknown`.
Esta proyección no cambia el estado persistido, la reserva ni el bloqueo de una
segunda creación. La interfaz consulta cada tres segundos durante las
transiciones y cada treinta en estados estables, sin consultas en segundo plano.
Los permisos, propietario y firma de la función se conservan.

Motivos públicos permitidos: `config_pending`, `oauth_denied`, `oauth_expired`,
`oauth_exchange_failed`, `scope_missing`, `refresh_missing`,
`reauthorization_required`, `different_google_account`,
`provisioning_unknown`, `remote_missing`, `temporary_failure`,
`permanent_failure`, `cleanup_failed`, `budget_exhausted` o `null`.

## Dispatcher exclusivo del servidor

```text
tr8_server_google(p_action text, p_actor uuid = null,
                  p_session uuid = null, p_payload jsonb = {}) -> jsonb
```

Wrapper público `SECURITY INVOKER` y dispatcher privado `SECURITY DEFINER` con
`search_path=''`. Únicamente `service_role` puede ejecutarlos. Las claves
privilegiadas nunca llegan al cliente. Edge obtiene actor/sesión del JWT
verificado; la BD vuelve a comprobar cuenta y `auth.sessions` para toda acción
de usuario. El navegador no elige una identidad alternativa.

Las acciones de usuario `begin`, `reconcile`, `disconnect`, `retry_cleanup`,
`abandon_cleanup`, `recover_calendar` y `rebuild_missing` reciben siempre
`expected_version` y UUID estable `request_id`. Mismo ID y payload devuelve el
recibo previo; reutilizarlo con otro payload produce conflicto. Se serializan
por cuenta y vuelven a validar la sesión después del bloqueo. Los errores usan
`42501`, `22023`, `PT404`, `PT409`, `PT429` y `PT503`, traducidos por Edge sin
filtrar diagnósticos SQL.

En `begin` la identidad lógica excluye los valores aleatorios de servidor
`state_hash` y `pkce_envelope` e incluye la sesión, navegador, origen y versión.
Un reintento del mismo navegador recibe los valores originales cifrados mientras
el intento siga vigente, sin consumir y con su conexión todavía en ese estado.
Otro navegador/sesión o un intento consumido no puede recuperarlos. El sobre
PKCE guarda `{state,verifier}` y el servidor reconstruye la misma URL OAuth;
los recibos idempotentes solo guardan IDs, sin duplicar ese sobre.

| Acción                   | Payload adicional                                       | Resultado y control                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`                 | Ninguno                                                 | Estado público propio                                                                                                                                                                            |
| `inspect_connection`     | Ninguno                                                 | Solo servidor: `user_id,connection_id,generation,calendar_id,credential_envelope,state,version`                                                                                                  |
| `begin`                  | `state_hash,browser_hash,pkce_envelope,app_origin`      | Crea intento; devuelve al servidor `attempt_id,connection_id,generation,version,state_hash,pkce_envelope`; origen exacto administrativo                                                          |
| `relay`                  | `state_hash`; sin actor recibido del cliente            | Solo servidor: `app_origin,user_id` de intento vigente, conexión actual y usuario/sesión vivos; no consume ni entrega secretos                                                                   |
| `record_oauth_result`    | `state_hash,result_hash,result_envelope`                | Callback servidor: guarda el primer resultado cifrado antes de redirigir; mismo hash devuelve el origen sin sobrescribir, otro hash entra en conflicto                                           |
| `consume_attempt`        | `state_hash,browser_hash`                               | Actor y sesión iniciadora exactos; exige resultado recibido; consumo único; devuelve `attempt_id,user_id,connection_id,generation,pkce_envelope,result_envelope,calendar_id,credential_envelope` |
| `complete_authorization` | `attempt_id,credential_envelope,keep_existing_calendar` | Consume resultado del intento; calendario previo exige comprobación remota de la misma cuenta por Edge; guarda cifrado y encola provisión o exploración                                          |
| `authorization_failed`   | `attempt_id,reason`                                     | Cierra intento, borra PKCE y restaura conexión previa cuando existe                                                                                                                              |
| `reconcile`              | Ninguno                                                 | Encola exploración; mínimo 30 segundos entre solicitudes manuales                                                                                                                                |
| `recover_calendar`       | `calendar_id`, opcional `credential_envelope`           | Solo `provisioning_unknown`; Edge debe comprobar el recurso con el scope limitado antes de llamar; no buscar por nombre                                                                          |
| `rebuild_missing`        | Ninguno                                                 | Reconstrucción expresamente elegida de enlaces `remote_missing` aún elegibles; nuevo ID aleatorio y conservación de IDs ya confirmados retirados                                                 |
| `disconnect`             | `mode:keep\|delete`                                     | Corta creaciones normales; conserva o encola borrados por identificadores conocidos; después revoca y retira credenciales                                                                        |
| `retry_cleanup`          | Ninguno                                                 | Solo `cleanup_failed`; reinicia limpieza pendiente                                                                                                                                               |
| `abandon_cleanup`        | Ninguno                                                 | Pasa a conservar lo que quede; intenta revocar y retira credenciales                                                                                                                             |

Las operaciones sobre un intento también verifican sesión, vencimiento y que no
haya sido completado/reemplazado. Al reconectar un calendario existente se
mantiene su generación para descifrar las credenciales anteriores; una conexión
nueva después de desconectar elige la generación siguiente. No se mezclan
credenciales de dos cuentas Google.

El callback fijo de Edge no depende de servir HTML: Supabase transforma las
respuestas HTML de este endpoint en texto sin renderizar. El GET valida estado
y sesión iniciadora, cifra `{code|error}` con AAD `oauth-result:<state_hash>`,
sujeto usuario y generación `0`, registra ese resultado y redirige mediante 302
al origen exacto de la aplicación y ruta `/google-calendar/callback`. La URL de
la aplicación no lleva código, estado ni tokens. La página de regreso anuncia
que está lista al popup iniciador; este comprueba origen y ventana antes de
enviar su estado/secreto de navegador con sesión TR8. Solo entonces el servidor
consume ambos sobres y canjea el código. El resultado cifrado se borra al
completar, reemplazar, desconectar o caducar el intento, igual que PKCE. La BD
no almacena códigos OAuth en texto plano ni los duplica en recibos.

Cancelar o dejar vencer una reautorización conserva el estado previo seguro. Una
conexión que necesitaba reconectarse no se presenta como conectada solo porque
todavía queden un ID de calendario y un sobre de credenciales revocadas.

## Trabajador y solicitudes de Google

Estas acciones usan exclusivamente la credencial del servidor. No son APIs del
navegador ni aceptan una clave publicable como autoridad.

| Acción             | Payload                                               | Respuesta                                                                                              |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `claim`            | `limit:1..2`                                          | `[{job_id,lease_token,kind}]`; confirma la transacción antes de hacer HTTP                             |
| `prepare`          | `job_id,lease_token`                                  | `{valid:false}` o preparación vigente descrita abajo                                                   |
| `reserve_request`  | `purpose`, y `job_id,lease_token` para trabajador     | `{allowed:true,receipt_id}` o `{allowed:false,reason}`; reserva una unidad **antes de cada HTTP real** |
| `save_credentials` | `job_id,lease_token,credential_envelope`              | Booleano; guarda renovación antes de continuar con efectos externos                                    |
| `finish`           | `job_id,lease_token,outcome` y campos según resultado | Booleano; solo token exacto no vencido puede finalizar                                                 |

Preparación válida: `kind,connection_id,generation,user_id,calendar_id,
credential_envelope,time_zone`. Para eventos agrega `link:{id,event_id}` y, solo
para upsert autorizado, `event:{id,project_id,title,project_title,project_status,project_archived,status,
start_date,due_date,scheduled_start_at,scheduled_end_at,scheduled_time_zone}` y
`previously_synced`. El adaptador TS construye la proyección Google de un evento
por tarea. Esta respuesta es efímera: título y nombre de proyecto no se copian
en la cola. Las descripciones completas quedan excluidas.

`reconcile_scan` devuelve `internal:true,scanned,more` sin credenciales. Procesa
como máximo 100 IDs por página. `finish:succeeded` vuelve a dejarlo pendiente si
queda otra página; una nueva revisión mientras se exploraba reinicia el cursor.
No consume una solicitud Google. `revoke` con borrados pendientes libera su
concesión, programa espera de 30 segundos y devuelve `{valid:false,wait:true}`;
el trabajador no debe confirmar ese resultado inválido.

Tipos exactos: `provision`, `reconcile_scan`, `upsert`, `delete`, `revoke`.
Estados de trabajo: `pending`, `leased`, `retry`, `succeeded`, `cancelled`,
`unknown`, `dead`. Lote máximo dos y una concesión activa por conexión, con
duración de 60 segundos. Cada HTTP usa tiempo máximo menor que la concesión; el
adaptador limita solicitudes a ocho segundos y su petición total a 45 segundos.
Concesiones vencidas se recuperan con token nuevo. El antiguo no puede guardar
credenciales ni confirmar el trabajo de su sustituto.
Agotar una última concesión de limpieza deja la conexión en `cleanup_failed`,
con las opciones de reintentar o abandonar, y no continúa enviando por sí sola.

`finish.outcome`: `succeeded`, `retry`, `dead`, `unknown`, `cancelled`,
`needs_reauthorization` o `remote_missing`. Campos opcionales:
`retry_after_seconds`, `calendar_id` para provisión exitosa y
`credential_envelope` actualizado. `needs_reauthorization` pausa la conexión;
`remote_missing` exige reconstrucción elegida por el usuario. Reintentos: base
30 segundos, variación, techo seis horas y ocho intentos por trabajo.

`reserve_request.purpose`: `oauth`, `refresh`, `calendar_create`,
`calendar_get`, `event_get`, `event_upsert`, `event_delete`, `revoke`. OAuth,
refresh y comprobación de calendario también admiten actor/sesión vivos sin
trabajo durante conexión/recuperación. `save_credentials` admite la variante
actor/sesión con `generation` para esa misma recuperación. No se reservan
solicitudes por lecturas de BD o exploraciones internas. Antes de una escritura
externa el adaptador vuelve a preparar y reservar; la reserva comprueba acceso,
instancia, estado de conexión, generación y concesión vigentes.

La creación de calendario se trata especialmente: su reserva cambia a
`provisioning_unknown` **antes** del HTTP y prohíbe repetir `calendar_create` con
la misma concesión. Éxito conocido confirma el ID y conecta. Solo un fallo
HTTP conocido sin creación puede clasificarse `retry` y restaurar provisión.
Timeout, 408, 5xx ambiguo o caída requieren `unknown`; no se vuelve a crear
automáticamente. La recuperación necesita un ID comprobado, nunca una búsqueda
por nombre ni permiso adicional implícito.

Los IDs de evento se asignan aleatoriamente antes de la solicitud y se mantienen
en reintentos inciertos. Desconexión y revocación conservan las lápidas. Un
upsert que termina después de perder acceso registra el resultado y programa
la retirada por ID sin exponer el contenido. La limpieza espera, como mínimo,
el vencimiento de la concesión anterior más diez segundos para cubrir una
solicitud saliente tardía; un 404 anterior no puede confirmar una limpieza
prematura. La barrera `cleanup_not_before` se guarda en el enlace al reservar una
escritura y sobrevive a cancelar, agotar o limpiar los campos de la concesión.
No hay promesa de revocación absoluta de copias externas ni de
ejecución exactamente una vez entre sistemas.

## Programador, presupuesto y operación

La instalación crea Google configurado y programador **desactivados**, sin URL,
sin conexiones y sin trabajos. Dos cron nuevos también quedan inactivos:
`tr8-google-worker` cada minuto y mantenimiento diario a las 03:23 UTC. Se
mantienen los cron internos de etapa 4 sin reescribirlos.

Antes de activar se necesitan Edge desplegado, cliente OAuth auditado, orígenes
y callback exactos, clave de cifrado fuera de BD y secreto Vault
`tr8_google_worker_secret`. `worker_url` solo admite el endpoint fijo
`/functions/v1/tr8-google-worker` de los proyectos TR8 prueba/producción.
El despertar usa `pg_net`, body `{}` y header `x-tr8-worker-secret`. Solo se
produce con trabajo vencido ejecutable, presupuesto y configuración válidos;
evita repetir despertares en menos de 55 segundos. No depende del navegador.
El transporte espera hasta 50 segundos por la respuesta del trabajador de 45
segundos; SQL solo encola la solicitud y no mantiene una transacción esperando
la red.

Cota global propia: 500 solicitudes Google por día UTC y 10.000 por mes UTC.
Todas las llamadas, incluidas OAuth, refrescos, verificaciones y reintentos,
reservan presupuesto de manera serializada. Alcanzarlo no impide guardar
proyectos/tareas ni activa un plan de pago. No sustituye las cuotas reales de
Google, Supabase o Vercel.

Mantenimiento: retirar PKCE vencidos, resolver intentos expirados, borrar
intentos de más de un día, recibos de más de 32 días en lotes acotados e historial
de cron exclusivamente de TR8 Google tras siete días. No elimina enlaces ni
trabajos desconocidos, fallidos o pendientes: sus identificadores son necesarios
para compensación y seguimiento. Su crecimiento debe medirse.

La prueba SQL aislada histórica verifica límites de rol, sesiones, consumo OAuth,
idempotencia, provisión incierta, IDs persistidos, proyección fresca, presupuestos,
concesiones vencidas, desconexión concurrente, limpieza sin contenido privado y
preservación de filas previas. Esas pruebas no acreditan consentimiento ni
entrega real al proveedor. El consentimiento posterior del propietario y la
creación del calendario sí quedaron comprobados en producción como se registra
al inicio; la entrega de eventos todavía no se ha observado.

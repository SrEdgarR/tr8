# TR8: calendario, Google Calendar y correos

Estado: contrato técnico de etapa 0, preparado el 23 de octubre de 2026. No implementa tablas, funciones, clientes OAuth ni envíos. Las convenciones nuevas señaladas como propuestas técnicas concretan las decisiones del producto y se comprobarán antes de activar cada integración.

Los permisos y pertenencias se resolverán mediante [el contrato de datos y autorización](data-and-access.md); ninguna copia en una cola, JWT o caché concederá acceso. El presupuesto y las condiciones de activación están en [free-tier-budget.md](free-tier-budget.md).

## 1. Alcance acordado

- Calendario general filtrable y calendario dentro de cada proyecto, mostrando únicamente proyectos autorizados.
- Vencimiento opcional y bloque horario opcional e independiente. Se conserva `start_date`, que ya existe.
- Google Calendar opcional por usuario, en una dirección: TR8 → Google. Calendario secundario propio llamado TR8.
- Se sincronizan tareas del espacio personal del usuario y tareas asignadas a él en equipos, con fecha o bloque horario y acceso vigente.
- Completar conserva el evento con «Hecha»; reabrir retira la marca. Desconectar permite conservar o intentar eliminar las copias antes de retirar las credenciales.
- Correos desactivados inicialmente, con selección de proyectos y tipos de aviso: asignación, cambio de fechas y cierre o archivo de proyectos. Entrega inmediata o resumen diario.
- Finanzas personales y contenido de Pulso quedan excluidos del calendario, correos, colas y registros de estas funciones.

## 2. Fechas y contrato del calendario interno

### Datos e invariantes

| Campo                 | Tipo previsto           | Regla                                                                                                         |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `start_date`          | `date`, opcional        | Fecha prevista de inicio existente; conservar su significado y sus datos                                      |
| `due_date`            | `date`, opcional        | Vencimiento existente; conservar `start_date <= due_date` cuando ambos existan                                |
| `scheduled_start_at`  | `timestamptz`, opcional | Instante de inicio del bloque                                                                                 |
| `scheduled_end_at`    | `timestamptz`, opcional | Instante de fin; debe ser posterior al inicio                                                                 |
| `scheduled_time_zone` | Nombre IANA, opcional   | Zona utilizada al programar; obligatorio junto con ambos instantes                                            |
| Zona del perfil       | Nombre IANA             | Preferencia de visualización y resumen diario; inicialización explícita, sin inferirla permanentemente por IP |

Los tres campos del bloque estarán completos o vacíos. No se deduce un bloque a partir del vencimiento ni se exige que termine antes de este: son conceptos distintos. Se puede advertir una planificación posterior al vencimiento sin modificarla silenciosamente.

Las fechas `YYYY-MM-DD` permanecen como fechas civiles: cambiar de zona del perfil no mueve el vencimiento al día anterior. Los bloques conservan sus instantes al cambiar de zona de visualización; editar su hora local es una operación explícita. El formulario rechazará horas inexistentes por cambio horario y pedirá elegir el desplazamiento cuando una hora sea ambigua. No se utilizará «sumar 24 horas» para calcular el día siguiente civil.

### Proyección propuesta

El calendario interno puede mostrar dos elementos de una tarea: su bloque y su vencimiento. Se distinguen por `(task_id, kind)` y no representan tareas duplicadas. Una tarea sin bloque ni vencimiento puede aparecer en `start_date` como elemento de día completo; una tarea sin ninguna fecha permanece en la lista «Sin programar». `start_date` no genera un intervalo de varios días entre inicio y vencimiento.

Propuesta de consulta lógica `calendar_items`:

- Entrada: espacio o conjunto autorizado de espacios, proyectos opcionales, responsables, estados, zona IANA de visualización, rango de fechas civiles `[date_from, date_to)` y cursor.
- Rango máximo inicial: 93 días por solicitud; paginación de hasta 250 elementos. Son límites de aplicación propuestos, no cuotas del proveedor.
- Para bloques: convertir los límites civiles a instantes en la zona solicitada y seleccionar solapamientos `start < range_end AND end > range_start`.
- Para fechas: comparar directamente con el rango civil; no convertir cada `date` a UTC. El día final siempre es exclusivo.
- Salida mínima: identificador de elemento, tarea/proyecto autorizados, título, tipo, fechas o instantes, zona del bloque, responsable, estado y versión. Sin tokens ni contenido financiero.
- Orden estable por comienzo, identificador de tarea y tipo. El cursor no sustituye la autorización de cada página. Una revocación puede retirar resultados entre páginas; no se promete una fotografía transaccional entre solicitudes.
- La vista general muestra todas las tareas autorizadas, con filtro «Mías». El filtro obligatorio «personal o asignada» corresponde a Google, no limita por defecto el calendario interno.

Mover un bloque conserva su duración salvo edición explícita. Mover un vencimiento cambia únicamente `due_date`. Toda escritura exige `task.edit`, acceso `write`, proyecto no archivado, versión esperada y validación de fechas; un conflicto devuelve la versión vigente para que el usuario decida.

## 3. Acontecimientos y destinatarios

La escritura autorizada de dominio insertará un registro de salida en la misma transacción. El cliente no enviará correos ni instrucciones de sincronización directamente. Esta tabla define el alcance; no introduce comentarios, menciones o recordatorios recurrentes.

| Acontecimiento                                         | Google                                                                                                                                                   | Correo propuesto                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Crear o fechar tarea elegible                          | Crear o actualizar proyección                                                                                                                            | Solo asignación si hay responsable nuevo, distinto del actor y con avisos activados   |
| Cambiar título, estado o prioridad                     | Actualizar los campos de la proyección                                                                                                                   | No se añade un tipo de aviso nuevo                                                    |
| Cambiar inicio, vencimiento, horario o zona del bloque | Recalcular proyección                                                                                                                                    | Responsable vigente o propietario del espacio personal, si optó por cambios de fechas |
| Asignar o reasignar                                    | Retirar copia del responsable anterior; crear para el nuevo si procede                                                                                   | Nuevo responsable autorizado; no incluir el contenido para quien ya perdió acceso     |
| Quitar responsable                                     | Retirar la copia del antiguo responsable en equipo                                                                                                       | Sin correo adicional de «desasignación» en esta versión                               |
| Completar o reabrir tarea                              | Poner o retirar «Hecha» sin cambiar la fecha                                                                                                             | Sin correo de estado de tarea en esta versión                                         |
| Eliminar tarea o quitar todas sus fechas               | Retirar la copia correspondiente                                                                                                                         | Sin correo adicional                                                                  |
| Completar o archivar proyecto                          | Conservar las copias; refleja su estado en futuras reconciliaciones                                                                                      | Suscriptores autorizados que eligieron ese tipo de aviso                              |
| Revocar acceso, expulsar miembro o eliminar proyecto   | Cancelar actualizaciones y solicitar retirada de copias afectadas                                                                                        | Cancelar avisos pendientes; no enviar detalles del proyecto al antiguo miembro        |
| Cambiar roles                                          | Reconciliar si cambia el acceso efectivo; si vuelve inelegible al responsable, desasignar con nueva versión y limpieza en la transacción de autorización | Sin correo de roles ni contenido a quien perdió acceso                                |

Los destinatarios y las preferencias se comprueban al preparar y al enviar, no se heredan del permiso del actor. Los avisos personales optativos se suprimen cuando el destinatario es quien provocó el cambio. Las invitaciones y los mensajes de acceso/recuperación son flujos separados; no quedan habilitados por activar estos avisos.

## 4. Cola transaccional y contrato del trabajador

### Registros lógicos

- `outbox`: identificador, tipo permitido, entidad, versión, actor, fecha y referencias mínimas. No almacena una copia del título o descripción como autoridad.
- `delivery_jobs`: canal, destinatario, clave de deduplicación, revisión deseada, estado, `available_at`, intentos, concesión temporal y resultado remoto. Solo procesos internos pueden reclamar o finalizar trabajos.
- `calendar_links`: usuario, tarea, conexión/generación, calendario, identificador de evento preasignado, revisión sincronizada y estado de eliminación. Conservar una lápida mínima permite limpiar después de eliminar la tarea; una eliminación en cascada no puede borrar estos identificadores antes de confirmar la limpieza.
- Preferencias y comprobantes de correo: solo el dueño y el servidor autorizado acceden a sus datos; no se publican como actividad del equipo.

Estados: `pending`, `leased`, `retry`, `succeeded`, `cancelled`, `unknown` y `dead`. Un trabajo no confirmado no se marca exitoso.

### Ejecución

1. Reclamar un lote limitado de trabajos vencidos con bloqueo de filas sin esperar otros trabajadores. Guardar un token de concesión y vencimiento; confirmar esta transacción antes de la llamada HTTP.
2. Resolver acceso efectivo, revisión más reciente y elegibilidad. Cancelar avisos sin permiso; para limpieza usar únicamente los identificadores remotos mínimos ya registrados, sin volver a exponer el contenido privado.
3. Serializar por `(conexión, tarea, usuario)` y consolidar cambios de Google en el estado deseado más reciente. No aplicar una versión antigua después de una nueva. Los correos pueden agrupar sucesos, pero conservan sus claves de deduplicación.
4. Enviar con tiempo máximo de red menor que la concesión, identificación idempotente cuando el proveedor la soporte y límite global por canal. Renovar la concesión si es necesario; un trabajador vencido no puede confirmar resultados usando su token antiguo.
5. Confirmar solo con la concesión vigente. Si cambió la revisión o el acceso durante el envío, registrar el resultado remoto conocido y programar reconciliación o eliminación compensatoria.
6. Para errores temporales, respetar `Retry-After` y aplicar espera exponencial con variación: base de 30 segundos, techo de 6 horas y hasta 8 intentos automáticos como política inicial ajustable. Errores permanentes no se reintentan indefinidamente. Un `invalid_grant` pausa la conexión y solicita reconexión.

Una concesión evita procesamiento normal simultáneo, pero no cancela mágicamente una solicitud HTTP antigua que ya salió. Una revocación concurrente puede coincidir con un envío externo. Se hará una comprobación inmediatamente antes de enviar y una reconciliación posterior, sin prometer ausencia absoluta de esa carrera.

### Confirmaciones desconocidas

- **Eventos:** persistir antes de crear un identificador compatible con Google, derivado de un UUID aleatorio y sin guiones. Reintentar/reconciliar con el mismo identificador; consultar el evento ante resultado dudoso o conflicto. Una nueva generación tras una eliminación usa otro identificador y conserva la limpieza de la anterior. Google documenta los identificadores elegidos por el cliente como ayuda para evitar creaciones duplicadas. [Crear eventos](https://developers.google.com/workspace/calendar/api/guides/create-events).
- **Calendario secundario:** una creación con respuesta perdida puede dejar un calendario sin identificador local. No reintentar ciegamente ni buscar por nombre suponiendo unicidad. Marcar `provisioning_unknown` y ofrecer recuperación controlada; no solicitar permisos amplios solo para ocultar este fallo.
- **Correo:** la clave se conserva en TR8 y se reutiliza con contenido idéntico dentro de la ventana idempotente del proveedor. Si se desconoce el resultado fuera de esa ventana y no puede consultarse, marcar `unknown`; no reenviar automáticamente y arriesgar un duplicado. No se promete entrega «exactamente una vez» entre sistemas.

El planificador, las cotas de lote y la retención operativa seguirán [el presupuesto gratuito](free-tier-budget.md). No depender de una pestaña abierta, ni crear solicitudes artificiales para evitar pausas. Una cola pendiente tras una pausa no autoriza recuperar sucesos antiguos sin volver a comprobar permisos y utilidad.

## 5. Google Calendar: proyección y seguridad

### Un evento por tarea, usuario y conexión activa

Propuesta técnica: dar preferencia al bloque; si no existe, usar vencimiento; en su defecto, fecha de inicio. Cuando hay bloque y vencimiento, se mantiene un solo evento horario y se indica el vencimiento en sus detalles. El calendario interno conserva ambas representaciones; esta reducción solo afecta a la copia en Google.

Para día completo: `start.date` es la fecha elegida y `end.date` el día civil siguiente. Para bloques se envían instantes RFC 3339 y zona IANA, con fin exclusivo. No establecer asistentes, conferencias o recordatorios de correo automáticamente. El título incluye «Hecha» solo cuando corresponda. Detalles mínimos: proyecto, vencimiento si procede y enlace autenticado a TR8; no copiar descripciones completas por defecto. [Campos y fin exclusivo de eventos](https://developers.google.com/workspace/calendar/api/v3/reference/events).

Guardar `calendar_id` y los identificadores de eventos; no localizar o eliminar recursos solo por su nombre TR8. Una edición en Google no altera TR8. En la siguiente reconciliación se restaura la proyección de TR8; una eliminación manual se detectará al actualizar/reconciliar y se ofrecerá reconstruirla de forma controlada, sin sondeo continuo ni suscripciones de Google en esta entrega.

Revocar acceso o reasignar produce una nueva revisión de elegibilidad e invalida trabajos antiguos. Incluso si un `create` obsoleto termina después de la revocación, se registra el identificador remoto para retirarlo. Desactivar una conexión corta nuevas creaciones antes de iniciar la limpieza.

Desconectar pasa a `disconnecting`, invalida trabajos normales y conserva las credenciales solo mientras se intenta la opción elegida. Conservar deja las copias y retira las credenciales. Eliminar intenta retirar exclusivamente los eventos registrados de TR8; cualquier fallo pendiente se muestra al usuario antes de terminar o abandonar la limpieza. Después se revocan y borran las credenciales locales. No eliminar el calendario completo, que el usuario podría haber reutilizado.

**Límite de privacidad:** una copia externa ya entregada no es revocable con garantías. Google puede conservar eventos si se revoca la autorización o el usuario abandona la limpieza; un correo enviado no se puede retirar. Esta condición se explica antes de conectar o activar avisos.

### OAuth y credenciales

- Cliente de tipo aplicación web con intercambio de código en servidor; conexión ligada al usuario autenticado de TR8, no por coincidencia de correo. Google puede ser una cuenta distinta a la utilizada para entrar a TR8.
- Estado aleatorio de un solo uso, con vencimiento corto y vinculado al navegador/usuario que inició el flujo. Callback con URI exacta autorizada; sin redirecciones libres. Canje de código exclusivamente en servidor y vuelta a la interfaz sin códigos o tokens en URL persistente o registros.
- PKCE S256 mediante una biblioteca compatible con el flujo elegido, además de `state`; comprobar su interoperabilidad durante la prueba OAuth. La biblioteca oficial de Google documenta generación y canje del verificador. [Referencia de Google Auth Library](https://googleapis.dev/nodejs/google-auth-library/latest/classes/OAuth2Client.html).
- Solicitud contextual al pulsar Conectar, con acceso offline. Comprobar los permisos efectivamente concedidos. No sustituir un refresh token existente por un valor vacío en una renovación/reautorización.
- Scope objetivo único: `https://www.googleapis.com/auth/calendar.app.created`. Permite crear calendarios secundarios y gestionar sus eventos; las referencias de [calendars.insert](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/insert) y [events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) lo admiten. No pedir acceso general a calendarios, Gmail o Drive. Si una operación adicional exige otro alcance, queda bloqueada hasta justificarlo.
- Access/refresh tokens cifrados con cifrado autenticado en un esquema no expuesto, acceso restringido al servidor y clave versionada fuera de la base de datos. Rotación documentada y secretos fuera de Git, del bundle y de variables públicas `VITE_*`. Esta protección es independiente de la bóveda de Pulso. [Buenas prácticas OAuth de Google](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).

Una conexión puede estar `disconnected`, `provisioning`, `connected`, `needs_reauthorization`, `disconnecting` o `error`. La interfaz solo consulta estado, última sincronización y errores sanitizados de su propia conexión; nunca credenciales.

### Condiciones antes de activar

Crear y revisar manualmente los clientes OAuth, configurar dominios y redirecciones reales, página informativa y política de privacidad. No asumir propiedad de `tr8.studio` ni que un subdominio compartido satisface por sí solo los requisitos de Google. Verificar la clasificación vigente de los scopes en la consola y completar la revisión que corresponda antes de ampliar la audiencia. Google exige separar pruebas y producción en su guía de preparación. [Preparación y políticas](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance).

External + Testing no proporciona sincronización duradera: los refresh tokens para Calendar expiran a los siete días. También hay otras causas de revocación; la aplicación debe poder solicitar nueva autorización sin perder tareas. No confundir publicar la pantalla de consentimiento con superar una verificación. [Caducidad de refresh tokens](https://developers.google.com/identity/protocols/oauth2#expiration).

## 6. Correos: preferencias, resumen y proveedor

Propuesta inicial de preferencias: tipos habilitados por proyecto, más frecuencia global `off | immediate | daily`, zona IANA y hora local de resumen. Inicialmente `off`. Ningún administrador activa estos avisos en nombre de otro usuario. Cambiar preferencias cancela lo pendiente que deje de corresponder y no envía retrospectivamente todo el historial.

El resumen tendrá una clave única por destinatario y ventana cerrada; sus intervalos se registran como instantes, aunque la planificación use hora local. Cambiar de zona no duplica una ventana ya cerrada. Tras una pausa se prepara como máximo un resumen consolidado útil, no un mensaje por cada día atrasado. Revalidar el acceso a cada elemento al renderizar y justo antes de entregar.

Escapar contenido, limitar títulos y número de elementos, enlazar a rutas con autenticación y no incluir descripciones extensas. Adjuntar una forma de desactivar los avisos sin conceder acceso a proyectos; si se usa un enlace firmado, será acotado al cambio de preferencias. Los enlaces nunca llevarán tokens de sesión.

**Proveedor no elegido ni contratado.** Resend es un candidato por su API e idempotencia; su selección requiere verificar cuota, región, remitente y tratamiento de datos junto con el presupuesto. Su documentación exige un dominio propio verificado para el uso general y mantiene las claves de idempotencia 24 horas; no asumir que cubre reintentos indefinidos. [Dominios](https://resend.com/docs/dashboard/domains/introduction), [idempotencia](https://resend.com/docs/dashboard/emails/idempotency-keys).

Los correos de proyecto permanecen deshabilitados hasta disponer de proveedor y remitente válidos dentro del presupuesto. El trabajador utilizará la API HTTPS del proveedor, no SMTP desde Edge Functions. No comprar dominios ni activar planes de pago como parte de esta etapa. El correo por defecto de autenticación no se reutiliza como servicio general de avisos.

**Dependencia anterior a los avisos opcionales:** incorporar colaboradores externos también necesita resolver el correo de autenticación y recuperación. El SMTP de autenticación disponible por defecto restringe sus destinatarios y frecuencia; no debe suponerse que las invitaciones por enlace hacen innecesario ese correo. La habilitación de nuevas cuentas externas en etapa 1 queda condicionada al remitente/SMTP de Auth válido o a un flujo alternativo explícitamente diseñado y verificado, según [el presupuesto y sus bloqueos](free-tier-budget.md).

## 7. Operaciones previstas y autoridad

Son contratos lógicos, no rutas implementadas. Se resolverán como RPC o funciones según el modelo de seguridad y no podrán aceptar una identidad de usuario arbitraria del cliente.

| Operación                       | Autoridad y efecto                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consultar calendario            | Sesión válida; comprobar membresía, `project.read`, `task.read` y acceso explícito de cada proyecto en cada página, salvo la excepción protegida del propietario |
| Cambiar programación            | `task.edit`, acceso `write`, proyecto no archivado y versión esperada; tarea y outbox atómicos. Reasignar exige `task.assign` por separado                       |
| Leer/cambiar preferencias       | Solo el propio usuario; validar acceso al proyecto, sin habilitación por administradores                                                                         |
| Iniciar Google OAuth            | Sesión válida del usuario; crear intento acotado y redirigir a Google                                                                                            |
| Resolver callback               | Estado, navegador, intento y código válidos; no confiar en un `user_id` recibido en la URL                                                                       |
| Consultar estado de integración | Solo el propio usuario; respuesta sin secretos                                                                                                                   |
| Solicitar reconciliación        | Solo la propia conexión; limitar frecuencia y ejecutar mediante la cola                                                                                          |
| Desconectar conservar/eliminar  | Solo el propio usuario; operación idempotente con estado visible                                                                                                 |
| Reclamar/finalizar trabajos     | Credencial interna de servidor, token de concesión y límites; no invocable por el navegador                                                                      |

## 8. Criterios de aceptación para las etapas posteriores

1. Un proyecto privado no aparece en calendario, filtros o respuestas directas de un miembro sin acceso, aunque manipule identificadores.
2. Retirar a un miembro cancela sus avisos y proyecciones pendientes; la limpieza remota no necesita entregar contenido privado de la tarea eliminada.
3. Una tarea con horario y vencimiento muestra ambas referencias internamente y genera una sola copia coherente en Google.
4. Fechas civiles permanecen en el mismo día al cambiar de zona; bloques y consultas funcionan en los límites del día y en cambios horarios, incluidos instantes ambiguos.
5. Reasignar, quitar todas las fechas, completar/reabrir y eliminar produce el resultado de la matriz sin copias huérfanas conocidas.
6. Dos trabajadores, una concesión vencida, un timeout posterior a creación y dos cambios fuera de orden convergen a la última revisión; una operación desconocida no se declara exitosa.
7. Una revocación que coincide con una creación externa produce intento de compensación y estado visible; no se promete retirar una copia sin autorización de Google.
8. Google denegado, permisos parciales, token vencido y `invalid_grant` dejan utilizables proyectos y tareas, con reconexión explícita.
9. El callback rechaza estado ajeno/repetido/vencido; secretos y datos financieros no aparecen en respuestas, registros, URLs persistentes o bundle.
10. La desconexión respeta conservar/eliminar y no elimina eventos ajenos; una confirmación perdida al crear el calendario detiene la provisión en vez de duplicarla a ciegas.
11. Correos inicialmente apagados; exclusiones, acciones propias, cambios de preferencia y pérdida de acceso se respetan incluso con trabajos ya encolados.
12. El resumen se deduplica entre reintentos y cambios de zona; una pausa no desencadena una avalancha. El proveedor impide duplicados solo dentro de la ventana documentada y el sistema trata resultados desconocidos posteriores.
13. No se activan envíos o sincronización autónoma mientras falten los requisitos OAuth, remitente o presupuesto descritos. Las pruebas usarán datos ficticios y destinatarios controlados.

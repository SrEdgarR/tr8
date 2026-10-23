# Etapa 5 · Google Calendar

Estado: **publicada; autorización Google pendiente**. Las migraciones y funciones están instaladas en producción, la interfaz está publicada y se verificaron Vercel `READY` y CI satisfactorio para la versión de código registrada abajo. Por decisión expresa del propietario se omite la aceptación OAuth en un entorno aislado y se conectará directamente producción con su consentimiento. Todavía no se ha realizado la autorización real ni demostrado entrega de eventos.

## Preparación de producción verificada

Se aplicaron las migraciones canónicas `20261023195952_google_calendar_stage5.sql` y `20261023202750_google_calendar_reeligibility.sql`, conservando sus archivos inmutables. Producción tiene nueve migraciones registradas. La comparación de la copia actualizada antes y después de instalar confirmó igualdad de proyectos, tareas, las dieciséis tablas privadas anteriores y la secuencia; solo se excluyó de la comparación la hora de captura de la propia copia.

La copia privada previa tiene SHA-256 `06f03b2c351dea1932d31a193d056d0ab6e5ff264978be03e2bf88860a7961bc`. Se conservaron **un proyecto, una tarea y una cuenta habilitada**. La tarea existente no tiene fecha ni bloque horario; por ahora no existe una tarea elegible para crear su copia en Google. No se agregaron datos ficticios en producción.

Las funciones `tr8-google` y `tr8-google-worker` están `ACTIVE`, versión 1, con el mismo código comprobado previamente en las funciones de prueba. Se configuraron seis variables privadas de servidor, sin incorporar secretos al navegador o a Git. El despertar tiene el secreto en Vault, fuera de los contratos públicos, y el endpoint fijo del trabajador corresponde a producción.

En producción la configuración y el programador de Google están habilitados, con sus dos cron activos y presupuesto de 500 solicitudes diarias y 10.000 mensuales. En la comprobación de instalación había **cero conexiones y cero trabajos Google**. No se realizaron solicitudes a Google: la infraestructura espera el consentimiento del propietario.

En Supabase de prueba, la configuración y el programador de Google están desactivados, los dos cron de Google inactivos y las variables del identificador y secreto del cliente OAuth retiradas. No hay credenciales activas de Google para continuar allí una sincronización.

## Publicación verificada

Los recibos siguientes corresponden al código de etapa 5 del commit [1852f1f](https://github.com/SrEdgarR/tr8/commit/1852f1f3b4dba1cea7bb1ede94bad731c9c8e44a), publicado en `SrEdgarR/tr8`. Identifican la versión comprobada de la interfaz y no afirman que ese SHA siga siendo el último commit después de actualizar esta documentación.

| Comprobación          | Resultado                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Vercel                | `READY`, destino `production`, despliegue `dpl_JCQdYcaMeXsYAud5yDxrc6PKMc47`                                                         |
| URL del despliegue    | [tr8-9t5d4odm1-mr-xpras-projects.vercel.app](https://tr8-9t5d4odm1-mr-xpras-projects.vercel.app)                                     |
| Alias comprobado      | [tr8.vercel.app](https://tr8.vercel.app/)                                                                                            |
| Compilación de Vercel | 22,5 segundos                                                                                                                        |
| GitHub Actions        | [Run 40023189791](https://github.com/SrEdgarR/tr8/actions/runs/40023189791), `SUCCESS`; 250 pruebas de aplicación y 167 de funciones |

La comprobación HTTP de producción aprobó **32 verificaciones en seis solicitudes HTTPS**, sin solicitudes a la API de Google. La interfaz autenticada cargó el proyecto y tarea conservados, mostró **Conectar Google Calendar** y abrió su diálogo con foco inicial en **Continuar con Google**. Escape cerró el diálogo y devolvió el foco al botón de conexión. La vista a 390 píxeles no tuvo desbordamiento horizontal. El contenido de `/about` y `/privacy` se renderizó correctamente.

La consulta de Vercel observó cero errores de runtime en una ventana de 30 minutos y cero drains configurados. Esta observación se limita a Vercel: el adaptador Google se ejecuta en Supabase Edge y no queda cubierto íntegramente por los registros de Vercel. Publicar la interfaz o habilitar el programador no equivale a una conexión autorizada ni a una entrega de eventos.

## Verificaciones técnicas previas realizadas

Las comprobaciones siguientes ya se habían completado antes de la decisión de conectar directamente producción. Se conservan como evidencia histórica; no se requiere otra aceptación Google en prueba para publicar esta entrega.

La base de prueba tiene las migraciones `20261023195952_google_calendar_stage5.sql` y `20261023202750_google_calendar_reeligibility.sql`. La primera permanece inmutable. La segunda permite volver a proyectar una tarea que recupera fecha, responsable o acceso después de que Google confirmó la eliminación de su copia: asigna otro identificador y conserva el anterior. No reconstruye automáticamente los eventos eliminados manualmente ni los conservados al desconectar.

Pasaron 232 comprobaciones SQL de Google, incluidas 20 de esa recuperación, y 532 comprobaciones de regresión de las etapas anteriores. Los ensayos de restauración de la migración inicial y del ajuste conservaron el proyecto, tarea y metadatos privados respaldados dentro de transacciones revertidas. Una prueba con transacciones confirmadas comprobó la persistencia de reservas, la recuperación con un token nuevo y el rechazo de finalizaciones antiguas o duplicadas. Dos conexiones concurrentes disputaron la última unidad de presupuesto: una fue admitida y otra rechazada.

Con el proveedor desactivado pasaron 183 comprobaciones de acceso por HTTP, en 125 solicitudes con cuatro identidades sintéticas. Estas pruebas no hicieron llamadas a Google. La comprobación local previa comprende 250 pruebas de aplicación y 167 de funciones, además de tipos, lint, formato y compilación. El workflow de CI incluye ambos conjuntos por separado y su ejecución remota satisfactoria está enlazada arriba.

Contra las funciones desplegadas en prueba pasaron otras 373 comprobaciones en 63 solicitudes HTTP: inicio idempotente, retorno público 302 sin código en la URL de TR8, denegación, estado y navegador ajenos, otra sesión del mismo usuario, consumo único, caducidad antes del retorno o del consumo, y sesión cerrada. Se comprobó en Postgres que PKCE y resultado quedaban cifrados. No hubo canjes de códigos, credenciales de Google ni solicitudes al proveedor; esta evidencia acredita el transporte y los rechazos, no una sincronización.

La revisión previa del navegador comprobó la tarjeta de configuración pendiente, las páginas públicas y el ajuste a 390 píxeles sin desbordamiento horizontal. Después se verificó la publicación de producción como se registra arriba. Ninguna de esas comprobaciones acredita consentimiento ni entrega real de eventos. La integración Google de Supabase de prueba permanece desactivada y sin credenciales activas de Google. No se realizará allí una autorización OAuth ni una aceptación externa adicional.

## Alcance acordado

Google Calendar es una integración opcional de cada usuario de TR8, independiente del espacio seleccionado y de los administradores de equipos. No añade Google como método de inicio de sesión. La cuenta de Google puede ser distinta de la utilizada para entrar a TR8.

La proyección tiene una sola dirección, **TR8 → Google Calendar**. Un calendario secundario llamado **TR8** recibe las tareas personales y las asignadas al usuario en equipos, siempre con acceso vigente y alguna fecha o bloque horario. El bloque tiene prioridad sobre el vencimiento y este sobre la fecha de inicio; una tarea genera una sola copia por usuario y conexión. Los vencimientos siguen siendo fechas civiles y los bloques conservan sus instantes y zona IANA.

Completar conserva la copia con «Hecha»; reabrir retira esa marca. Reasignar, quitar fechas, eliminar la tarea o perder acceso solicita retirar la copia anterior. Las descripciones completas, datos financieros, asistentes e invitaciones a otras personas quedan fuera de esta integración. Google no modifica los datos de TR8.

Los proyectos, tareas, roles, preferencias horarias y procesos internos existentes deben conservarse. Se mantienen Supabase Free y Vercel Hobby. El correo opcional de **4B** y las altas externas permanecen desactivados.

## Interfaz y contrato de usuario

En **Configuración → Google Calendar** la interfaz consulta únicamente la conexión personal. No depende del permiso `project.read` del espacio que esté seleccionado. Cuando el servidor no está configurado muestra **Configuración pendiente** sin ofrecer una conexión inexistente.

La tarjeta distingue `disconnected`, `authorizing`, `provisioning`, `provisioning_unknown`, `connected`, `needs_reauthorization`, `disconnecting`, `cleanup_failed` y `error`. Presenta última sincronización confirmada, pendientes y fallos con motivos limitados a un catálogo. Una solicitud aceptada de reconciliación no se presenta como una sincronización terminada. Los fallos de lectura ocultan el estado anterior.

Conectar muestra primero el alcance y el límite de privacidad: una copia ya enviada podría permanecer en Google si se revoca el acceso antes de retirarla. El consentimiento enlaza las páginas públicas `/about` y `/privacy`, accesibles sin sesión y sin consultar datos de una cuenta. La desconexión permite elegir **conservar** o **intentar eliminar los eventos registrados de TR8**. Conservar es la opción inicial. No se elimina el calendario completo ni los eventos ajenos a TR8. Una limpieza fallida sigue visible y ofrece reintentar o confirmar que se conservarán las copias restantes antes de terminar la desconexión.

Una creación de calendario sin confirmación queda en `provisioning_unknown`; no se repite ciegamente. La recuperación solicita el identificador exacto del calendario y exige comprobación en el servidor, sin deducirlo por el nombre «TR8». Un evento eliminado manualmente queda pendiente de una acción explícita **Reconstruir eventos ausentes**; esta acción requiere confirmación y acceso vigente. No se importan ediciones de Google y una reconciliación puede restablecer los datos de TR8.

La vista de **Procesos e integraciones** conserva el significado de «Preparado» como resultado interno. El estado de Google se consulta en su tarjeta propia; una preparación interna no afirma que se entregó un evento externo.

## Frontera OAuth y transporte

La RPC pública `tr8_v2_get_google_status()` no acepta una identidad alternativa. Su respuesta contiene solamente:

```text
configured, state, generation, version,
last_sync_at, pending, failed, reason
```

Las operaciones del navegador usan `POST` a la Edge Function `tr8-google`, con una acción explícita. `begin` recibe `request_id`, `expected_version` y un secreto aleatorio del navegador; devuelve `authorization_url` y `state`. Su repetición lógica reutiliza el estado y PKCE cifrados del primer intento, sin crear otra autorización. `complete` recibe **únicamente `state` y `browser_secret`**: el navegador no le envía un código ni una denegación de Google. Las acciones `reconcile`, `disconnect`, `retry_cleanup`, `abandon_cleanup`, `recover_calendar` y `rebuild_missing` exigen un UUID de petición y la versión esperada. La desconexión añade `mode: keep | delete`; la recuperación añade `calendar_id`.

El navegador abre la ventana emergente dentro del clic y conserva el secreto de 32 bytes y el `state` del intento solo en memoria. Google vuelve a la URI exacta de Supabase `/functions/v1/tr8-google/callback`. Este endpoint valida el intento vigente, cifra el primer resultado `{code|error}` con AAD ligado al estado y al usuario, lo registra mediante `record_oauth_result` y responde **302** a la ruta fija de la aplicación `/google-calendar/callback`, sin query ni fragmento. El registro no canjea el código por tokens y no permite que una repetición sustituya un resultado ya registrado por otro diferente.

La ruta de retorno de TR8 es pública, anterior al control de acceso de la aplicación y no lee parámetros OAuth. Solo emite `{type:'tr8-google-oauth-ready'}` hacia `window.location.origin` y cierra la ventana cuando existe iniciador. La ventana principal acepta esa señal vacía exclusivamente desde su mismo origen y desde la ventana que abrió; ignora mensajes con código, estado u otros campos. Utiliza el `state` propio conservado en memoria para solicitar `complete`. La señal no demuestra autorización: el servidor todavía exige la sesión iniciadora viva, el secreto del navegador y un resultado cifrado ya recibido, con consumo único y caducidad.

El canje de código sucede exclusivamente en el servidor después de ese control. Los sobres de PKCE y resultado OAuth se descifran con propósitos distintos; sus recibos no duplican secretos. Un intento ajeno, repetido, vencido, reemplazado o sin resultado no concede una conexión. Si el retorno se abre sin ventana iniciadora, la página explica cómo volver a Configuración sin intentar canjear nada.

La autorización usa PKCE S256, acceso offline y exclusivamente `https://www.googleapis.com/auth/calendar.app.created`. La interfaz comprueba el destino HTTPS exacto de Google y los parámetros esenciales antes de navegar. Los códigos, verificadores y secretos no se guardan en almacenamiento del navegador ni en una URL persistente de TR8. Los tokens y secretos del cliente OAuth no forman parte de la respuesta al navegador ni de variables públicas `VITE_*`.

Una reconexión con calendario previo comprueba que la autorización nueva puede acceder al recurso vinculado; esto no se presenta como una comparación de identidad Google. Si el nuevo canje no entrega refresh token, conserva íntegro el sobre previo y devuelve `refresh_missing`: no mezcla el acceso nuevo con el refresh token de otra autorización. Una renovación normal del trabajador sí conserva su propio refresh token cuando Google omite otro valor. En la recuperación de calendario se guarda un token renovado antes de continuar con consultas remotas, para no perder una rotación si la consulta posterior falla.

El retorno mediante 302 mantiene el flujo en Supabase Free y Vercel Hobby. No depende de servir HTML ejecutable desde una respuesta API de Supabase ni de comprar un dominio personalizado.

La URI OAuth pública conserva HTTPS y `/functions/v1/tr8-google/callback`. El gateway alojado de Supabase entrega a Deno una URL interna HTTP sin `/functions/v1`; el receptor admite exclusivamente esa representación del mismo proyecto o la URL pública exacta. Ninguna cabecera ni parámetro del cliente decide el destino de retorno. Las pruebas incluyen ambas representaciones y el rechazo de otras ubicaciones.

El transporte del SDK tiene un plazo de 60 segundos combinado con la señal de cancelación de la sesión. Cerrar sesión o abandonar la pantalla cancela la operación local y descarta respuestas tardías; no se afirma que cancelar HTTP revierta una operación ya confirmada en el servidor. Las versiones y generaciones evitan que una respuesta antigua sustituya una conexión nueva. Los errores HTTP se convierten en mensajes propios, sin mostrar diagnósticos remotos o credenciales.

## Trabajador, persistencia y límites

La implementación añade tablas privadas para conexiones, intentos OAuth, correspondencias de eventos, trabajos, recibos y configuración de Google. La cola externa se distingue de la reconciliación interna de etapa 4A. Los identificadores de eventos se persisten antes de llamar a Google; las referencias mínimas sobreviven a la eliminación de tareas para permitir la limpieza.

El trabajador debe confirmar la reserva antes de la llamada externa, comprobar permisos y revisión vigentes, finalizar con una reserva válida y reconciliar resultados ambiguos. Los errores temporales respetan `Retry-After`; `invalid_grant` requiere reconexión. Una creación incierta de calendario no se reintenta automáticamente. No existe una transacción distribuida con Google ni una garantía de entrega exactamente una vez.

La migración instala la configuración y los cron de Google desactivados. Después de desplegar los endpoints y preparar los secretos, producción se habilitó como se registra arriba; prueba continúa desactivada. Los efectos externos se comprobarán directamente con la cuenta del propietario y requieren su consentimiento; no se condicionan a otra aceptación aislada. El despertar mediante SQL/HTTP solo debe ocurrir cuando hay trabajo elegible; la durabilidad corresponde a Postgres, no al mensaje de despertar ni a una pestaña abierta.

Los límites de Google son 500 solicitudes reservadas al día y 10.000 al mes, con lotes pequeños y hasta ocho intentos. Se mantienen junto con las cuotas reales gratuitas. Al alcanzar un límite, las tareas continúan utilizables y el trabajo queda pendiente; no se contrata ni activa un plan de pago. No se genera actividad artificial para evitar pausas del proyecto gratuito.

## Copia y ensayo de restauración

La publicación directa actualizó la copia privada previa y comparó los datos existentes antes y después de migrar producción, con el resultado de preservación registrado arriba. El formato `tr8-stage5-backup-v1` incluye proyectos, tareas, estado de la secuencia de tareas, las doce tablas privadas anteriores a 4A, las cuatro tablas de procesos de 4A y las identidades mínimas de Auth necesarias para sus referencias. Es una copia **previa a Google**: no incluye conexiones, tokens o secretos de Google.

Los ensayos ya realizados se generaron con `scripts/stage5/build-restore-rehearsal.mjs`, que produce SQL para el entorno sintético designado y termina siempre con `ROLLBACK`. Exige que la copia y el SQL generado estén fuera del repositorio, que las altas externas estén apagadas y que las identidades respaldadas no existan en el destino. Rechaza campos o tablas adicionales en el formato de copia y valida los estados de trabajos, reservas y runtime antes de generar SQL. No se solicita ni programa otro ensayo aislado como condición de la publicación actual.

El ensayo restaura las filas de negocio y metadatos, incluidos outbox, trabajos y recibos de 4A. El singleton `process_runtime` ya existente se bloquea y recibe los valores respaldados solamente dentro de la transacción del ensayo. No se intenta insertar otro singleton ni sustituir permanentemente los contadores del entorno de prueba. Se compara cada campo respaldado antes y después de la migración.

La secuencia exportada se representa mediante una secuencia **temporal**. No se rebobina la secuencia real del entorno de prueba. Las identidades mínimas de Auth no incluyen contraseñas ni sesiones y no constituyen una restauración completa de Auth o un mecanismo PITR. Los ensayos existentes, la comparación de producción y el despliegue de la interfaz constan arriba; falta la autorización real, sin presentar las comprobaciones históricas como consentimiento.

## Configuración Google para la conexión directa

La configuración actual utiliza **un único proyecto personal de Google Cloud, `tr8-sredgar`**, y su cliente web de producción para uso personal. Se omite la autorización OAuth en Supabase de prueba. La interfaz ya está publicada; no se afirma que existan proyectos Google independientes o una verificación pública de Google. La publicación OAuth de Google no habilita cuentas de TR8: sus altas siguen cerradas y cada operación exige una identidad habilitada.

El primer intento real fue bloqueado por Google con el mensaje de aplicación en pruebas y acceso limitado a usuarios aprobados. No llegó un resultado OAuth al servidor ni se obtuvieron credenciales de Google. El propietario debe ajustar el estado de publicación en Google Auth Platform antes de reintentar el consentimiento. En modo Pruebas las autorizaciones de Calendar expiran a los siete días; el estado En producción y la verificación pública de la marca son aspectos distintos. Véanse las condiciones de [audiencia de Google](https://support.google.com/cloud/answer/15549945) y la [excepción para uso personal](https://support.google.com/cloud/answer/13464323).

| Uso actual                      | Callback de producción                                                      |
| ------------------------------- | --------------------------------------------------------------------------- |
| Cuenta personal del propietario | `https://ggbjezprlsnhidlbjivl.supabase.co/functions/v1/tr8-google/callback` |

Supabase de prueba y producción permanecen separados. La integración Google del entorno de prueba queda desactivada y sin credenciales activas de Google; no se usará para el consentimiento ni para sincronizar los datos del propietario.

La comprobación real se realizará directamente en producción: consentimiento del propietario, revisión del estado de su conexión y comprobación de los efectos que se observen con sus tareas existentes y elegibles. No se crearán proyectos, tareas o eventos ficticios para una aceptación aislada. Conectar correctamente no acredita por sí solo que una tarea ya se entregó a Google.

Como práctica para futuros ensayos, conviene usar un proyecto independiente de Google Cloud si se decide probar una integración aislada mientras producción está conectada. La revocación de Google puede afectar a la concesión de todos los clientes del mismo proyecto; un segundo cliente dentro del proyecto personal no representa aislamiento suficiente. Esta recomendación futura no condiciona ni retrasa la conexión directa autorizada ahora.

## Autorización Google y comprobaciones pendientes

- Revisar durante la autorización el cliente web de producción, pantalla de consentimiento y callback exacto. Las páginas informativas y de privacidad ya están publicadas. No asumir que `tr8.studio` está comprado ni afirmar separación entre proyectos Google que aún no existe.
- Completar el ajuste del estado de publicación de Google y revisar alcance y condiciones de renovación de tokens al reintentar. Crear un proyecto o cliente no acredita consentimiento terminado, verificación o autorización duradera. Mantener el uso personal y las altas de TR8 cerradas.
- Conservar la copia y comparación ya realizadas, las migraciones aplicadas inmutables y las altas externas desactivadas. Las regresiones y ensayos anteriores permanecen documentados como verificaciones previas.
- Mantener la integración Google de prueba desactivada y sin credenciales activas; no realizar allí otra aceptación OAuth.
- Obtener el consentimiento directamente en producción y comprobar sesión, estado de conexión y efectos reales sobre las tareas existentes. Conservar la distinción entre pruebas simuladas, transporte HTTP ya verificado y entrega externa observada.
- Registrar una creación o actualización de evento solo cuando exista evidencia real de una tarea elegible; no afirmar entrega, «Hecha», retirada o limpieza por el mero éxito de la conexión. No crear datos ficticios ni cambiar los datos del propietario únicamente para simular esos casos.
- Mantener las verificaciones de escritorio, móvil y foco ya registradas y comprobar los estados que se observen durante la conexión. Las pruebas de interfaz y el despliegue satisfactorio no acreditan por sí solos el intercambio OAuth ni la entrega real.
- Añadir la evidencia de autorización y sincronización únicamente cuando ocurra. Vercel y CI ya están comprobados para el código publicado; Google seguirá pendiente hasta que el propietario lo autorice.

La implementación está publicada y verificada; la autorización real de Google permanece pendiente. Se continuará directamente en producción según la decisión del propietario, con planes gratuitos, datos conservados y altas externas desactivadas, sin afirmar una entrega externa todavía no observada.

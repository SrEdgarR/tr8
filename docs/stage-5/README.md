# Etapa 5 · Google Calendar

Estado: **publicación en curso; conexión real pendiente**. Por decisión expresa del propietario se omite la aceptación OAuth en un entorno aislado y se procederá directamente en producción, conservando los proyectos y tareas existentes. La conexión requiere su consentimiento real. Este documento no acredita todavía una publicación final ni entrega de eventos; los resultados de producción se registrarán cuando exista evidencia.

## Verificaciones técnicas previas realizadas

Las comprobaciones siguientes ya se habían completado antes de la decisión de conectar directamente producción. Se conservan como evidencia histórica; no se requiere otra aceptación Google en prueba para publicar esta entrega.

La base de prueba tiene las migraciones `20261023195952_google_calendar_stage5.sql` y `20261023202750_google_calendar_reeligibility.sql`. La primera permanece inmutable. La segunda permite volver a proyectar una tarea que recupera fecha, responsable o acceso después de que Google confirmó la eliminación de su copia: asigna otro identificador y conserva el anterior. No reconstruye automáticamente los eventos eliminados manualmente ni los conservados al desconectar.

Pasaron 232 comprobaciones SQL de Google, incluidas 20 de esa recuperación, y 532 comprobaciones de regresión de las etapas anteriores. Los ensayos de restauración de la migración inicial y del ajuste conservaron el proyecto, tarea y metadatos privados respaldados dentro de transacciones revertidas. Una prueba con transacciones confirmadas comprobó la persistencia de reservas, la recuperación con un token nuevo y el rechazo de finalizaciones antiguas o duplicadas. Dos conexiones concurrentes disputaron la última unidad de presupuesto: una fue admitida y otra rechazada.

Con el proveedor desactivado pasaron 183 comprobaciones de acceso por HTTP, en 125 solicitudes con cuatro identidades sintéticas. Estas pruebas no hicieron llamadas a Google. La comprobación local actual comprende 250 pruebas de aplicación y 167 de funciones, además de tipos, lint, formato y compilación. CI ejecuta ambos conjuntos por separado.

Contra las funciones desplegadas en prueba pasaron otras 373 comprobaciones en 63 solicitudes HTTP: inicio idempotente, retorno público 302 sin código en la URL de TR8, denegación, estado y navegador ajenos, otra sesión del mismo usuario, consumo único, caducidad antes del retorno o del consumo, y sesión cerrada. Se comprobó en Postgres que PKCE y resultado quedaban cifrados. No hubo canjes de códigos, credenciales de Google ni solicitudes al proveedor; esta evidencia acredita el transporte y los rechazos, no una sincronización.

La revisión del navegador comprobó la tarjeta de configuración pendiente, las páginas públicas y el ajuste a 390 píxeles sin desbordamiento horizontal. Las comprobaciones anteriores no acreditan consentimiento ni entrega real de eventos. La publicación de producción está en curso; la integración Google de Supabase de prueba permanece desactivada y sin credenciales activas de Google. No se realizará allí una autorización OAuth ni una aceptación externa adicional.

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

La migración empieza con la configuración y los cron de Google desactivados. La configuración de producción se habilita después de desplegar los endpoints y preparar los secretos del servidor y el consentimiento. Los efectos externos se comprobarán directamente con la cuenta del propietario; no se condicionan a otra aceptación aislada. El despertar mediante SQL/HTTP solo debe ocurrir cuando hay trabajo elegible; la durabilidad corresponde a Postgres, no al mensaje de despertar ni a una pestaña abierta.

Los límites de Google son 500 solicitudes reservadas al día y 10.000 al mes, con lotes pequeños y hasta ocho intentos. Se mantienen junto con las cuotas reales gratuitas. Al alcanzar un límite, las tareas continúan utilizables y el trabajo queda pendiente; no se contrata ni activa un plan de pago. No se genera actividad artificial para evitar pausas del proyecto gratuito.

## Copia y ensayo de restauración

La publicación directa conserva la copia privada previa y exige actualizarla antes de migrar producción para comparar los datos existentes antes y después. El formato `tr8-stage5-backup-v1` incluye proyectos, tareas, estado de la secuencia de tareas, las doce tablas privadas anteriores a 4A, las cuatro tablas de procesos de 4A y las identidades mínimas de Auth necesarias para sus referencias. Es una copia **previa a Google**: no incluye conexiones, tokens o secretos de Google.

Los ensayos ya realizados se generaron con `scripts/stage5/build-restore-rehearsal.mjs`, que produce SQL para el entorno sintético designado y termina siempre con `ROLLBACK`. Exige que la copia y el SQL generado estén fuera del repositorio, que las altas externas estén apagadas y que las identidades respaldadas no existan en el destino. Rechaza campos o tablas adicionales en el formato de copia y valida los estados de trabajos, reservas y runtime antes de generar SQL. No se solicita ni programa otro ensayo aislado como condición de la publicación actual.

El ensayo restaura las filas de negocio y metadatos, incluidos outbox, trabajos y recibos de 4A. El singleton `process_runtime` ya existente se bloquea y recibe los valores respaldados solamente dentro de la transacción del ensayo. No se intenta insertar otro singleton ni sustituir permanentemente los contadores del entorno de prueba. Se compara cada campo respaldado antes y después de la migración.

La secuencia exportada se representa mediante una secuencia **temporal**. No se rebobina la secuencia real del entorno de prueba. Las identidades mínimas de Auth no incluyen contraseñas ni sesiones y no constituyen una restauración completa de Auth o un mecanismo PITR. Los ensayos existentes constan en el registro anterior; el cierre actual debe añadir la comparación de datos y el despliegue de producción, sin presentar las comprobaciones históricas como consentimiento real.

## Configuración Google para la conexión directa

La configuración actual utiliza **un único proyecto personal de Google Cloud, `tr8-sredgar`**, y su cliente web de producción, acotado al uso personal y sin ampliar la audiencia. Se omite la autorización OAuth en Supabase de prueba. No se afirma que ya existan proyectos Google independientes, una verificación pública, un despliegue final o una autorización duradera.

| Uso actual                      | Callback de producción                                                      |
| ------------------------------- | --------------------------------------------------------------------------- |
| Cuenta personal del propietario | `https://ggbjezprlsnhidlbjivl.supabase.co/functions/v1/tr8-google/callback` |

Supabase de prueba y producción permanecen separados. La integración Google del entorno de prueba queda desactivada y sin credenciales activas de Google; no se usará para el consentimiento ni para sincronizar los datos del propietario.

La comprobación real se realizará directamente en producción: consentimiento del propietario, revisión del estado de su conexión y comprobación de los efectos que se observen con sus tareas existentes y elegibles. No se crearán proyectos, tareas o eventos ficticios para una aceptación aislada. Conectar correctamente no acredita por sí solo que una tarea ya se entregó a Google.

Como práctica para futuros ensayos, conviene usar un proyecto independiente de Google Cloud si se decide probar una integración aislada mientras producción está conectada. La revocación de Google puede afectar a la concesión de todos los clientes del mismo proyecto; un segundo cliente dentro del proyecto personal no representa aislamiento suficiente. Esta recomendación futura no condiciona ni retrasa la conexión directa autorizada ahora.

## Publicación y conexión directa pendientes

- Completar y revisar el cliente web de producción, pantalla de consentimiento, callback exacto y páginas informativas y de privacidad publicadas. No asumir que `tr8.studio` está comprado ni afirmar separación entre proyectos Google que aún no existe.
- Revisar el estado de publicación, audiencia, alcance solicitado y condiciones de renovación de tokens. Crear un proyecto o cliente no acredita consentimiento terminado, verificación o autorización duradera. Mantener el alcance personal y no ampliar la audiencia.
- Actualizar la copia privada, aplicar las migraciones de producción y comparar los datos conservados; mantener las migraciones ya aplicadas inmutables y las altas externas desactivadas. Las regresiones y ensayos anteriores permanecen documentados como verificaciones previas.
- Dejar la integración Google de prueba desactivada y sin credenciales activas; no realizar allí otra aceptación OAuth.
- Obtener el consentimiento directamente en producción y comprobar sesión, estado de conexión y efectos reales sobre las tareas existentes. Conservar la distinción entre pruebas simuladas, transporte HTTP ya verificado y entrega externa observada.
- Registrar una creación o actualización de evento solo cuando exista evidencia real de una tarea elegible; no afirmar entrega, «Hecha», retirada o limpieza por el mero éxito de la conexión. No crear datos ficticios ni cambiar los datos del propietario únicamente para simular esos casos.
- Revisar escritorio, móvil, teclado, foco, fallos, limpieza pendiente y cancelación tras cambio de cuenta. Las pruebas unitarias existentes de interfaz no acreditan por sí solas el intercambio OAuth ni la entrega real.
- Confirmar SHA publicado y estado del despliegue; registrar evidencia final y límites. La conexión seguirá pendiente hasta que el propietario autorice Google.

La publicación está en curso y la conexión real permanece pendiente. Se avanzará directamente en producción según la decisión del propietario, con planes gratuitos, datos conservados y altas externas desactivadas.

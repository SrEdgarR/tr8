# Finanzas personales · entrega productiva

## Preferencia actual: acceso con la cuenta

Por decisión del propietario, Finanzas se abre directamente con su sesión de
TR8, sin contraseña privada adicional. El documento normal se guarda en
`tr8_private.account_finances`, sin cifrado privado del lado del cliente. No hay
acceso directo a esa tabla: el RPC deriva el propietario de `auth.uid()`, verifica
la sesión viva, limita el documento y serializa las escrituras por propietario.
La versión esperada y el ID de operación evitan sobrescrituras y duplicados al
reintentar. El cliente valida el dominio financiero completo antes de guardar y
después de leer. Los datos se mantienen fuera de React Query y del almacenamiento
local del navegador.

La bóveda descrita abajo es opcional y conserva sus datos y protocolo anteriores.
Es un espacio independiente: abrirla no convierte ni mueve el documento normal.
La interfaz y privacidad lo explican explícitamente. Los respaldos JSON normales
no están cifrados con contraseña privada; su restauración requiere vista previa
y escribir `REEMPLAZAR`. Los respaldos cifrados se gestionan desde la bóveda.

El esquema añadido no modifica proyectos, tareas, cuentas Auth, envelopes,
recibos ni autoridades de las bóvedas existentes. Se mantiene el plan gratuito.

La actualización pasó 662 pruebas de aplicación y 503 de Edge. Se comprobó en
TEST la carrera CAS (un solo ganador), reintento exacto, rechazo de un ID de
operación con contenido distinto, aislamiento entre cuentas y denegación a anon.
En el navegador se guardó una cuenta ficticia de 123,45 BOB y se conservó su saldo
tras recargar, sin crear una bóveda ni introducir una contraseña privada.

2026-10-25. Continuación de 6B.1–6B.5D para la cuenta personal del propietario.
Las entregas sintéticas anteriores conservan sus cercas; el servicio productivo
es `tr8-vault`, con configuración y generación independientes. Los equipos y sus
roles no conceden acceso financiero. Las altas externas siguen cerradas.

## Funcionalidad

- Bóveda con contraseña privada distinta de la cuenta, código de recuperación y
  confirmación de custodia antes del primer guardado.
- Cuentas de efectivo, débito y crédito; ingresos, gastos, transferencias, pagos
  de tarjeta y reembolsos. Importes enteros en unidades menores, por moneda.
- Historial y filtros; planes confirmables, posponibles o cancelables y
  proyecciones que no modifican los saldos reales.
- Respaldo cifrado, importación a un contexto nuevo y restauración con vista
  previa y confirmación escrita. Cambio de contraseña, recuperación y renovación
  de claves dentro del Worker.
- Reinicio irreversible de la bóveda con contraseña de TR8 y la frase
  `ELIMINAR BÓVEDA`. La petición queda ligada al ID de la bóveda observada; otra
  bóveda creada entretanto produce conflicto. Retira el contexto y cierra las
  sesiones; conserva proyectos y tareas.

El propietario configura sus medios privados en la aplicación. El servidor no
elige ni recibe la contraseña privada o el código. No se guardan importes o
movimientos en Google, correo, React Query, localStorage ni el registro externo.

## Cierre del ADR F02 y límite de confianza

El contenido cifrado reside en PostgreSQL. Cloudflare Durable Objects conserva
el head y los hechos de seguridad. Un testigo privado en Vercel Blob conserva
ese mismo estado y la intención pendiente. Está fuera de los dominios de
restauración de PostgreSQL y Cloudflare.

Las lecturas privadas de Blob utilizan origen (`cache=0`, equivalente a
`get({useCache:false})` del SDK 2.4.0). Las escrituras utilizan CAS de ETag
(`x-if-match`, equivalente a `put({ifMatch})`). Se verificaron lectura inmediata
tras escritura y rechazo de un ETag anterior contra el servicio alojado. El
adaptador usa Fetch nativo: el SDK Node/undici provocaba un fallo de Brotli en
Supabase Edge y no se usa en esa ruta.

1. Validar Auth, sesión real en SQL, propietario y transición actual.
2. Preparar una intención durable en Cloudflare y en Blob antes de aplicar SQL.
3. Aplicar proyección y recibo transaccional, con fencing de versión y sesión.
4. Confirmar Cloudflare y después el testigo mediante CAS. Solo entonces dar ACK.
5. Antes de devolver un envelope, comparar los registros, validar su hash contra
   SQL y volver a observar las autoridades. Un recibo histórico no sustituye esto.

Una autoridad ausente, antigua, divergente, un límite del proveedor o una
operación pendiente mantiene cerrado el acceso. Una confirmación parcial se
reanuda con la misma intención; nunca vence por TTL. Reintentar un PUT conserva
sus bytes. Si la respuesta se perdió tras confirmar, el controlador solo adopta
el head que corresponde al mismo operationId y revisión del ACK. Un head leído
antes de un cambio de credenciales tampoco se puede descifrar como versión actual.

La garantía presupone que al menos uno de los dos dominios independientes
conserva su estado actual y que el código/credenciales de servicio son de
confianza. No cubre restaurar ambos registros a la misma versión antigua ni un
operador malicioso que controle todos los servicios. Tampoco revoca copias ya
descargadas o información que el usuario ya vio. Los respaldos antiguos conservan
sus medios de acceso originales.

## Sesiones

El login de Supabase no basta: cada sesión financiera se inscribe con una prueba
reciente comprobada en Auth. Revocación, cierre global, recuperación de cuenta y
reset preparan el hecho independiente antes de retirar sesiones en SQL/Auth.
Los guards impiden saltarse esa secuencia con cambios directos de identidad.
La recuperación de cuenta acepta el AMR de recuperación/OTP verificado contra
Auth; el cambio de contraseña ocurre después del cierre global confirmado.

Realtime transporta exclusivamente invalidaciones. Su política permite al JWT
del propio usuario recibir el aviso incluso cuando su sesión acaba de revocarse;
eso no permite leer ciphertext. Las lecturas financieras siguen comprobando
`auth.sessions`, generación, cortes y revocaciones en el servidor. Otro head,
una revocación, el cierre del canal, navegación o cambio de identidad bloquean
el Worker. En segundo plano se limpia la vista, con cierre a los 60 segundos;
el límite de inactividad es cinco minutos. No se promete borrar información de
un dispositivo desconectado que ya la recibió.

## Operación y recuperación

- Supabase Free, Workers Free y Vercel Hobby. Blob es privado y pertenece al
  proyecto `tr8` de Horizon Studios. No hay upgrade automático ni polling
  financiero continuo. Cada mutación requiere dos escrituras condicionales del
  testigo; sus cuotas pueden limitar la disponibilidad de un uso intensivo.
- Recursos separados: `tr8-vault` / `tr8-vault-staging`. Bootstrap explícito una
  sola vez, después cerrado; las lecturas nunca crean un registro ausente.
- Secretos distintos por entorno, guardados solo en configuración de servicios
  y archivos privados fuera de Git. Credenciales de Blob nunca llegan al frontend.
- Ante restauración conocida: poner `tr8_live.config.quarantined=true`; observar
  ambas autoridades actuales, validar el envelope completo y el recibo vigente,
  ejecutar la reparación privada y volver a verificar antes de liberar.
- La ruta de reparación no está expuesta al navegador. Los recibos negativos
  pueden finalizarse por el operador cuando la sesión iniciadora ya desapareció.
- Si se pierde una autoridad y no puede recuperarse con continuidad demostrable,
  mantener el cierre. La recuperación requiere una nueva generación revisada,
  conservar retiros/revocaciones del registro superviviente y una importación
  explícita con contexto y claves nuevos. El bootstrap vacío del despliegue
  existente no es un mecanismo de recuperación y no debe habilitarse para ello.
- Descargar respaldos cifrados desde Seguridad y custodiar contraseña/código
  fuera de TR8. Perder ambos medios privados impide recuperar el contenido.

## Evidencia

658 pruebas de aplicación y 503 de Edge aprobadas. Incluyen carreras al abrir
versiones anteriores, ACK propio frente a otro dispositivo, divergencias de
autoridades, CAS, fallos parciales y límites de transporte. TypeScript, ESLint,
formato, comprobación SQL y builds financieros forman parte de CI.

En la cuenta ficticia preexistente del proyecto TEST se ejecutaron:

1. Creación/custodia con Worker, Argon2id y AES-GCM reales, y cuatro revisiones
   confirmadas mediante la ruta Edge real con CORS.
2. Cuenta BOB 1.250,50; gasto 25,50 → saldo 1.225,00; plan 100 → proyección
   1.125,00, manteniendo el saldo real. Bloqueo y reapertura desde SQL.
3. Restauración lógica de revisión 4 a 3: HTTP 409 sin envelope. Reparación
   privada en cuarentena contra el head vigente y reapertura de revisión 4.
4. Recuperación Auth real sin enviar correo: cierre global, rechazo de sesión
   anterior y login posterior, preservando la contraseña de la fixture.
5. Reinicio con confirmación incorrecta y contexto distinto rechazados; reinicio
   correcto retira la bóveda, deniega la sesión antigua y deja vacía una sesión
   nueva. No se borró el usuario ficticio ni sus proyectos/tareas.
6. Realtime alojado: una sesión recibió su invalidación después de eliminarse
   de Auth, mientras la ruta financiera de esa sesión respondió 401. El aviso no
   contenía contenido financiero.

Los hashes completos de producción permanecen: proyectos
`24d612b15fc2caf2c2c21cfe21b0d785` (2) y tareas
`89767fcefe177918ffc25689e8bf3ed0` (2). TEST conserva 11 proyectos y 25 tareas.
Las cuatro migraciones nuevas tienen contenido idéntico en ambas bases. Se
normalizó únicamente su versión de seguimiento en TEST para coincidir con las
versiones productivas, sin modificar SQL aplicado ni repetir DDL.

Fuentes del contrato de almacenamiento:
[Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk),
[cuotas](https://vercel.com/docs/vercel-blob/usage-and-pricing) y
[Workers / Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/).

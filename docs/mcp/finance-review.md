# MCP financiero de TR8 — revisión local

Decisiones confirmadas el 30 de octubre de 2026, zona `America/La_Paz`.
El 31 de octubre se autorizó aplicar las migraciones y publicar OAuth para un
DOT de **solo lectura**. Las migraciones ya se aplicaron sin alterar los
proyectos, tareas o documentos financieros. La importación permanece apagada;
la conexión cloud y su consentimiento se comprueban por separado.
Las identidades, claves y avisos de los ensayos contables siguen siendo ficticios.

## Arquitectura y seguridad conservada

| Capa existente                        | Reutilización                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `api/mcp.ts`, `server/mcp/http.ts`    | Streamable HTTP, autenticación Bearer, límite de cuerpo y errores saneados.               |
| `server/mcp/backend.ts`               | Clave pública de Supabase y RPC acotada; sin `service_role` ni sesión de usuario copiada. |
| `tr8_private.account_finances`        | Finanzas normales: documento JSON por propietario, legible por el servidor.               |
| `domain/money.ts`, dominio financiero | Importes en unidades menores enteras, precisión de moneda y validación de movimientos.    |
| Guardado financiero interactivo       | Conserva su comprobación de sesión real, versión optimista y bloqueo por propietario.     |
| Bóveda cifrada opcional               | Excluida. No se entrega contraseña/clave al servidor ni se descifra o migra su contenido. |

La bóveda depende de una clave del lado cliente. Un agente desatendido no puede
escribir allí con este diseño. Esta entrega opera únicamente sobre Finanzas
normales y no modifica ese modelo de seguridad.

El nuevo RPC `tr8_mcp_finance_dispatch` valida directamente permisos, cuentas,
monedas, categorías y datos de cada aviso. Nunca acepta un snapshot arbitrario
del agente. Comparte el bloqueo `tr8-account-finance:<owner>` con el guardado
interactivo: una pestaña con una versión anterior recibe conflicto en lugar de
sobrescribir un movimiento llegado desde el MCP.

Las conexiones actuales no heredan acceso financiero por tener permiso `write`.
El propietario debe concederlo expresamente, desde una sesión real vigente, a
una conexión concreta de su espacio personal. Define consulta o registro,
cuentas, categorías y buzones autorizados, y un instante de inicio por cuenta.
Los equipos y sus administradores no reciben acceso a estas finanzas.

## Reglas acordadas

- Solo ingresos y compras confirmados, completos, posteriores al inicio y con
  referencia bancaria real inequívoca son elegibles para registro.
- Transferencias propias, pagos de tarjeta, devoluciones, anulaciones, avisos
  pendientes/rechazados, posibles duplicados e información incompleta se guardan
  en una bandeja independiente. **No alteran saldos ni planes.**
- Un ingreso a una tarjeta y un ingreso clasificado como devolución también
  necesitan revisión: pueden ser un pago o reembolso, no ingreso nuevo.
- No se hacen conversiones de moneda ni operaciones en bancos. Una moneda
  incompatible se rechaza; no se elige otra cuenta ni se inventa una tasa.
- Los avisos del día de apertura o incluidos en un saldo de tarjeta ya capturado
  se revisan, aunque sean posteriores al inicio de importación. La granularidad
  diaria del saldo inicial no permite demostrar que estén excluidos.
- Una coincidencia de importe y fecha genera revisión, nunca fusión automática.
  Dos compras iguales pueden ser legítimas.
- Categoría omitida: `other`, solo si está autorizada. No se crean categorías.
- La revisión permite consultar o descartar avisos. Aprobar transferencias,
  reembolsos o correcciones requiere conciliación manual usando los tipos
  contables existentes; esta versión no da al agente esas facultades.

## Herramientas nuevas

Se publican en el catálogo MCP únicamente cuando el servidor se habilita
expresamente. El RPC comprueba los permisos de nuevo en cada llamada.

| Herramienta                   | Campos de entrada                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `tr8_get_finance_context`     | Ninguno. Devuelve acceso financiero, cuentas, inicio, buzones, categorías y versión.            |
| `tr8_list_finance_accounts`   | `cursor?`, `limit?` (1–100). Solo cuentas autorizadas.                                          |
| `tr8_list_finance_categories` | Ninguno. Categorías permitidas de ingresos y gastos.                                            |
| `tr8_list_finance_movements`  | `date_from`, `date_to` exclusivo (máximo 93 días), `account_id?`, `kind?`, `cursor?`, `limit?`. |
| `tr8_submit_finance_notice`   | Aviso mínimo descrito abajo. Es la única escritura MCP nueva.                                   |
| `tr8_list_finance_reviews`    | `cursor?`, `limit?`. Solo avisos de las cuentas autorizadas.                                    |

Los listados devuelven `items` y `next_cursor`; recorrer todas las páginas antes
de afirmar que una consulta está completa. Los movimientos exponen concepto,
fecha e importes del lado autorizado, no notas privadas. Un pago DOP→USD no
expone el débito DOP si la conexión solo tiene autorizado el bolsillo USD.

El permiso de consulta abarca los movimientos de las cuentas seleccionadas en
todas sus categorías, necesario para conciliar registros previos. Las listas de
categorías limitan los nuevos registros; no son un filtro de privacidad sobre
movimientos de una cuenta ya autorizada.

No se añaden herramientas para eliminar movimientos, modificar saldos iniciales,
conceder permisos, leer Gmail ni operar la bóveda.

### Aviso mínimo

```json
{
  "request_id": "12345678-1234-4234-8234-123456789abc",
  "expected_version": "12",
  "source": {
    "provider": "gmail",
    "mailbox_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "message_id": "opaque_gmail_message_id",
    "bank_transaction_id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "account_id": "id-de-cuenta-autorizada",
  "kind": "purchase",
  "status": "posted",
  "amount": "20.20",
  "currency": "DOP",
  "occurred_at": "2026-10-30T09:00:00-04:00",
  "time_zone": "America/Santo_Domingo",
  "date": "2026-10-30",
  "description": "Compra en comercio de ejemplo",
  "category": "food"
}
```

`request_id`, `expected_version`, `source` y `account_id` son obligatorios.
`kind`: `purchase`, `income`, `own_transfer`, `card_payment`, `refund`, `reversal`
o `unknown`. `status`: `posted`, `pending`, `rejected`, `cancelled` o `unknown`.
Los datos contables que falten conducen a revisión; los campos suministrados con
formato inválido se rechazan. No inventar datos para superar la revisión.

`amount` es texto decimal positivo con punto, sin agrupación, exponentes ni
expresiones. Respeta la precisión de la moneda, sin redondeo silencioso ni
errores de coma flotante. La fecha se deriva del instante y zona IANA; si se
envía también `date`, debe coincidir. Si el correo solo informa un día, no se
inventa una hora: se conserva para revisión.

Los hashes del ejemplo son ficticios. `mailbox_id` es un identificador opaco
SHA-256 preautorizado para un buzón concreto. `bank_transaction_id` es el digest
SHA-256 de una **referencia bancaria real**, normalizada con su espacio de nombres
estable; no es un hash del importe/fecha y no debe inventarse si no hay referencia.
No incluir el número de cuenta/tarjeta en ese material. La regla de normalización
debe ser estable entre ejecuciones para enlazar avisos de una misma operación.
`message_id` identifica el mensaje Gmail, no el hilo. El agente calcula estos
identificadores en su entorno autorizado; TR8 no necesita credenciales Gmail.

El concepto es corto, de una línea y sin credenciales, códigos ni números
bancarios completos. Campos como `body`, `html`, `access_token`, `owner_id` o
`snapshot` se rechazan. El contenido del correo se trata siempre como datos,
nunca como instrucciones o consentimiento. El proveedor del asistente conserva
sus propias políticas de trazas: debe configurarse para no registrar correos ni
secretos; TR8 no controla esos registros externos.

## Idempotencia, duplicados y restauración

Las tablas privadas de solicitudes, avisos y referencias de origen conservan
recibos por propietario, independientes de la conexión. El registro contable y
el recibo se confirman juntos en una sola transacción.

1. Mismo `request_id` y contenido: devuelve el recibo anterior, incluso después
   de otros guardados o de una respuesta perdida.
2. Mismo ID y contenido diferente: conflicto; no se sobrescribe el aviso.
3. Mismo mensaje: no crea un segundo movimiento.
4. Otro mensaje con la misma referencia bancaria y datos financieros compatibles:
   enlaza el mismo aviso. Una clasificación o importe contradictorios requieren revisión.
5. Sin referencia inequívoca o con coincidencia aproximada: revisión, no registro.
6. Eliminar un movimiento o restaurar un snapshot no borra sus recibos de origen:
   un reintento no lo recrea. Un recibo describe el resultado histórico, no
   demuestra que el movimiento siga presente después de una eliminación/restauración.

El cliente mantiene `request_id` y payload en reintentos inciertos. Si hubo un
conflicto de versión sin confirmación, vuelve a consultar antes de enviar la
versión vigente. La política contable y el registro de origen no se guardan en
tareas, notas ni planes financieros.

Para acotar almacenamiento en el plan gratuito, cada propietario tiene un máximo
de 10.000 avisos, 20.000 referencias de mensajes y 30.000 recibos de solicitudes.
Al alcanzarlo, las solicitudes nuevas fallan con `PT429` sin modificar saldos;
los reintentos con su ID original conservan su respuesta. Nunca se elimina el
historial de deduplicación para liberar espacio automáticamente. Estos límites
no sustituyen las cuotas de almacenamiento y uso de Supabase.

Los respaldos financieros actuales siguen siendo compatibles, pero no incluyen
la bandeja ni los recibos de origen. Restaurar el libro contable conserva esos
recibos del servidor. No habilitar importaciones históricas por restaurar un
respaldo. El traslado a otro proyecto Supabase necesitará migrar también ese
registro privado antes de reanudar la integración.

## Revisión local y activación separada

Las opciones vienen apagadas en `.env.example`; se habilitan expresamente para
el despliegue autorizado. El catálogo PAT tiene un interruptor independiente:

- `TR8_MCP_FINANCE_REVIEW_ENABLED=false`: servidor MCP.
- `VITE_TR8_MCP_FINANCE_REVIEW_ENABLED=false`: panel de revisión en
  Finanzas → Seguridad. Es presentación, no una barrera de autorización.
- `TR8_MCP_LEGACY_FINANCE_ENABLED=false`: conservar el catálogo de 11
  herramientas del MCP PAT; no habilitarlo para el despliegue OAuth del DOT.

Habilitar un panel no concede permisos ni instala la migración. El panel carga
las conexiones existentes solo por una acción explícita; las concesiones se
limitan a cuentas del propietario y exigen confirmación del alcance. No crea
claves MCP. Cada operación de gestión necesita sesión real vigente.

Las migraciones se generaron por CLI y se aplicaron tras autorización explícita;
sus versiones locales coinciden con el historial alojado. No se modifican sus
contenidos después de aplicarlas. Las
pruebas SQL usan identidades ficticias y rollback. Los ensayos utilizan PGlite y
PostgreSQL nativo en loopback, sin recursos alojados ni credenciales de TR8.

## Conectar el dot sin PC: hallazgo y pendiente

OpenAI documenta que un dot tiene un ordenador cloud, permanece disponible con
el PC apagado y usa plugins autorizados por la cuenta. Esto no implica que
herede las conexiones MCP, variables o sesiones del Codex local.
[Documentación de dots](https://learn.chatgpt.com/docs/dots/computers-and-apps).

El endpoint de proyectos de TR8 usa claves Bearer personales. La
configuración de un MCP como plugin en ChatGPT documenta OAuth para acceso
autenticado y no admite presentar una clave API personalizada. Por tanto,
**introducir solo la URL actual no completa el enlace cloud seguro**.
[Conectar un MCP personalizado](https://developers.openai.com/api/docs/guides/custom-mcp-server),
[autenticación de plugins](https://developers.openai.com/plugins/build/auth).

La ampliación incorpora un recurso financiero independiente con autorización
por código y PKCE S256, tokens opacos y consentimiento explícito. Reutiliza los
handlers OAuth mantenidos del SDK MCP; el almacenamiento, la revocación y los
permisos limitados se verifican en SQL. La publicación del protocolo y el permiso
financiero de consulta están autorizados; el acceso efectivo del cliente depende
de su callback exacto y del consentimiento. Véase [protocolo, pruebas y límites](./oauth-review.md).

Se descartó entregar al asistente un JWT de sesión de Supabase: restringir la
Data API no acredita por sí solo el aislamiento respecto a las API de Auth y las
RPC interactivas. El nuevo acceso no es un JWT de Supabase ni una clave MCP de
proyectos; solo funciona en `/api/mcp/finance`. Las conexiones publicadas de
proyectos y las sesiones del navegador conservan su comportamiento anterior.

Alternativas documentadas: un servicio cloud propio que invoque un MCP remoto
autenticado mediante la API Responses, o una sesión independiente de TR8 en el
navegador cloud del dot. La primera necesita configuración, custodia de un
acceso nuevo aprobado y cómputo/modelos; la segunda utiliza la interfaz web y no
demuestra una conexión MCP. Ninguna se activa en esta entrega.
[MCP remoto en Responses](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).

La prueba de lectura real desde el dot con el PC fuera de la ruta queda
pendiente de esa autorización y configuración. Un ensayo HTTP local, una
llamada desde este Codex o el hecho de alojar TR8 en Vercel **no cuentan como
prueba cloud del dot**.

El asistente deberá validar el remitente y la autenticidad de los avisos con las
capacidades autorizadas de Gmail y usar mapeos explícitos de cuentas. TR8 recibe
datos mínimos, por lo que no puede demostrar por sí solo que un correo procede
del banco ni corregir una extracción equivocada presentada como inequívoca.
Cualquier duda de origen o clasificación debe enviarse como `unknown` para
revisión. Esta entrega no incorpora un analizador de correos ni un programador
de ejecuciones.

## Verificación realizada

| Comprobación                       | Resultado local                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Suite de aplicación                | 1.729 pruebas aprobadas.                                                                                            |
| Suite de servidor/Edge             | 746 pruebas aprobadas, incluidas política financiera, protocolo OAuth y recurso separado.                           |
| RPC PostgreSQL/PGlite              | 129 comprobaciones financieras y 68 OAuth aprobadas en ambos motores.                                               |
| Concurrencia PostgreSQL nativo     | 149 comprobaciones adicionales, 25 escenarios y 33 bloqueos entre sesiones observados; 346 contando las suites SQL. |
| Cliente MCP → HTTP → RPC SQL       | 22 comprobaciones PAT y 30 del flujo OAuth completo; la conexión PostgREST se adapta a SQL local.                   |
| UI de gestión y consentimiento     | 24 pruebas de gestión y 19 OAuth incluidas en la suite; revisión visual en escritorio y a 390 px.                   |
| TypeScript, ESLint, formato, build | Aprobados.                                                                                                          |

Los ensayos SQL se ejecutan con `scripts/mcp/finance-sql-test.mjs`, pasando la
ruta absoluta de una instalación local de `@electric-sql/pglite` 0.5.13. La
dependencia se instaló fuera del repositorio solo para el ensayo: no es una
dependencia de TR8 ni crea recursos cloud. El ejecutor HTTP/SQL es
`scripts/mcp/finance-http-sql-test.mjs`; primero compilar:

```sh
npm run typecheck:mcp -- --noEmit false --outDir test-results/mcp-finance-runtime
node scripts/mcp/finance-sql-test.mjs /ruta/absoluta/@electric-sql/pglite
node scripts/mcp/finance-http-sql-test.mjs /ruta/absoluta/@electric-sql/pglite
```

Se verificaron ingresos/gastos, precisión, fechas y zonas, reintentos, respuestas
perdidas, avisos repetidos, coincidencias legítimas pendientes de revisión,
cuentas/buzones ajenos, lectura/escritura, monedas distintas, transferencias,
pagos, devoluciones, anulaciones, pendientes/rechazados, caducidad, revocación,
eliminación/restauración posterior, cuotas y redacción de datos antiguos. No se
consultó Gmail ni se escribieron movimientos o permisos reales.

Los ejecutores `finance-concurrency-test.mjs`, `oauth-concurrency-test.mjs` y
`oauth-http-sql-test.mjs` usan un PostgreSQL 18.6 temporal en `127.0.0.1` y varias
conexiones `pg`, con herramientas de prueba instaladas fuera del repositorio.
Observan bloqueos con `pg_blocking_pids` antes de liberar cada transacción:
no simulan concurrencia mediante un mutex JavaScript. Cierran conexiones y
servidor y verifican el puerto cerrado. Conservan carpetas ficticias inactivas:
una revisión automática rechazó eliminar un directorio anterior con la razón
«blocked by policy» y no se intentó eludirla.

## Criterios antes de publicar

- Mantener la publicación autorizada limitada a lectura; las reglas de escritura
  documentadas no activan una importación por sí solas.
- La contención entre varias sesiones de PostgreSQL ya se verificó localmente.
  Falta un ensayo autorizado de PostgREST/GoTrue alojado, sus permisos, sesión,
  caché de esquema y rutas Vercel; el adaptador SQL local no prueba esas capas.
- Verificar cuotas, planes gratuitos y altas externas cerradas sin modificarlos.
- La migración, el despliegue y el acceso cloud de consulta fueron autorizados;
  cualquier ampliación a escritura requiere otra autorización.
- Probar primero lectura cloud real, luego avisos ficticios, antes de cualquier
  activación automática. No importar históricos o movimientos reales durante
  la revisión.

# OAuth financiero — revisión y despliegue de solo lectura

El 31 de octubre de 2026 se autorizó probar Supabase y publicar lo necesario para
conectar el DOT con **solo lectura**. Se aplicaron las migraciones y se preparó
un permiso de consulta sobre las cuatro cuentas normales, sin buzones ni
categorías de escritura, con caducidad a los 30 días. Su registro padre contiene
únicamente un hash aleatorio sin clave PAT recuperable; no se copió ninguna
credencial de Codex. El cliente OAuth necesita su callback exacto y consentimiento
en ChatGPT antes de acceder. No se leyó Gmail ni se registraron movimientos
reales. El plan gratuito y las altas cerradas se conservan.

## Separación de seguridad

El recurso nuevo es `https://tr8.vercel.app/api/mcp/finance`. Acepta exclusivamente
tokens opacos `tr8_oauth_a_…`; no acepta claves PAT ni JWT del navegador. Solo
expone las seis herramientas financieras del [borrador financiero](./finance-review.md).
Un permiso de consulta expone cinco, sin la herramienta de registro.

Supabase autentica al propietario en la pantalla de consentimiento mediante su
sesión habitual, comprobada contra `auth.sessions`. Esa sesión nunca se entrega
al cliente OAuth. Se mantienen las RPC interactivas y la bóveda cifrada opcional.
El servidor utiliza únicamente la clave pública existente para invocar dos RPC
acotadas, sin `service_role` ni credenciales copiadas de Codex.

Se eligió una familia de tokens independiente porque un JWT de usuario de
Supabase también pertenece al dominio de confianza de Auth: limitar sus permisos
de Postgres no demuestra su aislamiento respecto a las operaciones de cuenta.
No se habilitó el OAuth Server de Supabase ni se alteraron las sesiones actuales.

Los handlers de autorización, token y revocación proceden del SDK MCP mantenido.
TR8 implementa en SQL las concesiones, los hashes y las transacciones. Esta capa
de seguridad propia requiere revisión antes de publicarse; superar un cliente
de prueba no equivale a certificar todo OAuth ni la conexión real con ChatGPT.

## Flujo implementado

1. El cliente descubre metadatos públicos y solicita código con PKCE **S256**, el
   recurso financiero exacto y `finance:read`; puede pedir además `finance:write`.
2. Solo se admiten clientes públicos previamente autorizados, con callback HTTPS
   exacto. No se ofrecen DCR, CIMD, secretos de cliente, grants de contraseña ni
   `client_credentials`. El registro de clientes viene **vacío**.
3. TR8 crea un intento de diez minutos. El código posterior dura cinco minutos.
   El navegador recibe solo su nonce; la
   página lo retira del historial y tiene `no-referrer` y `no-store`.
4. El propietario elige un permiso financiero existente de su espacio personal.
   Revisa cuentas, moneda, inicio, tipo de acceso y caducidad; debe confirmar
   expresamente. No se crea un permiso padre ni se concede acceso al cargar.
5. El intento queda ligado al propietario y a su sesión real. La aprobación debe
   presentar la huella del permiso **que se mostró**: si cambia mientras el
   usuario lo revisa, falla con conflicto, sin conceder un alcance nuevo.
6. El cliente canjea el código una sola vez. SQL valida recurso, cliente,
   callback, expiración y PKCE en la misma transacción que consume el código.
7. El acceso dura como máximo **15 minutos**. El refresh rota y el permiso
   completo dura como máximo **30 días**, limitado también por el permiso padre.
   Reutilizar un refresh consumido revoca su familia; un cliente ajeno no puede
   revocarla. Reducir a lectura durante la renovación no permite recuperar
   escritura posteriormente dentro de esa familia.
8. Cada llamada comprueba usuario, pertenencia al espacio, cliente, permiso
   padre, revisión del alcance, concesión, token y expiración. Revocar o cambiar
   el permiso padre invalida sus accesos derivados. Los controles de caducidad se
   repiten después de las esperas relevantes por bloqueos.

Los códigos y tokens se generan con entropía criptográfica y se almacenan solo
como hashes. Las respuestas de error no incluyen diagnósticos SQL, cuerpos de
solicitudes, tokens o sesiones. Los tokens solo se admiten en Authorization,
nunca en la URL. El callback se compara con el destino exacto revisado antes de
que el navegador regrese al cliente.

La configuración de revisión en Finanzas → Seguridad incluye un panel colapsado
para consultar y revocar asistentes. No carga datos hasta abrirlo ni crea
concesiones. Cancelar una autorización devuelve `access_denied` al callback.

## Bloqueos y contabilidad

El recurso OAuth entra en el mismo núcleo privado que el MCP financiero PAT.
Comparte bloqueo por propietario, versión optimista y recibos persistentes.
Un aviso concurrente por PAT y OAuth produce un único movimiento. Cambiar de
credencial no evita la idempotencia ni autoriza una cuenta ajena.

La revocación y las escrituras se serializan: si gana la revocación, el registro
se rechaza; si el movimiento ya se confirmó antes, revocar no lo borra. La
respuesta histórica de un reintento no demuestra la existencia actual de un
movimiento después de una eliminación o restauración manual.

Las operaciones ambiguas siguen en revisión sin afectar saldos. OAuth no añade
un lector de Gmail, un programador ni un importador automático. El transporte
no prueba que el contenido extraído sea verdadero ni que el remitente sea el banco.

## Apagado y límites gratuitos

Todos los interruptores nuevos vienen en `false`:

```dotenv
TR8_MCP_FINANCE_REVIEW_ENABLED=false
VITE_TR8_MCP_FINANCE_REVIEW_ENABLED=false
TR8_MCP_OAUTH_REVIEW_ENABLED=false
VITE_TR8_MCP_OAUTH_REVIEW_ENABLED=false
TR8_MCP_LEGACY_FINANCE_ENABLED=false
```

La migración tiene además su propio `enabled=false` inicial. Para esta
publicación autorizada se habilita el protocolo y sus cuatro variables de
revisión; `TR8_MCP_LEGACY_FINANCE_ENABLED` permanece en `false` para conservar las
herramientas de proyectos. Habilitar la interfaz no concede permisos.
No se añade un proveedor de identidad, servicio de pago o trabajo programado.
Las solicitudes futuras consumirán las cuotas normales de Vercel/Supabase.

Hay presupuestos SQL: 1.000 intentos pendientes globales, 20 concesiones activas
y 100 totales por propietario, y 10.000 filas de tokens por propietario. Los
metadatos OAuth expirados pueden depurarse según el borrador; no se borran los
recibos de deduplicación financieros. El límite de proceso del SDK complementa
estos presupuestos y no confía en `X-Forwarded-For` arbitrario. Antes de exponer
el protocolo públicamente debe revisarse también la protección frente a abuso
distribuido y las cuotas del proyecto.

## Evidencia local

| Capa                                       | Resultado                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| SQL financiero                             | 129 comprobaciones en PGlite y PostgreSQL 18.6.                                              |
| SQL OAuth                                  | 68 comprobaciones en ambos motores.                                                          |
| Concurrencia financiera                    | 67 comprobaciones, 13 escenarios, 17 barreras de bloqueo observadas.                         |
| Concurrencia OAuth                         | 82 comprobaciones, 12 escenarios, 16 barreras observadas.                                    |
| SDK OAuth → HTTP loopback → MCP → SQL real | 30 comprobaciones, 39 llamadas RPC, cuatro reintentos concurrentes y un movimiento.          |
| Regresión MCP PAT → HTTP → SQL             | 22 comprobaciones.                                                                           |
| Aplicación / servidor                      | 1.729 / 747 pruebas aprobadas.                                                               |
| Interfaz de consentimiento                 | 19 pruebas incluidas; revisión visual de escritorio y 390 px, sin desbordamiento horizontal. |

Las carreras verifican uso único del código, PKCE incorrecto seguido del correcto,
reutilización de refresh, revocación, reducción de permisos, expiración de token,
código, sesión o padre mientras se espera, huella de consentimiento obsoleta,
deduplicación entre PAT/OAuth y aislamiento entre propietarios. También se
prueban precisión decimal, monedas, mensajes ambiguos y operaciones en revisión.

Los ejecutores crean una base vacía en loopback; nunca leen el `.env` de TR8 ni
usan datos del usuario. El bootstrap simula dependencias mínimas de Auth y el
resto del esquema: no es una restauración completa de Supabase. Reutiliza el
cuerpo inmutable del guardado financiero interactivo y reproduce el bloqueo
real `FOR SHARE`/`FOR UPDATE` del espacio. Los servidores se detienen y sus
puertos se comprueban cerrados. Se conservan artefactos ficticios inactivos por
el rechazo de revisión automática documentado en la revisión financiera.

Para repetir con dependencias de prueba instaladas **fuera del repositorio**:

```sh
npm run typecheck:mcp -- --noEmit false --outDir test-results/mcp-finance-runtime
node scripts/mcp/finance-sql-test.mjs /ruta/absoluta/al/paquete/pglite
node scripts/mcp/oauth-sql-test.mjs /ruta/absoluta/al/paquete/pglite
node scripts/mcp/finance-concurrency-test.mjs /ruta/absoluta/herramientas-nativas
node scripts/mcp/oauth-concurrency-test.mjs /ruta/absoluta/herramientas-nativas
node scripts/mcp/oauth-http-sql-test.mjs /ruta/absoluta/herramientas-nativas
```

PGlite: `0.5.13`. Herramientas nativas actuales para Windows x64:
`@embedded-postgres/windows-x64@18.6.0-beta.19` (servidor 18.6) y `pg@8.23.1`.
Los scripts no descargan herramientas. Los resultados JSON y capturas locales
se guardan bajo `test-results/`, fuera del control de versiones.

## Pruebas alojadas y conexión del dot

- El usuario ya autorizó migraciones, despliegue y conexión de consulta; `main`
  está conectado al despliegue automático. No habilitar la importación.
- PostgREST real ya resuelve las cinco RPC y deniega tokens inválidos, gestión
  financiera anónima y consentimiento sin sesión. Auth confirma las altas
  desactivadas. Las 12 tablas nuevas tienen RLS y ningún permiso directo; los
  hashes de proyectos, tareas y finanzas se conservaron tras el DDL.
- Completar en el despliegue JWT/sesión reales, permisos de ejecución,
  caché de esquema, rutas y cabeceras Vercel. El ensayo completo usa un adaptador
  SQL en lugar del servidor PostgREST; no demuestra esas capas alojadas.
- Confirmar en la cuenta de ChatGPT la opción de cliente predefinido público con
  PKCE, y obtener el callback exacto que muestre la configuración. La
  [documentación oficial de OpenAI](https://developers.openai.com/plugins/build/auth)
  admite clientes predefinidos y PKCE; la disponibilidad y el flujo concreto de
  esa cuenta no se han probado. Si exige CIMD, DCR o autenticación de cliente,
  habrá que implementar y revisar esa compatibilidad antes de crear el acceso.
- Tras aprobarlo el propietario, registrar solo ese cliente/callback, crear o
  revisar el permiso financiero padre mínimo y completar el consentimiento.
  Empezar con lectura, sin copiar tokens del Codex local.
- Ejecutar una lectura desde el dot cloud sin que el PC actúe como puente.
  Una prueba loopback o desde Codex no cuenta como evidencia cloud.
- Mantener la importación apagada hasta otra aprobación explícita, verificar
  avisos ficticios y no importar históricos ni movimientos reales en esta fase.

La lectura desde el DOT cloud requiere evidencia de una llamada real desde su
entorno; ni los ensayos locales ni una llamada desde Codex la demuestran. El
despliegue y la conexión no habilitan un lector de Gmail ni importación automática.

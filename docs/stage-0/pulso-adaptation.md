# Adaptación de Pulso a TR8

Fecha: 2026-10-23. Estado: contrato propuesto de etapa 0; sin implementación,
migración de datos ni habilitación financiera. Este documento describe una
arquitectura nueva que debe verificarse antes de reutilizar Pulso en producción.

## Alcance y procedencia

La primera integración incorpora finanzas personales privadas por usuario. Los
equipos, sus propietarios y sus administradores no reciben acceso a una bóveda
ajena. No habrá presupuestos compartidos, claves compartidas, movimientos
financieros creados por tareas ni sincronización de finanzas con correo o Google
Calendar en esta entrega.

Fuentes revisadas en `SrEdgarR/PULSO`, fijadas al commit
[`b764bc55d08626c2ca57c131aaf76c0996356972`](https://github.com/SrEdgarR/PULSO/commit/b764bc55d08626c2ca57c131aaf76c0996356972),
consultado como `main` durante esta etapa:

| Fuente                                                                                                                                                                                                                                                                                                                                                                                          | Contrato observado                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [package.json](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/package.json)                                                                                                                                                                                                                                                                                    | React/TypeScript, Vinext, Hono, Better Auth y MongoDB; no requiere trasladar toda esa infraestructura a TR8 |
| [envelope.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/lib/vault/envelope.ts), [aad.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/lib/vault/aad.ts) y [constants.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/lib/vault/constants.ts)                                       | Formato cerrado, contexto autenticado, suite única y límites                                                |
| [opaque-contract.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/lib/vault/opaque-contract.ts) y [repository.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/server/src/vault/repository.ts)                                                                                                                            | CAS, transición de epochs, hash exacto del request, recibos y transacción durable                           |
| [body.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/server/src/vault/body.ts) y [routes/vault.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/server/src/routes/vault.ts)                                                                                                                                             | Límite sobre el stream real, validación y autorización de servidor                                          |
| [recent-auth.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/server/src/identity/recent-auth.ts)                                                                                                                                                                                                                                                            | Prueba de nuevo login, ligada a usuario y sesión, durante cinco minutos                                     |
| [core.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/server/src/operations/core.ts), [contract.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/server/src/lifecycle/contract.ts) y [retirement.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/server/src/lifecycle/retirement.ts) | Autoridad de identidad, sesión viva y retiro previo al uso de recibos                                       |
| [ADR-011](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/docs/decisions/0011-lifecycle-authority-fencing-and-retired-vault-protocol.md) y [restore-guard.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/server/src/lifecycle/restore-guard.ts)                                                                            | Fence común, baja/reset y cuarentena de restauración; límite QA frente a recuperación alojada               |
| [backup.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/lib/vault/backup.ts), [rotations.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/lib/vault/rotations.ts) y [browser-lifecycle.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/lib/vault/browser-lifecycle.ts)               | Restauración de datos, importación a contexto nuevo, rotaciones y bloqueo                                   |
| [money.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/lib/financial-domain/money.ts), [catalog.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/lib/financial-domain/catalog.ts) y [plans.ts](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/lib/financial-domain/plans.ts)            | Dinero entero, monedas versionadas y planes separados del saldo real                                        |
| [PROJECT_STATE.md](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/docs/PROJECT_STATE.md), [SECURITY.md](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/docs/SECURITY.md) y [ROADMAP.md](https://github.com/SrEdgarR/PULSO/blob/b764bc55d08626c2ca57c131aaf76c0996356972/docs/ROADMAP.md)                                      | Evidencias históricas y gates pendientes de publicación                                                     |

El commit es el merge del PR #7 de P6. Los documentos vivos conservan el corte
previo y aún dicen «no integrada»; ese texto no invalida el merge ni justifica
ignorar su código. Los requisitos históricos de P3/P4 que dicen «pendiente» no
demuestran ausencia de implementación actual. P7 sigue sin evidencia de cierre
en lo consultado. No se ejecutaron las suites de Pulso durante esta etapa ni se
trasladan sus resultados históricos como pruebas de TR8.

La base de TR8 examinada usa Supabase Auth con PKCE y sesión persistida en el
navegador (`src/app/data/client.ts`), operaciones RPC de proyectos/tareas y
control de versión (`src/app/data/repository.ts`). Esas capacidades no cubren
por sí solas las protecciones financieras de Pulso.

## ADR propuesto: conservar los contratos y sustituir los adaptadores

Mantener React/TypeScript/Vite en TR8. Reutilizar el dominio financiero puro y
el protocolo criptográfico, adaptando interfaz, repositorio, identidad y
persistencia. No añadir Next.js, Vinext, un segundo sistema de login ni MongoDB
solo para alojar Pulso.

La propuesta sustituye Better Auth/MongoDB por Supabase Auth/PostgreSQL. No es
una traducción mecánica: el transporte de Pulso presupone `/api/vault` del mismo
origen con cookies; TR8 persiste una sesión bearer y se comunica con Supabase.
Antes de escribir código financiero se cerrará un ADR de transporte que decida
sesión, tokens, reautenticación, origen/CORS/CSRF, expiración y revocación.
La opción preferida a validar es una frontera de servidor dedicada para bóveda,
conservando rutas de origen único cuando sea viable dentro del presupuesto.
No se afirmará equivalencia entre cookies y bearer sin pruebas.

El gate exige demostrar, con documentación vigente y un ensayo sintético
posterior autorizado, cómo comprobar la sesión actual y la prueba de login
reciente. Si Supabase Free no permite una garantía requerida en la forma
propuesta, se rediseñará o aplazará finanzas; no se reemplazará por un timestamp
del cliente ni por autorización basada únicamente en un JWT aún no vencido.

## Contrato criptográfico que se conserva

- Formato de sobre v1 y suite `pulso-v1-aes256gcm-hkdfsha256-argon2id13`.
  Conservar estos identificadores de compatibilidad no contradice la marca TR8.
  Cambiarlos por estética rompería formatos y AAD.
- VDK aleatoria de 32 bytes. AES-256-GCM/HKDF-SHA-256 en Web Crypto, tag de 128
  bits y nonce de 96 bits. Clave de payload derivada por snapshot con salt nuevo
  de 32 bytes. Un retry retransmite el mismo request; no vuelve a cifrar.
- Argon2id v1.3 con el perfil exacto `argon2id-64m-t3-p1-v1`: 64 MiB, tres
  pasadas, paralelismo uno, salida de 32 bytes y salt de 16 bytes. Sin reducción
  silenciosa, algoritmo alternativo o carga de KDF desde CDN.
- Password privada distinta de la identidad y recovery independiente de 256
  bits. Confirmación completa de custodia local antes de activar los medios.
  Usar recovery obliga a renovar ambos wraps; cambiar password de login no
  recupera ni cambia automáticamente la bóveda.
- AAD liga `formatVersion`, suite, `ownerId`, `vaultId`, propósito y `keyEpoch`.
  El payload autentica también `credentialEpoch`, revisión, operación y ambos
  wraps completos. Los epochs de slots, credenciales y VDK conservan sus reglas.
- Parser cerrado, versiones/codificaciones canónicas y parámetros exactos antes
  del KDF. Conservar el límite de 1 MiB de plaintext y 2 MiB del request opaco;
  ampliarlos requiere medición y decisión explícita.
- Claves operativas y contenido descifrado permanecen solo en memoria. Sin
  IndexedDB, localStorage, sessionStorage, cookies, cachés ni «recordar bóveda».
  La persistencia de la sesión de identidad no autoriza persistir claves.
- Bloqueo por logout, cambio/revocación de identidad, recarga, navegación y
  `pagehide`/BFCache; conservar inactividad de cinco minutos y gracia de 60 s
  en segundo plano. Invalidar generaciones y descartar resultados tardíos de
  Workers antes de mostrar información.
- Capability gate real de contexto seguro, CSPRNG, AES/HKDF, Worker, WASM y
  transferencia de CryptoKey. Fallar cerrado si el dispositivo no lo soporta.

La limpieza de memoria JavaScript es best effort. El cifrado no protege un
dispositivo comprometido ni JavaScript malicioso entregado al desbloquear. No
se presentará como auditoría criptográfica, zero knowledge o garantía absoluta.

## Identidad e importación

La identidad destino será el usuario autenticado de TR8; no se deducirá del
correo coincidente, de metadatos editables ni del `ownerId` enviado en el sobre.
Los identificadores históricos de Better Auth/Mongo no son UUID de Supabase.
Aunque el formato acepta identificadores ASCII acotados, `ownerId` participa en
AAD: editarlo en la base de datos invalida el contenido autenticado.

La vía inicial será importación explícita desde un respaldo cifrado:

1. Conservar el respaldo original; abrirlo en el dispositivo con el medio
   privado antiguo y su contexto original.
2. Validar formato, dominio e integridad; mostrar una previsualización privada.
3. Autenticar recientemente la identidad destino con prueba de servidor.
4. Crear un nuevo `vaultId`, VDK, password y recovery, con custodia confirmada.
5. Volver a cifrar los datos en el navegador para el nuevo `ownerId` y contexto.
6. Guardar con CAS y comprobar el recibo durable; bloquear, recargar y abrir
   nuevamente antes de considerar completada la importación.

No se copiarán wraps, claves, epochs o contexto criptográfico antiguos, ni se
vincularán cuentas automáticamente por email. Los identificadores internos de
cuentas y operaciones financieras se conservarán conforme al dominio validado;
no deben confundirse con el nuevo propietario/contexto de bóveda.

La primera importación requerirá un destino sin bóveda. Una bóveda existente
admitirá restauración de datos de su mismo contexto, preservando VDK, wraps y
epochs vigentes; mezclar identidades o conjuntos financieros será otra función.
No se harán lecturas o movimientos automáticos de datos reales de Pulso.

## API opaca y transacción PostgreSQL

Operaciones conceptuales: leer sobre activo; guardar snapshot; consultar
resultado técnico de una operación; reset explícito por pérdida total.
La UI no tendrá DML directo ni acceso a una RPC alternativa que evite el
servidor. Las funciones de persistencia financiera serán de uso backend,
fuera del acceso `anon`, `authenticated` y `PUBLIC`, con privilegios mínimos y
RLS como defensa adicional donde corresponda. Las claves privilegiadas nunca
se incluirán en el bundle.

El servidor derivará actor y sesión de credenciales verificadas, acotará el
stream real antes de parsear y rechazará UTF-8 inválido, campos extra, versión
incorrecta, encoding no admitido, tamaños excesivos o contexto ajeno. Un
`Content-Length` honesto no será la única defensa. No descifrará ni calculará
saldos; validará estructura y transiciones públicas del protocolo.

Modelo lógico restringido propuesto:

| Registro                   | Contenido permitido                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| Autoridad de identidad     | Estado, versión/fence y vínculo de identidad activo; sin autoridad competidora en roles de equipo |
| Bóveda activa              | Propietario, contexto, revisión y sobre opaco                                                     |
| Recibos                    | Propietario, operación, hash exacto del request y revisión/resultado técnico                      |
| Contextos retirados        | Identificador retirado, actor/propietario y motivo técnico mínimo                                 |
| Pruebas de reautenticación | Sesión, usuario, método permitido y hora acreditada por servidor                                  |
| Control de restauración    | Estado de cuarentena, protocolo y watermark confiable                                             |

Las operaciones utilizarán una transacción con un bloqueo/fence común de
identidad que también utilicen suspensión, baja, reset y purga. Una consulta
fresh anterior al commit no cierra por sí sola la carrera con revocaciones.
El contrato transaccional será:

1. Comprobar autoridad de identidad, estado permitido y sesión viva actual.
2. Comprobar que el contexto no esté retirado, antes de consultar recibos.
3. Buscar recibo único por propietario y operación. Request idéntico devuelve
   el resultado previo; mismo ID con otros bytes devuelve conflicto.
4. Verificar revisión esperada y transición válida de epochs/contexto.
5. Exigir reautenticación reciente cuando corresponda.
6. Guardar snapshot, recibo y auditoría mínima aplicable en un único commit.

El hash cubrirá los bytes originales del request; normalizar JSON en el
adaptador no debe cambiar la semántica de idempotencia. Un ACK significará
commit confirmado. Pérdida de respuesta dejará estado «sin confirmar» y retry
exacto, nunca «guardado» optimista. No se aplicará last-write-wins ante conflicto.
Se demostrarán rollback y durabilidad según PostgreSQL/Supabase; no se copiarán
como garantías automáticas las opciones majority/journal de MongoDB.

## Sesiones, ciclo de vida y anti-revival

Crear/importar bóveda, rekey/rescue y reset por pérdida total requieren un nuevo
login exitoso acreditado por servidor en los últimos cinco minutos y ligado a
la sesión y usuario actuales. `iat` de un JWT recién refrescado, actividad,
fecha de creación de sesión, `getSession()` del cliente y flags de UI no prueban
ese login. La lectura/escritura ordinaria, desbloqueo local y rewrap sin cambio
de VDK conservan el alcance de Pulso y no adquieren una exigencia adicional.

La validación sensible comprobará también que la sesión siga viva; retirar un
usuario o una sesión no debe dejar utilizable su token firmado hasta que expire.
Reset/retirada se verifican antes de responder un recibo antiguo.

P6 no desaparece por comenzar con un solo titular. El diseño deberá cubrir:

- Baja cancelable durante siete días con plazo de servidor; cancelación y purga
  compiten atómicamente. Sesión de cancelación limitada, sin acceso financiero.
- Reset irreversible con declaración explícita, nuevo contexto creado en
  navegador, retiro permanente del anterior, recibo durable y revocaciones.
- Rescue desde el último dispositivo desbloqueado: generar y verificar respaldo
  cifrado local antes de abandonar la página para reautenticarse.
- Purga de bóveda, recibos financieros, credenciales/sesiones e integraciones,
  con inventario DELETE/RETAIN/ANONYMIZE/EXTERNAL DEPENDENCY. Retención jurídica
  y plazos de registros mínimos siguen pendientes; no se inventan TTL legales.
- Ningún contexto retirado puede revivir mediante retry, otro usuario, un recibo
  antiguo o un respaldo. Los recibos no son credenciales.
- Una copia antigua de la base se restaura en cuarentena. No se abre servicio
  hasta reconciliar revocaciones, retiros y purgas posteriores con evidencia
  confiable completa. Una marca incluida solo en esa misma copia no protege
  frente a su rollback.

Con varios equipos, una baja debe resolver primero la propiedad de todos los
equipos: transferencia aceptada por otro miembro habilitado o cierre explícito.
Nunca heredar finanzas al nuevo propietario, borrar trabajo ajeno en cascada ni
dejar un equipo sin propietario. Solicitar la baja retira el acceso operativo;
cancelarla no concede acceso a proyectos que ya hayan revocado la membresía.
Esta interacción se probará junto al contrato de equipos antes de habilitarla.

Los roles administrativos internos de Pulso no se traducen a roles de equipo.
Si TR8 incorpora soporte o administración de plataforma, requerirá un contrato
separado que preserve MFA, reautenticación y sesiones privilegiadas, auditoría,
límites y recuperación de P6. No habrá puerta excepcional para leer bóvedas.

La reconciliación QA de Pulso no acredita autoridad externa durable ni
recuperación alojada. Diseñar y financiar esa autoridad dentro de Free es un
gate previo a publicar finanzas con garantías de restauración. Si no se resuelve,
finanzas queda sin habilitar; no se sustituye por «hacer backups manuales».

## Dominio financiero e interfaz

- Conservar cantidades en unidades menores enteras seguras. Sin floats para
  sumar dinero, redondeo silencioso ni conversiones automáticas de moneda.
- Catálogo versionado actual DOP/USD/EUR/BOB, dos decimales y DOP predeterminado.
  Cambiar predeterminado o añadir monedas necesita una decisión explícita.
- Saldos, deuda, crédito disponible y patrimonio separados por moneda.
  Transferencias/pagos entre cuentas de igual moneda sin duplicarlos como ingreso
  o gasto; reembolsos respetan límites y fechas del gasto original.
- Planes y proyecciones no son movimientos reales hasta confirmarlos. Confirmar
  cambia plan y movimiento en el mismo snapshot validado e idempotente.
- Preservar migraciones locales estrictas del dominio a schema 4, con preview y
  sin guardado automático al desbloquear. Schema de dominio y sobre raíz son
  versiones distintas.
- Adaptar componentes al diseño de TR8, accesibilidad, móvil y movimiento
  reducido. Cargar motor, herramientas y WASM de forma diferida cuando convenga.
  No portar el layout/routing de Next/Vinext como requisito del dominio.
- Mostrar bloqueo, borrador, guardado pendiente, confirmación y conflicto de
  forma inequívoca. Un fallo de configuración no habilita modo local silencioso.
- Finanzas no aparecerá en búsqueda de equipos, actividad, analytics, logs,
  asuntos de correo, eventos de Google, cachés compartidas o capturas automáticas.

## Matriz de brechas y aceptación

Estado de la adaptación TR8: todo lo financiero siguiente está pendiente. La
evidencia fuente es un contrato a preservar, no una prueba ya ejecutada aquí.

| Área                 | Brecha actual de TR8                                        | Evidencia necesaria antes de habilitar finanzas                                                                |
| -------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Identidad/transporte | PKCE y sesión persistida no equivalen a cookie same-origin  | ADR aprobado y pruebas de revocación, CSRF/CORS/origen, expiración y no fuga de tokens                         |
| Reautenticación      | No hay prueba específica server-side para bóveda            | Login real reciente PASS; refresh, flags cliente y sesión antigua FAIL                                         |
| Criptografía         | No hay Workers ni protocolo de bóveda en TR8                | Vectores y alteraciones, parámetros exactos, capability gate, cero plaintext/secretos en canales remotos       |
| Persistencia         | RPC de proyectos con versión no conserva contrato opaco     | CAS de dos sesiones, ACK perdido, reinicio, rollback y exact-byte idempotency                                  |
| Aislamiento          | Propiedad personal actual no modela ciclo financiero        | Otro usuario/propietario/admin de equipo FAIL incluso invocando rutas o RPC directamente                       |
| Ciclo de sesión      | Limpiar caché de proyectos no destruye estado criptográfico | Logout, cambio de cuenta, background, BFCache y Worker tardío nunca muestran plaintext                         |
| Importación          | IDs de origen/destino distintos                             | Respaldo antiguo abre localmente; nuevo contexto vuelve a abrir tras recarga; origen intacto                   |
| Recovery/rekey       | Sin flujos equivalentes                                     | Custodia, rotación de ambos wraps, rescue y pérdida total probados con datos sintéticos                        |
| P6 online            | Sin retiro/fence/recibos de lifecycle                       | Carreras PUT-reset/baja/purga; recibo viejo o contexto retirado FAIL                                           |
| Restauración alojada | Free no aporta por sí solo reconciliación externa           | Restaurar snapshot viejo bajo cuarentena; replay completo; fuente ausente/incompleta FAIL CLOSED               |
| Equipos y baja       | Nuevo alcance de TR8                                        | Varios equipos, transferencia aceptada, revocaciones y datos ajenos preservados                                |
| Publicación          | P7 fuente no cerrada; port aún sin revisión                 | Revisión web/cripto, dispositivos, TLS/CSP/Workers reales, proveedores, límites, recuperación y textos veraces |

Primero se completará la base de identidad y permisos de TR8. Después se cerrará
el ADR de adaptación y se autorizará un ensayo con datos ficticios; solo tras
validar criptografía/transporte se construirá persistencia financiera nueva.
La etapa 0 no crea ese prototipo, no modifica Pulso y no autoriza despliegue,
importación real, compra de planes o afirmaciones de seguridad de publicación.

# Pulso 6B.1 · Backend opaco para ensayos sintéticos

Estado: backend verificado con ensayos alojados en el proyecto TEST. **Las finanzas con datos reales permanecen
desactivadas.** Este corte continúa [6A](../pulso-6a/README.md) y el
[ADR de transporte](../pulso-6a/transport-adr.md). No activa una bóveda personal,
una pantalla financiera ni un segundo sistema de login.

Se conserva React/TypeScript y Supabase Free. No se añade un proveedor, plan de
pago, correo o integración con Google. La autoridad de restauración independiente
sigue sin resolver; su [decisión y puerta de aceptación](restore-authority.md)
impiden habilitar finanzas reales por el solo hecho de superar estas pruebas.

## Frontera implementada

| Pieza                                                                                                            | Responsabilidad                                                                                                                         | Límite                                                                                      |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Edge Function](../../supabase/functions/tr8-finance/handler.ts)                                                 | Origen exacto, métodos y cabeceras explícitos, errores sanitizados, `no-store`, stream de hasta 2 MiB, UTF-8 y formato opaco cerrado    | Sin UI, descifrado, medios privados ni creación de claves                                   |
| [Runtime](../../supabase/functions/tr8-finance/runtime.ts)                                                       | Verificación del Bearer exacto con Supabase Auth, comprobación de issuer/audience/exp, propietario y sesión; RPC con credencial backend | El cliente no elige actor ni acredita su propio login; requiere pruebas alojadas            |
| [Migración](../../supabase/migrations/20261024003723_finance_synthetic_stage6b1.sql)                             | Esquema privado, autoridad por usuario, CAS, recibos, retiros y revocaciones financieras                                                | La migración propuesta no demuestra por sí misma aplicación remota o durabilidad comprobada |
| [Contrato 6A](../../src/app/finance/compatibility/protocol.ts)                                                   | Suite Pulso v1, codificaciones canónicas, límites, epochs y contexto autenticado compatibles                                            | El servidor valida estructura; no demuestra que un ciphertext pueda abrirse                 |
| [Ensayo SQL](../../supabase/tests/finance_stage6b1.sql) y [smoke HTTP](../../scripts/finance-6b1/http-smoke.mjs) | Escenarios adversariales reproducibles con fixtures aislados                                                                            | No son evidencia de ejecución hasta registrar sus resultados                                |

La Edge Function solo puede habilitarse para el host literal
`kajcbwlnqcwcpbtqyieo.supabase.co`, con configuración de ensayo explícita y origen
permitido. La migración crea `synthetic_enabled=false`,
`restore_quarantined=true` y una allowlist vacía. La admisión exige además
habilitación explícita de ensayo, salida de cuarentena y pertenencia a esa
allowlist. El modo de datos reales no está implementado. Un entorno mal
configurado no selecciona automáticamente producción ni un modo local.

## Identidad, sesión y transacción

El runtime valida el token mediante Auth antes de utilizar sus claims. Comprueba
el usuario devuelto, `sub`, issuer, audience, rol, anonimato, expiración y
`session_id`. Un correo coincidente, rol de equipo, `user_metadata` o propietario
incluido en el sobre no sustituye esa identidad.

La transacción exige `READ COMMITTED` y mantiene bloqueos sobre la configuración,
allowlist, `auth.users`, `tr8_private.app_users`, `auth.sessions` y la autoridad
financiera del titular. Los bloqueos de filas de Auth compiten con DELETE de
sesión y cambios de ban/baja; el bloqueo de `app_users` compite con disable. Se
comprueban usuario vigente, cuenta habilitada, sesión perteneciente al actor,
`not_after`, expiración del token y revocación financiera. Tras las posibles
esperas se vuelve a validar antes de devolver el resultado. La aceptación exige
probar ambas órdenes de esas carreras con conexiones reales.

Crear un contexto, cambiar VDK mediante rekey y ejecutar reset/revoke requieren
login reciente. En este corte solo se admite el método **password**: su
`amr.timestamp` firmado debe coincidir, a precisión de segundo, con
`auth.mfa_amr_claims.updated_at` de esa sesión y método. Ambos deben acreditar
menos de cinco minutos con reloj del servidor. `iat`, refresh, recovery,
actividad y hora del cliente no acreditan ese login. La escritura ordinaria no
adquiere un requisito adicional de login reciente. No se declara implementado
un equivalente de reautenticación OAuth.

El PUT procesa los bytes originales del request, comprueba propietario/contexto
y rechazo de contextos retirados antes de buscar recibos, y calcula su SHA-256.
Un retry con el mismo propietario, ID y bytes devuelve el recibo previo; otro
contenido con ese ID produce conflicto. La revisión esperada y los epochs deben
cumplir el contrato 6A. Snapshot y recibo se escriben dentro de la misma
transacción. Un fallo o timeout ambiguo exige consultar o retransmitir los mismos
bytes; no autoriza guardar optimistamente ni cambiar de ID para eludir un
conflicto. Un bloqueo transaccional por contexto serializa su uso entre titulares.

Reset retira permanentemente el contexto en la autoridad actual e incrementa el
epoch. Revoke impide acceso **financiero** a la sesión elegida. Esas revocaciones
financieras no equivalen a cerrar globalmente la sesión de Supabase. Los ensayos
deben verificar también logout real de Auth con replay del antiguo JWT. Los
comandos reset/revoke usan un contrato de parámetros normalizados y sus propios
recibos; la garantía de identidad de bytes originales descrita arriba corresponde
al PUT.

## Privilegios y límites de confianza

`tr8_finance` no es un esquema de datos para el navegador. Todas sus tablas tienen
RLS y carecen de DML directo para `anon`, `authenticated`, `PUBLIC` y
`service_role`. Los helpers tampoco son una API pública. El wrapper
`public.tr8_server_finance` es invoker; únicamente el backend puede ejecutar la
frontera privada autorizada, cuyo definer contiene las validaciones y usa
`search_path` cerrado. No hay una RPC de cliente alternativa que omita la Edge.

El backend con credencial privilegiada es parte de la frontera confiable. Los
parámetros de actor, sesión, expiración y prueba de login que envía a la RPC deben
proceder del token verificado, nunca de campos del body ni de cabeceras elegidas
por el usuario. Comprometer esa credencial o el código servidor queda fuera de
las garantías del control de un cliente ordinario.

La Edge es responsable del JSON léxico estricto: números canónicos, duplicados,
Unicode, campos cerrados y límites. PostgreSQL vuelve a comprobar UTF-8, claves
únicas, estructura, tipos, suite, tamaños, propietario y transiciones. `jsonb`
normaliza representaciones numéricas como `1.0`; su validación no sustituye al
parser léxico de entrada. Mantener la RPC restringida al llamador backend es
parte de este contrato.

Estas tablas no contienen dinero en claro, notas financieras, passwords de
bóveda ni recovery. Los fixtures HTTP que cambian `ownerId` sobre el vector
conocido son **sobres estructurales sintéticos**: ese cambio modifica el AAD y no
produce un nuevo respaldo cifrado válido. Solo prueban la persistencia opaca y
la autorización. La compatibilidad AES/HKDF de 6A permanece separada; Argon2 WASM,
Workers, importación, custodia, bloqueo del navegador y dominio financiero siguen
fuera de 6B.1.

Los proyectos, tareas, equipos y sus RPC v2 conservan su modelo separado. La
migración financiera no importa ni transforma sus filas. Las pruebas deben
comparar hashes antes/después; esa conservación no se deduce únicamente del
nombre del nuevo esquema. El trabajo de correo, Google y actividad tampoco
recibe contenido financiero.

## Evidencia de 6B.1

Resultados ejecutados sobre esta entrega:

| Comprobación                            | Evidencia disponible                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Software Edge financiero                | 22 pruebas locales pasan con `vitest.edge.config.ts`; Auth y transporte están sustituidos por fixtures en estas pruebas                                               |
| Migración/SQL remoto                    | 97 comprobaciones SQL pasan en TEST, incluyendo CAS, recibos exactos, rollback, gates y preservación                                                                  |
| HTTP, Auth real, refresh y logout       | 252 comprobaciones en 139 solicitudes pasan con cuentas sintéticas existentes; sin llamadas a Google                                                                  |
| Carreras transaccionales                | Siete carreras con dos conexiones PostgreSQL y bloqueo observado: logout primero, escritor primero, disable, reset y caducidad de JWT, AMR y sesión durante la espera |
| Respuestas perdidas                     | PUT repetido devuelve el recibo durable y no otro snapshot; operación con bytes distintos produce conflicto                                                           |
| Autoridad de restauración independiente | Sin resolver; bloqueo para datos reales                                                                                                                               |

Las siete carreras registran sesiones PostgreSQL distintas y `pg_blocking_pids`.
En las tres pruebas de caducidad, los tiempos del servidor acreditan inicio antes
del plazo y finalización posterior. El ensayo HTTP verifica la lectura del
recibo y el retry tras ignorar una respuesta; no simula una caída física del
proveedor ni acredita recuperación frente a pérdida de su almacenamiento.

La migración financiera `20261024003723` se instaló en TEST y producción con
SHA-256 `c36962c4fce0ea95fe5cdd2da25a5d106c56997171794dcc3f8e433580f0442c`.
La Edge Function `tr8-finance` se desplegó **solo en TEST**, versión 1. Los ensayos
finalizaron sin bóvedas, actores ni allowlist financieros y con el gate apagado y
cuarentena activa; sus opciones de entorno también se volvieron a deshabilitar.
Producción conserva el esquema vacío, gate apagado y cuarentena activa. No se
desplegó allí una función financiera ni se habilitó al propietario.

Las otras migraciones de esta entrega incorporan eliminación de proyectos y
reparación del destino de importación Google Tasks; no son parte de la autoridad
financiera. El historial canónico total queda en 16 migraciones. Los tipos públicos
se regeneraron desde TEST. Los proyectos y tareas originales se compararon con
sus hashes; no se ejecutaron borrados del propietario en producción.

No trasladar los resultados del simulador 6A ni de las pruebas unitarias a
garantías distintas de los ensayos alojados descritos. La revisión independiente
de restauración, la criptografía y el ciclo de vida del cliente siguen pendientes.

El smoke rechaza producción y claves privilegiadas, no crea usuarios ni envía
emails. Solo inicia sesiones de fixtures `example.test` existentes. Con
`--coordinate-auth` escribe en una carpeta privada los IDs de sus sesiones
recién creadas y espera una señal con el mismo `runId`. El operador puede
envejecer únicamente la AMR de `ownerMain` y `not_after` de `ownerSecondary`.
Después se verifica refresh real y rechazo de rekey/expiración. Esto se registra
como **AMR de fixture envejecida y refresh real**, no como tiempo transcurrido
naturalmente ni como un JWT expirado firmado fabricado. Los tokens permanecen
en memoria y el script limpia solo sus contextos y sesiones.

Antes de ampliar 6B deben quedar verificadas admisión alojada, aislamiento,
CAS/recibos, carreras con revocación/reset/disable, login reciente real y
conservación de datos. Habilitar una bóveda real requiere además resolver la
restauración, completar criptografía y ciclo de vida del cliente, y cerrar la
aceptación restante de [etapa 0](../stage-0/pulso-adaptation.md).

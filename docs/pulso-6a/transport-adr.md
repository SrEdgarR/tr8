# ADR F01 · Identidad y transporte de Pulso en TR8

Estado: **aceptado para el prototipo 6A**. La implementación alojada queda
condicionada a las puertas de 6B. No se incorpora una segunda autenticación.

## Decisión

Conservar Supabase Auth y la sesión PKCE de TR8 para la identidad. Una futura
Edge Function financiera dedicada recibirá el Bearer de esa sesión sobre HTTPS
y llamará a operaciones privadas de almacenamiento opaco. El backend derivará
actor y sesión de credenciales verificadas; `ownerId`, correo o roles enviados
por el cliente no serán autoridad. El identificador de propietario formará parte
del AAD del nuevo sobre, sin reescribir sobres históricos.

La contraseña de la bóveda y su recovery seguirán siendo medios privados del
dispositivo, distintos de la contraseña de acceso a TR8. No se enviarán al
servidor ni se reutilizará la contraseña de Supabase como clave de cifrado.

El transporte usará orígenes exactos permitidos, métodos explícitos y JSON sin
compresión. Acotará el stream a 2 MiB antes de parsearlo y rechazará UTF-8 inválido,
claves duplicadas, campos adicionales y versiones no admitidas. CORS no sustituye
autenticación ni autorización: una llamada fuera del navegador también debe
superar todos los controles. No se pondrán tokens en URLs, logs o errores.

La API conceptual ofrecerá lectura, escritura CAS y consulta de recibo. Las
mutaciones sensibles de ciclo de vida tendrán contratos separados. Las funciones
SQL financieras no serán invocables por `anon`, `authenticated` ni `PUBLIC`, ni
habrá DML de navegador alternativo. Los secretos backend permanecerán fuera del
bundle y del repositorio.

## Verificación de identidad y login reciente

La documentación de [sesiones de Supabase](https://supabase.com/docs/guides/auth/sessions)
identifica `session_id` con una fila de `auth.sessions` y describe comprobar su
existencia para detectar el logout aun con un JWT firmado vigente. Verificar
firma/issuer/audience/exp no acredita por sí solo que una sesión continúe viva.

El futuro adaptador verificará el token y el estado autorizado actual de TR8.
Después la transacción comprobará sesión, identidad y lifecycle bajo un fence
común con las revocaciones relevantes. Una consulta HTTP previa con `getUser`
seguida de una escritura sin ese bloqueo deja una carrera y no cumple el contrato.

Para crear/importar, rekey/rescue y reset se requiere un login acreditado por el
servidor hace menos de cinco minutos, ligado al usuario y la sesión actuales.
La referencia de [claims JWT](https://supabase.com/docs/guides/auth/jwt-fields)
documenta `amr.method` y `amr.timestamp`; serán una entrada candidata **solo tras
verificar el token y demostrar su semántica con el proveedor real**. `iat`, un
refresh, recovery, `user_metadata`, hora del cliente o `getSession()` no serán
pruebas de login. Los métodos del simulador no se copiarán como un mapeo directo
de métodos de Supabase. Si la prueba no se puede acreditar, se exige un nuevo
login verificable y se rechaza la operación sensible mientras tanto.

Los controles de lifetime de sesiones ofrecidos por planes superiores no son
una dependencia de esta decisión. El presupuesto sigue siendo Free; el bloqueo
local de la bóveda y el contrato de autorización se implementarán explícitamente.

## Confirmación, revocación y restauración

La transacción deberá, en este orden: comprobar autoridad/sesión; rechazar
contextos retirados; consultar el recibo por propietario e ID y comparar el hash
SHA-256 de los bytes originales; verificar CAS y epochs; exigir login reciente
cuando proceda; confirmar sobre y recibo juntos. El ACK exige commit confirmado.
Un resultado ambiguo admite consulta o retry exacto, nunca otro ID para eludirlo.

Suspensión, revocación de sesión, reset y purga deberán competir con la escritura
usando la misma autoridad transaccional. La integración con las operaciones de
Auth que puedan retirar sesiones requiere prueba real; el mutex de JavaScript
del prototipo solo representa la propiedad que debe cumplir PostgreSQL.

Una restauración antigua iniciará en cuarentena. El watermark y los retiros que
impiden revivir contextos no pueden depender solo de esa misma copia. La autoridad
independiente, su recuperación y coste continúan abiertos para 6B; no se afirma
que exista un servicio gratuito instalado que ya proporcione esa garantía.

## Alternativas y consecuencias

- Copiar Better Auth/Mongo impondría otro login y otra infraestructura. Se
  conserva el protocolo opaco y se adapta su autoridad a TR8.
- La sesión Bearer existente no tiene las propiedades de una cookie HttpOnly
  same-origin. Requiere controles y pruebas propios; no se presenta como un port
  idéntico del transporte de Pulso. Un XSS sigue siendo un riesgo al desbloquear.
- Guardar plaintext en Postgres o habilitar una bóveda local silenciosa no
  satisface el contrato y queda excluido.
- No se depende de Pro, nuevos proveedores, correo ni nuevos usuarios externos.
  No se habilita 6B hasta cerrar los puntos pendientes de [aceptación](README.md).

El prototipo solo implementa la frontera de contrato con autoridades sintéticas
inyectadas. No contiene un verificador JWT, un endpoint financiero desplegado,
una migración ni un adaptador PostgreSQL. Esos trabajos y sus pruebas forman
parte de la siguiente entrega, sin poder deducirlos de los tests en memoria.

# Pulso 6B.5A · Protocolo de restauración y banco local

Estado: cortes A (banco local), [B (servicio sintético alojado)](hosted-test.md) y
[C (coordinación con PostgreSQL y restauración lógica alojada)](postgres-rehearsal.md).
[D (versiones, identidad, reanudación y recuperación)](control-hardening.md) implementa
y verifica los cuatro controles siguientes en el entorno sintético.
**La fase 6B.5 no está
completada y las finanzas reales siguen cerradas.** El ADR F02 continúa vigente.
El corte B crea un recurso externo de pruebas, separado de la aplicación y de
Supabase. No se modifica ninguna migración aplicada ni se conecta el acceso real
al servicio sintético.

## Entrega local

[`LocalSyntheticJournal`](../../server/finance-authority/local-journal.ts) es
exclusivamente un banco de pruebas con SQLite en disco, separado de otra SQLite
que representa una proyección restaurable. La provisión inicial es explícita;
abrir un archivo ausente, sin esquema o con otro identificador de autoridad
produce rechazo. No se reconstruye una autoridad vacía de forma automática.

El banco almacena identificadores ficticios, epochs, retiros, revocaciones,
comandos de ciclo de vida y su digest; no acepta títulos, movimientos, importes,
ciphertexts, contraseñas, recuperación o tokens. Su API recibe ya el principal
de confianza del ensayo: **no implementa autenticación remota**. No debe
publicarse ni tratarse como un servidor de autorización.

La secuencia ensayada es:

1. Validar el comando cerrado y su contexto; preparar una intención durable con
   ID de operación y bytes canónicos. Solo existe una intención pendiente por
   propietario. Desde este punto el acceso queda cerrado.
2. Aplicar la mutación en la proyección. En la integración futura ese paso deberá
   tener fencing, Auth vigente, idempotencia y comprobación transaccional real.
3. Comprobar una confirmación que corresponda exactamente a la intención y
   confirmar el cambio del registro independiente en una transacción: tombstone,
   revocación/purga, epoch y estado de operación cambian juntos.
4. Solo entonces evaluar acceso contra el ciclo de vida actual y la proyección.
   Un recibo anterior no sustituye esa comprobación. Un paso pendiente, fallo,
   contexto retirado, usuario purgado o sesión revocada sigue denegando acceso.

El digest de este banco identifica el comando; **no es firma, credencial ni
prueba de que Supabase haya confirmado nada**. Las pruebas suministran una
confirmación ficticia. La verificación de esa confirmación, firmas/autenticación
de servicio y recuperación de fallos distribuidos permanecen pendientes.

No hay transacción distribuida entre SQLite y otro almacén. La intención no
vence por TTL ni se cancela automáticamente por un timeout. Si no puede
demostrarse qué ocurrió, la admisión permanece cerrada. Una reejecución exacta
recupera la misma intención; cambiar los bytes con el mismo ID produce conflicto.

## Evidencia local

Veinte pruebas nuevas, dentro de `npm run test:edge`, comprueban:

- Persistencia de una intención pendiente al cerrar y volver a abrir el archivo.
- Retiro, revocación y purga que sobreviven a restaurar por copia una segunda
  base SQLite anterior. El archivo de autoridad no se restaura con ella.
- Rechazo de otra identidad, epoch, contexto o confirmación; replay exacto.
- Dos conexiones al mismo journal ven el estado confirmado y no admiten una
  segunda intención diferente mientras haya otra pendiente. Esto no equivale a
  probar concurrencia distribuida del proveedor.
- Un fallo SQL inyectado entre retiro y actualización de epoch revierte toda
  esa transacción y conserva la intención pendiente; se puede reintentar.
- Autoridad ausente, diferente o cerrada y agotamiento del epoch.

Las pruebas crean carpetas temporales con prefijo propio, comprueban su ruta
antes de limpiarlas y no consultan la base del propietario. Utilizan `node:sqlite`
de Node 22.13 o posterior; CI usa la versión actual de Node 22. No se añade una
dependencia npm ni se cambia el runtime de producción.

```powershell
npm run typecheck:edge
npm run test:edge
```

Estos ensayos no acreditan PostgreSQL restaurado, pérdida de energía, reinicio
de Cloudflare, durabilidad alojada ni una política de recuperación de su propia
autoridad. El protocolo es una base revisable para esas pruebas.

## Proveedor verificado para pruebas

La candidata es **Cloudflare Durable Objects con SQLite en Workers Free**,
separada del dominio de restauración de Supabase. La documentación vigente
ofrece ese backend en Free, 100.000 solicitudes diarias y errores al superar
las cuotas; esto permite evaluar un servicio personal sin contratar Paid.
Se verificó en el panel la cuenta Edgar Padilla y su plan Workers Gratuito, sin
cambiar su suscripción. El corte B comprueba el namespace SQLite real de pruebas.
Esto no garantiza un coste futuro ilimitado ni resuelve la integración con
PostgreSQL. [Precios y límites oficiales](https://developers.cloudflare.com/durable-objects/platform/pricing/).

La adaptación debe usar las transacciones del runtime de Durable Objects. Sus
consultas SQL no ejecutan `BEGIN`/`COMMIT`; por tanto, este banco Node **no se
puede desplegar sin adaptar**. Tampoco puede ejecutarse una llamada de red dentro
de `transactionSync`. [API SQLite y transacciones](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

También se evaluó Global Config en Vercel: Hobby incluye 100 escrituras y su
propagación global puede tardar hasta 10 segundos. Por esas características no
se selecciona su lectura distribuida como comprobación inmediata de revocación.
Esto es una decisión de diseño, no una afirmación de que ningún protocolo pueda
construirse usando sus otras APIs. [Límites oficiales](https://vercel.com/docs/global-config/global-config-limits).

El usuario confirmó su cuenta, inició sesión y autorizó Wrangler con permisos
limitados. Se conserva esa cuenta y el plan gratuito; no se crean cuentas ni
se activa facturación. Si se cambia de proveedor, habrá que volver a evaluar
consistencia, separación, durabilidad y cuotas.

## Trabajo necesario para cerrar 6B.5

1. Confirmar proveedor y cuenta; crear exclusivamente recursos Free para ensayos,
   con namespace de pruebas distinto del eventual namespace real.
2. Diseñar y revisar el coordinador remoto: identidad de servicio, credenciales
   separadas, bootstrap fijado fuera de Supabase, operaciones y orden monotónico.
   No admitir desde el navegador un actor ni una confirmación de base arbitrarios.
3. Adaptar el journal al almacenamiento alojado y validar persistencia después
   de reinicios, duplicados, pérdida de respuestas y concurrencia real.
4. Incorporar el fencing a PostgreSQL mediante una nueva migración y el adaptador
   al Edge de pruebas; la cuarentena debe comprobarse antes de cualquier dato o
   recibo. Las rutas existentes no llaman todavía al banco local.
5. Restaurar una copia real de una base aislada anterior a retiros/revocaciones/
   purgas; comprobar también intención incompleta, autoridad indisponible,
   evidencia truncada y pérdida de identidad de despliegue. Ningún timeout o
   recibo antiguo puede reabrir un contexto.
6. Resolver replay completo, operaciones interrumpidas, registro de contextos
   nuevos, recuperación de la propia autoridad y cobertura de todas las vías de
   baja/disable/reset/revoke/purge. No basta cubrir los tres comandos sintéticos.
7. Revisar CSP, flujos del propietario y presupuesto. Solo entonces evaluar una
   activación real con alcance explícito, conservando proyectos, tareas y altas
   externas cerradas. No importar automáticamente un respaldo de Pulso.

La alternativa de quitar el bloqueo sin cerrar estos puntos contradice el
[ADR F02](../pulso-6b1/restore-authority.md), que esta entrega no modifica.

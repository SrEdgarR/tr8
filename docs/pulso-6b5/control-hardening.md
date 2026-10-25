# 6B.5D · Versiones, identidad, reanudación y recuperación

2026-10-25. Los cuatro puntos se implementaron y verificaron, en ese orden, en
el entorno sintético. **La bóveda real permanece desactivada.** Esta entrega no
importa datos del propietario ni cambia el esquema de producción.

## 1. Versión vigente de la bóveda

El nuevo journal conserva un head independiente con contexto, revisión, epochs
de clave/credenciales, ID de operación, SHA-256 del envelope canónico y SHA-256
de los bytes originales del PUT. No guarda ciphertext, claves envueltas,
contraseñas, movimientos ni importes. Cada cambio avanza una secuencia monotónica.

La canonicalización coincide en JavaScript y PostgreSQL. Se comprueba el
envelope entero contra la autoridad antes de devolverlo y se observa de nuevo
el journal después de leer SQL. Cambiar solo el ciphertext dejando un head o
recibo reciente tampoco permite acceder. Los recibos se confirman contra el
estado y el ciphertext actuales; un recibo histórico no demuestra persistencia
actual tras una restauración parcial.

Se restauraron copias lógicas anteriores a cinco versiones de una fixture:
creación, cambio de payload, contraseña, recuperación y clave principal.
Las lecturas y los replays antiguos dieron conflicto. La reparación exigió el
envelope exacto del head vigente y mantuvo la cuarentena hasta la comprobación
operativa posterior.

## 2. Ciclo de vida de identidad

Una sesión válida en Supabase no obtiene acceso financiero por sí sola: debe
inscribirse explícitamente con autenticación reciente. Su fecha de creación se
consulta en Auth; el cliente no puede elegirla. El journal conserva sesiones
autorizadas, revocaciones, generación y corte de sesiones, retiros de contexto
y estado activo/deshabilitado/eliminado.

- Revocación individual: retira la sesión financiera y elimina su sesión Auth.
- Cierre global: avanza generación, revoca las sesiones conocidas y establece
  un corte temporal del servidor; las sesiones anteriores no pueden reinscribirse.
- Deshabilitación y baja financiera: cierran el acceso y las sesiones. La baja
  elimina el ciphertext de SQL y retira el contexto; no borra proyectos/tareas.
- Reset: retira el contexto y cierra sesiones, conservando la identidad activa.
  Un login nuevo puede inscribirse; el contexto retirado no puede reutilizarse.

Los cambios negativos siguen el orden intención independiente → transacción SQL
→ confirmación independiente. Triggers acotados impiden que una sesión inscrita
se elimine/reescriba, una identidad se deshabilite, o se cambie su estado Auth
sensible por fuera de esa secuencia. Las consultas de los guards usan MVCC sin
añadir bloqueos en orden inverso a Auth. No contienen llamadas de red.

Se comprobaron cinco intentos de bypass sin confirmar ninguna mutación:
logout SQL directo, cambio de fecha de sesión, ban, disable y borrado Auth.
La eliminación física del usuario no se ejecutó: conservar sus proyectos/tareas
forma parte del alcance. Su guard exige la baja financiera previa.

En los ensayos alojados se restauraron proyección, recibos, filas de sesiones,
AMR y el flag habilitado anteriores a revocar/cerrar/deshabilitar/dar de baja/
reiniciar. Las sesiones restauradas siguieron denegadas por la autoridad.
La reparación volvió a retirar sus filas Auth. Otro miembro de sesión vigente
conservó acceso en la revocación individual; un login nuevo pudo inscribirse
después del cierre global y del reset.

Estos guards son **de pruebas**, condicionados a su configuración sintética.
La activación futura exige conectar los controles al logout, cambio de contraseña,
baja y mantenimiento de sesiones reales de la aplicación. No basta activar una
bandera: el login/logout actual de producción conserva su comportamiento.

## 3. Operaciones interrumpidas

`/resume` consulta el journal y el recibo SQL actual. No confía en una confirmación
de base enviada desde el navegador. Una respuesta SQL perdida puede recuperarse
sin repetir la escritura. Si SQL nunca confirmó un PUT, se exigen sus bytes
originales y se repiten las comprobaciones de identidad, transición y head.
Un timeout no cancela intenciones ni abre el acceso.

Si falta el original, la respuesta es `ORIGINAL_ENVELOPE_REQUIRED`; sin evidencia
suficiente se mantiene cerrado. La reparación puede reconstruir únicamente el
recibo verificado del head actual, nunca inventar recibos de versiones pasadas.

La autorrevocación puede terminarse desde un login nuevo. Para una identidad Auth
que ya no exista se añadió una capacidad **privada de operador**, independiente
del JWT del usuario. `tr8_operator_vault_receipt` solo permite service_role y
devuelve metadatos de un recibo negativo concordante con la proyección/ciphertext
actuales. `finalizeNegativeIntent` comprueba esa evidencia contra la intención
independiente. Rechaza PUT e inscripción y no entrega datos de la bóveda.
No existe una ruta de navegador para esa capacidad.

Se ensayaron en Cloudflare/PostgreSQL una intención de PUT previa a SQL, su
reenvío exacto, el replay sin duplicados y una autorrevocación SQL confirmada cuyo
journal seguía pendiente. La finalización desde otra sesión dio éxito. El lector
privado SQL se probó como service_role sin la sesión iniciadora y dentro de una
transacción revertida. Las pérdidas de respuesta y otros fallos intermedios
tienen además pruebas locales inyectadas; no se presentan como cortes del proveedor.

## 4. Recuperación de la autoridad externa

El alta inicial requiere un bootstrap explícito de una instancia nueva. El
Worker publicado lleva `BOOTSTRAP_ENABLED=false`: aunque se pierda el namespace,
una consulta no lo inicializa y un bootstrap con la credencial de servicio está
denegado. Los namespaces anteriores conservan sus hechos y no se reinician.

El operador puede exportar un comprobante Ed25519 de los metadatos, ligado a
autoridad, caso, propietario, secuencia, digest de estado e intención pendiente.
La huella de clave pública y el mínimo conocido se conservan fuera de Supabase
y Cloudflare. El verificador recibe ese pin por un canal separado del respaldo;
rechaza firmas, identidades, secuencias o digests incompatibles. Los comprobantes
del ensayo son de una sola firma y no son una infraestructura de claves productiva.

**Una firma demuestra integridad, no que el comprobante sea el último.** Si no
hay autoridad vigente o evidencia independiente suficiente de actualidad,
`assessAuthorityRecovery` devuelve admisión falsa y exige una generación nueva.
Nunca restaura automáticamente el journal antiguo ni reutiliza su contexto.
El camino de recuperación de datos sería una importación explícita del respaldo
cifrado a un contexto y claves nuevos, como exige 6B.3, después de revisar
identidad, generación y credenciales. No se ha ejecutado con datos reales.

Un rollback silencioso del propio proveedor no queda resuelto universalmente
por un checkpoint manual. Si no puede demostrarse continuidad, no se activa la
bóveda. Una garantía automática más fuerte exige un testigo de actualidad en
otro dominio de fallo y su revisión de presupuesto/operación; no se simula con
otra tabla de la misma base.

Se verificaron firma/pin, regresión, evidencia ausente y pendiente. En el
servicio alojado el bootstrap cerrado dio 403. Tras retirar su credencial y
redesplegar explícitamente, la credencial antigua dio 401 y el Edge dio 503 para
lectura y escritura. Finalmente se desactivó también el Edge.

## Recursos, pruebas y cierre

- Worker de pruebas: `tr8-vault-control-test`, SQLite Durable Objects, cuenta
  Edgar Padilla. Edge: `tr8-vault-control-test`, fijado al proyecto TEST literal
  y al propietario ficticio `@example.test`. El código no admite usuarios reales.
- Se añadieron 62 pruebas locales significativas sobre heads, identidad,
  concurrencia/fallos, recuperación y frontera HTTP. Los ensayos alojados se
  conservan fuera de Git junto al SQL y snapshots sintéticos.
- Las seis migraciones nuevas se aplicaron solo a `tr8-test`. Los RPC
  auxiliares y guards privados no conceden acceso de datos a anon/authenticated;
  los tres nuevos almacenes tienen RLS y sin DML directo para service_role.
- Cierre: configuración desactivada y en cuarentena, cero proyecciones/operaciones
  de ensayo en SQL, identidad ficticia habilitada como antes y secreto Cloudflare
  retirado. No se eliminó el usuario ni sus proyectos/tareas.
- Se mantienen Supabase Free, Vercel Hobby y Workers Free. No se contrataron
  servicios ni funciones de sesión Pro. Los límites Free se tratan como error
  cerrado, sin reintentos infinitos ni polling financiero en segundo plano.
  [Límites oficiales de Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Los envelopes alojados son vectores públicos con cabeceras adaptadas, como en C:
se verifica persistencia opaca y rechazo de rollback; no se afirma descifrado
bajo esas cabeceras. Las pruebas criptográficas del producto se ejecutan aparte.
El script de aceptación requiere Node 24 con `--experimental-transform-types`,
destinos fijados y fixtures fuera de Git. No contiene contraseñas ni secretos.

Antes de activar finanzas reales siguen siendo necesarias la revisión del
modelo de continuidad externa, las rutas productivas de identidad, custodia de
claves/pins, CSP y los recorridos del propietario. **F02 permanece abierto.**

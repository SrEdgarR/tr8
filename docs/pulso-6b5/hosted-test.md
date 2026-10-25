# 6B.5B · Registro sintético alojado en Cloudflare

Fecha: 2026-10-25. Este corte continúa el banco local de 6B.5A. **El ADR F02
permanece abierto y las finanzas reales siguen desactivadas.**

## Recurso y separación

- Cuenta verificada: Edgar Padilla, Workers **Gratuito**, sin cambio de plan.
- Worker: `tr8-authority-test`; un binding `JOURNAL` a la clase SQLite
  `Tr8SyntheticAuthority`. Configuración en
  [`wrangler.toml`](../../cloudflare/finance-authority-test/wrangler.toml).
- Código en [`worker.ts`](../../cloudflare/finance-authority-test/worker.ts).
  Comparte el núcleo SQL con el banco local; no importa Node, KDF ni claves de
  bóveda. No modifica la app, el Edge financiero o PostgreSQL.
- El journal guarda únicamente metadatos ficticios del protocolo. La única
  identidad admitida es el fixture de 6B.1, fijado en código. Ni siquiera una
  credencial válida habilita al propietario real o un contexto arbitrario.

La provisión del namespace utiliza `new_sqlite_classes`, compatible con Free.
No se cambian dominios, DNS, otros Workers ni recursos del usuario. Observabilidad
del Worker desactivada; no se añaden logs de requests, cuerpos o cabeceras.

## Frontera HTTP de pruebas

El servicio exige HTTPS, POST, rutas exactas, cuerpo JSON de hasta 4 KiB,
credencial de servicio y nonce canónico. Rechaza Origin de navegador, querystrings,
codificaciones de cuerpo y campos desconocidos. El parser rechaza claves
duplicadas. Las respuestas son `no-store`, sin CORS, y reflejan el desafío y la
identidad de autoridad cuando corresponde. No se puede consultar directamente
desde la interfaz de TR8.

La comparación de la credencial utiliza verificación HMAC de Web Crypto. No
es una firma de los recibos ni convierte un digest en evidencia de un commit de
Supabase. El nonce evita aceptar una respuesta que no corresponda a la petición
del ensayo; no se afirma que exista un protocolo de admisión distribuido.

El bootstrap requiere un comando autenticado y fijado al fixture. No se inicializa
estado durante una lectura; un bootstrap repetido no borra retiros, intenciones o
revocaciones. Los cambios del journal usan `storage.transactionSync` con SQL
síncrono, sin red dentro de la transacción.

## Autorización y secretos

Wrangler 4.152.0 está instalado fuera del repositorio. El usuario autorizó
`user:read`, `account:read`, `workers_scripts:write` y el acceso de background que
requiere OAuth. No se añadieron permisos DNS, rutas, Pages, D1, KV o facturación.
Wrangler puede mostrar una advertencia por no tener todos sus permisos por
defecto; eso no justifica ampliar el alcance concedido.

Sus credenciales se guardan cifradas, con la clave en Windows Credential Manager.
El secreto aleatorio del servicio se generó fuera de Git, se subió sin imprimir
su valor y nunca se puso en Vite, el navegador, Supabase o los documentos. Después
del ensayo se retiró `ACCESS_TOKEN` del Worker: el servicio queda cerrado y sus
tombstones ficticios persistidos. La credencial local anterior queda inactiva.

## Evidencia y límites

- Veinte pruebas del núcleo y banco local, más once pruebas de frontera HTTP con
  SQLite real. Se ejecutan con `npm run test:edge`.
- Veintitrés comprobaciones HTTP contra Cloudflare: autenticación, propietario y
  Origin incorrectos; bootstrap; intención pendiente; retries exactos concurrentes;
  persistencia tras redespliegue inmediato; confirmación alterada; revocación;
  epoch antiguo; retiro y rechazo de recibo/contexto anterior. El bootstrap
  repetido conservó el retiro.
- Tras retirar el secreto se realizó una comprobación adicional con la credencial
  anterior: recibió `401 AUTH_REQUIRED`. No basta una petición sin credencial
  para demostrar que el acceso de pruebas ha quedado cerrado.
- Antes de verificar la persistencia se publicó la versión
  `f8e43883-4dfd-4f4c-a5d2-685c4de538ba` con el modo de actualización de Durable
  Objects `immediate`. La intención preparada continuó pendiente después de ese
  despliegue. Esto prueba redespliegue, no un corte de energía ni todos los modos
  de pérdida del proveedor.
- La purga se ensaya en SQLite local y en la frontera HTTP de pruebas; no se
  presenta como una purga remota ejecutada en este namespace, que quedó retirado
  tras el reset sintético.

El informe HTTP y las capturas se conservan en el directorio privado de la etapa,
fuera de Git. No incluyen el secreto de servicio o las credenciales de Wrangler.
No se importaron respaldos del propietario ni se consultaron/mutaron sus tablas.

## Reproducción controlada

El servicio fue retirado del acceso de pruebas después del ensayo. Repetirlo
requiere preparar una nueva instancia **sintética** con otro identificador de
autoridad, revisar la cuenta/plan, volver a instalar el secreto y mantener el
namespace anterior. No se borra una autoridad para simular que nunca existió.

```powershell
wrangler deploy --dry-run --config cloudflare/finance-authority-test/wrangler.toml
node scripts/finance-6b5/cloudflare-smoke.mjs prepare '<secret externo>' '<informe externo>'
# Redesplegar explícitamente la misma instancia con actualización inmediata.
node scripts/finance-6b5/cloudflare-smoke.mjs verify '<secret externo>' '<informe externo>'
# Retirar ACCESS_TOKEN y comprobar que la credencial anterior ya no funciona.
node scripts/finance-6b5/cloudflare-smoke.mjs closed '<secret externo>' '<informe externo>'
```

El script fija la URL de prueba, rechaza fixtures dentro de Git y usa desafíos
nuevos. La fase prepare no sobrescribe un informe existente; no se debe repetir
contra un namespace retirado esperando que lo reinicie.

## Próximo corte: integración con PostgreSQL

El servicio de pruebas no verifica una confirmación de Postgres: la suministra
el ensayo. Faltan el coordinador real, fencing y revisión de cada vía de baja,
disable, revocación, reset y purga; también registro de contextos nuevos, ciclo
de vida de identidad, replay completo y recuperación de la propia autoridad.
La cadena HTTP de pruebas no sustituye esas piezas.

La próxima entrega debe ensayar una restauración real aislada, con evidencia
independiente completa y fallos parciales entre ambos sistemas. Hasta entonces
no se cambia el gate de la aplicación, no se adapta el servicio a usuarios reales
y no se declara resuelta la protección de restauración.

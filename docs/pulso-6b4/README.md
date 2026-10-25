# Pulso 6B.4 · Interfaz financiera de TR8

Esta entrega conecta el [dominio 6B.3](../pulso-6b3/README.md) y el motor de
bóveda a una ruta personal `/finance`, cargada de forma diferida. Se conserva el
diseño de TR8, sus iconos Lucide, los diálogos accesibles y el comportamiento
adaptable. No hay migraciones, dependencias nuevas, planes de pago ni cambios en
los repositorios de proyectos, tareas, equipos, notificaciones o Google.

## Funcionalidad

- Creación con contraseña privada de al menos 16 caracteres; código nuevo y
  reentrada completa para confirmar custodia antes del primer guardado.
- Apertura por contraseña o recuperación en modo de solo lectura. Para volver a
  escribir desde recuperación se renuevan ambos medios de acceso y se confirma
  la nueva custodia.
- Cuentas de efectivo, débito y crédito, con moneda, saldo/deuda inicial, fecha y
  límite de crédito. Las monedas se presentan separadas, sin conversión implícita.
- Ingresos, gastos, transferencias, pagos de tarjeta y reembolsos referidos al
  gasto original; importes decimales exactos y validación del dominio existente.
- Historial con filtros de cuenta, moneda y fechas; presentación incremental.
- Planes pendientes, confirmación explícita de un movimiento real, aplazamiento
  y cancelación. Confirmar conserva su historial y no permite duplicar el alta.
- Saldos por fecha y proyección explícita de hasta un año, con planes futuros y
  separación entre saldo real y estimación.
- Respaldo cifrado descargable, importación en destino vacío y restauración del
  mismo contexto, ambas con preview antes de guardar. Restaurar exige escribir
  `RESTAURAR`. Renovación de contraseña, recuperación y clave; esta última exige
  escribir `RENOVAR` y confirmar nueva custodia.
- Guardados ambiguos sin plaintext visible y reintento de exactamente los mismos
  bytes. Los conflictos y las denegaciones definitivas requieren volver a abrir.

## Frontera de acceso

**No se habilitan finanzas reales.** Continúa vigente el
[ADR F02](../pulso-6b1/restore-authority.md). No se ha elegido una autoridad
independiente del rollback de la base y no se afirma que el flag de cuarentena
resuelva ese problema. En producción Finanzas presenta un estado honesto de
preparación; no ofrece una bóveda local alternativa ni datos ficticios del dueño.

`createFinanceApi` habilita exclusivamente el origen literal del proyecto TEST.
La interfaz no puede activar producción mediante un parámetro o flag de navegador.
El backend conserva además su allowlist sintética, Auth, control de sesión,
epoch, cuarentena y comparación de revisión. No se despliega una función
financiera de producción como parte de esta entrega.

Para el transporte de pruebas se verifica el bearer exacto mediante `getUser`,
su propietario, issuer, audiencia, rol, sesión y expiración. El GET/PUT usa
`no-store`, no sigue redirecciones, tiene timeout y acota/valida la respuesta.
Solo una denegación cerrada con código y HTTP coincidentes descarta el guardado
como definitivo; los fallos ambiguos conservan el reintento cifrado exacto.

Los equipos no muestran la entrada Finanzas y su URL no monta la bóveda personal.
No hay permiso de equipo que conceda acceso financiero. La ruta se desmonta al
salir de Finanzas o cambiar de espacio/usuario.

## Memoria y ciclo de vida

El hook mantiene una sola acción en vuelo y vincula cada lectura a instancia,
generación del controlador y contador de acción. Comprueba la vigencia después
de cada espera y otra vez antes de publicar el estado de React. Una respuesta
tardía de head, archivo, Worker o lectura no vuelve a mostrar datos después de
bloquear, ocultar, invalidar la sesión o desmontar.

`onClear` retira snapshot, preview y código de recuperación; una nueva clave de
formulario desmonta credenciales, archivos, diálogos y filtros. El controlador
sigue siendo responsable de terminar el Worker, invalidar claves y exigir una
nueva identidad. No se prometen borrado físico de strings de JavaScript ni
protección contra un dispositivo o navegador comprometido.

El contenido financiero no pasa por React Query, localStorage, sessionStorage,
IndexedDB, logs, Google ni tablas de tareas. El navegador conserva únicamente la
sesión general de TR8 según su configuración existente. La descarga de respaldo
es una acción explícita y conserva el cifrado.

## Ensayos reproducibles

```powershell
npm run typecheck
npm run typecheck:edge
npm run typecheck:finance:test
npm test
npm run test:edge
npm run lint
npm run format:check
npm run test:database:static
npm run build
npm run build:finance:test
npm run build:finance:domain:test
npm run build:finance:ui:test
```

La entrada `scripts/finance-6b4/index.html` no forma parte del build de la app.
Su servidor admite exclusivamente el proyecto TEST y el usuario ficticio
preexistente documentado en 6B.2. Las credenciales de fixture permanecen fuera de
Git y del navegador. El puente solo transmite sobres cifrados y registra hashes,
revisiones y estados HTTP; no sustituye una prueba de CORS directo del navegador
al Edge. Se cierra su sesión y se limpian solo sus registros al finalizar.

```powershell
node scripts/finance-6b2/serve.mjs '<fixture privado fuera del repositorio>' --finance-6b4
```

La UI de pruebas usa el Worker financiero, Argon2id y AES-GCM reales. El servidor
aplica CSP sin eval en la página y permite WASM únicamente al Worker, sin red
desde él. La verificación estática comprueba los paquetes ESM fijados, hashes y
grafo de importaciones para impedir que el KDF llegue al hilo principal. CI
compila y verifica también esta entrada separada.

Las pruebas de React usan dobles criptográficos explícitos para controlar
respuestas tardías, bloqueos, confirmaciones y formularios. No se presentan como
evidencia del KDF real. Los ensayos de navegador complementan esa cobertura.

Antes de una futura activación real siguen pendientes la autoridad del ADR F02,
sus ensayos de restauración y conciliación, revisión del despliegue/CSP de la
aplicación real y aceptación de los flujos del propietario. Cambiar el origen o
abrir flags no basta para dar por cumplidas estas condiciones.

# 6B.5C · Coordinación y restauración lógica en PostgreSQL

Fecha: 2026-10-25. Implementado y ensayado con una identidad ficticia en
`tr8-test`. **No habilita finanzas reales ni cierra el ADR F02.** No hay cambios
en los proyectos/tareas ni en el esquema financiero de producción.

## Implementación

El Edge `tr8-finance-restore-test` verifica el JWT con Auth, exige el origen
configurado y deriva el usuario, sesión, caducidad y AMR del token verificado.
Solo admite el propietario de la fixture `@example.test`, el contexto sintético
fijo y el proyecto de pruebas fijado en código. Su bandera de entorno es distinta
de la del Edge anterior; no activa sus rutas ni la interfaz real.

El servicio `tr8-authority-restore-test` usa Durable Objects SQLite y un namespace
nuevo, separado del ensayo B. Tiene tres instancias de caso: reset, revoke y
purge. La identidad de autoridad está fijada en código y configuración fuera de
la proyección de PostgreSQL. Su credencial solo se instala en los dos servidores,
nunca en el navegador, Git ni logs. El bootstrap es explícito y exclusivo de la
fixture; una consulta no crea ni reinicia una autoridad.

El endpoint de estado entrega el historial completo, los retiros y las sesiones
revocadas. El cliente verifica campos cerrados, nonce nuevo, instancia, caso,
epoch, orden, digest de cada comando y correspondencia exacta entre historial y
hechos. Más de 64 operaciones/hechos, datos truncados, respuesta cacheable,
identidad distinta o dependencia inaccesible deniegan acceso. El digest identifica
el comando; no es una firma ni sustituye la autenticación entre servidores.

Para lecturas, escrituras y recibos:

1. Consultar la autoridad independiente y rechazar retiros, purgas, revocaciones
   o una intención pendiente.
2. Obtener metadatos de PostgreSQL; su epoch debe coincidir con la autoridad.
3. Ejecutar la operación con ese epoch como fence dentro de la transacción SQL.
4. Consultar de nuevo la autoridad. Si cambió o falló, no entregar el resultado.

Las transacciones SQL mantienen los bloqueos de configuración, identidad, sesión
y actor hasta commit. No contienen llamadas de red. El bloqueo global de la
configuración serializa deliberadamente este pequeño ensayo sintético; no es el
diseño de concurrencia definitivo para un servicio multiusuario.

Para reset, revocación y purga se exige autenticación reciente: primero se
autoriza la sesión en SQL, después se persiste la intención en Cloudflare, luego
se confirma la mutación SQL y su vínculo al comando/digest/epoch en una única
transacción, y finalmente se confirma el journal. El Edge comprueba la identidad
exacta del recibo SQL. No acepta recibos de base enviados por el navegador.

Una pérdida de respuesta deja la intención bloqueando acceso. El reintento exacto
puede recuperar el recibo SQL y confirmar una intención pendiente; cambiar el
comando con el mismo ID produce conflicto. No se usa TTL para desbloquear. Los
casos que no pueden reanudarse con certeza, incluida una pérdida de identidad o
una autorrevocación interrumpida, permanecen cerrados y requieren un protocolo
de recuperación posterior. Una purga confirmada deniega también nuevos comandos.

## Reparación tras restaurar

La nueva migración `20261025145648` se aplicó **solo a pruebas**. Añade
configuración desactivada por defecto, identidad de autoridad, vínculos de
operación y reparación. Todas las tablas tienen RLS y carecen de permisos
directos para anon, authenticated y service_role. La función coordinada solo es
ejecutable por service_role; el antiguo RPC financiero y sus helpers dejan de
ser ejecutables por ese rol para evitar el acceso por la ruta anterior.

El operador pone la base en cuarentena. `POST /reconcile` con `release:false`
revalida Auth reciente sin quitarla, exige evidencia completa sin intenciones
pendientes, reconstruye hechos/recibos y eleva el epoch. Elimina ciphertext y
recibos que pertenecen a un contexto retirado/purgado. Nunca reduce el epoch ni
elimina revocaciones; hechos locales no explicados por la evidencia son conflicto.

La reparación guarda el hash de la evidencia aplicada. Solo otra observación
independiente idéntica permite solicitar `release:true`. SQL exige ese hash y
epoch antes de levantar la cuarentena. Levantarla no elimina los retiros ni las
revocaciones: las comprobaciones externas siguen siendo obligatorias en cada
acceso. Una intención nueva que aparezca después de la observación sigue
denegando las operaciones posteriores desde el journal.

## Ensayo alojado y resultados

Se capturó y restauró realmente por DML una **copia lógica de la proyección
financiera sintética en PostgreSQL alojado**. Incluyó actor, epoch, envelope,
recibos, retiros, revocaciones, vínculos y estado de reparación. La autoridad de
Cloudflare permaneció fuera de esa restauración.

No fue una restauración física de todo Supabase ni PITR. Auth y las tablas de
proyectos/tareas no se restauraron; mantener las sesiones vigentes hizo posible
probar el rechazo de tokens reales frente a datos financieros antiguos.

| Caso             | Copia restaurada                                  | Respuesta de API                       | Reparación verificada                                      |
| ---------------- | ------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| Reset            | epoch 1, una bóveda y un recibo, cuarentena falsa | GET, PUT exacto y recibo: 403          | epoch 2, retiro persistente, cero bóvedas/recibos          |
| Revocación       | mismo estado anterior sin revocación              | sesión revocada: 403 en las tres rutas | epoch 2, revocación reconstruida; otra sesión lee 200      |
| Purga financiera | mismo estado anterior sin purga                   | GET, PUT exacto y recibo: 403          | epoch 2, purga y retiro persistentes, cero bóvedas/recibos |

En los tres casos el acceso anónimo dio 401. Un fence SQL incorrecto y una
mutación sin intención dieron conflicto sin modificar la copia. Una intención
pendiente real dio 503 y no permitió reparar/levantar la cuarentena. Se retiró
la credencial de Cloudflare y se redesplegó explícitamente: la credencial anterior
dio 401 y el Edge dio 503 para datos, PUT y recibos. Finalmente se desactivó el
Edge, que respondió `FINANCE_DISABLED`.

Los envelopes son vectores públicos con cabeceras adaptadas a la fixture: se
ensaya almacenamiento opaco, no su descifrado bajo esas cabeceras. No se cargó
un respaldo real de Pulso. La purga sintética solo toca el dominio financiero;
no elimina al usuario Auth ni sus proyectos.

Se añadieron 31 pruebas del coordinador/evidencia con SQLite real y fallos
inyectados entre las dependencias: carrera con un reset, caída de la segunda
lectura, epoch antiguo, pérdida de respuesta SQL/Cloudflare, recibo distinto,
historial incompleto, nonce/autoridad/caso/caché incorrectos y límites de tamaño.
Los fallos distribuidos inyectados son pruebas locales; no se presentan como
cortes eléctricos o fallos del proveedor alojado.

Los informes HTTP, snapshots y SQL exacto del ensayo se guardan fuera del repo.
El script `scripts/finance-6b5c/hosted.mjs` fija los destinos de prueba y rechaza
credenciales dentro de Git. La captura/restauración DML requiere operación
administrativa explícita y acotada; el navegador no dispone de esa capacidad.
No se reinicia un namespace retirado para repetir el ensayo: se debe preparar
otra identidad/instancia de pruebas y revisar sus destinos y permisos.

## Estado de cierre y límites pendientes

- Producción: dos proyectos y dos tareas, hashes íntegros sin cambios; 16
  migraciones. Pruebas: 11 proyectos y 25 tareas, hashes sin cambios; 17 migraciones.
- Cero actores, bóvedas, recibos, allowlist, vínculos y propietarios financieros
  de ensayo en PostgreSQL. Configuraciones desactivadas y cuarentena activa.
- Credencial Cloudflare retirada y acceso anterior denegado; el namespace
  conserva sus hechos. Workers Free, Supabase Free y Vercel Hobby se mantienen.
- Altas externas cerradas y admisión financiera real desactivada.

Para cerrar F02 faltan la cobertura integral de bajas/disable y sesiones Auth,
alta segura de contextos nuevos, cambios de credenciales, protección contra
rollback de snapshots ordinarios, recuperación de intenciones que no pueden
reintentarse y recuperación de la propia autoridad ante pérdida/restauración del
proveedor. También quedan la revisión de coste/cuotas, CSP y los flujos reales
del propietario. **Este ensayo de ciclo de vida no garantiza por sí solo que
una versión antigua cualquiera de una bóveda activa sea rechazada.**

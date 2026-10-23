# Etapa 1 · Espacios e identidad

Implementación del primer paso del [plan acordado](../stage-0/implementation-plan.md), autorizada el 2026-10-23. Continúa el uso gratuito; no habilita altas externas ni servicios de correo. Las decisiones futuras de etapa 0 conservan su alcance original.

## Alcance

- Un espacio personal por identidad habilitada y varios equipos independientes.
- Selector de espacio, creación idempotente de equipos y directorio mínimo de miembros.
- Proyectos y tareas conservan lista, tablero, formularios, archivo, búsqueda y filtros.
- Las URLs existentes `/projects/:id?view=board` consultan el espacio del proyecto mediante RLS. No requieren cambiar los enlaces guardados.
- Sesiones existentes conservadas en `tr8.auth.v1`. Login editable, registro público retirado y recuperación validada contra la identidad de Auth.
- La invitación y su aceptación tienen contrato SQL, con destinatario confirmado, vencimiento, revocación, permisos vigentes del emisor e idempotencia. Permanecen bloqueadas por `external_invites_enabled = false`, incluido el servidor.

El propietario administra el contenido de sus espacios. La interfaz de miembros es de consulta. La administración de roles, acceso por proyecto, responsables de tareas y colaboración entre cuentas reales se completa en etapa 2, después de resolver la provisión de cuentas. No hay correo transaccional de proyectos, Google Calendar ni Pulso activados.

## Datos y autorización

`public.tr8_projects` y `public.tr8_tasks` se renombran en sitio a `tr8_workspace_projects` y `tr8_workspace_tasks`. Se añade `workspace_id`; `owner_id` conserva la procedencia del autor y deja de decidir el acceso. Los campos históricos, OIDs, identidad/secuencia, versiones y tiempos se comprueban dentro de la migración; cualquier diferencia aborta la transacción.

El esquema no expuesto `tr8_private` contiene identidades habilitadas, espacios, membresías, catálogo de 18 permisos, plantillas Lectura/Colaborador/Administración, roles acumulativos, ACL de proyectos, invitaciones y actividad mínima. Todas sus tablas tienen RLS y acceso directo revocado. El propietario accede a todos los proyectos de su equipo; los demás requieren membresía activa, permiso y ACL explícita. La pertenencia al equipo o un rol de administración no abren por sí solos un proyecto privado.

El bootstrap consulta una sola vez la configuración histórica y la cuenta confirmada de Auth. A partir de ahí se consulta `app_users`; iniciar sesión, modificar el correo de configuración o manipular `user_metadata` no habilita una cuenta. Se comprueba también que Auth siga confirmado, activo y sin eliminación/bloqueo.

No hay escritura directa desde `anon` o `authenticated`, tampoco mediante permisos heredados por columna o secuencia. Los wrappers públicos son `SECURITY INVOKER`; cada implementación privada usa identidad de sesión, permisos vigentes, `search_path` vacío y bloqueos de autorización antes de escribir. Los UUID, autores, espacio, tiempos y versiones no son campos editables.

## API v2

| RPC                                     | Entrada principal                         | Resultado                                                                              |
| --------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| `tr8_v2_get_context`                    | Sin parámetros                            | Versión de contrato 2, espacio personal, espacios autorizados y puerta de invitaciones |
| `tr8_v2_create_team`                    | UUID estable y nombre                     | Espacio creado; reintento compatible devuelve el mismo                                 |
| `tr8_v2_list_members`                   | Espacio                                   | Directorio mínimo y roles, sin correos de otros miembros                               |
| `tr8_v2_list_invitations`               | Espacio                                   | Propietario del equipo: estados y destinatarios; sin token ni digest                   |
| `tr8_v2_create_invitation`              | Espacio, UUID estable, correo             | Token solo en primera creación; reintento devuelve `token: null`                       |
| `tr8_v2_revoke_invitation`              | Espacio, UUID y versión                   | Estado y versión nuevos                                                                |
| `tr8_v2_accept_invitation`              | Token efímero                             | Equipo, miembro y estado aceptado                                                      |
| `tr8_v2_create_project` / `create_task` | Espacio, UUID estable y campos permitidos | Fila persistida                                                                        |
| `tr8_v2_update_project` / `update_task` | Espacio, UUID, versión y parche           | Fila persistida con versión incrementada                                               |
| `tr8_v2_delete_task`                    | Espacio, UUID y versión                   | Sin contenido                                                                          |

Los nombres abreviados de la última parte de la tabla mantienen el prefijo `tr8_v2_`. Los tipos públicos se generan desde el esquema de prueba y se conservan en `src/app/data/database.generated.ts`.

Los conflictos de versión devuelven `PT409`, recursos no accesibles `PT404`, identidad no habilitada `42501` y entradas inválidas `22023` o restricciones Postgres. Las cuentas se verifican antes de buscar tareas para no distinguir su existencia. El archivado serializa con escrituras de tareas y bloquea creación/edición hasta restaurar; permite eliminar una tarea con permiso y versión.

El repositorio pagina el contenido en lotes de 250 y filtra explícitamente por espacio; RLS permanece como barrera del servidor. Las cachés usan usuario y espacio, se cancelan y eliminan al cambiar y se retiran al recibir una denegación. Una respuesta tardía no puede navegar ni poblar el nuevo espacio. El token de invitación se retira del fragmento de URL y permanece solo en memoria del flujo, fuera de la caché de mutaciones.

## Migración y recuperación

1. Registrar SHA de origen, inventario y huellas de los datos antes del corte. Copiar proyectos, tareas, configuración inicial, identidades mínimas y estado de secuencia a un archivo privado fuera del repositorio. No exportar contraseñas, tokens ni sesiones de Auth.
2. Usar `scripts/stage1/build-restore-rehearsal.mjs <backup.json> <migration.sql> <private-output.sql>` para generar un ensayo con `BEGIN/ROLLBACK`. Requiere tablas de prueba vacías, compara restauración y migración y rechaza límites de transacción en la migración incluida. Ejecutarlo únicamente en la base aislada, nunca en producción.
3. Aplicar las migraciones históricas y luego `20261023113257_workspace_identity_stage1.sql`. El corte bloquea las dos relaciones y la configuración con `NOWAIT`; si hay actividad incompatible, aborta y se reintenta en otro momento. No editar migraciones aplicadas.
4. Aplicar `20261023114232_close_task_resource_oracle_stage1.sql`, que adelanta la comprobación de cuenta en dos funciones sin cambiar datos ni grants.
5. Probar el cliente nuevo antes de coordinar esquema y publicación. El cliente antiguo falla cerrado porque ya no existen tablas ni RPC antiguas; no se mantiene un puente que exponga contenido compartido. Este corte puede ocasionar una interrupción breve.
6. Comparar de nuevo huellas y secuencia, confirmar cuenta habilitada, RLS, puerta de invitaciones cerrada y enlaces previos. No ejecutar fixtures sobre producción.

Volver a un bundle antiguo no revierte el esquema. Ante un problema de cliente, corregir o volver a una versión compatible con API v2. Ante fallo de migración, su transacción revierte. Para una recuperación de datos posterior al commit, detener escrituras, conservar un respaldo nuevo y reconciliar los cambios antes de restaurar. El respaldo de contenido de esta entrega no sustituye una copia completa de Auth ni un servicio PITR.

## Verificación reproducible

- TypeScript, Vitest, ESLint, Prettier, comprobación estática histórica, `git diff --check` y build antes de publicar.
- `supabase/tests/workspace_stage1.sql`: 176 aserciones contra roles reales de Postgres, con identidades sintéticas `example.test` y `BEGIN/ROLLBACK`. Cubre autorización, RLS, ACL/roles acumulativos, FKs, versiones, archivo, grants por columna/secuencia, invitaciones, aceptación atómica y contenido preexistente. No simula conexiones simultáneas.
- `scripts/stage1/http-smoke.mjs <private-config.json> all`: Auth real y Data API con clave pública, 98 aserciones y carrera de dos solicitudes sobre una versión. El script solo admite el host aislado designado, rechaza producción y claves privilegiadas y no imprime tokens ni contraseñas. Sus fixtures sintéticos y configuración privada no se versionan.
- Navegador: acceso, separación personal/equipo, creación, edición, persistencia, lista/tablero, directorio, invitaciones cerradas y enlaces directos. No usar contraseñas reales en las pruebas automatizadas.

## Registro de verificación · 2026-10-23

- Base de código previa: `89959e572298b0361f385ffdd7348f06ac1693e2`.
- Ensayo privado de restauración y migración: un proyecto y una tarea reales preservados íntegramente; transacción revertida y base de prueba vacía confirmada antes de instalar el esquema definitivo.
- SQL final: 176 aserciones aprobadas, después de aplicar ambas migraciones de etapa 1 en prueba.
- HTTP: 98 aserciones en 65 solicitudes con tres cuentas ficticias. Carrera real: una escritura guardada y un conflicto `PT409`, con un único incremento de versión.
- Aplicación: 82 pruebas aprobadas; TypeScript, ESLint, Prettier, comprobación estática histórica, `git diff --check` y build correctos. Persiste un aviso de Vite por tamaño del bundle, sin error de compilación.
- Navegador local contra prueba: sesión ficticia, creación de equipo/proyecto/tarea, cambio de estado, lista y tablero, recarga, separación de espacios, enlace directo sin `workspace`, directorio y botón de invitaciones desactivado. Verificación móvil a 390 × 844 con menú y selector funcionales, sin desbordamiento del documento.
- Revisión independiente: corregidos el retiro de datos de caché ante denegación y la consulta de existencia previa a autorización. Sin hallazgos bloqueantes pendientes en esa revisión.
- La prueba de envío de correo y la incorporación de usuarios externos se omiten deliberadamente porque esas funciones están desactivadas por decisión del propietario.
- Publicado el código `9afc1ea890a1de346d1e3aeea0c25ad01dd143ca` en [TR8](https://tr8.vercel.app/). Preview HTTPS con Auth, cambio de estado y persistencia tras recarga comprobados, sin errores de consola. Bundle preview con referencia de prueba únicamente; bundle de producción con referencia de producción únicamente.
- Producción después del corte: un proyecto, una tarea, una identidad habilitada y un espacio personal. Huellas de todos los campos históricos y secuencia idénticas a las previas. Lectura con el rol autenticado y la identidad del propietario: contrato v2, un proyecto y una tarea visibles. No se ejecutaron fixtures ni se usó la contraseña del propietario en producción; el acceso de navegador se ensayó con cuentas ficticias en preview.
- Los cuatro registros de migración remotos coinciden con los archivos locales, tanto en producción como en prueba. MCP asignó inicialmente timestamps de aplicación distintos: se reconciliaron solo sus versiones bajo bloqueo/transacción, comprobando nombre, versiones origen/destino y huellas del resto de cada registro. No se modificaron archivos aplicados ni se repitió DDL.
- Las comprobaciones de aplicación son locales. La consulta de GitHub no devolvió ejecuciones de Actions para este commit; no se presenta ese resultado como CI aprobada. El build de Vercel sí quedó `READY` y el dominio apunta a la nueva aplicación.

## Operación gratuita y límites

Producción usa `tr8`; prueba usa `tr8-test`, ambos en Horizon Studios Free. Los previews de Vercel apuntan exclusivamente a prueba. No se contrataron SMTP, ramas de pago, cron, colas ni planes Pro. Las claves del navegador son públicas; nunca se necesita una clave privilegiada en React.

La base aislada ocupa el segundo proyecto activo permitido por la organización gratuita. No crear un tercero sin revisar cupo. El proyecto de prueba solo contiene datos ficticios persistentes; el ensayo con contenido real se revirtió íntegramente. Una pausa del proyecto gratuito o sus cuotas pueden afectar disponibilidad; no se promete un SLA.

Los avisos informativos de RLS sin políticas son deliberados en tablas privadas que no admiten lectura cliente. Los índices nuevos sin uso y algunas FKs de administración no indexadas se revisarán al introducir consultas o volumen que lo justifiquen. No se añaden índices sin uso medido. La protección contra contraseñas filtradas de Supabase no se activa porque requiere Pro.

Antes de altas externas: elegir proveedor/remitente verificado, provisión controlada de Auth, probar entrega/confirmación/recuperación, paginar directorios e invitaciones y cerrar las pruebas de la etapa 2. El interruptor actual no basta por sí solo para habilitar esta función.

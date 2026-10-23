# Contrato de datos y autorización

Estado: diseño de etapa 0, 23 de octubre de 2026. No describe funciones ya
implementadas ni contiene una migración ejecutable. Las decisiones de producto
son las acordadas con el usuario; las reglas técnicas siguientes son propuestas
de implementación y criterios obligatorios de revisión antes del desarrollo.

## Base observada

El esquema actual tiene `tr8_projects` y `tr8_tasks`, vinculados mediante
`(project_id, owner_id)`. El propietario coincide con la cuenta confirmada de la
allowlist administrativa. `src/app/types.ts` no contiene equipos, miembros,
responsables ni horarios. `src/app/data/repository.ts` carga todos los registros
visibles mediante RLS y utiliza las seis RPC públicas actuales.

Las RPC son `SECURITY INVOKER`. `authenticated` conserva permisos de escritura
directa sobre determinadas columnas y uso de la secuencia: RLS y los triggers
protegen las filas, pero la versión esperada se exige en las RPC, no en toda
escritura directa. El modelo colaborativo debe cerrar esta segunda vía antes de
habilitar equipos. No basta con ampliar el predicado `is_owner()`.

Referencias locales: [base actual](../database.md),
[migración y aceptación](migration-and-acceptance.md).

## Decisiones de producto fijas

- Un espacio personal privado por usuario y varios equipos independientes.
- Los proyectos de equipo nacen privados; solo participan miembros activos del
  equipo con acceso al proyecto. No hay invitados externos en esta versión.
- El propietario accede a todos los proyectos de su propio equipo. Un
  administrador delegado necesita acceso explícito al contenido de cada proyecto.
- Roles personalizados del equipo, varios por persona y permisos acumulativos.
  Los roles no abren proyectos privados por sí mismos.
- Un responsable principal opcional por tarea, distinto de su creador.
- La propiedad y los roles de un equipo no abren espacios personales ni bóvedas
  financieras. Pulso será privado por usuario.

## Modelo lógico propuesto

Los identificadores de equipo, rol, proyecto y usuario nunca son intercambiables.
Las relaciones compuestas deben hacer imposible combinar un recurso de un
equipo con membresías, roles o accesos de otro, incluso si una RPC contiene un
error. Los nombres nuevos son orientativos; no son objetos ya creados.

| Entidad                 | Campos e invariantes principales                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profiles`              | `user_id`, nombre visible y zona horaria. No expone email, tokens ni datos de la bóveda al directorio del equipo.                                                               |
| `workspaces`            | `id`, `kind` personal/equipo, `owner_id`, nombre, versión y tiempos de servidor. Unicidad de espacio personal por propietario. Su propietario no es un rol editable.            |
| `workspace_members`     | Identidad estable de membresía, `workspace_id`, `user_id`, estado y versión. Unicidad equipo/usuario. Una invitación pendiente no equivale a membresía activa.                  |
| `workspace_roles`       | `id`, `workspace_id`, nombre y versión. No admite el permiso ficticio «superadministrador» ni cambiar su equipo.                                                                |
| `role_permissions`      | Equipo, rol y clave de un catálogo fijo, con unicidad por rol/clave.                                                                                                            |
| `member_roles`          | Equipo, membresía y rol del mismo equipo; no acepta IDs de otro espacio.                                                                                                        |
| `project_access`        | Equipo, proyecto, membresía y nivel `read` o `write`. Un único acceso por proyecto/membresía; no concede permisos de rol.                                                       |
| `invitations`           | Equipo, email normalizado destinatario, digest del token, expiración, emisor, estado y versión. El token original no se guarda ni se registra.                                  |
| Proyectos               | UUID, `workspace_id`, procedencia de creador y campos existentes. El código continúa derivado del UUID; unicidad por espacio. Cambiar de equipo queda fuera del primer alcance. |
| Tareas                  | UUID, `workspace_id`, `project_id`, procedencia de creador, responsable opcional y campos actuales. Bloque horario opcional sujeto al contrato de calendario.                   |
| `workspace_authz_state` | Una fila por espacio para serializar cambios de autorización y mantener su revisión. No es editable desde el navegador.                                                         |
| Actividad               | Equipo/proyecto, actor, acción, identificador y fecha. Payload mínimo, sin textos privados innecesarios ni secretos.                                                            |

La relación tarea/proyecto será `(workspace_id, project_id)` y la pertenencia del
responsable se comprobará dentro de ese mismo espacio. En equipos, el responsable
debe ser miembro activo con acceso de lectura al proyecto y capacidad de leer
tareas; no tiene que poder editarlas. En el espacio personal solo puede ser su
propietario o quedar vacío. Cualquier cambio que lo vuelva inelegible lo
desasigna en la misma operación controlada: retirada de proyecto/equipo, cambio
de nivel, asignación o retirada de roles, edición/eliminación de sus permisos o
cambio de propiedad. Se comprueba el acceso efectivo posterior, no solo que
exista una fila de membresía o ACL. La desasignación incrementa versión y tiempos
de las tareas afectadas, emite su acontecimiento y programa limpieza Google;
no borra trabajo ni envía contenido a quien perdió acceso. El resultado público
no revela títulos ni conteos de proyectos privados que el administrador no pueda
consultar. Es un cambio de dominio ordinario, distinto del backfill histórico que
debe conservar versiones y tiempos.

`owner_id` actual no se reinterpretará como permiso colaborativo: será procedencia
histórica durante la transición. `workspace_id` expresa el ámbito; el creador
expresa autoría; el responsable expresa asignación. La eliminación de una cuenta
no podrá activar cascadas que borren proyectos de un equipo por su creador.

Índices mínimos a revisar con planes reales: espacios por propietario; membresías
por usuario/equipo y estado; roles por miembro; accesos por miembro/proyecto;
proyectos por espacio y actualización; tareas por espacio/proyecto/posición,
responsable y rango temporal. Evitar índices preventivos sin consulta concreta.

## Evaluación de acceso

El actor se obtiene de `auth.uid()`. Se comprueba su registro vigente, cuenta
confirmada/no eliminada y habilitación de aplicación, además de las membresías
actuales. No se confía en `user_metadata`, cabeceras de cliente ni roles copiados
en un JWT que puede quedar desactualizado.

Para el espacio personal, solo su propietario obtiene acceso a sus proyectos.
Para un equipo, el propietario protegido es la única excepción al acceso
explícito por proyecto. Los demás necesitan simultáneamente:

1. Membresía activa del equipo correcto.
2. Acceso explícito al proyecto.
3. Permiso de operación, acumulado a partir de sus roles actuales.
4. Nivel del acceso compatible: `read` para leer, `write` para modificar.

La ausencia de cualquiera de estas condiciones deniega. Crear un proyecto
requiere membresía y `project.create`; su creador recibe acceso `write` en la
misma transacción, sin recibir por ello permisos adicionales de rol. No existe
«todos los equipos» por ser administrador de uno.

Toda operación sobre contenido de proyecto requiere también `project.read`; las
operaciones sobre tareas requieren `task.read`. La interfaz mostrará estas
dependencias al editar un rol. No se arreglan asignando permisos adicionales
silenciosamente. `task.assign` solo autoriza el cambio de responsable, no la
edición del resto de campos si falta `task.edit`.

## Catálogo fijo de permisos propuesto

| Clave                   | Alcance y condición adicional                                               |
| ----------------------- | --------------------------------------------------------------------------- |
| `team.settings.edit`    | Configuración general del equipo, sin cambiar propiedad.                    |
| `member.read`           | Directorio mínimo de miembros del equipo, sin contenidos privados.          |
| `member.invite`         | Crear/revocar invitaciones y proponer roles que pueda delegar.              |
| `member.remove`         | Retirar miembros dentro de sus límites de delegación; nunca al propietario. |
| `role.read`             | Consultar catálogo y asignaciones autorizadas del equipo.                   |
| `role.manage`           | Crear, editar o eliminar roles dentro de los límites siguientes.            |
| `role.assign`           | Asignar o retirar roles dentro de los límites siguientes.                   |
| `project.create`        | Crear proyectos únicamente en ese equipo.                                   |
| `project.read`          | Leer metadatos de un proyecto al que tiene acceso.                          |
| `project.edit`          | Editar sus metadatos con acceso `write`.                                    |
| `project.archive`       | Archivar/restaurar con acceso `write`.                                      |
| `project.access.manage` | Gestionar accesos de un proyecto ya accesible con nivel `write`.            |
| `task.read`             | Leer tareas de un proyecto accesible.                                       |
| `task.create`           | Crear tareas con acceso `write`.                                            |
| `task.edit`             | Editar tareas, estado, posición y horario con acceso `write`.               |
| `task.delete`           | Eliminar tareas con acceso `write`.                                         |
| `task.assign`           | Cambiar responsable con acceso `write` y comprobar su elegibilidad.         |
| `audit.read`            | Actividad administrativa del equipo y actividad de proyectos accesibles.    |

No hay permisos personalizados que ejecuten código, comodines, denegaciones
negativas ni jerarquía visual equivalente a autoridad. Transferir propiedad,
eliminar el equipo y administrar una bóveda quedan fuera de este catálogo.
Transferir propiedad se reserva a un flujo separado con reautenticación; no a
una edición genérica del espacio.

Los roles iniciales serán plantillas editables, no privilegios mágicos. Su
contenido de arranque queda fijado como propuesta técnica:

| Plantilla      | Permisos exactos iniciales                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------- |
| Lectura        | `member.read`, `project.read`, `task.read`                                                          |
| Colaborador    | Los tres anteriores más `project.create`, `project.edit`, `task.create`, `task.edit`, `task.assign` |
| Administración | Las 18 claves del catálogo anterior; sin facultad de propiedad ni acceso implícito a proyectos      |

Crear un equipo provisiona esas tres plantillas una sola vez. Su creador será
propietario protegido, sin depender de una asignación de Administración. Una
invitación propone Lectura por defecto; el emisor puede elegir roles que pueda
delegar y se vuelven a comprobar al aceptar. Nunca se asigna Administración
implícitamente. Aceptar no concede acceso a proyectos salvo un acceso expresamente
incluido y validado en esa invitación. Las plantillas y sus asignaciones muestran
sus permisos antes de confirmar; sus nombres no alteran la evaluación. Un miembro
sin roles no obtiene acceso efectivo a proyectos aunque exista una fila de acceso.

| Actor o condición                                   | Equipo y directorio      | Proyecto privado sin acceso | Proyecto `read`     | Proyecto `write`        | Bóveda ajena |
| --------------------------------------------------- | ------------------------ | --------------------------- | ------------------- | ----------------------- | ------------ |
| Propietario de ese equipo                           | Administración protegida | Lectura/escritura           | Lectura/escritura   | Lectura/escritura       | Denegado     |
| Administrador delegado                              | Según roles              | Denegado                    | Lectura según roles | Operaciones según roles | Denegado     |
| Miembro ordinario                                   | Según roles              | Denegado                    | Lectura según roles | Operaciones según roles | Denegado     |
| Miembro retirado, no miembro o invitación pendiente | Denegado                 | Denegado                    | Denegado            | Denegado                | Denegado     |

Ser creador o responsable no añade excepciones a esta matriz. Archivar conserva
lectura, bloquea creación/edición de tareas y permite eliminar una tarea solo con
`task.delete`, como en el comportamiento actual. Cambiar este comportamiento
requeriría una decisión posterior.

## Delegación sin elevación de privilegios

Toda operación calcula primero los permisos vigentes del actor y después el
resultado completo, bajo el bloqueo de autorización. Las comprobaciones incluyen
edición de roles ya asignados, no solo asignar roles nuevos.

- Solo el propietario puede actuar sobre su facultad de propiedad.
- Un delegado necesita `role.manage`/`role.assign` según la operación. Los permisos
  del rol antes y después deben estar dentro de sus capacidades delegables
  actuales; no puede editar un rol superior para degradarlo y tomar su control.
- Ninguna operación iniciada por un delegado puede aumentar sus propios permisos
  efectivos, ni editando un rol que ya tiene, ni mediante reasignaciones.
- Al retirar miembros o roles de terceros, no puede controlar un miembro cuyo
  conjunto de facultades exceda el suyo. El propietario queda siempre protegido.
- Gestionar accesos exige acceso `write` previo al proyecto y
  `project.access.manage`. Un administrador sin acceso no puede concedérselo a sí
  mismo. Tampoco puede elevar su propio acceso de `read` a `write`.
- Solo se concede acceso a miembros activos del mismo equipo y, como máximo, el
  nivel que el actor puede delegar. El acceso no altera roles ni permite
  reasignar un proyecto a otro equipo.
- El creador de un proyecto recibe su acceso inicial mediante el contrato de
  creación, no mediante una excepción general para concederse accesos.

Estas reglas aceptan que varios usuarios con capacidades expresamente
delegables puedan concedérselas entre sí: es la delegación autorizada. Si se
necesita aprobación del propietario para toda concesión administrativa, será una
política adicional; no se presume en esta primera versión.

## Frontera de base de datos

Lecturas mediante tablas/vistas seguras y RLS; escrituras de dominio únicamente
por operaciones públicas controladas y versionadas. Revocar DML directo y acceso
a secuencias de `anon`, `authenticated` y `PUBLIC`, incluyendo los grants por
columna existentes. Revocar también `EXECUTE` por defecto de funciones nuevas.

El corte de compatibilidad renombrará en sitio las tablas expuestas a
`tr8_workspace_projects`/`tr8_workspace_tasks` y las operaciones nuevas usarán
`tr8_v2_`, según el [plan de migración](migration-and-acceptance.md). No se
conservan las rutas antiguas como alias que pueda consultar un bundle obsoleto.

Como los invocadores actuales necesitan esos grants, el cambio exige una
frontera estrecha explícita: wrapper público invocador y rutina privada con
privilegios mínimos que vuelve a autorizar al actor, bloquea, valida y escribe.
No será una función genérica que reciba SQL, nombres de tablas o un actor elegido
por el cliente. Una función privilegiada no queda protegida automáticamente por
RLS: sus comprobaciones son parte de la frontera y deben probarse directamente.

Los helpers de autorización serán privados, de finalidad única, con nombres
totalmente calificados, `search_path` vacío y grants de ejecución explícitos.
Resolverán membresías sin recorrer una política de la misma tabla que los llama,
para evitar RLS recursiva. Solo devolverán decisiones para el actor de la sesión;
no permitirán consultar permisos de cualquier usuario arbitrario.

No se expone el esquema privado en la Data API. Las vistas expuestas serán
invocadoras o inaccesibles al cliente. No habrá claves privilegiadas en Vite ni
funciones administrativas genéricas accesibles desde la app.

Las RPC nuevas reciben el espacio explícito, IDs estables, versión esperada e
identidad de petición cuando corresponda. Un ID fuera del ámbito no revela si
existe: error genérico de recurso no disponible. Los reintentos solo devuelven
resultados previos si el actor conserva acceso; la idempotencia no es un permiso.

## Concurrencia y revocación

Propuesta inicial deliberadamente simple: todas las escrituras de un espacio
adquieren primero la fila de `workspace_authz_state`. Las escrituras ordinarias
la comparten; cambios de miembros, roles, accesos y propiedad la bloquean de forma
exclusiva. Se vuelve a leer autorización después de adquirir el bloqueo.

Orden estable: estado del espacio; invitaciones/roles afectados por ID;
membresías afectadas por ID; proyectos por ID; tareas por ID; auditoría y
trabajos pendientes. No se llama a Google ni se envían correos mientras se
mantienen bloqueos. El trabajador confirma autoridad
vigente al procesar, además de cuando se creó el trabajo.

Así, una escritura ya autorizada puede terminar antes de que se confirme una
revocación; después de confirmarse, las siguientes escrituras deben denegarse.
Las comprobaciones sensibles usarán sentencias posteriores al bloqueo y un
aislamiento definido y probado: no se asumirá que un snapshot anterior se
actualiza mágicamente. Los conflictos/deadlocks abortan sin aplicar cambios
parciales y se reintentan de forma limitada solo cuando sea seguro.

Las lecturas se evalúan con RLS y autorización vigente al iniciarse la consulta.
No es posible retirar datos ya descargados o un resultado que estaba en vuelo.
La aplicación cancelará peticiones, vaciará datos y volverá a comprobar acceso al
cambiar de usuario/espacio, recuperar foco o recibir una denegación. La caché se
identifica por usuario, espacio y proyecto; nunca por un UUID de proyecto solo.
No se persistirá contenido de equipo como caché sin conexión en esta versión.

## Referencias de diseño

- [Supabase: RLS y grants](https://supabase.com/docs/guides/database/postgres/row-level-security).
- [PostgreSQL 17: políticas por fila](https://www.postgresql.org/docs/17/ddl-rowsecurity.html).
- [PostgreSQL 17: bloqueos explícitos](https://www.postgresql.org/docs/17/explicit-locking.html).

Estas referencias no sustituyen comprobar las capacidades/versiones del proyecto
durante la etapa de implementación. No se ha modificado ni auditado el servicio
en esta etapa documental.

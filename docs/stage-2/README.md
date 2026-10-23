# Etapa 2 · Colaboración, roles y permisos

Estado: implementación y verificación en curso. El despliegue se realizará después de las pruebas aisladas y la comprobación de preservación. Continúan Supabase Free y Vercel Hobby; las altas externas permanecen desactivadas.

## Alcance

- Roles personalizados por equipo: crear, editar, eliminar y asignar varios a un miembro. Sus permisos se suman; no existen denegaciones negativas ni una jerarquía visual con autoridad.
- Administración de miembros existentes y acceso explícito `read`/`write` a cada proyecto privado.
- Un responsable opcional por tarea, separado de su autor y del permiso para editar contenido.
- Actividad administrativa y del proyecto, filtrada en el servidor antes de paginar.
- Interfaz de roles, miembros, acceso, responsabilidad y actividad con el diseño existente.

Las invitaciones y el registro abierto siguen cerrados en la interfaz y en el servidor. No se crean colaboradores reales, no se contrata SMTP y no se activa Google, calendario, correo de proyectos ni Pulso. Los miembros sintéticos usados en pruebas existen únicamente en `tr8-test`.

## Reglas de autorización

El propietario protegido conserva la administración de su equipo y el acceso a todos sus proyectos. Los demás necesitan membresía activa, permisos actuales y ACL del proyecto. Un administrador sin ACL no puede abrir el proyecto ni darse acceso; un acceso `read` no permite escribir aunque el rol tenga permisos de edición.

Un delegado solo crea o modifica roles dentro de sus permisos actuales, considerando el conjunto anterior y posterior. No puede aumentar sus propias facultades ni controlar un miembro superior. La protección incluye editar o eliminar un rol ya asignado. El propietario no se puede retirar ni convertir en miembro ordinario mediante estos formularios.

`project.read` es requisito de las operaciones de contenido, y `task.read` de las operaciones de tareas. La interfaz muestra estas dependencias; no añade permisos de forma implícita. La administración de roles sigue disponible para quien tenga sus permisos aunque no tenga `project.read`. El directorio de miembros no sustituye `role.read` para leer detalles de roles y permisos.

`task.assign` permite cambiar el responsable con acceso `write`; no permite cambiar título, estado ni otros campos sin `task.edit`. La asignación usa una RPC independiente con versión esperada. El responsable debe pertenecer al mismo espacio, estar activo y poder leer el proyecto y sus tareas. En el espacio personal solo puede ser el propietario.

Quitar ACL, roles o membresía reevalúa la elegibilidad efectiva. Si se pierde, la misma transacción retira la responsabilidad y actualiza versión, tiempo y actividad de las tareas afectadas, también en proyectos archivados. Una pérdida de `write` que conserva lectura no desasigna. No se eliminan proyectos ni tareas al retirar un miembro.

## Contrato técnico

La migración nueva añade `assignee_member_id` nullable con FK compuesta de espacio/membresía, tiempos de servidor en roles/ACL y una identidad privada del destinatario afectado en actividad. Los campos históricos de proyectos y tareas, sus OIDs, versiones y secuencia se comprueban y conservan. No se reescriben migraciones aplicadas.

Las RPC de etapa 1 conservan sus firmas y funcionan con responsables nulos. Todas las operaciones nuevas mantienen wrappers públicos invocadores y ejecutores privados que obtienen `auth.uid()`, validan la cuenta viva, bloquean el espacio y vuelven a leer permisos. No hay escritura directa ni claves privilegiadas en React.

| Operaciones `tr8_v2_*`                                               | Controles principales                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `list_roles`, `create_role`, `update_role`, `delete_role`            | Catálogo cerrado de 18 permisos, límite de delegación y versión; UUID estable al crear                 |
| `list_members_page`, `set_member_roles`, `remove_member`             | Directorio mínimo, protección del propietario, versión y limpieza atómica de asignaciones              |
| `list_project_access`, `set_project_access`, `remove_project_access` | Gestor con acceso `write` previo, miembro del mismo equipo y versión de ACL; cero solo al crear        |
| `get_project_capabilities`, `list_project_capabilities`              | Capacidades efectivas según rol, ACL y archivo, sin listar proyectos invisibles                        |
| `list_assignable_members`, `assign_task`                             | Participantes elegibles mínimos para lectores de tareas; asignar exige permiso independiente y versión |
| `list_activity`                                                      | `audit.read`, acceso vigente al proyecto, filtros anteriores a paginación y sin total privado          |

Roles, miembros, ACL, capacidades y responsables se paginan con límite predeterminado 100 y máximo 250. Los cursores codifican lista, espacio, proyecto y último UUID; se validan, pero nunca conceden autoridad. La actividad usa un cursor descendente de ID, predeterminado 50 y máximo 250. No se garantiza un snapshot común entre páginas.

Las capacidades se consultan por páginas, evitando una solicitud por proyecto en cada refresco. La caché se separa por usuario/espacio y los datos del proyecto tienen ámbito explícito. Una revocación cancela consultas, retira resultados y cierra editores que ya no pueden usarse. Los conflictos conservan el borrador únicamente mientras se mantiene el acceso necesario.

La actividad pública devuelve identificadores, acción, nombre visible y tiempo, sin títulos, correos, tokens, digests ni el destinatario privado de limpieza. Este último permite preparar futuros procesos de calendario sin activar un trabajador ni contactar Google en esta etapa.

## Verificación y recuperación

- Copia de contenido, metadatos privados e identidades mínimas fuera del repositorio; nunca contraseñas ni sesiones reales de Auth.
- `scripts/stage2/build-restore-rehearsal.mjs <backup.json> <private-output.sql> <migration.sql>...` restaura el respaldo en una transacción del entorno sintético designado, compara cada campo histórico y ejecuta la migración antes de `ROLLBACK`. Rechaza límites de transacción en las migraciones y una base que ya contenga las identidades respaldadas. La secuencia exportada se ensaya en una secuencia temporal, sin rebobinar la secuencia del entorno de prueba.
- `supabase/tests/collaboration_stage2.sql` prueba permisos mediante roles reales de Postgres y fixtures con rollback. La suite anterior `workspace_stage1.sql` reconoce la presencia autorizada de etapa 2 y mantiene sus comprobaciones de regresión.
- `scripts/stage2/http-smoke.mjs` usa Auth real y clave pública del proyecto aislado; rechaza producción y claves privilegiadas. Comprueba escrituras simultáneas y revocación con sesiones todavía vigentes.
- TypeScript, pruebas de interfaz/datos, ESLint, formato, comprobación estática y build antes de publicar; navegador con cuentas ficticias en prueba y lectura de los datos existentes en producción.

Una migración fallida se revierte como transacción. Después de publicarla, solo se vuelve a clientes compatibles con API v2; no se restauran políticas antiguas. La recuperación de contenido requiere detener escrituras y reconciliar los cambios posteriores al respaldo. La copia de esta entrega no sustituye una copia completa de Auth ni PITR.

## Registro de verificación · 23 de octubre de 2026

- Base de código: `e81ae1d9ac5866ed4f052725d6cbb8967864f8a8`. Copia privada nueva del contenido y metadatos, con restauración y comparación campo por campo ensayadas en una transacción aislada.
- Migración de etapa 2 instalada únicamente en prueba en este punto. Preservación ensayada con un proyecto y una tarea respaldados, sin cambios históricos, sin cuentas reales residuales y con rollback completo del ensayo.
- SQL: 113 aserciones nuevas y las 176 de regresión de etapa 1 aprobadas. HTTP: 252 aserciones en 165 solicitudes usando usuarios ficticios y claves públicas.
- Carrera de versión: una escritura confirmada y un conflicto `PT409`. Seis carreras de revocación/edición comprobaron ambos órdenes válidos; toda solicitud posterior al commit de la revocación se rechazó con el JWT anterior.
- Revisión independiente: corregidas la exposición de detalles de roles sin `role.read`, la permanencia de editores al perder permisos y la actividad retenida por un observer al perder ACL. Los ámbitos de caché incluyen permisos y capacidades del proyecto; 30 pruebas focales independientes aprobadas.
- Advisors: sin advertencias nuevas de esquema o permisos. Se conservan avisos informativos de tablas privadas sin políticas, FKs e índices; la advertencia de protección de contraseñas filtradas es previa y exige Pro. No se cambió de plan para activarla.

## Límites conservados

- Sin transferencia de propiedad, eliminación de equipos ni reincorporación automática de miembros retirados.
- Un rol referenciado por una invitación histórica no se elimina: devuelve conflicto para conservar esa relación. La invitación continúa desactivada.
- No se activan proveedores ni recursos de pago. Se reutilizan los dos proyectos Free existentes.
- El envío de notificaciones, la sincronización externa y los trabajos en segundo plano se implementan en sus etapas posteriores.

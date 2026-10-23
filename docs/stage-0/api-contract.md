# Superficie de operaciones y contrato de errores

Estado: contrato propuesto de etapa 0; nombres y entradas para construir y probar en etapas posteriores. No existen aún estas RPC ni rutas. Complementa [datos y acceso](data-and-access.md), [calendario](calendar-and-notifications.md) y [Pulso](pulso-adaptation.md).

## Convenciones

- Las operaciones nuevas usan `tr8_v2_`. Las tablas de proyectos/tareas se renombran según [la migración](migration-and-acceptance.md), sin conservar endpoints antiguos como alias.
- Actor y sesión proceden de credenciales verificadas; ninguna operación acepta un `actor_id` o propietario arbitrario como autoridad. El `workspace_id` de entrada se valida contra el recurso y la membresía, no concede acceso.
- Toda creación usa UUID estable de petición/recurso. Mismo ID y contenido compatible devuelve el registro existente solo mientras el actor conserve acceso; contenido diferente entra en conflicto.
- Mutaciones reciben versiones esperadas de los recursos modificados. Los tiempos, revisiones, códigos y números de tarea son del servidor.
- Los patches son objetos cerrados con campos permitidos. No admiten ámbito, creador, propiedad ni campos internos. Actualizaciones de acceso y roles no pasan por un patch genérico de perfil o proyecto.
- Listas usan cursor opaco y orden estable: ID de desempate incluido, filtros y límites validados en servidor. Límite general propuesto de 100 y máximo 250 por página. No garantizar snapshot común entre páginas.
- La UI solo confirma guardado cuando recibe el registro o resultado durable. No reintentar automáticamente una versión obsoleta con los datos nuevos del servidor.

## Operaciones públicas de aplicación

Los nombres de fila dentro de una celda comparten prefijo `tr8_v2_`. Las entradas de tabla son mínimas, no firmas SQL ni autorización para ejecutar DDL.

| Grupo / operaciones                                            | Entradas mínimas                                                                   | Resultado y controles                                                                                                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_context`                                                  | Sin actor de cliente                                                               | Perfil propio, habilitación, espacios accesibles y versión del contrato; nunca tokens ni datos financieros                                                                          |
| `list_workspaces`, `create_team`                               | Cursor/límite; ID estable y nombre al crear                                        | Solo cuenta habilitada; crear equipo provisiona propietario, estado de autorización y las tres plantillas en una transacción                                                        |
| `list_members`                                                 | Espacio, cursor/límite                                                             | `member.read`, directorio mínimo sin emails privados; no enumera contenido de proyectos                                                                                             |
| `create_invitation`, `revoke_invitation`                       | Espacio, ID estable, destinatario, roles propuestos; versión para revocar          | `member.invite`, límites de delegación y acceso a proyecto si se incluye; devolución del token/enlace solo al emisor autorizado, sin logs                                           |
| `accept_invitation`                                            | Token y ID estable de aceptación                                                   | Cuenta confirmada, destinatario vigente, emisor autorizado; consumo, habilitación, membresía y espacio personal atómicos e idempotentes                                             |
| `remove_member`, `set_member_roles`                            | Espacio, membresía, versión y conjunto de roles                                    | `member.remove` o `role.assign`; protección de propiedad, desasignaciones por pérdida de acceso efectivo, versiones y efectos externos en la misma operación de dominio             |
| `list_roles`, `create_role`, `update_role`, `delete_role`      | Espacio, ID estable al crear, versión, nombre y conjunto cerrado de permisos       | `role.read`/`role.manage`; edición sobre un rol asignado también comprueba el resultado efectivo y la delegación                                                                    |
| `list_projects`, `get_project`                                 | Espacio, proyecto opcional, filtros, cursor/límite                                 | Autorización vigente de cada fila; no existe listado global sin ámbito como estrategia del cliente                                                                                  |
| `create_project`, `update_project`                             | Espacio, ID estable o versión, campos actuales permitidos                          | Creación concede ACL `write` al creador sin permisos extra de rol; actualización/archivo requieren permisos específicos                                                             |
| `set_project_access`, `remove_project_access`                  | Espacio, proyecto, miembro, versión y nivel                                        | `project.access.manage` y acceso `write` previo; sin autoconcesión ni invitado externo                                                                                              |
| `list_tasks`                                                   | Espacio, proyecto o conjunto validado, búsqueda, filtros y cursor                  | Datos autorizados paginados; totales y búsqueda aplican las mismas reglas                                                                                                           |
| `create_task`, `update_task`, `delete_task`                    | Espacio/proyecto, ID estable o versión, contenido y responsable/horario opcionales | Permisos de cada campo: asignar requiere `task.assign`; editar contenido/estado/horario requiere `task.edit`; asignar al crear requiere además su facultad si se indica responsable |
| `calendar_items`                                               | Ámbitos autorizados, rango civil, zona IANA, filtros y cursor                      | Máximo 93 días y 250 elementos según calendario; no importa eventos de Google ni movimientos financieros                                                                            |
| `get_notification_preferences`, `set_notification_preferences` | Proyecto propio accesible, tipos, frecuencia y versión                             | Solo preferencias del actor; ninguna facultad de equipo habilita correos de otro usuario                                                                                            |
| `get_integration_status`                                       | Proveedor                                                                          | Solo estado propio y errores sanitizados; nunca access/refresh tokens                                                                                                               |

En espacios personales, el propietario conserva las operaciones equivalentes a la aplicación actual. Las facultades protegidas de propiedad no se implementan mediante `update_project`/`set_member_roles`. Si se agrega transferencia de equipo, tendrá solicitud/aceptación separadas, reautenticación y pruebas de concurrencia; eliminar equipos no forma parte de la primera entrega.

La creación de cuentas de Auth y la invitación de aplicación no son una transacción distribuida. Un proceso de servidor con estado de provisión controlado puede usar las capacidades administrativas de Auth después de comprobar al emisor. Debe recuperarse de cuenta Auth creada pero mensaje fallido sin conceder acceso: solo la aceptación válida habilita la app. No se insertan contraseñas con SQL ni se habilita registro público como atajo.

## Funciones HTTP y operaciones privadas

| Operación lógica            | Actor admitido                               | Frontera                                                                                                   |
| --------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Iniciar conexión Google     | Usuario vivo de TR8                          | Prepara state/PKCE y URL fija; no acepta un dueño alternativo                                              |
| Callback Google             | Flujo pendiente válido                       | Canje en servidor, consumo único y vínculo a la sesión que lo inició; no basta el email Google             |
| Desconectar Google          | Titular                                      | Opción conservar/eliminar, versión/generación, estado de limpieza y retirada de credenciales               |
| Despachar trabajos          | Trabajador con credencial privada específica | Reclama lote y lease; publicar la URL o poseer la clave publishable no autoriza el despacho                |
| Provisionar invitación Auth | Emisor autorizado, operado por servidor      | Rol administrativo nunca llega al navegador; estado recuperable y envío sujeto a SMTP                      |
| Operaciones de bóveda       | Titular y sesión viva                        | Servidor opaco validado; adaptación y reautenticación bajo la puerta de Pulso, sin RPC pública alternativa |

Los detalles de rutas HTTP, origen exacto del callback y librería OAuth se fijarán con las pruebas de despliegue del conector. No son una elección de nuevos servicios o planes. La ruta financiera exige el ADR específico antes de implementarse.

## Respuestas y errores

Respuesta normal: datos autorizados, versión vigente y, para mutaciones, identificador de petición. El éxito de dominio no afirma que ya se envió el correo o se actualizó Google; ese resultado es otro estado.

| Código lógico             | Respuesta prevista             | Tratamiento                                                                            |
| ------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| `AUTH_REQUIRED`           | HTTP 401                       | Volver a autenticar; limpiar estado sensible                                           |
| `APP_ACCESS_DENIED`       | HTTP 403                       | Cuenta no habilitada; sin enumerar recursos ajenos                                     |
| `RESOURCE_UNAVAILABLE`    | HTTP 404                       | Igual para UUID inexistente o recurso no accesible                                     |
| `INVALID_INPUT`           | HTTP 400                       | Campo/regla comprensible; sin diagnósticos internos                                    |
| `STALE_VERSION`           | HTTP 409                       | Conservar borrador; versión actual solo si conserva acceso                             |
| `REQUEST_CONFLICT`        | HTTP 409                       | Identidad de petición reutilizada con otro contenido                                   |
| `PROJECT_ARCHIVED`        | HTTP 409                       | Lectura conservada; operaciones según contrato de archivo                              |
| `CLIENT_UPGRADE_REQUIRED` | Error tipado del cliente nuevo | Recargar; el bundle antiguo puede recibir recurso retirado y no interpreta este código |
| `RATE_LIMITED`            | HTTP 429                       | Espera indicada; no reintento sin límite                                               |
| `DEPENDENCY_UNAVAILABLE`  | HTTP 503                       | Fallo temporal; no afirmar guardado si no hubo commit                                  |

La traducción de SQLSTATE/PostgREST a estos códigos se probará al implementar; no se cambia silenciosamente el significado de los errores actuales. Detalles, stacks, tokens, claves, SQL y contenido financiero no forman parte de las respuestas de error.

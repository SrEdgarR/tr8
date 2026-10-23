# Migración y aceptación por etapas

Estado: plan de etapa 0, 23 de octubre de 2026. No se ha ejecutado este plan ni se
afirman resultados de las pruebas futuras descritas aquí. El alcance de esta
entrega es documentación; el código actual continúa siendo la aplicación personal.

Contrato complementario: [datos y acceso](data-and-access.md).

## Condiciones para comenzar la migración

- Inventariar el esquema realmente desplegado, funciones, cuerpos, propietarios,
  grants por tabla/columna/secuencia, RLS, triggers y ajustes Auth/Data API.
  Las migraciones locales describen la base, no certifican por sí solas su estado
  remoto futuro.
- Capturar un respaldo exportable y verificar su restauración en un entorno
  aislado compatible con el presupuesto gratuito. No usar los datos reales para
  fixtures de pruebas ni contratar una rama de pago automáticamente.
- Registrar conteos y fingerprints de filas actuales, IDs, códigos, números de
  tarea, versiones, tiempos, posiciones y relaciones. Registrar el estado y
  configuración de la secuencia de tareas. No reiniciarla ni usar `MAX + 1`.
- Conservar las migraciones aplicadas intactas. Crear migraciones aditivas futuras
  mediante el flujo verificado de la CLI; esta etapa no crea archivos SQL.
- Definir un protocolo de compatibilidad de cliente y un interruptor que mantenga
  equipos deshabilitados hasta terminar pruebas y corte de permisos.

## Transición expandir, rellenar y cambiar acceso

### A. Expandir sin habilitar colaboración

Añadir espacios, habilitación de aplicación, membresías, roles, accesos,
invitaciones y estado de autorización con RLS y grants de denegación iniciales.
Añadir `workspace_id` y procedencia a proyectos/tareas sin cambiar su contenido.
La allowlist personal vigente seguirá cerrando el acceso mientras no exista el
nuevo contrato validado. No convertirla en «cualquier cuenta confirmada».

Preparar APIs nuevas explícitas por espacio, sin habilitar su uso para otros
usuarios. Definir índices y restricciones compuestas antes de introducir datos
de equipos. El acceso del propietario histórico seguirá limitado a su espacio
personal durante esta fase.

### B. Rellenar datos y validar preservación

Crear exactamente un espacio personal para la cuenta actual y asociar a él
todos sus proyectos y tareas en una operación administrativa repetible. La
creación ordinaria del espacio personal de futuros usuarios será atómica y
tendrá una restricción de unicidad, no un «buscar y después insertar» sin control
de concurrencia.

La carga administrativa preservará UUID, códigos, números de tarea, versiones,
`created_at`, `updated_at`, fechas, posición, estado y archivo. No pasará por una
RPC de edición que incremente versiones o por un trigger que reescriba los
tiempos: cualquier mecanismo especial de backfill será exclusivo de la migración,
en transacción y sin desactivar defensas mientras acepta tráfico ordinario.

Validar ausencia de huérfanos y de filas sin espacio. Sustituir la FK
`(project_id, owner_id)` por `(workspace_id, project_id)` después de verificar
datos y restricciones nuevas. El responsable tendrá relaciones del mismo ámbito
y una validación transaccional de membresía/acceso activos.

El `owner_id` antiguo queda como procedencia durante la compatibilidad, sin
decidir RLS ni heredar autoridad. Sus antiguas cascadas desde Auth deben
reemplazarse o bloquearse de modo que eliminar al creador no borre proyectos
compartidos. La eliminación de cuentas con dependencias se deniega hasta disponer
de un flujo explícito de transferencia o anonimización.

El fingerprint de campos previos debe coincidir antes y después. Solo cambian
los nuevos campos documentados. La secuencia conserva su configuración y su
progreso monotónico; números consumidos por pruebas transaccionales pueden dejar
huecos, como ya sucede hoy.

### C. Cambiar RLS, grants y RPC en un corte coordinado

El corte instala la nueva autorización, revoca toda escritura directa —incluidos
grants por columna— y habilita las operaciones controladas en una transacción.
No habrá un intervalo con políticas antiguas y nuevas permisivas combinadas por
OR. Inventariar y sustituir todas las políticas afectadas, no añadir una política
colaborativa junto a la del antiguo propietario global.

El nuevo contrato exige contexto de espacio. El bundle actual ejecuta lecturas
sin ese filtro y RPC sin espacio. La elección técnica de este contrato es un
corte coordinado con pausa breve de escrituras y denegación de endpoints antiguos,
sin puente colaborativo ni apertura de las consultas históricas.

Para distinguir realmente ambos contratos, se propone renombrar en sitio las
tablas expuestas a `tr8_workspace_projects` y `tr8_workspace_tasks`, preservando
identidad de filas/objetos, y publicar RPC con prefijo `tr8_v2_`. El rename conserva
OIDs, UUID, índices, relaciones no sustituidas expresamente, versiones y la
secuencia existente; no reconstruye las tablas ni reasigna números. Las FKs que
cambian de semántica se sustituyen solo después de validar las nuevas. No se dejarán
alias públicos de las tablas o funciones anteriores. Se revisarán todos los
cuerpos de funciones/triggers y tipos dependientes: un rename no reescribe
automáticamente sus referencias textuales. Refrescar el caché de esquema de la
Data API será parte del corte. El cliente previo falla de forma cerrada; el nuevo
cliente comunica la necesidad de recargar y usa el nuevo contrato.

Todo ello se recoge en una migración nueva; nunca se reescriben las históricas.

Una cabecera de versión sirve para compatibilidad, nunca como permiso. No se
concederá acceso a equipos confiando en que un navegador «seguro» manda el filtro
correcto. Reabrir un bundle cacheado después del corte no debe mostrarle datos de
otros espacios ni permitir saltarse el control de versión. Cambiar solo los
nombres de RPC, dejando las lecturas históricas abiertas, no cumple este contrato.

Solo después de estas verificaciones se habilitará crear equipos e invitar
colaboradores. Se regenerarán los tipos del esquema y se actualizará el contrato
del repositorio para cargar por espacio/proyecto/rango, eliminando el
`readAll` global como estrategia de trabajo colaborativo.

### D. Cerrar compatibilidad

Retirar campos de compatibilidad u objetos internos obsoletos mediante otra
migración, después de confirmar que no los usa el nuevo despliegue. Los endpoints
antiguos ya se habrán retirado en el corte. Documentar la versión mínima y la
ventana de transición; un eventual puente solo podría añadirse mediante revisión
expresa y limitarse en base de datos al espacio personal, nunca a todos los
recursos del usuario.

Antes de habilitar equipos, se puede retroceder a la versión personal si se
conservan sus invariantes. Después de introducir datos colaborativos, no se
restaurarán políticas antiguas: el retroceso será a una versión compatible o a
modo de mantenimiento. Una restauración de respaldo real exige evaluar las
escrituras posteriores; no es un mecanismo automático de deshacer.

## Invitaciones y habilitación de cuentas

El registro abierto sigue sin estar autorizado. Una cuenta confirmada creada
directamente en Auth no obtiene datos ni espacio operativo por ese solo hecho.
La habilitación se basa en la cuenta inicial o en una invitación aceptada válida.
El mecanismo para provisionar cuentas invitadas se implementará en servidor con
los límites vigentes del servicio, sin insertar contraseñas mediante SQL ni
entregar claves administrativas al navegador.

Contrato de invitación:

- Token aleatorio fuerte, digest almacenado, vencimiento propuesto de siete días,
  uso único y revocación explícita. Su valor completo no aparece en logs,
  analítica, actividad ni respuestas a otros usuarios.
- La cuenta autenticada debe tener email confirmado que coincida con el
  destinatario normalizado desde el registro actual de Auth, no desde un campo
  editable del perfil o del JWT. Un enlace reenviado no es suficiente.
- Al aceptar se bloquean invitación y ámbito de autorización; se vuelve a
  comprobar vigencia, emisor con capacidad actual de invitar y roles aún
  delegables. Si el emisor perdió facultades, un administrador autorizado debe
  reemitir o aprobar la invitación.
- Se consumen token, habilitación, membresía, asignaciones permitidas y bootstrap
  personal en una transacción. Repetir la misma aceptación no duplica nada;
  competir por el token desde otra cuenta falla.
- Entrar en el equipo no concede acceso a sus proyectos. Una invitación a proyecto
  deberá identificarlo expresamente y validar también `project.access.manage`
  vigente del emisor, nivel delegable y acceso del receptor al aceptar.
- Las invitaciones son mensajes de acceso separados de los avisos opcionales de
  proyecto. Necesitan remitente/canal aprobado; no se enviarán correos reales
  hasta resolver esa dependencia.

La lectura inicial del digest solo identifica el espacio; después se bloquean
primero su estado de autorización y luego la invitación, respetando el orden
global. La aceptación no usa el orden inverso aunque el enlace empiece por un
token.

El correo Auth predeterminado no resuelve altas externas: sus restricciones de
destinatarios y frecuencia deben verificarse y configurar un remitente adecuado
antes de probar invitaciones reales. La disponibilidad de SMTP personalizado no
se ha verificado en esta etapa. Mientras se resuelve, las pruebas se mantienen
con identidades ficticias en el entorno aislado, sin enviar mensajes a personas.

## Matriz de pruebas futuras

Las pruebas se ejecutarán con usuarios ficticios independientes, varios equipos
y proyectos privados. Comprobar tanto la Data API como las RPC directas: la
interfaz no es una frontera de seguridad. No incluir contraseñas, tokens ni datos
financieros reales en salidas de pruebas.

| Grupo                        | Casos y resultado exigido                                                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aislamiento                  | Anónimo, cuenta sin confirmar y cuenta confirmada no habilitada: denegación. Un usuario no enumera espacios, proyectos, tareas ni actividad ajenos cambiando UUID o filtro.                                                                                                        |
| Propiedad                    | Propietario lee todos sus proyectos de equipo; no lee otro equipo, espacio personal ni bóveda. Administrador sin acceso explícito no lee un proyecto privado.                                                                                                                      |
| Roles/acceso                 | Varios roles suman permisos, pero falta de acceso, nivel `read` o permiso insuficiente bloquea escritura. Creador/responsable no eluden reglas.                                                                                                                                    |
| Integridad                   | Rechazar roles, miembros, responsables y proyectos de otro equipo; impedir cambiar ámbito, campos gestionados y propiedad mediante patch.                                                                                                                                          |
| Delegación                   | Rechazar rol con permiso superior, edición de rol propio que eleva poder, autoasignación que eleva poder, degradar rol superior para administrarlo y autoconcederse acceso privado. Probar también operaciones combinadas.                                                         |
| Invitaciones                 | Token caducado, revocado, reutilizado, email distinto/no confirmado y emisor degradado: denegación. Dos aceptaciones simultáneas crean una sola membresía y un solo espacio personal.                                                                                              |
| Escritura                    | DML directo, secuencia y funciones privadas no autorizadas fallan. Solo una de dos ediciones simultáneas con misma versión termina; ningún overwrite silencioso.                                                                                                                   |
| Reintentos                   | Crear con mismo ID/payload no duplica; payload diferente entra en conflicto. Resultado idempotente no se devuelve tras perder acceso.                                                                                                                                              |
| Revocación                   | Retirar acceso/membresía/rol frente a edición, asignación, archivo y creación concurrentes respeta el orden de bloqueo y la frontera de commit documentada.                                                                                                                        |
| Elegibilidad del responsable | Retirar/editar un rol o sus permisos que elimine `project.read`/`task.read` desasigna atómicamente, aumenta versión/tiempo y genera limpieza de la copia Google; no envía contenido ni revela proyectos privados al delegado. Si conserva los permisos por otro rol, no desasigna. |
| Caché                        | Cambiar usuario/equipo, perder acceso y recibir respuestas tardías cancela/vacía datos; una petición anterior no rellena de nuevo la caché del usuario siguiente.                                                                                                                  |
| Lecturas derivadas           | Búsqueda, contadores, filtros, calendario, exportación futura y auditoría no filtran nombres o cantidades de proyectos inaccesibles.                                                                                                                                               |
| Archivo                      | Crear/editar en proyecto archivado falla; restaurar exige permiso. Probar carrera entre archivo y escritura de tarea.                                                                                                                                                              |
| Migración                    | Coinciden fingerprints de todos los campos previos, IDs y relaciones; secuencia no retrocede; constraints nuevas válidas y sin huérfanos.                                                                                                                                          |
| Clientes antiguos            | Bundle y sesión previos al corte quedan cerrados o limitados al espacio personal; no recuperan acceso por endpoints o grants obsoletos.                                                                                                                                            |
| Degradación                  | Caída de trabajador no pierde escritura/evento; retirar un miembro impide avisos pendientes y sincronización de contenido nuevo. La retirada remota tiene límites si Google ya revocó la conexión.                                                                                 |

Las pruebas de concurrencia necesitan sesiones/conexiones reales y barreras para
forzar el solapamiento. Ejecutar dos instrucciones consecutivas en una sola
transacción no demuestra corrección ante carreras. Incluir pausa después del
bloqueo, orden inverso y reintentos limitados por deadlock/serialización.

La actividad administrativa del equipo no mostrará títulos ni diferencias de
contenido de proyectos privados a administradores sin acceso. Su evento puede
indicar que se cambió una membresía/rol; consultar la actividad del proyecto
exige el mismo permiso que consultar su contenido. Tokens, emails completos,
textos de tareas y contenido de bóveda quedan fuera del payload por defecto.

## Criterios de salida

Para comenzar etapa 1: contratos de etapa 0 coherentes, entorno de verificación
aislado identificado y ninguna dependencia que obligue a contratar servicios.
La elección técnica es corte coordinado con clientes antiguos denegados; se debe
ensayar antes de aplicarlo al servicio real.

Para publicar colaboración: migración ensayada y recuperable, matriz anterior
ejecutada, inspección de grants/RLS/funciones sin vías alternativas, controles
de tipos/lint/formato/compilación y verificación del flujo completo con varios
usuarios. Los resultados, limitaciones y cambios de datos se documentarán al
realizarlos, sin reutilizar como evidencia las pruebas de la versión personal.

No se habilitan en esta etapa registro abierto, invitados externos, permisos
financieros de equipo, archivos adjuntos, eliminación de equipos ni transferencia
de propiedad mediante formularios genéricos.

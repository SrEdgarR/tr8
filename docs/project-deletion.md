# Eliminación de proyectos

TR8 permite eliminar un proyecto desde su página o sus tarjetas. El diálogo
muestra el alcance, exige escribir su nombre exacto, distingue mayúsculas y
espacios y comienza con foco en Cancelar. El botón destructivo permanece
deshabilitado hasta coincidir; durante el envío se bloquean dobles envíos y
cierre. Un error conserva el diálogo para revisión. No se elimina nada al abrirlo.

El permiso **`project.delete`** es distinto de `project.archive`. El propietario
del espacio recibe la capacidad; los roles existentes no reciben nuevos permisos
automáticamente. Para delegar eliminación se requiere concederla expresamente y
mantener acceso de escritura al proyecto. Los equipos nuevos conservan su
plantilla de Administración con el catálogo completo vigente. Un rol con solo
archivado o acceso de lectura no puede borrar.

`tr8_v2_delete_project` exige ID, versión esperada y nombre exacto también en el
servidor. Usa el orden de bloqueo espacio → proyecto → tareas. Una transacción
retira solo las tareas, accesos e historial de ese proyecto y después el
proyecto. Conserva una constancia mínima de eliminación en el espacio, sin
convertir la actividad privada anterior en actividad visible para todo el equipo.
Las tablas siguen sin DML de navegador y el wrapper público conserva su modo
invoker. Un cambio de versión o nombre exige volver a revisar el proyecto.

Se conservan los triggers de tareas y el outbox: la limpieza de copias vinculadas
de Google mantiene sus colas, identidades y comprobaciones. No es instantánea ni
garantizada con una conexión pausada/revocada, errores o conflictos pendientes.
Las demás tareas y correspondencias quedan fuera de la operación.

Si se elimina el destino de importación de Google Tasks, una tarea nueva válida
puede crear otro proyecto de destino en el espacio personal. La reparación se
hace al importar, bajo el bloqueo existente de la conexión, sin mover enlaces
anteriores ni recrear el proyecto al borrarlo. Un destino archivado se conserva;
no se lo sustituye para eludir el archivo.

## Verificación

- La suite SQL `supabase/tests/project_deletion.sql` pasó **50 comprobaciones**
  en TEST: permisos, confirmación, versión, reversión ante fallo final, preservación
  de otros registros, colas de Google y continuación de nuevas importaciones.
- `scripts/project-deletion/concurrency.mjs` pasó **cuatro carreras** con dos
  conexiones PostgreSQL reales y bloqueo observado mediante `pg_blocking_pids`:
  eliminar antes/después de crear o editar una tarea. No quedaron huérfanos.
- Las pruebas de interfaz y repositorio cubren cancelación, errores, coincidencia
  exacta, dobles envíos, navegación posterior y descarte de consultas tardías.

Los ensayos eliminaron únicamente fixtures de TEST. No se ejecutó un borrado de
los proyectos del propietario en producción. La copia privada y comparación de
hashes forman parte de la publicación; no se incluyen datos personales en Git.

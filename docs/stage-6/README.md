# Etapa 6 · Google Tasks

Estado: **implementación y backend publicados; autorización de Tasks e importación real comprobadas en la aplicación**. Se observó la tarea «Tarea de prueba para ver si se carga en TR8» en el proyecto personal Google Tasks. Las pruebas reales de edición, finalización y eliminación de esas tareas siguen pendientes; las pruebas de eventos de Calendar pertenecen a la etapa 5.

## Alcance

Configuración reúne Calendar y Tasks en una sola tarjeta **Google**, con un flujo
de autorización conjunto y acciones comunes para sincronizar, actualizar el estado
y desconectar. Dentro se conservan las opciones de eventos y de listas de tareas.
La sincronización manual respeta la pausa de Tasks y vuelve a consultar su estado
antes de solicitar cambios. Las operaciones de ambas funciones comparten un bloqueo
en la interfaz para evitar editar las listas durante una reconexión o desconexión.
Esta reorganización no necesita migraciones ni modifica datos existentes.

La pantalla dispone de las categorías **General**, **Conexiones** y **Actividad**.
Zona horaria, Google y procesos empiezan colapsados. Cambiar de categoría o plegar
un apartado conserva su contenido montado y sus borradores. El estado de Google
permanece visible en la cabecera junto al icono de la plataforma; el diálogo de
autorización se mantiene fuera del contenido que se puede ocultar.

Una tarea creada en Google Tasks, incluida una creada como «Tarea» desde Google Calendar del teléfono, se importa al proyecto **Google Tasks** del espacio personal. El proyecto aparece con el primer elemento válido. Esta versión sincroniza las tareas de Google ya importadas; no crea tareas nuevas en Google a partir de tareas normales de TR8.

- El **título, la fecha y el estado de completado** se pueden modificar en ambas aplicaciones. Las eliminaciones de tareas vinculadas también se sincronizan, con comprobación de versión y tratamiento de conflictos.
- La fecha `due` de Google se guarda como **`start_date`**, el día planificado. Google Tasks API no expone la hora del teléfono: no se importa ni modifica esa hora. El vencimiento y el bloque horario propios de TR8 se conservan.
- Las notas de Google no se importan ni se exportan. La descripción local de TR8 permanece independiente. Las tareas asignadas desde Docs o Chat quedan fuera de esta entrega.
- La conexión es opcional. Google exige permiso sobre todas las tareas; TR8 trabaja solo con las listas activas. **La primera lista descubierta se selecciona automáticamente al conectar**; las demás requieren selección explícita. Se muestran hasta las 2000 listas admitidas por Google sin truncar las seleccionadas. Desactivar una lista conserva sus tareas y detiene sus próximos cambios.
- Las listas elegidas se revisan **cada 15 minutos** y mediante **Sincronizar tareas ahora**. Pedir una revisión no significa que Google ya haya confirmado todos los cambios. Los presupuestos y los reintentos pueden aplazar su procesamiento.
- Si ambas versiones cambiaron de forma incompatible, se conserva un **conflicto** y el usuario revisa cuál mantener. No se sobrescribe silenciosamente una versión con la otra; las escrituras remotas usan `If-Match`.

Las tareas vinculadas a Tasks no generan otro evento en el calendario TR8 de Google, incluso al pausar o desconectar la integración. La sincronización inversa de **eventos de Google Calendar aún no está activada**: la exportación de eventos de la etapa 5 mantiene la dirección TR8 → Google Calendar.

Pausar Tasks conserva las tareas y el permiso compartido. Reconectar Calendar conserva el permiso Tasks previamente autorizado. Desconectar Google detiene ambas integraciones; la elección de limpieza de Calendar afecta a sus eventos registrados, no elimina las tareas importadas.

## Verificación y conservación

En la base de prueba pasaron **168 comprobaciones SQL de esta etapa**, además de las regresiones SQL anteriores. Pasaron **299 pruebas de aplicación y 299 de Edge**, los controles de tipos, lint, formato y compilación. Son pruebas técnicas; no sustituyen una aceptación real de Google Tasks.

Producción registra **11 migraciones**. La migración `20261023213543_google_tasks_stage6.sql` tiene SHA-256:

```text
21b015bd527fa1ba96b1c65d7aef13781a7b0bb4fefb22a720e15b92512d72ed
```

La comparación antes y después conservó exactamente el **proyecto y la tarea existentes**, las **23 tablas privadas anteriores** y la secuencia de tareas; solo se excluyeron las nuevas columnas con valores predeterminados añadidas por la migración. No se importaron datos reales ni se activó Tasks durante la instalación. Las funciones de producción `tr8-google` y `tr8-google-worker` están **ACTIVE, versión 2**.

Para evitar la regresión transaccional de la CLI documentada en [Supabase CLI #6347](https://github.com/supabase/cli/issues/6347), se aplicaron el SQL y su registro en el historial mediante `db query` dentro de una misma transacción. Se conservó el historial canónico, sin `migration repair` y sin modificar las migraciones originales ya aplicadas.

Se mantienen **Supabase Free**, **Vercel Hobby**, las altas externas desactivadas y el correo opcional desactivado. El contrato detallado está en [tasks-contract.md](tasks-contract.md). Queda pendiente verificar con Google los cambios de título y fecha, la finalización y la eliminación de una tarea importada, sin modificar las demás.

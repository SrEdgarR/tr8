# Proyectos y tareas — etapa 4

Recupera las funciones de planificación y detalle de la
[demo original de Gr8r Studio](https://gr8r-taskmanagement.vercel.app/), con la
persistencia, identidad y permisos actuales de TR8.

## Proyectos

Crear y editar un proyecto permite definir inicio y fecha objetivo opcionales.
La fecha objetivo pertenece al proyecto: el próximo vencimiento de una tarea
sigue identificado por separado. En un proyecto existente se puede elegir un
responsable entre sus miembros elegibles, con permiso de asignación. Elegirlo no
concede acceso al proyecto. El directorio debe estar autorizado para mostrar su
nombre; al revocar acceso se retiran las asignaciones que dejan de ser válidas.

La creación ofrece proyecto vacío o tres plantillas incluidas: Sitio web,
Lanzamiento y Sprint. Cada plantilla crea cinco tareas pendientes en la misma
transacción, sin fechas ni responsables de tarea. No copia tareas de otro usuario
ni usa el almacén local del prototipo.

En **Proyectos**, el icono de copiar de cada tarjeta abre Duplicar proyecto.
Se puede copiar solo su configuración o incluir hasta 50 tareas activas. La copia
es privada, con IDs nuevos y estado de planificación. Conserva descripciones,
etiquetas y estimaciones; las subtareas empiezan pendientes. No copia ACL,
responsables, fechas, actividad ni vínculos con proveedores. La identidad estable
de petición evita crear otra copia ante un reintento exacto.

## Detalle de tareas

Abrir una tarea muestra un panel lateral con estado, prioridad, responsable,
fechas y descripción. Editar tarea conserva el formulario existente para los
campos principales, asignación y bloque de calendario.

El detalle permite añadir hasta diez etiquetas de 40 caracteres, una estimación
entera de 0 a 100.000 minutos y hasta cien subtareas de checklist con título de
240 caracteres. Las etiquetas tienen colores estables. El avance de subtareas no
completa automáticamente la tarea principal. **Guardar detalle** confirma esos
campos juntos con la versión leída. Si hay conflicto, el borrador permanece para
revisarlo o descartarlo explícitamente.

Lista, Tabla y Tablero muestran etiquetas, estimación y progreso de subtareas.
La búsqueda también encuentra etiquetas y títulos de subtareas. Las vistas y
favoritos existentes se conservan.

- **Duplicar:** crea una tarea nueva en un proyecto autorizado del mismo espacio.
  Conserva descripción, prioridad, etiquetas y estimación; empieza pendiente,
  sin fechas ni responsable y con IDs de subtareas nuevos. La fuente solo necesita
  ser legible; el destino requiere crear tareas.
- **Mover:** conserva ID, número, creación, contenido y vínculos con Google. Exige
  editar en origen y crear en destino. Conserva el responsable si sigue siendo
  elegible; retirarlo requiere una decisión explícita y permiso de asignación.
- **Archivar/restaurar:** conserva el contenido y la identidad. Las archivadas
  dejan de aparecer en vistas activas, resúmenes y calendario. Se consultan en
  **Proyecto → Archivadas** y desde sus favoritos. No admiten edición hasta
  restaurarlas. El orden manual afecta únicamente a tareas activas.
- **Eliminar:** exige su permiso propio y escribir ELIMINAR. El archivo ofrece
  la alternativa reversible. Las demás tareas quedan fuera de la operación.

Mover o archivar requiere guardar o descartar antes los cambios de detalle
pendientes. Duplicar usa el contenido guardado. Copias, movimientos y archivo
conservan una identidad de petición para tratar reintentos sin repetir acciones.

## Calendario y Google

El calendario interno excluye las tareas archivadas. Google Calendar retira los
eventos que dejan de ser elegibles; Google Tasks pausa la sincronización de la
tarea archivada y conserva el elemento remoto y su vínculo. Restaurar reactiva
la comparación con ese mismo elemento. La limpieza por revocación de acceso o
desconexión conserva su contrato previo.

Mover una tarea mantiene su identidad y actualiza el contexto del vínculo; no
crea otra tarea remota por el mero traslado. Duplicar no copia vínculos de la
fuente. Si el usuario ya activó el envío de tareas nuevas, la copia puede iniciar
su propia sincronización conforme a esa preferencia y al presupuesto existente.

## Datos, permisos y operación

La migración `20261028115927_work_management_stage4.sql` añade columnas opcionales
de planificación y detalle, restricciones, índices y una tabla privada de recibos
con RLS y sin acceso directo. No reescribe proyectos, tareas, finanzas ni la
configuración existente. Compara sus huellas antes y después, excluyendo solo los
campos nuevos con valores iniciales vacíos.

La RPC pública `tr8_v2_work_management` delega en una función privada con sesión
vigente, espacio, ACL y capacidades verificadas. Los DTO son cerrados y acotados.
Actualizaciones usan versiones esperadas; copias y movimientos son transaccionales.
Los recibos se limitan a mil por usuario y espacio. No se amplían permisos del MCP
ni se cambia su contrato de escritura en esta etapa.
Su inventario de lectura puede incluir archivadas, identificadas por
`archived_at`; también devuelve etiquetas, estimación y subtareas. Las nuevas
acciones de archivo y traslado se realizan desde TR8 en esta entrega.

Las consultas, mutaciones y paneles permanecen separados por usuario, espacio y
acceso actual. Una respuesta tardía no puede introducir datos en otro contexto.
El modo global de lectura bloquea todas las escrituras; las capacidades de
proyecto distinguen editar, asignar, eliminar y crear en un destino.

Las pruebas usan datos ficticios en memoria y fixtures SQL transaccionales en
tr8-test. En producción se comprueban lectura, versión publicada, huellas de datos
y altas cerradas, sin crear ni modificar tareas o movimientos reales para ensayar.

Verificación: 989 pruebas de aplicación y 560 de servidor, Edge y MCP aprobadas;
74 aserciones SQL nuevas y 1.256 de regresión, todas revertidas en tr8-test.
TypeScript, ESLint, formato y las compilaciones de producción y Finanzas pasan.
Se comprobó el panel lateral en escritorio y a 390 × 844 sin desbordamiento de
página, así como metadatos, archivo/restauración, traslado, plantillas y fechas
con datos ficticios. La migración aplicada conserva el SHA-256
`6dfee95d62b12f1964483fa7d4f4b9d2ef07c9744540823a465525fb9e21faf4`.

Se conservan Supabase Free y Vercel Hobby, sin proveedores ni dependencias nuevas,
sin nuevos procesos programados y con altas e invitaciones externas desactivadas.
La reversión del cliente conserva las columnas nuevas; antes de volver a una
versión que no conoce el archivo de tareas se debe considerar que esa versión
podría mostrarlas en sus listas. No se eliminan columnas ni datos para revertir.

Timeline, dependencias, archivos y las funciones de comunicación de la demo
pertenecen a las siguientes etapas.

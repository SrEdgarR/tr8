# Timeline, dependencias e hitos — etapa 5

Recupera el cronograma de la [demo original de Gr8r Studio](https://gr8r-taskmanagement.vercel.app/)
con datos persistentes y los permisos actuales de TR8. No ejecuta el prototipo
ni importa sus datos de demostración.

## Timeline

**Timeline** en la barra lateral muestra el espacio actual. Cada proyecto tiene
también una pestaña Timeline. Las escalas Semanas y Meses ofrecen ventanas de
91 y 238 días, navegación de períodos y acceso a Hoy, con fines de semana y día
actual señalados. Se puede agrupar por estado, proyecto o responsable, colapsar
grupos y filtrar por búsqueda, estado, prioridad, proyecto y responsable. Los
nombres de miembros requieren acceso al directorio. Los iconos y colores siguen
la identidad del proyecto y los estados de la demo.

Las barras representan las fechas civiles de inicio y vencimiento, incluyendo
el último día. Una tarea con una sola fecha ocupa un día; las tareas sin fechas
aparecen aparte. El cronograma general excluye proyectos y tareas archivados.
Un proyecto archivado abierto explícitamente conserva la consulta en lectura.

Arrastrar una barra o sus extremos prepara una propuesta. **Confirmar fechas**
guarda exclusivamente el inicio y vencimiento de esa tarea, con su versión
original. El botón Reprogramar y la tecla R sobre la barra permiten hacer lo
mismo sin arrastrar. Cancelar o Escape descartan la propuesta. Un conflicto
conserva el borrador; no se reemplaza silenciosamente la versión esperada. Los
bloques horarios y las tareas relacionadas permanecen independientes.

## Dependencias

En el detalle de tarea, **Dependencias → Añadir dependencia** elige la
predecesora. Se muestran «Bloqueada por» y «Bloquea a» con acceso a la tarea
relacionada. Quitar una relación exige confirmación y conserva ambas tareas.

Las relaciones pueden cruzar proyectos del mismo espacio. Crear o quitar una
relación exige editar la sucesora y leer ambos extremos; no concede permisos
en el otro proyecto. Se rechazan relaciones consigo misma, duplicados, ciclos y
versiones obsoletas. El ciclo se comprueba sobre el grafo completo, incluidos los
extremos que el usuario no puede consultar, sin devolver sus identidades.

Son relaciones informativas: una predecesora pendiente muestra un aviso, pero no
impide completar manualmente la sucesora. Con fechas inclusivas, la sucesora
debe comenzar después del último día de la predecesora; el mismo día se señala
como solapamiento. Las flechas solo se dibujan si ambos extremos están presentes
y visibles. Los filtros y grupos colapsados pueden ocultarlas. Los cambios nunca
reprograman automáticamente otras tareas.

## Hitos

**Timeline → Hitos → Nuevo hito** permite definir proyecto, nombre, fecha y
estado. Editar, completar, reabrir o eliminar requiere `project.edit` y un
proyecto activo. El hito tiene una versión independiente. Los diamantes agrupan
los hitos del mismo día sin superponer sus nombres; abrirlos muestra el panel.
Los hitos no son tareas y no alteran su estado o progreso.

## Persistencia y límites

La migración `20261028123618_planning_stage5.sql` añade relaciones, hitos y
recibos en tablas privadas con RLS, sin acceso directo. Las referencias
compuestas impiden cruzar espacios. La RPC pública `tr8_v2_planning` es invoker;
su implementación privada exige una sesión de navegador vigente y revalida
espacio, capacidades y acceso a proyectos. La autorización y un bloqueo del
grafo por espacio serializan cambios para verificar ciclos y límites.

Los DTO son cerrados y acotados: hasta 1.000 relaciones y 200 hitos por espacio,
con 50 hitos por proyecto. Se conservan hasta 1.000 recibos de creación por
usuario y espacio; los reintentos exactos usan un UUID estable. Las eliminaciones
usan la versión de la relación o del hito. Una respuesta tardía de otro ámbito no
confirma una operación ni entra en su caché.

Mover una tarea dentro del espacio conserva las relaciones. Archivar conserva
los registros y limita su edición; eliminar tareas o proyectos retira sus
relaciones e hitos correspondientes por integridad referencial. Duplicar sigue
creando contenido independiente, sin copiar relaciones o hitos. No se amplía el
contrato de escritura del MCP.

La migración compara huellas de proyectos, tareas, documentos financieros y
configuración antes y después. No reescribe sus filas. La reversión del cliente
puede conservar las nuevas tablas sin restaurar ni eliminar datos.

## Verificación y operación

Las pruebas de interfaz usan datos ficticios en memoria. Las suites SQL se
ejecutan en `tr8-test`, con transacciones revertidas: permisos, ciclos ocultos,
versiones, reintentos, límites, archivo, traslado, copias y eliminaciones. En
producción se comprueban la versión desplegada, lectura, huellas de datos y
altas cerradas; no se modifican datos reales para ensayar.

La entrega pasa 1.067 pruebas de aplicación, 560 de servidor/Edge/MCP y 1.391
comprobaciones SQL (61 nuevas y 1.330 de regresión), además de TypeScript, lint,
formato y compilación. El ensayo de navegador verifica hitos, dependencias y
reprogramación con aviso de solapamiento, en escritorio y a 390 × 844. La página
mantiene el ancho del dispositivo; el cronograma se desplaza dentro de su área y
centra Hoy en el espacio disponible.

Se mantienen Supabase Free, Vercel Hobby y las altas e invitaciones externas
desactivadas. No se añaden paquetes, servicios, correo ni procesos programados.
Las funciones de archivos y comunicación de la demo siguen pendientes.

# Productividad y vistas — etapa 3

Referencia: [demo original de Gr8r Studio](https://gr8r-taskmanagement.vercel.app/).
Recupera productividad sobre los datos autorizados de TR8 y añade la edición y
eliminación de movimientos de Finanzas. No añade proveedores ni dependencias.

## Pantallas y acciones

- **Mis tareas** muestra las tareas personales o las asignadas al miembro actual
  de un equipo. **Tareas** reúne todas las tareas que puede consultar en el espacio.
- **Favoritos** reúne proyectos y tareas marcados con la estrella. Quitar una
  estrella solo modifica la preferencia propia; no elimina el contenido.
- **Tabla**, junto a Lista y Tablero, permite editar título, estado, prioridad y
  fechas con los permisos actuales. Enter guarda; Escape descarta la edición.
  Los errores conservan el borrador y permiten volver a intentarlo.
- Búsqueda y filtros combinables por proyecto, estado, prioridad, responsable,
  fecha y favoritos; orden ascendente o descendente; grupos colapsables por
  estado, proyecto, prioridad o responsable; columnas configurables.
- Las vistas se guardan por usuario, espacio y contexto: Tareas, Mis tareas o un
  proyecto concreto. Aplicarlas es una acción explícita. Se pueden actualizar y
  eliminar sin afectar proyectos ni tareas. La creación conserva su identidad al
  reintentar un resultado ambiguo; actualizar y eliminar requieren su versión.
- En orden manual ascendente, las flechas y el arrastre ordenan tareas del mismo
  proyecto. El cliente conserva los huecos de tareas excluidas por el filtro y
  envía las versiones del orden completo. No reordena entre proyectos.

Los iconos, colores, navegación y preferencias de apariencia de la etapa 1 se
mantienen. Nueva tarea permanece visible en el proyecto; se desactiva cuando
faltan permisos. Calendario y actividad conservan sus consultas y contratos.

## Persistencia y permisos

La migración `20261027143908_productivity_views_favorites.sql` añade tres tablas
privadas con RLS: favoritos, vistas y recibos de reordenamiento. No concede acceso
directo a sus filas. La RPC pública `tr8_v2_productivity` verifica la sesión del
navegador, espacio, identidad y permisos actuales antes de delegar la operación.

Los favoritos y vistas son preferencias propias, disponibles también para quien
solo puede leer un proyecto. Modificar tareas sigue requiriendo `task.edit`. La
lectura vuelve a verificar el acceso al contenido; favoritos y vistas no otorgan
permisos. La caché se separa por usuario y espacio, y rechaza consultas y escrituras
tardías tras cambiar el contexto o perder acceso.

Límites por usuario y espacio: 1.000 favoritos, 50 vistas, configuración de vista
cerrada de hasta 20 KB y 1.000 recibos de orden. El reordenamiento se limita a
proyectos de hasta 200 tareas, es transaccional y usa versiones esperadas e
identidad de petición. No cambia la identidad de tareas ni sus enlaces con Google.

La migración bloquea las tablas afectadas durante su breve transacción y compara
huellas de proyectos, tareas, finanzas y configuración antes de confirmar. No
reescribe sus filas. SHA-256 de la fuente aplicada:
`4658d09d0a48e7aef28fc61d3232096781cb8e9031587044313dfe2c6a5273ee`.

## Editar y eliminar movimientos

En **Finanzas → Movimientos**, cada operación tiene acciones de edición y
eliminación. Funcionan en el espacio protegido por la cuenta y en la bóveda
opcional. La edición conserva ID, tipo y moneda; permite ajustar importe, fecha,
descripción, nota, categoría y cuentas compatibles. Guardar vuelve a validar el
documento completo con la versión esperada.

Transferencias y pagos de tarjeta son una operación con dos efectos: se corrigen
o retiran conjuntamente. Editar un movimiento vinculado actualiza su plan;
eliminarlo cancela únicamente ese plan. La eliminación requiere escribir
**ELIMINAR** y explica sus efectos. No admite eliminar un gasto mientras tenga
reembolsos dependientes.

Una modificación financiera que afecta una captura de deuda de tarjeta se
detiene con indicaciones para marcar el pendiente del corte por completar y
recapturarlo desde Configurar tarjeta. Cambiar solo descripción o nota no altera
esa captura. El resto de movimientos, planes, saldos de apertura y monedas se
conserva. No se modifica automáticamente ningún dato financiero existente.

## Verificación y operación

- 914 pruebas de aplicación y 560 de servidor, Edge y MCP; compilación, TypeScript,
  ESLint y formato globales. Los nuevos casos cubren permisos, cambios de espacio, respuestas
  tardías, conflictos, reintentos, vistas, orden y efectos financieros emparejados.
- 74 aserciones nuevas de PostgreSQL y 509 de regresión, todas aprobadas en el
  proyecto de prueba, con fixtures transaccionales revertidos. Ningún fixture SQL
  se ejecuta en producción.
- Ensayo de navegador con datos ficticios en memoria: favoritos, edición en
  tabla, vistas guardadas y navegación; editar un ingreso y eliminar una
  transferencia, comprobando ambos saldos y las operaciones restantes.
- Diseño de escritorio y móvil a 390 × 844: la tabla puede desplazarse dentro de
  su contenedor sin ensanchar la página; menús y controles respetan el viewport.
- Publicación con verificación de versión, comprobación productiva de lectura,
  huellas de datos y altas externas cerradas. Los movimientos reales del usuario
  no se editan ni se eliminan para probar la entrega.

Se mantienen Supabase Free, Vercel Hobby y las altas e invitaciones externas
desactivadas. No se incorporan procesos programados, servicios de pago ni correo.
La reversión del cliente es compatible: las tablas nuevas pueden conservar sus
preferencias sin restaurar ni eliminar datos.

Las siguientes etapas siguen pendientes: completar proyectos y tareas (fechas
propias, plantillas, duplicación, traslado, subtareas, etiquetas y detalle),
Timeline, archivos y las funciones de comunicación de la demo.

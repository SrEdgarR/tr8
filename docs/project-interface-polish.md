# Ajustes de proyectos, formularios e identidad

Entrega del 29 de octubre de 2026 a partir de las anotaciones de la interfaz.
Conserva el diseño, los permisos y los planes gratuitos de TR8.

## Cambios de interfaz

- Las acciones de favorito, subir y bajar quedan centradas respecto a toda la
  fila, incluidas las filas con subtareas, etiquetas o títulos largos.
- Selección masiva y finalización se distinguen por forma, check e indicaciones
  accesibles. Las acciones disponen de nombres y tooltips; los permisos y las
  versiones esperadas siguen controlando cada escritura.
- Búsqueda, estado, prioridad, filtros avanzados, organización, vistas guardadas
  y contador forman una sola barra. Los estados y prioridades múltiples no se
  sustituyen al dibujar sus selectores rápidos. En escritorio compacto se usan
  acciones con iconos y tooltip; móvil permite varias filas.
- Las columnas del resumen estiran su último panel hasta el mismo borde inferior,
  de modo que Pendientes con fecha y Actividad forman un conjunto rectangular.
  En pantallas estrechas se conserva el flujo de una columna.
- El selector de espacio presenta iconos, nombre, tipo y selección actual. Su
  popup no queda recortado por el sidebar; admite flechas, Home/End, Enter,
  espacio, Escape, Tab, búsqueda por teclado y cierre exterior.
- Sincronización y actualización comparten un botón. Conserva los estados de
  comprobación, guardado, desconexión, error y bóveda bloqueada. Reconectar por
  sí solo no confirma que los datos estén sincronizados.
- El formulario de tareas incorpora iconos dentro de los controles y colores
  de proyecto, estado y prioridad. Las indicaciones de responsable, bloque
  horario y repetición se reúnen en una nota contextual.
- La estimación reserva espacio para el icono y el valor; la unidad «min» queda
  fuera del input y no tapa los controles numéricos del navegador.

## Calendario

La captura mostraba octubre de 2026 y las tareas indicadas tenían sus próximas
fechas en noviembre. La consulta estaba correctamente limitada al mes visible;
no se cambian las fechas ni se importa otra copia desde Google para resolverlo.

Cuando un proyecto no tiene elementos en el mes visible y la consulta terminó,
TR8 muestra su próxima fecha autorizada y un botón para ir a ese mes. La pista
se deriva de las tareas visibles del mismo proyecto y espacio, con permiso de
lectura; no incluye tareas completadas o archivadas. Se retira cuando hay
filtros activos o páginas pendientes para no confundir un filtro con ausencia
de tareas. La navegación vuelve a consultar la ventana correspondiente.

## Nombre de quien realizó la acción

El registro inicial de la cuenta tenía literalmente el nombre «Usuario»; no
existía otro nombre configurado. Mi cuenta permite ahora elegir un nombre
visible de 1 a 120 caracteres. No se infiere a partir del correo ni se guarda
un nombre real durante la migración. Hasta configurarlo, las acciones propias
se identifican como «Tú». Las acciones de otra persona conservan su identidad
devuelta por el servidor; no se atribuyen al usuario conectado.

El nombre se guarda en `tr8_private.app_users.display_name`, que ya utilizan
actividad, comentarios y directorios. La RPC `tr8_v2_profile` solo lee o cambia
la identidad de `auth.uid()` con cuenta habilitada y sesión vigente de navegador.
No admite un ID de usuario a elegir, datos de autorización ni llamadas delegadas
del MCP. La revisión `updated_at` evita sobrescribir otro cambio; un reintento
con el mismo nombre devuelve la revisión existente sin otra escritura.

El formulario conserva el borrador ante conflictos y requiere revisar la
versión actual. Un resultado incierto solo se confirma después de volver a leer
el nombre guardado. Las respuestas de una cuenta o ámbito anterior no se aplican
a la pantalla nueva. Guardar refresca las cachés de directorio y actividad.

## Datos y verificación

La migración `20261029150419_profile_identity.sql` añade funciones, sin modificar
filas, columnas, roles ni permisos existentes. Su SHA256 es
`C1D33885F4B9093238C8DF1949EC82CA861F4B34511F7B74B685F063D2FFD94D`.
Se aplicó el mismo SQL en TEST y producción; las huellas inmediatas de proyectos,
tareas, finanzas, espacios y perfiles coinciden antes y después. Los registros
e invitaciones externos siguen cerrados. No se añade dependencia, proveedor,
cron ni recurso de pago.

Pasan 1.527 pruebas de aplicación y 560 de servidor/Edge/MCP. Los 44 checks SQL
de perfil se ejecutaron en TEST con rollback: lectura propia, CAS, actividad,
reintentos, validación, cuentas deshabilitadas, sesiones ajenas o terminadas,
roles anónimos y llamadas MCP reales. Las identidades sintéticas no persisten.
También se comprueban TypeScript, ESLint, formato, migraciones y compilación.

El navegador sobre harnesses locales sin servicios verificó los formularios,
la estimación, los controles de lista, el selector de espacio, la fila única de
filtros, los bordes alineados del resumen, el salto a noviembre y el nombre
visible con datos sintéticos. Esta revisión no guarda cambios en tareas reales.

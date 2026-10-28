# Comunicación en tareas — etapa 7

Recupera comentarios, menciones, reacciones y la bandeja de la
[demo original de Gr8r Studio](https://gr8r-taskmanagement.vercel.app/), con
persistencia y permisos reales. No conecta el almacén local de demostración.

## Conversación

El detalle de cada tarea ofrece una conversación con avatar, autor, fecha,
edición propia y borrado confirmado. El texto es plano, con saltos de línea,
sin HTML ni ejecución de contenido. El editor permite seleccionar menciones
por identidad de miembro y enviar con Ctrl/Cmd + Enter. Las seis reacciones
originales son 👍, 🎉, ❤️, 👀, 🚀 y ✅; cada persona puede añadir o retirar cada
reacción sin que un reintento invierta dos veces su intención.

Las menciones son una selección explícita de miembros elegibles, no nombres
interpretados como permisos. Solo se ofrecen cuando el autor puede consultar
el directorio. Los nombres de autores y menciones respetan ese permiso actual;
sin él se muestran etiquetas genéricas. No se muestran correos ni el listado
de personas que reaccionaron. Editar el texto conserva las menciones fijadas
al publicar y no genera avisos adicionales.

Consultar requiere lectura actual de proyecto y tarea. Publicar o reaccionar
requiere edición y acceso de escritura; editar se limita al autor y eliminar
también permite moderación con permiso de eliminar tareas. Archivar conserva
la conversación en lectura. Duplicar no copia comentarios. Eliminar la tarea
retira sus comentarios, reacciones y avisos asociados.

Una tarea con conversación no se puede trasladar a otro proyecto: hacerlo
podría dar acceso a mensajes privados a los miembros del destino. Se puede
duplicar sin copiar la conversación. La guardia se aplica en PostgreSQL y no
solo en el botón de la interfaz.

## Bandeja y notificaciones

Bandeja de entrada y Notificaciones usan una única fuente. Hay filtros por
menciones, asignaciones, comentarios y no leídos, acciones de leído/no leído,
marcar todas como leídas y retirar un aviso. Abrir una tarea permite responder
desde su conversación. El contador y la campana comparten la consulta de la
bandeja; un fallo no se presenta como cero avisos.

Al publicar se avisa a los mencionados, al creador y al responsable elegibles,
sin avisar al propio autor ni duplicar destinatarios. Una mención tiene prioridad
frente al aviso de comentario para la misma persona. Las asignaciones nuevas
tienen su aviso propio. No se crean retrospectivamente avisos de tareas antiguas.
La lectura comprueba pertenencia y acceso vigentes; los avisos no conceden acceso
ni conservan copias de títulos o contenido privado. El estado de lectura pertenece
exclusivamente a su destinatario y espacio.

## Persistencia, límites y verificación

La RPC `tr8_v2_communication` verifica una sesión de navegador vigente y delega
en funciones privadas con permisos explícitos y `search_path` vacío. Las tablas
propias tienen RLS y no se exponen directamente. Los UUID estables de creación,
recibos y versiones evitan duplicados, resurrecciones y sobrescrituras concurrentes.
Las mutaciones de comunicación no modifican versiones ni contenido de las tareas.

Para mantener acotado el uso gratuito, se permiten 4.000 caracteres por comentario,
diez menciones, páginas de cincuenta comentarios, quinientos comentarios por tarea
y cinco mil por espacio. La bandeja conserva los doscientos avisos más recientes
por miembro y espacio; los recibos de creación se limitan a diez mil por espacio.
Las consultas se actualizan al abrir, recuperar el foco,
pedirlo expresamente o realizar una acción; no añaden sondeos periódicos.

Se mantienen Supabase Free y Vercel Hobby, sin paquetes nuevos, proveedores,
correo, push o altas externas. Las menciones masivas, los adjuntos de comentarios
y la búsqueda global de conversaciones quedan fuera de esta entrega.

Las pruebas usan fixtures sintéticas y rollback en `tr8-test`. La publicación
compara las huellas de proyectos, tareas, espacios y finanzas antes y después.
La entrega verifica 1.216 pruebas de aplicación y 560 de servidor/Edge/MCP;
1.729 comprobaciones SQL (129 nuevas y 1.600 de regresión), y 53 comprobaciones
HTTP reales usando el repositorio TypeScript compilado. Las identidades,
sesiones, espacios y contenido sintéticos se retiraron al finalizar; las huellas
de datos ajenos y la configuración se conservaron. También se verifican
TypeScript, ESLint, Prettier y la compilación de producción.

La herramienta de revisión visual volvió a detenerse porque no pudo determinar
la URL del navegador de forma segura. El recorrido visual manual queda pendiente;
no se presenta la evidencia de componentes y API como una comprobación visual.

La validación detectó y corrigió la diferencia entre moderar un comentario propio
con permiso de eliminar tareas y editarlo, el retiro idempotente de avisos, la
reasignación sin resucitar notificaciones anteriores y el rechazo de controles
de texto antes de persistirlos. Estas correcciones usan migraciones posteriores;
las fuentes ya aplicadas se conservan exactamente.

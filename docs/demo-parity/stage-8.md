# Búsqueda global y accesos rápidos — etapa 8

Recupera el buscador, la paleta y los atajos de la
[demo original de Gr8r Studio](https://gr8r-taskmanagement.vercel.app/) sobre los
datos reales de TR8. La búsqueda abarca el espacio seleccionado. Para buscar en
otro espacio se cambia desde el selector o una acción de la paleta.

## Entrada y navegación

El botón de la barra superior, `Ctrl/Cmd + K` y `/` abren la paleta. Con el campo
vacío aparecen acciones de navegación, creación autorizada, cambio de espacio y
vistas del proyecto actual. No se ofrecen invitaciones, acciones destructivas ni
funciones que no estén disponibles en la aplicación. Las flechas y Enter permiten
elegir un resultado; Escape o pulsar fuera cierran y devuelven el foco.

La página Búsqueda ofrece las mismas categorías, conteos, filtros y resultados,
con paginación por categoría. La consulta se conserva únicamente en memoria del
ámbito actual al volver desde un resultado. No se guarda en la URL, preferencias,
historial propio, analítica ni almacenamiento persistente de TR8.

Los resultados abren proyectos y tareas, los detalles de metadatos de un archivo,
el miembro del equipo o un comentario concreto. Los comentarios anteriores se
localizan cargando como máximo sus diez páginas, sin descargar archivos ni
exportar contenido. Si un elemento ya no existe, se muestra su indisponibilidad.
La selección actualiza el snapshot del espacio y cada lectura conserva su
autorización en el servidor.

La guía de atajos se abre desde la barra lateral o `?`. Incluye `N`, `P`, `[`,
y las secuencias de navegación `G H`, `G P`, `G T`, `G I`, `G N`, `G C`, `G M`,
`G A` y `G S`, según las funciones y permisos disponibles. Los atajos de una
letra no actúan al escribir ni mientras haya una ventana abierta. `Ctrl/Cmd + K`
tampoco abre una segunda paleta sobre un formulario. Los cambios de permiso y
espacio retiran la paleta anterior y sus acciones.

## Resultados y privacidad

Se consultan nombres, códigos y descripciones de proyectos; títulos,
descripciones y claves de tareas; nombres visibles de miembros; nombres de
archivos confirmados y texto de comentarios. Los resultados se agrupan en cinco
categorías con los iconos y colores de TR8. El resaltado utiliza texto y elementos
React, sin interpretar HTML ni patrones proporcionados por el usuario.

Los archivos requieren lectura de su proyecto; tareas y comentarios requieren
además lectura de tareas. Las personas se buscan solo en equipos con permiso
`member.read`; no se devuelven correos ni roles. Los autores de comentarios
respetan el directorio vigente y pueden aparecer como «Tú» o «Miembro». No se
buscan datos financieros, contenido binario ni rutas privadas de Storage.
La entrada global exige lectura de proyectos del espacio; la administración de
miembros y roles conserva sus accesos existentes por separado.

Por defecto se excluyen proyectos y tareas archivados. El filtro explícito los
incluye con sus permisos actuales y su estado de solo lectura. Un resultado o
conteo no concede acceso ni revela coincidencias de otros espacios o proyectos.

## Consulta y presupuesto

La RPC `tr8_v2_search` es de lectura. Su envoltorio público utiliza seguridad de
invocador y delega en código privado con `search_path` vacío, sesión de navegador
vigente y autorización actual serializada con las modificaciones de permisos.
No amplía permisos del MCP ni expone tablas privadas a la API.

La búsqueda es una coincidencia literal de subcadena, sin distinguir mayúsculas;
`%`, `_`, comillas y texto parecido a SQL no se convierten en patrones o código.
No se corrigen automáticamente tildes, errores de escritura ni sinónimos. Se
permiten entre dos y cien caracteres y se rechazan controles de texto.

Tras una pausa de 250 ms se consulta el servidor. Cambiar consulta, categoría o
permisos cancela la petición anterior y retira sus resultados inmediatamente.
La caché es en memoria, separada por cuenta/espacio/ACL, y se retira al desmontar
la consulta. No hay sondeos periódicos ni consultas al abrir una paleta vacía.

Una CTE materializa los proyectos autorizados y obtiene conteos y página en el
mismo snapshot. «Todos» equilibra los tipos: cinco resultados por categoría en
la paleta y diez en la página; una categoría concreta carga veinticinco por página.
El servidor acepta hasta cincuenta por categoría y desplazamientos de hasta diez
mil. Para más coincidencias se debe precisar la consulta. El orden es categoría,
fecha descendente e ID descendente, incluyendo la precisión de PostgreSQL.

Se utilizan los índices actuales de espacio y proyecto. No se crean tablas,
extensiones, servicios de búsqueda, dependencias ni tareas programadas. El coste
de la coincidencia de texto crece con los datos visibles; antes de ampliar mucho
el volumen habrá que medir el plan y evaluar un índice de texto apropiado.
Se mantienen Supabase Free, Vercel Hobby, el correo sin activar y las altas
externas desactivadas.

## Verificación y publicación

Las pruebas usan fixtures ficticias, transacciones SQL con rollback y sesiones
HTTP sintéticas en `tr8-test`. El ensayo HTTP valida el repositorio TypeScript
contra PostgreSQL y Storage reales. Sus identidades y objetos se retiran al
terminar, sin modificar datos ajenos ni configuración. Las migraciones aplicadas
son inmutables; la corrección del DTO de comentarios se añade como una migración
posterior. La publicación compara huellas de proyectos, tareas, espacios y finanzas.

La entrega verifica 1.295 pruebas de aplicación, 560 de servidor/Edge/MCP,
1.892 comprobaciones SQL (163 nuevas y 1.729 de regresión) y cuarenta
comprobaciones HTTP reales, además de TypeScript, ESLint, formato y compilación.
El ensayo HTTP incluye un archivo real, sesiones terminadas, permisos retirados,
autores redactados, consultas literales y las cinco categorías. Su limpieza
restauró los recuentos y huellas de datos ajenos de TEST.

El control visual del navegador se detuvo porque la herramienta no pudo verificar
su URL de forma segura. El recorrido visual de esta entrega y el pendiente de
Archivos/Comunicación siguen sin confirmarse; las pruebas de componentes y API
no se presentan como evidencia visual.

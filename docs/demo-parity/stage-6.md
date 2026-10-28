# Archivos por proyecto — etapa 6

Recupera la sección Archivos de la [demo original de Gr8r Studio](https://gr8r-taskmanagement.vercel.app/)
con almacenamiento real. Se abre en **Proyecto → Archivos**, también desde las
vistas desplegables de la barra lateral. La demo guardaba metadatos locales y
simulaba la subida; TR8 guarda los binarios en un bucket privado de Supabase.

## Interfaz y operaciones

La cuadrícula y la lista ofrecen búsqueda, filtro de tipo y orden por fecha,
nombre o tipo. Los iconos y colores distinguen imágenes, PDF, documentos,
presentaciones, hojas de cálculo y archivos comprimidos. El menú permite
consultar detalles, descargar, cambiar el nombre y eliminar. La descarga exige
sesión y permiso actual; no se generan enlaces públicos ni firmados para compartir.
Los detalles muestran metadatos, sin descargar automáticamente el contenido.
Los nombres de autores respetan el acceso al directorio de miembros.
El listado se consulta al abrir, recuperar el foco, actualizar explícitamente o
confirmar cambios; no descarga metadatos periódicamente mientras queda abierto.
Los permisos siguen participando en el refresco del espacio y en cada operación.

Se pueden elegir o arrastrar hasta diez archivos por lote. Las subidas son
secuenciales y muestran estados reales, sin porcentajes simulados. Cada intento
conserva su UUID y su archivo para reintentarlo tras una respuesta ambigua. Los
formatos rechazados localmente no consumen una reserva ni bloquean otro lote.
Si se abandona una carga, su reserva aparece en la lista y puede retirarse.

Renombrar conserva el tipo y la identidad del binario; usa la versión esperada.
Eliminar exige escribir el nombre exacto y afecta exclusivamente a ese archivo.
Los proyectos y tareas se conservan. Si falla una retirada, se puede reintentar:
el sistema mantiene su reserva hasta confirmar que el objeto ya no existe.

## Formatos, permisos y presupuesto

Se admiten PNG, JPEG, WebP, PDF, TXT, CSV, DOCX, XLSX, PPTX y ZIP. La validación
comprueba nombre, extensión, tipo declarado y tamaño; no presenta este control
como un análisis antivirus. El contenido se descarga para abrirlo en el
dispositivo, sin ejecutar HTML, SVG, scripts ni descomprimir archivos en TR8.

Los límites internos son 5 MiB por archivo, 50 MiB y cien archivos por proyecto,
y 200 MiB globales para este módulo. Para iniciar una carga hacen falta 5 MiB
libres: se reserva el máximo permitido hasta verificar el objeto recibido y
después se reduce al tamaño real. Las retiradas incompletas conservan su reserva.
Esto impide exceder el presupuesto declarando un tamaño menor que el enviado.
No se expone al usuario el consumo de
proyectos a los que no tiene acceso. Los recibos permanentes tienen un límite
global de diez mil, para acotar el crecimiento de metadatos sin reutilizar IDs.
Estos son límites de TR8; no equivalen a todas las cuotas de la cuenta del proveedor.

`project.read` permite consultar y descargar archivos de un proyecto autorizado.
`project.edit` permite subir, renombrar y retirar, con ACL de escritura actual.
Un proyecto archivado conserva la consulta y descarga. El modo global de lectura
bloquea cambios. No se amplían los permisos del MCP ni las altas externas.

## Protocolo y almacenamiento

La RPC `tr8_v2_project_files` delega en código privado con sesión de navegador
vigente, espacio y permisos verificados. Sus DTO son cerrados y acotados. Las
tablas propias tienen RLS y carecen de acceso directo. Los objetos usan rutas
de UUID de espacio/proyecto/archivo, independientes del nombre visible.

1. **Reservar:** comprueba capacidad y registra una identidad estable con estado
   `pending`. Repetir exactamente la petición recupera la misma reserva.
2. **Subir:** el SDK de Storage envía los bytes sin sobrescribir objetos.
   Las políticas autorizan su sondeo previo de permisos. La comprobación del
   tamaño declarado en ese sondeo no sustituye la reserva conservadora del máximo.
3. **Completar:** comprueba tamaño y MIME en los metadatos reales de Storage
   antes de marcar `ready` y reducir la reserva al tamaño confirmado. Un objeto
   discrepante sigue pendiente y no se puede descargar desde TR8.
   Ante una respuesta perdida se consulta el mismo ID antes de reenviar bytes.
4. **Retirar:** una transición con versión esperada marca `deleting`; el SDK
   elimina el binario y después la RPC comprueba su ausencia antes de liberar
   espacio. Un recibo mínimo impide resucitar el ID eliminado.

Solo la API de Storage modifica sus objetos. No se borran filas de
`storage.objects` mediante SQL. Las políticas permiten descarga autenticada y
las operaciones acotadas de subida/retirada; no permiten listar el bucket,
generar URLs firmadas, sobrescribir, copiar ni mover objetos desde el cliente.
Las URLs Blob de descarga se revocan y no se guardan en preferencias persistentes.
Cada descarga utiliza un nonce nuevo y `no-store` para volver a comprobar el
acceso, sin reutilizar una respuesta HTTP anterior a la retirada del archivo.

## Eliminación de proyectos y conservación

Un proyecto con archivos o reservas no se puede eliminar hasta retirarlos desde
Archivos. Una guardia en la tabla propia de proyectos impide que un borrado
directo o una cascada deje binarios huérfanos. Archivar permite conservarlos.
Duplicar un proyecto sigue creando una copia independiente, sin copiar archivos.

Las migraciones comparan huellas de proyectos, tareas, finanzas y configuración
existentes. No importan archivos de la demo ni modifican datos financieros. Las
migraciones aplicadas son inmutables; las correcciones del sondeo real de Storage,
el límite de recibos y la reserva conservadora se documentan en migraciones posteriores.

## Verificación

Las pruebas de interfaz usan datos ficticios. Las pruebas SQL se ejecutan en
`tr8-test` con `ROLLBACK`, y el ensayo real de API utiliza dos identidades
sintéticas: subida y descarga con comparación de bytes, reintentos, permisos,
renombrado, archivo y retirada. Los binarios se limpian mediante la API de
Storage antes de retirar las identidades. Las altas siguen cerradas durante
todo el ensayo; no se usan proyectos ni archivos reales como fixtures.

La herramienta de verificación visual se detuvo al no poder identificar de
forma segura la URL del navegador. Esta entrega distingue las pruebas de
componentes y API de un recorrido visual manual, que queda pendiente.

Validación de la entrega: 1.140 pruebas de aplicación, 560 de servidor/Edge/MCP,
1.482 comprobaciones SQL (91 nuevas y 1.391 de regresión), 41 comprobaciones de
API real y tres casos de concurrencia con cuerpos de subida retrasados. También
se verifican TypeScript, ESLint, formato y compilación. Las pruebas detectaron y
corrigieron el sondeo previo de Storage, la diferencia entre tamaño declarado y
recibido, y la reutilización de una respuesta de descarga tras eliminar el archivo.

Se mantienen Supabase Free y Vercel Hobby, sin contratar servicios, añadir
paquetes, activar correo o abrir registros. Los comentarios, menciones y las
funciones de comunicación de la demo siguen pendientes.

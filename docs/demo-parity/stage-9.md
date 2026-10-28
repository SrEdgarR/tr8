# Estabilización y revisión de cierre — etapa 9

Esta entrega revisa las capacidades recuperadas de la demo y corrige problemas
en los flujos actuales. El [inventario comparativo](stage-9-inventory.md)
distingue funciones reales, variantes pendientes y controles simulados de la demo.
No declara paridad completa. La ampliación del MCP queda para otra entrega.

## Correcciones

- Escape cierra solo el diálogo activo, sin propagar el cierre a su diálogo padre.
- Al cerrar detalles, renombrado o eliminación de un archivo, el foco vuelve al
  botón de opciones del archivo. Abrir esos diálogos no descarga el binario.
- La edición de títulos en Tabla no guarda ni cancela durante composición IME.
- Si una recarga de Finanzas descubre otra versión del registro, se invalidan
  las vistas previas de restauración y los formularios abiertos sobre la versión
  anterior. También se descartan lecturas de respaldo que terminan después de esa
  recarga. Se vuelve al Resumen para revisar los datos actuales antes de editar.
  Una recarga de la misma versión conserva el borrador; un guardado normal
  conserva la pestaña. El control de versión del servidor continúa vigente.

Las pruebas financieras emplean cuentas, tarjetas DOP/USD y movimientos ficticios.
Se conservan DOP predeterminado, Finanzas sin contraseña privada y bóveda opcional.
No se convierten, agrupan, restauran ni eliminan datos reales en esta revisión.

## Carga de secciones

Calendario, Timeline, Archivos, Bandeja, comentarios y Configuración se cargan
cuando se montan. Las conexiones Google/MCP y los procesos también se separan de
la entrada inicial. Finanzas conserva su carga diferida. Cada sección muestra un
estado de carga y un error con reintento local, conservando el espacio alrededor.
No se usa una recarga de toda la página como reintento.

Los contenedores de los diálogos de tarea y búsqueda permanecen disponibles desde
el inicio para mantener modalidad, Escape, foco y bloqueo de atajos incluso con
una red lenta. La navegación mantiene montada la estructura del espacio; cambiar
de proyecto no vuelve a montar la aplicación ni acumula páginas anteriores.

Configuración no monta las categorías aún no visitadas ni el contenido de un
ajuste antes de abrirlo. Después de abrirlo, conserva sus hijos al ocultarlos para
no perder borradores. Las claves de cuenta, espacio y permisos mantienen el
aislamiento existente.

### Medición reproducible

Comparación con `365220e0c4a2b935f8fe5866ef46f8b26a1bcc84`, usando las mismas
dependencias y configuración de Vite. Se suman los archivos finales de la entrada
y todos sus imports estáticos, sin contar chunks diferidos como ahorro si siguen
referenciados estáticamente. Gzip se calcula por archivo.

| Carga inicial | Antes, bytes | Después, bytes | Antes gzip | Después gzip |
| ------------- | -----------: | -------------: | ---------: | -----------: |
| JavaScript    |    1.116.672 |        963.003 |    312.617 |      272.333 |
| CSS           |      222.072 |        167.928 |     39.052 |       30.559 |

La reducción de JavaScript inicial comprimido es del 12,9 % y la de CSS del
21,7 %. Es una medición de tamaño de compilación, no de tiempo de carga, LCP,
fluidez ni memoria en un dispositivo real. El bundle inicial sigue siendo grande;
el catálogo de zonas y el cifrado también conservan chunks diferidos grandes.
No se ocultan las advertencias de tamaño de Vite.

Para repetir la medición de una revisión:

```sh
npm exec vite build -- --manifest
node scripts/measure-initial-assets.mjs dist
```

## Verificación y límites

La regresión local comprueba 1.313 pruebas de aplicación y 560 de servidor,
Edge y MCP. Incluye las siete regresiones nuevas de Finanzas, cinco de
interacción, cuatro de carga diferida y dos de configuración. Pasan TypeScript
de aplicación, Edge, MCP y banco financiero, ESLint, formato, comprobación estática
de migración y compilación. Las pruebas integradas siguen verificando permisos,
navegación entre proyectos, ausencia de páginas acumuladas y apertura de
comentarios/archivos concretos desde búsqueda.

No hay migraciones, dependencias ni nuevos servicios. Las verificaciones SQL/HTTP
alojadas documentadas en la etapa 8 son evidencia de esa entrega y no se vuelven a
contabilizar como ejecuciones de esta etapa. La publicación compara las huellas
de proyectos, tareas, espacios y finanzas antes y después. Se mantienen Supabase
Free, Vercel Hobby y las altas e invitaciones externas cerradas.

Se revisaron las reglas responsive y de movimiento reducido en el código. El
recorrido visual de escritorio/móvil y las comprobaciones manuales completas
siguen pendientes: Computer Use volvió a detenerse al no poder identificar la URL
del navegador con suficiente certeza. No se realizaron más acciones de navegador
después del bloqueo. Las pruebas de DOM/componentes y los GET de publicación no
sustituyen esa revisión visual ni un ensayo completo en un navegador real.

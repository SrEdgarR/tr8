# Auditoría móvil de TR8

Revisión del 30 de octubre de 2026. Amplía la navegación de proyectos de
`e19185b` al resto de la aplicación. Implementación y revisión visual realizadas
en el navegador integrado de Codex, con componentes reales y datos sintéticos.

## Criterios aplicados

- Reflujo a 320, 390 y 430 píxeles CSS, más tableta de 768 y altura reducida.
  Tablas, tablero y cronograma conservan desplazamiento local sin ensanchar la
  página. Los recuadros tienen un borde de 1 píxel por lado: sus anchos interiores
  medidos son 318, 388, 428 y 766.
- Acciones principales visibles y opciones secundarias plegadas, conservando
  controles, filtros y borradores. Selectores móviles de vistas y categorías.
- Campos móviles de 16 píxeles y controles principales de 44 píxeles. Los
  controles compactos de tableta son de 32; el cronograma conserva filas de 40
  y reprogramación de 32 × 40 para mantener la geometría de las dependencias.
  El calendario usa siete columnas de días y áreas táctiles completas.
- Menú lateral modal: fondo `inert`, foco contenido, Escape, cierre interior y
  retorno del foco. El selector de espacios se monta dentro del menú modal.
  Los diálogos evitan restaurar el foco en elementos ocultos o inertes.
- Pies de formulario visibles con altura corta, zonas seguras y scroll interno.
  Temas claro/oscuro, títulos largos y movimiento reducido.
- Contratos de datos, permisos y sincronización conservados. Sin migraciones,
  dependencias nuevas, proveedores de pago ni cambios de altas externas.

Referencias: [reflujo WCAG](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html),
[objetivos táctiles WCAG 2.2](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
y [diseño de Apple](https://developer.apple.com/design/tips/).
Son criterios de implementación; esta revisión no constituye una certificación
integral de WCAG ni una prueba en dispositivos iOS/Android físicos.

## Cobertura

| Área                      | Cambios y revisión                                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cabecera y navegación     | Menú táctil con foco y cierre; selector de espacios contenido; cabecera compacta, altura dinámica y safe areas.                                                                            |
| Inicio y vista general    | Estadísticas adaptables, acciones táctiles, títulos multilínea y pestañas ajustadas. Se conserva el aviso de cobertura parcial cuando corresponde.                                         |
| Proyectos y colecciones   | Lista, tablero, tabla, resumen y archivadas; búsqueda y opciones plegadas. Favoritos con nombres largos sin desbordamiento. Todas las acciones de las tarjetas caben a 320.                |
| Detalle y formularios     | Acciones secundarias plegadas; personalización opcional del proyecto; fechas y estimación sin solapamiento de iconos; repetición, subtareas y comentarios adaptados.                       |
| Calendario                | Mes compacto con días tocables, indicadores y agenda del día; filtros plegados. Mensajes de ausencia coherentes con las páginas pendientes de cargar.                                      |
| Timeline                  | Opciones plegadas, scroll local y geometría de filas conservada.                                                                                                                           |
| Archivos                  | Cuadrícula/lista, filtros, acciones y detalle contenidos dentro de la pantalla.                                                                                                            |
| Búsqueda                  | Categorías con scroll local, resultados largos legibles y conservación de «Ver todos los resultados».                                                                                      |
| Bandeja                   | Aviso elegido en diálogo móvil. Abrir y cerrar no lo marca leído; errores dentro del diálogo y retorno del foco al cambiar de tamaño.                                                      |
| Equipo, roles y actividad | Filas, permisos, acciones y nombres largos con reflujo. Se conservan las comprobaciones de autorización.                                                                                   |
| Configuración y cuenta    | Categorías móviles; zona, Apariencia, Google/Tasks, MCP, procesos y perfil conservan su estado.                                                                                            |
| Finanzas                  | Selector móvil de cinco secciones; filtros plegados; importes largos y tarjeta DOP/USD; cuentas, movimientos, planes, seguridad y bóveda opcional. Iconos de campos con espacio reservado. |
| Acceso y recuperación     | Campos de 16 píxeles, botones táctiles, etiquetas adaptables y altura corta. Sin cambios de autenticación.                                                                                 |

## Verificación

- **1.557 pruebas de aplicación aprobadas en 111 archivos**, sin fallos.
  Informe: `test-results/mobile-audit-app-release.json`.
- TypeScript, ESLint, Prettier, `git diff --check` y compilación de producción
  correctos. La compilación conserva el aviso previo sobre chunks grandes.
- Inspección de las pantallas de Workspace mediante una matriz de cuatro
  tamaños, más ensayos de Finanzas, calendario/configuración y formularios.
  Temas claro y oscuro; estados vacío, carga, error y solo lectura; navegación,
  Escape, diálogos y altura reducida.
- Mediciones posteriores a las correcciones en Inicio, Proyectos, Lista,
  Favoritos y Equipo: `scrollWidth` no supera `clientWidth` del contenido.
  Informe: `test-results/mobile-reflow-final.json`.
- Comprobación real de formularios: fechas de proyecto con 33 píxeles de padding
  izquierdo y altura 44; campos financieros con icono, 38 de padding; estimación
  de tarea con altura 44 y fuente 16. Corregidos los conflictos de cascada que
  anulaban estos estilos.
- Contraste calculado de tokens de texto: mínimo 4,69:1 en las superficies
  revisadas. Corregidos texto de botón destructivo en oscuro, contador de filtros
  y pulgar del switch financiero. Este cálculo no sustituye una evaluación
  exhaustiva del contraste renderizado de todos los estados.

## Ensayos reproducibles sin datos reales

Con Vite en `127.0.0.1:5175`, los archivos ignorados de `test-results` renderizan
componentes de producción con APIs exclusivamente en memoria:

- `/test-results/mobile-audit.html`: Workspace, tamaños, estados, temas y altura.
- `/test-results/visual-mobile-finance.html`: cuentas, tarjeta DOP/USD,
  movimientos, plan, errores y bóveda opcional.
- `/test-results/mobile-planning-audit.html`: calendario, Timeline y configuración.
- `/test-results/mobile-forms-audit.html`: detalle, tarea, proyecto, comentarios,
  bandeja, acceso y recuperación.

Los ensayos y capturas no se incluyen en la aplicación publicada. No se usan
credenciales ni se crean, editan o eliminan proyectos, tareas, movimientos o
cuentas reales. La publicación se realiza mediante el repositorio existente y
se verifica contra el commit desplegado, los checks de CI y el dominio de TR8.

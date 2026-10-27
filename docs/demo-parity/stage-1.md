# Identidad visual y navegación — etapa 1

Referencia: [demo original de Gr8r Studio](https://gr8r-taskmanagement.vercel.app/).
TR8 conserva su marca, el espacio personal, los equipos, la autenticación y los
permisos reales. Esta entrega recupera la presentación de las funciones actuales.

## Entrega

- Sidebar colapsable en escritorio, con nombres accesibles y ayudas al pasar el
  cursor; navegación móvil superpuesta y selector de espacio conservados.
- Todos los proyectos activos autorizados, sin el límite visual de diez.
- Submenús desplegables de proyecto: Lista, Tablero, Calendario y Actividad,
  sujetos a las capacidades disponibles. Cada enlace conserva el espacio y
  señala la vista seleccionada. La navegación utiliza React Router.
- Actividad de proyecto en su pestaña y acceso general al historial autorizado.
  Los procesos de Configuración conservan su categoría independiente.
- Menú global «Nuevo», navegación con teclado, cierre con Escape y permisos de
  creación actuales. Desde un proyecto archivado permite elegir otro habilitado.
- Cabeceras con icono del proyecto, estados con punto semántico, prioridades con
  barras/aviso urgente y avatares con iniciales y fondo suave. Los responsables
  solo se representan cuando sus nombres ya están en el directorio autorizado.
- Selector de los 16 iconos y ocho colores originales, previsualización y
  persistencia atómica del icono junto al proyecto.
- Configuración → Apariencia: claro, oscuro o sistema; seis acentos; densidad de
  navegación y tareas; preferencia de movimiento reducido. Ajustes colapsados.
- Transiciones y hover coherentes con los tokens originales, con alternativa
  sin movimiento. Los cambios específicos anteriores de Finanzas se conservan.

## Persistencia y compatibilidad

`20261027130108_project_visual_identity.sql` añade únicamente la columna
`tr8_workspace_projects.icon`, con valor inicial `folder` y una lista cerrada de
16 identificadores. No admite HTML, SVG arbitrario ni URL. No modifica nombres,
fechas, versiones, tareas, finanzas, membresías ni configuración de altas.

El nuevo RPC `tr8_v2_create_project_with_icon` guarda todo en una transacción y
comprueba la repetición exacta de la solicitud. El RPC anterior de seis argumentos
permanece disponible para clientes existentes y MCP. La actualización conserva
sesión viva, autorización por proyecto y control de versión. El origen de datos
continúa siendo PostgreSQL; no se conecta el almacén de demostración.

Los iconos y colores se guardan en la cuenta y se leen desde cualquier dispositivo.
Las preferencias de apariencia se guardan **por cuenta y navegador**, como
preferencias de presentación locales. No se sincronizan entre dispositivos. Su
DTO versionado contiene solo preferencias visuales; no documentos, finanzas ni
credenciales. El almacenamiento corrupto, bloqueado o lleno no impide abrir TR8.
Se limpia la presentación al cambiar o cerrar la cuenta.

## Verificación

- 787 pruebas de aplicación y 560 de servidor/Edge/MCP.
- 509 aserciones SQL en TEST con rollback: identidad visual 56, espacios 176,
  colaboración 113, eliminación de proyectos 50, MCP 64 y seguridad 50.
- Los ensayos comprueban iconos válidos/inválidos, atomicidad, reintentos,
  versiones obsoletas, miembros de lectura, otra cuenta, sesiones revocadas,
  compatibilidad MCP y conservación de datos anteriores.
- Pruebas de navegación: más de diez proyectos, historial sin recarga,
  alternancia sin acumulación, permisos retirados, vistas por espacio y menú de
  creación desde un proyecto archivado.
- TypeScript, ESLint, Prettier, comprobaciones SQL estáticas y compilación.
- Revisión visual en navegador con proyectos ficticios aislados: escritorio,
  sidebar compacto, tema claro, acento, persistencia al recargar y formulario de
  proyecto. Se comprobó móvil a 390 × 844 y el menú móvil después de compactar
  el escritorio. La prueba visual no escribe en cuentas de producción.

La publicación aplica primero la migración compatible y después la interfaz.
La verificación de producción compara hashes de proyectos, tareas y documentos
financieros y confirma que las invitaciones externas siguen desactivadas. No se
crean servicios de pago ni se modifican los planes Free/Hobby.

## Alcance posterior

Inbox, Favoritos, notificaciones internas, tabla avanzada, Timeline, archivos y
las demás ampliaciones del inventario pertenecen a las siguientes etapas. Esta
entrega no incorpora enlaces que aparenten ofrecer esas funciones sin backend.
La búsqueda global y la reconstrucción de los paneles de resumen también quedan
para sus entregas correspondientes.

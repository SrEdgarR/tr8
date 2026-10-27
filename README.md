# TR8

Aplicación de proyectos y tareas con espacio personal y equipos, construida con React, TypeScript y Supabase. Conserva los colores, la tipografía, la navegación y los componentes visuales del prototipo original de [Gr8r Studio](https://github.com/gr8rstudio/gr8r-studio).

La marca es **TR8** y el identificador de proyectos y plataformas es `tr8`.
`tr8.studio` es el dominio previsto para una compra futura.

**Aplicación publicada:** [tr8.vercel.app](https://tr8.vercel.app/).

![TR8](docs/preview.png)

## Funciones de TR8

- Cuenta confirmada con Supabase Auth: inicio/cierre de sesión y recuperación de contraseña. El registro público está cerrado.
- Espacio personal privado, varios equipos, selector de espacio y directorio mínimo de miembros.
- Roles personalizados por equipo, varios roles por miembro y administración delegada dentro de sus permisos actuales.
- Proyectos privados con acceso explícito de lectura o escritura y controles de interfaz por capacidad efectiva.
- Proyectos: crear, editar, archivar, restaurar y eliminar con confirmación por nombre exacto y permiso propio. La eliminación incluye sus tareas y actividad; los demás proyectos quedan fuera de la operación.
- Tareas: crear, editar, eliminar, completar y cambiar de estado; descripción, prioridad, fechas y un responsable opcional. Asignar y editar son permisos separados.
- Lista y tablero sobre los mismos datos, con búsqueda y filtros. El tablero permite arrastrar tareas entre estados; el selector ofrece una alternativa con teclado.
- Calendario general y por proyecto, mes y agenda, filtros, vencimientos de día completo y bloques horarios independientes. Zona IANA detectada al primer acceso, búsqueda por país o ciudad con hora en directo, edición posterior en Configuración y reprogramación con versión esperada. Transiciones y foco accesible con movimiento reducido.
- Procesos internos durables: registro transaccional de cambios, reservas, reintentos, presupuesto compartido y consulta de procesos propios en Configuración. Un trabajo «Preparado» confirma su revisión interna; no una entrega externa.
- Conexión Google opcional por usuario, con Calendar y Tasks en una sola configuración. Calendar recibe eventos desde TR8 en un calendario secundario; Google Tasks sincroniza en ambos sentidos títulos, día planificado, finalización y eliminación de las tareas vinculadas. El envío de nuevas tareas de TR8 se activa por usuario y lista, sin exportar de golpe el historial.
- Inicio con resumen y próximos vencimientos. Los datos se guardan en Postgres y se recuperan al volver a entrar.
- Acceso por identidad habilitada, membresía, permisos y proyecto, aplicado en Postgres mediante RLS y RPC verificadas. La caché está separada por usuario y espacio.
- Actividad de equipos y proyectos, filtrada por el acceso vigente. Retirar un miembro o su acceso conserva el trabajo y elimina responsabilidades que dejen de ser válidas.
- [Conector MCP para agentes](docs/mcp/README.md): proyectos, tareas y calendario mediante Streamable HTTP o un adaptador stdio para clientes como Claude Desktop y Cursor. Claves revocables por espacio, lectura o escritura y caducidad; sin acceso a Finanzas ni administración de miembros.

Las altas e invitaciones externas permanecen desactivadas, por decisión del propietario, hasta disponer de correo y provisión de cuentas adecuados. Se pueden administrar miembros existentes y preparar roles y proyectos. El correo opcional de etapa 4B sigue pendiente de proveedor y remitente verificado. Se mantienen Supabase Free y Vercel Hobby. Pulso dispone de un contrato y prototipo de compatibilidad con datos sintéticos; las finanzas reales aún no están habilitadas.

## Especificación y evolución

La [recuperación visual de la demo, etapa 1](docs/demo-parity/stage-1.md) incorpora
iconos de proyecto persistentes, sidebar colapsable y submenús, estados y avatares,
menú de creación y preferencias de apariencia por cuenta en este navegador.
Conserva los datos, permisos y planes actuales.

La [etapa 2 de recuperación de la demo](docs/demo-parity/stage-2.md) reconstruye
Inicio, Vista general y los resúmenes de proyecto y equipo con datos autorizados,
sin migraciones ni servicios adicionales.

Google está autorizado en producción. La [etapa 5](docs/stage-5/README.md) documenta Calendar y su publicación inicial; la [ampliación Google Tasks](docs/stage-6/README.md) y el [envío de tareas nuevas](docs/stage-6/outbound-tasks.md) registran el contrato y las verificaciones posteriores. Se comprobaron creación, cambios, finalización y eliminación con tareas de prueba, conservando las demás tareas. Los eventos de Calendar mantienen la dirección TR8 → Google; no se importan eventos de Google en esta versión.

La integración utiliza el proyecto Google Cloud `tr8-sredgar`. El entorno Supabase de prueba mantiene Google desactivado, sin credenciales activas del cliente OAuth. En producción las integraciones comparten el presupuesto de solicitudes y tratan por separado los conflictos y los resultados remotos ambiguos; pedir una sincronización no significa que el proveedor ya la haya confirmado.

La [compatibilidad Pulso 6A](docs/pulso-6a/README.md) añade el formato opaco, AAD y vectores sintéticos, además de un simulador de sesión, CAS, recibos y ciclo de vida. La [etapa 6B.1](docs/pulso-6b1/README.md) implementa el backend opaco en PostgreSQL y una Edge Function para ensayos alojados con identidades sintéticas. La [etapa 6B.2](docs/pulso-6b2/README.md) incorpora Argon2id WASM, cifrado en un Worker, contraseña privada, custodia, recuperación y renovación de claves. La [etapa 6B.3](docs/pulso-6b3/README.md) adapta el dominio financiero, proyecciones, respaldos cifrados e importación explícita a un contexto nuevo, con validación dentro del Worker. La [etapa 6B.4](docs/pulso-6b4/README.md) añade la interfaz financiera personal; el acceso financiero real permanece cerrado. La [etapa 6B.5](docs/pulso-6b5/README.md) incorpora el banco SQLite, el servicio sintético en Cloudflare y la [coordinación con PostgreSQL y restauración lógica alojada](docs/pulso-6b5/postgres-rehearsal.md). El [ADR de restauración](docs/pulso-6b1/restore-authority.md) sigue abierto: estos ensayos no autorizan activar datos financieros reales.

El [corte 6B.5D](docs/pulso-6b5/control-hardening.md) verificó head, identidad y recuperación en el entorno aislado. La [entrega productiva de Finanzas](docs/finance-release/README.md) conecta la bóveda personal con Supabase, Cloudflare y un testigo privado en Vercel Blob, y documenta la admisión, las pruebas y sus límites. Conserva los planes gratuitos y las altas externas cerradas.

La [eliminación de proyectos](docs/project-deletion.md) conserva los permisos y datos ajenos al proyecto elegido. `project.delete` se concede por separado del archivado; escribir el nombre en el diálogo no elimina el proyecto hasta confirmar expresamente.

La [especificación técnica y el plan por etapas](docs/stage-0/README.md) documentan
la evolución acordada hacia espacios personales, equipos, roles, calendarios,
avisos opcionales y Pulso privado. La etapa 0 prepara contratos y condiciones
de verificación. La [entrega de etapa 1](docs/stage-1/README.md) registra la transición a espacios; la [etapa 2](docs/stage-2/README.md) describe colaboración y permisos; la [etapa 3](docs/stage-3/README.md) documenta el calendario interno y sus comprobaciones, y la [etapa 4](docs/stage-4/README.md) define los procesos durables y la puerta pendiente para correo. El [presupuesto gratuito](docs/stage-0/free-tier-budget.md) identifica
las dependencias externas antes de activar correo, Google o finanzas.

## Desarrollo local

Requiere Node.js **22.12 o posterior** y npm. Usa un solo gestor de paquetes; `package-lock.json` es el archivo de bloqueo del proyecto.

```bash
npm ci
cp .env.example .env.local
```

En PowerShell, el segundo comando puede escribirse como `Copy-Item .env.example .env.local`. Completa las variables de `.env.local` con la URL y la clave **publishable** del proyecto de Supabase. Este archivo está ignorado por Git. Las variables `VITE_*` llegan al navegador: nunca pongas allí una clave `service_role`, `sb_secret_*` ni una contraseña. `VITE_OWNER_EMAIL` ya no es necesaria ni autoriza acceso.

```bash
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Abre [la aplicación local](http://127.0.0.1:5173/). Si falta la configuración, la aplicación muestra una pantalla de configuración pendiente; no sustituye los datos por ejemplos.

```bash
npm run typecheck
npm test
npm run test:database:static
npm run lint
npm run format:check
npm run build          # genera dist/
npm run preview       # sirve la compilación local
```

## Preparar Supabase

El entorno de este entregable usa el proyecto `tr8` de la organización **Horizon Studios**. Para instalarlo en otro proyecto:

1. Aplica las dos migraciones históricas iniciales mediante Supabase CLI o una conexión administrativa. Antes de la migración de etapa 1, provisiona y confirma la cuenta inicial mediante Supabase Auth, sin insertar contraseñas reales con SQL. Mantén el registro público cerrado.
2. Configura el propietario inicial desde una conexión de confianza, con su correo en minúsculas:

   ```sql
   update tr8_private.app_config
   set owner_email = 'tu-correo@example.com'
   where singleton;
   ```

3. Aplica las migraciones de etapa 1 en orden. El bootstrap solo habilita la cuenta confirmada de la configuración histórica; después la autoridad es `tr8_private.app_users`, no una coincidencia de correo ni metadatos editables. Un inicio de sesión no habilita por sí solo una cuenta nueva.
4. En **Authentication → URL Configuration**, usa `http://127.0.0.1:5173` como Site URL y autoriza las redirecciones exactas de inicio y recuperación descritas en [docs/database.md](docs/database.md).
5. Aplica la migración de etapa 2, que añade responsables y operaciones de colaboración conservando el contrato v2. Mantén activa la confirmación de correo y desactivados los registros e invitaciones externas. Consulta [la operación actual](docs/stage-2/README.md) antes de habilitar colaboradores.
6. Aplica la migración de etapa 3 para habilitar las consultas de calendario y la programación. Los bloques y la zona personal empiezan vacíos; consulta [el contrato de fechas](docs/stage-3/README.md) antes de importar o programar datos.
7. Aplica la migración de etapa 4A después de ensayar su restauración en una base aislada. Instala `pg_cron`, registra cambios nuevos y programa el trabajador SQL y mantenimiento internos. Mantén correo, Google y altas externas apagados; consulta [presupuesto y operación](docs/stage-4/README.md) antes de añadir adaptadores externos.
8. Para Google sigue los contratos de [Calendar](docs/stage-5/README.md), [Tasks](docs/stage-6/README.md) y [envío de tareas nuevas](docs/stage-6/outbound-tasks.md), aplica sus migraciones en orden y despliega sus funciones. Configura el cliente OAuth y secretos de servidor en el entorno elegido, y solicita el consentimiento del usuario. En esta instalación Google se aceptó directamente en producción; en la base de prueba permanece desactivado. La compatibilidad de Pulso 6A no requiere instalación ni activa finanzas.

El esquema comienza con acceso denegado hasta habilitar una identidad de confianza. No expongas el esquema privado a la Data API. El proyecto `tr8` está publicado en Vercel dentro de **Horizon Studios**, conectado a `SrEdgarR/tr8` y su rama `main`. Producción y pruebas usan bases de Supabase separadas. `vercel.json` contiene las reglas de la SPA y sus cabeceras de seguridad.

Supabase usa `https://tr8.vercel.app` como Site URL y permite las redirecciones exactas `https://tr8.vercel.app/` y `https://tr8.vercel.app/?auth=recovery`. Las URLs locales se conservan para desarrollo. Cada dispositivo inicia sesión con la misma cuenta y lee los mismos datos. Para mayor volumen de correos hace falta configurar un servicio SMTP adecuado.

## Cómo funciona

```text
Interfaz React → React Query → repositorio → Supabase Auth / Data API
                                                  ↓
                                      Postgres + RLS + funciones SQL
```

`App.tsx` comprueba la sesión, obtiene los espacios autorizados y carga únicamente los proyectos y tareas visibles del espacio seleccionado. React Query conserva una caché en memoria separada por usuario y espacio, vuelve a consultar al recuperar el foco y cada 30 segundos, y retira los datos al salir, cambiar de espacio o recibir una denegación. Los enlaces internos identifican el espacio y conservan su interfaz al navegar; solo los enlaces antiguos sin espacio usan una consulta adicional sujeta a RLS. Cada página de proyecto sustituye por completo a la anterior al cambiar de proyecto, incluidos su lista, tablero y actividad. El navegador conserva la sesión de Auth para volver a entrar; no usa el antiguo almacén de datos de demostración.

Los formularios llaman al repositorio. Una escritura solo se considera guardada cuando Supabase devuelve el registro persistido. Un UUID estable evita duplicar un alta al reintentar tras un fallo de red. Las modificaciones incluyen la versión leída: si otra pestaña ya cambió el registro, el servidor rechaza la escritura antigua y la interfaz conserva el formulario para revisarlo. El archivado bloquea nuevas tareas y cambios hasta restaurar el proyecto.

La base de datos valida identidad, acceso al espacio/proyecto, relación proyecto/tarea, estados, prioridades y fechas. Los códigos, números de tarea, versiones y marcas de tiempo se gestionan en el servidor. Las escrituras directas están denegadas; las RPC `tr8_v2_*` verifican permisos y versión. Las consultas de capacidades y directorios están paginadas; los roles no abren un proyecto privado por sí solos. Consulta [el contrato actual](docs/stage-2/README.md) y [el registro histórico](docs/database.md).

## Estructura

```text
src/app/
  main.tsx              entrada React y proveedores
  App.tsx               sesión, consultas y escrituras
  auth/                 formularios y recuperación de contraseña
  workspace/            inicio, proyectos, tareas, lista y tablero
  finance/compatibility/ contrato Pulso y simulador sintético, sin ruta de aplicación
  finance/crypto/        cifrado y medios privados compatibles con Pulso v1
  finance/worker/        claves y snapshot dentro de un Worker dedicado
  finance/session/       custodia, confirmación, bloqueo y ciclo de vida
  finance/domain/        dinero entero, cuentas, movimientos, planes y proyección
  finance/import/        respaldos cifrados, preview, importación y restauración
  finance/ui/            cuentas, movimientos, planes y seguridad; ruta personal
  data/                 cliente, configuración, repositorio y tipos de Supabase
  types.ts              modelo de dominio
  constants.ts          estados, prioridades y presentación de fechas
  test/                 preparación de las pruebas de interfaz
src/styles/             sistema visual original reutilizado
supabase/migrations/    esquema y permisos versionados
  supabase/tests/         comprobaciones SQL con rollback
docs/database.md        acceso, funciones y verificación
```

El código JavaScript del prototipo permanece en las demás carpetas de `src/` como referencia de la migración. `index.html` carga únicamente `src/app/main.tsx`; el antiguo router, los listeners y los datos de demostración no se ejecutan.

La integración continua ejecuta TypeScript, pruebas, ESLint, formato y compilación. Las pruebas SQL requieren una conexión de administración a una base de pruebas: crean usuarios ficticios dentro de una transacción y revierten sus cambios. No usan contraseñas reales.

Finanzas está activa en el espacio personal. El [contrato productivo actual](docs/finance-release/README.md)
describe el acceso con la cuenta, sin contraseña privada adicional por defecto,
y la bóveda cifrada opcional e independiente. Los roles de equipos no conceden
acceso financiero y los documentos no se guardan en React Query. La
[etapa 6B.4](docs/pulso-6b4/README.md) conserva el registro histórico del ensayo.

## Auditoría de seguridad

El [informe del 26 de octubre de 2026](docs/security/2026-10-26-audit.md) recoge
las reproducciones, correcciones y pruebas de seguridad de la aplicación y MCP,
incluidos los límites que siguen vigentes en el plan gratuito. El acceso del
navegador comprueba sesiones vivas; las conexiones MCP conservan su caducidad y
revocación propias. Las altas externas permanecen desactivadas.

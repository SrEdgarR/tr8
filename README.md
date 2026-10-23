# TR8

Aplicación de proyectos y tareas con espacio personal y equipos, construida con React, TypeScript y Supabase. Conserva los colores, la tipografía, la navegación y los componentes visuales del prototipo original de [Gr8r Studio](https://github.com/gr8rstudio/gr8r-studio).

La marca es **TR8** y el identificador de proyectos y plataformas es `tr8`.
`tr8.studio` es el dominio previsto para una compra futura.

**Aplicación publicada:** [tr8.vercel.app](https://tr8.vercel.app/).

![TR8](docs/preview.png)

## Funciones actuales · Etapa 4A

- Cuenta confirmada con Supabase Auth: inicio/cierre de sesión y recuperación de contraseña. El registro público está cerrado.
- Espacio personal privado, varios equipos, selector de espacio y directorio mínimo de miembros.
- Roles personalizados por equipo, varios roles por miembro y administración delegada dentro de sus permisos actuales.
- Proyectos privados con acceso explícito de lectura o escritura y controles de interfaz por capacidad efectiva.
- Proyectos: crear, editar, archivar y restaurar.
- Tareas: crear, editar, eliminar, completar y cambiar de estado; descripción, prioridad, fechas y un responsable opcional. Asignar y editar son permisos separados.
- Lista y tablero sobre los mismos datos, con búsqueda y filtros. El tablero permite arrastrar tareas entre estados; el selector ofrece una alternativa con teclado.
- Calendario general y por proyecto, mes y agenda, filtros, vencimientos de día completo y bloques horarios independientes. Zona IANA detectada al primer acceso, búsqueda por país o ciudad con hora en directo, edición posterior en Configuración y reprogramación con versión esperada. Transiciones y foco accesible con movimiento reducido.
- Procesos internos durables: registro transaccional de cambios, reservas, reintentos, presupuesto compartido y consulta de procesos propios en Configuración. Un trabajo «Preparado» confirma su revisión interna; no una entrega externa.
- Inicio con resumen y próximos vencimientos. Los datos se guardan en Postgres y se recuperan al volver a entrar.
- Acceso por identidad habilitada, membresía, permisos y proyecto, aplicado en Postgres mediante RLS y RPC verificadas. La caché está separada por usuario y espacio.
- Actividad de equipos y proyectos, filtrada por el acceso vigente. Retirar un miembro o su acceso conserva el trabajo y elimina responsabilidades que dejen de ser válidas.

Las altas e invitaciones externas permanecen desactivadas, por decisión del propietario, hasta disponer de correo y provisión de cuentas adecuados. Se pueden administrar miembros existentes y preparar roles y proyectos. El correo opcional de etapa 4B sigue pendiente de proveedor y remitente verificado; Google y Pulso son etapas posteriores. Se mantienen Supabase Free y Vercel Hobby. La etapa 4A está implementada y su migración instalada en prueba y producción; sus garantías y verificaciones se registran en [la documentación de entrega](docs/stage-4/README.md).

## Especificación y evolución

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

El esquema comienza con acceso denegado hasta habilitar una identidad de confianza. No expongas el esquema privado a la Data API. El proyecto `tr8` está publicado en Vercel dentro de **Horizon Studios**, conectado a `SrEdgarR/tr8` y su rama `main`. Producción y pruebas usan bases de Supabase separadas. `vercel.json` contiene las reglas de la SPA y sus cabeceras de seguridad.

Supabase usa `https://tr8.vercel.app` como Site URL y permite las redirecciones exactas `https://tr8.vercel.app/` y `https://tr8.vercel.app/?auth=recovery`. Las URLs locales se conservan para desarrollo. Cada dispositivo inicia sesión con la misma cuenta y lee los mismos datos. Para mayor volumen de correos hace falta configurar un servicio SMTP adecuado.

## Cómo funciona

```text
Interfaz React → React Query → repositorio → Supabase Auth / Data API
                                                  ↓
                                      Postgres + RLS + funciones SQL
```

`App.tsx` comprueba la sesión, obtiene los espacios autorizados y carga únicamente los proyectos y tareas visibles del espacio seleccionado. React Query conserva una caché en memoria separada por usuario y espacio, vuelve a consultar al recuperar el foco y cada 30 segundos, y retira los datos al salir, cambiar de espacio o recibir una denegación. El navegador conserva la sesión de Auth para volver a entrar; no usa el antiguo almacén de datos de demostración. Los enlaces existentes a proyectos resuelven su espacio mediante una consulta sujeta a RLS.

Los formularios llaman al repositorio. Una escritura solo se considera guardada cuando Supabase devuelve el registro persistido. Un UUID estable evita duplicar un alta al reintentar tras un fallo de red. Las modificaciones incluyen la versión leída: si otra pestaña ya cambió el registro, el servidor rechaza la escritura antigua y la interfaz conserva el formulario para revisarlo. El archivado bloquea nuevas tareas y cambios hasta restaurar el proyecto.

La base de datos valida identidad, acceso al espacio/proyecto, relación proyecto/tarea, estados, prioridades y fechas. Los códigos, números de tarea, versiones y marcas de tiempo se gestionan en el servidor. Las escrituras directas están denegadas; las RPC `tr8_v2_*` verifican permisos y versión. Las consultas de capacidades y directorios están paginadas; los roles no abren un proyecto privado por sí solos. Consulta [el contrato actual](docs/stage-2/README.md) y [el registro histórico](docs/database.md).

## Estructura

```text
src/app/
  main.tsx              entrada React y proveedores
  App.tsx               sesión, consultas y escrituras
  auth/                 formularios y recuperación de contraseña
  workspace/            inicio, proyectos, tareas, lista y tablero
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

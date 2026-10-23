# Etapa 4 · Procesos durables

Estado: **4A implementada y verificada**, con la migración instalada en prueba y producción. Ensayo de restauración, aplicación, SQL, HTTP, cron y concurrencia aprobados. Esta versión incluye la interfaz para su publicación en Vercel; cada despliegue exige confirmar su SHA y estado `READY`. La etapa **4B de correo sigue pendiente** de proveedor y remitente verificado.

## Alcance

Esta entrega prepara los cambios de proyectos, tareas y permisos en segundo plano, aunque el navegador esté cerrado. Añade un registro transaccional de cambios, trabajos persistentes, reservas temporales, reintentos, límites de procesamiento y una vista de estado. No envía correos ni crea eventos en Google Calendar.

En **Configuración → Procesos e integraciones** cada usuario consulta sus procesos del espacio seleccionado y con acceso vigente. Se muestran hasta 20 registros recientes, sus estados y su propio consumo; los límites son compartidos por la aplicación. «Preparado» confirma una comprobación interna, sin afirmar una entrega externa. Un error de autorización oculta la información anterior.

El editor de zona horaria también se encuentra en **Configuración**. Al abrir el calendario por primera vez se conserva la detección automática; una vez guardada la zona, desaparece la tarjeta del calendario. Una preferencia previa siempre se respeta. El calendario añade transiciones de días, tareas y controles, con estados de foco por teclado y respeto de `prefers-reduced-motion`.

Se mantienen Supabase Free y Vercel Hobby, los proyectos de prueba y producción existentes y las altas e invitaciones externas desactivadas. No se instala un proveedor de correo, OAuth, servicio de colas de pago ni dependencia nueva de aplicación.

## Flujo y garantías actuales

1. Los triggers registran metadatos mínimos y crean el trabajo en la misma transacción de la escritura original. Si esa transacción se revierte, también se revierten el evento y el trabajo. No se generan eventos retroactivos por los datos anteriores a la migración.
2. La clave única por espacio, tipo, entidad, fecha de creación de la entidad (`entity_created_at`) y versión evita duplicar un mismo cambio. La fecha identifica la instancia del recurso: eliminarlo y recrearlo con el mismo UUID no confunde su historial con el anterior. La eliminación conserva una referencia mínima que permite comprobar que el recurso ya no existe.
3. El trabajador SQL interno de `pg_cron` consulta lotes acotados y reserva trabajos mediante una concesión de 60 segundos, token único y bloqueo que omite filas ocupadas. Solo una reserva vigente de una entidad puede procesarse a la vez.
4. Antes de reservar y finalizar se comprueban la revisión vigente de permisos, la identidad habilitada del actor cuando existe y la instancia, versión o eliminación del recurso. Los cambios superados o invalidados se cancelan sin procesar la revisión antigua.
5. La finalización exige el token exacto y no vencido. El trabajo interno actual no realiza solicitudes de red: una interrupción revierte su transacción, y el cambio durable sigue disponible para una ejecución posterior.

La infraestructura contempla resultados transitorios, definitivos y desconocidos. Un resultado desconocido queda para revisión; no se reintenta a ciegas. Un adaptador externo futuro deberá confirmar su resultado e idempotencia antes de usar estas operaciones. Esta etapa no promete una única entrega de correo ni sincronización externa.

## Presupuesto y retención

| Control                        | Valor actual                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Intentos reservados por día    | 500 compartidos, día UTC                                                                                                              |
| Intentos reservados por mes    | 10.000 compartidos, mes UTC                                                                                                           |
| Lote de trabajo                | Hasta 20 reservas                                                                                                                     |
| Intentos por trabajo           | Hasta 8                                                                                                                               |
| Reserva                        | 60 segundos, con token nuevo al recuperar una vencida                                                                                 |
| Reintento transitorio          | Espera exponencial desde 30 segundos, variación aleatoria y tope de 6 horas; respeta una espera superior solicitada dentro del límite |
| Ejecución automática           | Trabajador interno cada minuto; mantenimiento diario                                                                                  |
| Trabajo confirmado o cancelado | Eliminable tras 30 días, hasta 500 por mantenimiento                                                                                  |
| Recibos de intentos            | Eliminables tras 32 días, hasta 1.000 por mantenimiento                                                                               |
| Historial de cron de TR8       | Eliminable tras 7 días, hasta 1.000 por mantenimiento                                                                                 |

Las consultas vacías no consumen intentos. Al agotarse el presupuesto, los trabajos continúan guardados y los proyectos y tareas pueden seguir modificándose; el procesamiento se retoma al renovarse la cuota. Estos límites controlan la actividad de TR8, no sustituyen los límites de almacenamiento o uso del proveedor ni provocan una actualización automática a un plan de pago.

Los trabajos pendientes, reservados, en reintento, desconocidos o fallidos de forma definitiva no se eliminan por esa política de retención. Requieren seguimiento para evitar acumulación. El mantenimiento acotado no borra la actividad de negocio de equipos o proyectos.

## Datos y acceso

Las tablas privadas nuevas son `process_outbox`, `process_jobs`, `process_runtime` y `process_attempts`. Almacenan identificadores, revisiones, estados, tiempos y motivos limitados a un catálogo, además del token interno temporal de cada reserva. No copian títulos, descripciones, direcciones de destinatarios, contenido financiero, contraseñas, sesiones, tokens de Auth ni credenciales de proveedores. Los resultados de cron son contadores internos; no se incluyen cargas de negocio en sus logs.

Los clientes no tienen escritura ni lectura directa de estas tablas. Las funciones de productor, reserva, finalización y mantenimiento usan `search_path` fijo y no son ejecutables con los roles `anon`, `authenticated` o `service_role`. El trabajador se ejecuta dentro de Postgres; no existe una ruta HTTP pública de trabajador ni un secreto compartido en el navegador.

El único contrato público nuevo es:

```text
tr8_v2_get_process_status(p_workspace_id uuid default null)
```

El wrapper público es `SECURITY INVOKER`; la función privada valida al actor, su espacio y sus permisos actuales. Devuelve canales apagados, estado del programador, presupuesto, conteos propios y hasta 20 trabajos del actor con acceso vigente. No devuelve tokens de reserva, destinatarios, contenido de tareas ni procesos de otro miembro. Si se omite el espacio se usa el espacio personal del actor. La interfaz vuelve a consultar cada 30 segundos y permite actualizar manualmente.

## Migración y recuperación

La migración aditiva `20261023184152_durable_processes_stage4a.sql` conserva las tablas de proyectos y tareas, sus OIDs, campos, responsables, bloques horarios, versiones, tiempos y secuencia. Conserva también las definiciones y permisos de las RPC anteriores y la configuración de altas. La instalación empieza con la cola vacía: no cambia tareas ni reconstruye un historial de trabajos a partir de ellas.

Antes de instalar en producción se exige una copia privada nueva de formato `tr8-stage4-backup-v1` y el ensayo generado por `scripts/stage4/build-restore-rehearsal.mjs`. El script exige los tres campos de bloque horario y las preferencias de calendario de etapa 3, restaura los metadatos privados y las identidades mínimas de referencia en el entorno sintético designado, compara cada campo antes y después de la migración y termina con `ROLLBACK`.

La secuencia exportada se comprueba en una secuencia **temporal**; no se rebobina la secuencia real de prueba. El script rechaza un entorno que ya contenga las identidades respaldadas y exige el marcador del entorno sintético. La copia y el SQL generado contienen datos privados, se guardan fuera de Git y no deben ejecutarse en producción como una prueba.

Las identidades mínimas de Auth permiten ensayar referencias; no contienen contraseñas, sesiones ni tokens y no constituyen una restauración completa de Auth o PITR. La vuelta al cliente anterior sigue siendo compatible con el esquema ampliado. Ante un problema del trabajador se pueden pausar exclusivamente sus entradas de cron desde una conexión administrativa; no se eliminan datos ni se reescriben migraciones aplicadas. Restaurar una copia después de nuevas escrituras exige reconciliarlas.

## Puerta de 4B · Correo opcional

No está habilitado ningún envío ni selector que prometa activarlo. Falta seleccionar un proveedor y verificar un remitente. También deben comprobarse límites gratuitos, secretos del servidor, entrega real en prueba, tratamiento de duplicados y fallos ambiguos, y recuperación después de revocar permisos.

Una vez resueltas esas dependencias, se implementarán las preferencias acordadas: apagadas por defecto, opt-in por usuario, proyecto y tipo de aviso; asignaciones, cambios de fechas y cierre o archivo de proyectos; envío inmediato o resumen diario. Cada destinatario se volverá a autorizar antes de enviar. Los correos de acceso y recuperación de Supabase Auth siguen su configuración separada.

La ausencia de proveedor no bloquea el calendario ni los procesos internos de 4A. No se cambian planes ni se habilitan cuentas externas como parte de esta entrega. Google Calendar y Pulso conservan sus etapas y condiciones de avance propias.

## Verificación de cierre

Comprobaciones confirmadas el 2026-10-23:

- **221 pruebas de aplicación** aprobadas.
- **532 comprobaciones SQL** aprobadas: 116 de procesos, 2 de aislamiento transaccional y 176, 113 y 125 de regresión de las etapas 1, 2 y 3, respectivamente.
- **232 comprobaciones HTTP en 101 solicitudes** aprobadas contra el entorno real de prueba, con identidades sintéticas.
- Ensayo final de restauración y preservación aprobado, con comparación de los campos históricos de etapa 3 y `ROLLBACK`.
- Migración instalada en **prueba y producción**, historial reconciliado con la versión canónica y tipos de Supabase regenerados a partir del esquema de prueba.
- Reserva persistida entre transacciones, recuperación tras vencimiento simulado, rechazo del token antiguo y rechazo de finalización duplicada aprobados.
- Trabajo sintético completado por `pg_cron` con un intento, resultado `reconciled` y ejecución correlacionada, sin llamada manual al trabajador ni dependencia del navegador.
- Dos conexiones concurrentes, con un único cupo disponible, obtuvieron una y cero reservas. Se conservó el segundo trabajo pendiente. Cron y contadores del entorno de prueba quedaron restaurados.
- Tipos, ESLint, Prettier, build y comprobación estática de nombres aprobados. El build conserva el aviso de tamaño de chunks; no impide compilar ni publicar.
- Navegador real contra prueba: zona cambiada desde Configuración, reflejada en calendario sin editor y restaurada; panel de procesos consultó la RPC real sin errores. Configuración y calendario comprobados a 390 × 844 y en escritorio, sin desbordamiento horizontal ni errores de consola. Foco por teclado visible de 2 px y reglas cargadas de movimiento reducido comprobados; los estados de espera, denegación y error también están cubiertos por las pruebas de interfaz.
- Producción: comparación exacta de proyectos, tareas, los doce metadatos privados anteriores, identidades mínimas y secuencia antes y después. Se conservaron un proyecto, una tarea y una cuenta habilitada; altas externas apagadas y cola inicial vacía. Supabase permanece en Free y no se cambiaron recursos ni planes de Vercel.

Las auditorías posteriores no añadieron advertencias de seguridad o rendimiento. Las tablas privadas con RLS sin políticas son intencionales: el cliente no tiene acceso directo. Se mantiene la advertencia previa de [protección contra contraseñas filtradas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection), función del plan de pago; no se activó ni se modificó el plan.

La evidencia privada conserva respaldo y comparación, resultados HTTP, fases de recuperación, carrera de presupuesto y recibos de cron fuera de Git. El recibo de publicación debe asociar el commit exacto, el despliegue `READY`, la comprobación del alias de producción y las capturas del navegador; no se considera una vista previa con la base de prueba como publicación de producción.

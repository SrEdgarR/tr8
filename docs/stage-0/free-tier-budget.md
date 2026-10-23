# Presupuesto gratuito y dependencias externas

Fecha de consulta: 2026-10-23. Estado: presupuesto de diseño, no medición de carga ni certificación de una cuenta de facturación. No se contrató servicio, cambió plan ni habilitó extensión.

## Cuotas publicadas verificadas

| Recurso                     | Referencia publicada                                          | Consecuencia para TR8                                                                    |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Base de datos Supabase Free | 500 MB por proyecto                                           | Datos, índices, auditoría, colas y recibos comparten espacio; medir antes de crecer      |
| Salida Supabase Free        | 5 GB incluidos; cached egress tiene otra cuota                | No contar ambas cuotas como una bolsa libremente intercambiable                          |
| Auth                        | 50.000 usuarios activos mensuales incluidos                   | No es el primer cuello de botella del escenario pequeño; SMTP tiene límites propios      |
| Edge Functions              | 500.000 invocaciones incluidas                                | Medir reintentos, OAuth, despachos y operaciones financieras, no solo envíos exitosos    |
| Runtime Edge Free           | 150 s de duración, 2 s CPU por petición, 256 MB               | Lotes pequeños; ninguna KDF financiera en servidor                                       |
| SMTP de Auth predeterminado | Destinatarios de la organización; actualmente 2 mensajes/hora | No sirve de base para invitar/confirmar colaboradores externos                           |
| Custom SMTP de Auth         | Disponible en Free                                            | El proveedor, remitente y cuota deben configurarse aparte                                |
| Copias automáticas de BD    | No incluidas en Free                                          | Diseñar exportación y restauración verificadas; no afirmar respaldo automático existente |
| Inactividad Free            | Puede pausarse tras 7 días de poca actividad                  | Calendario externo y correo pueden detenerse; no se promete SLA                          |
| Vercel Hobby Cron           | Como máximo una ejecución diaria por job; precisión horaria   | No usarlo para avisos frecuentes ni multiplicar jobs para eludir la restricción          |
| Uso Hobby                   | Personal y no comercial                                       | Verificar elegibilidad del uso real antes de abrir equipos comerciales                   |

Fuentes: [Supabase pricing](https://supabase.com/pricing), [Edge limits](https://supabase.com/docs/guides/functions/limits), [Auth SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [pausas](https://supabase.com/docs/guides/platform/free-project-pausing), [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Vercel Cron](https://vercel.com/docs/cron-jobs/usage-and-pricing). Revalidar antes de activar cada servicio. Las cuotas de Auth de plataforma no limitan por sí solas el número de miembros de un equipo de TR8.

## Escenario de dimensionamiento, no límites funcionales aprobados

Escenario inicial de prueba: 10 usuarios activos, dos equipos, 50 proyectos, 5.000 tareas y 200 cambios diarios. Son supuestos para generar fixtures y medir, no restricciones de producto ni capacidad ya demostrada.

| Medida interna propuesta | Objetivo inicial                                                        | Cómo comprobarlo                                                       |
| ------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| BD total                 | Menos de 150 MB                                                         | Medir tablas, índices, historial de cron, colas y recibos              |
| Salida mensual           | Menos de 2 GB                                                           | Dashboard de proveedor y estimación de respuestas por módulo           |
| Invocaciones Edge        | Menos de 10.000/mes                                                     | Contadores agregados y métricas, incluyendo reintentos                 |
| Correos opcionales       | Tope inicial de 500/mes y 25/día, además de la cuota real del proveedor | Control de admisión de avisos y reserva para mensajes de autenticación |
| Lote de trabajos         | Hasta 20 operaciones por invocación, máximo un trabajador inicial       | Ensayo CPU/memoria/latencia; reducir el lote si se acerca al límite    |

La cuota de un proveedor de correo puede ser compartida con Auth y otros proyectos. Un contador de avisos de TR8 no controla por sí solo los mensajes de Auth: revisar ambos consumos y los límites nativos del proveedor.

Propuesta de avisos de consumo: revisar al 50 %, reducir actividad opcional al 75 % y bloquear nuevas activaciones/efectos opcionales al 90 % del presupuesto real más restrictivo. No borrar finanzas, auditorías de seguridad o comprobantes durables para ahorrar espacio. Los límites y su implementación se ensayan; no se afirma que exista hoy un bloqueo automático de costes.

## Planificador concreto propuesto

- Cron ejecuta una consulta breve de trabajos vencidos cada minuto; solo despierta Edge cuando hay trabajo elegible. Un trabajo adicional controla limpieza de metadatos operativos y agregados.
- La outbox es durable. `pg_net` solo despierta al trabajador; sus tablas no registradas no son la fuente de verdad.
- Evitar invocar Edge cada minuto vacío: hacerlo 31 días consumiría 44.640 invocaciones sin producir trabajo. El cálculo es aritmético, no una medición de uso.
- En el escenario de 200 cambios/día, una invocación por cambio produciría unas 6.000/mes de 30 días, antes de reintentos/OAuth/resúmenes. El batching reduce esta cifra; el presupuesto de 10.000 necesita validación con carga.
- El historial de ejecuciones del cron también ocupa BD. Retener una ventana técnica corta y agregados, separada de auditoría de negocio y de recibos de idempotencia.
- No se programa actividad ficticia para impedir pausas. Los cron son procesos de negocio, y no garantizan que el proyecto nunca se pause.

La lectura de metadatos del proyecto confirmó que `pg_cron` y `pg_net` están disponibles pero no instalados. Su instalación, secretos, permisos, funcionamiento en Free y límites de ejecución se comprueban en un entorno de prueba en la etapa correspondiente; disponibilidad no significa activación o ensayo exitoso.

## Tráfico de la bóveda

Las instantáneas completas hacen que el tráfico dependa del tamaño y las lecturas. Ejemplo conservador: 10 usuarios × 10 lecturas/día × 30 días × 2 MiB por sobre ≈ 5,86 GiB, antes de otros recursos. Ese escenario no cabe en una cuota de 5 GB aunque el número de usuarios sea pequeño.

Por ello: carga al desbloquear y cuando se requiera conciliar; sin polling de bóvedas completas cada 30 segundos, sin repetir respuestas grandes tras cada navegación y sin refetch financiero en segundo plano. Evitar escrituras redundantes conservando la promesa de guardado durable. Parches cifrados o cambios del formato no se introducen como optimización implícita: requieren otro diseño.

## Registro de dependencias y puertas

| ID     | Dependencia                         | Evidencia actual                                                                            | Etapa afectada / condición                                                                                      |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| EXT-01 | Entorno aislado de pruebas          | No aprovisionado por etapa 0                                                                | Antes de migraciones: entorno local o proyecto Free disponible; sin usar producción como fixture                |
| EXT-02 | Correo de autenticación a externos  | Solo se verificó la limitación documental; SMTP personalizado de la cuenta no inspeccionado | Antes de incorporar colaboradores reales: proveedor/remitente válido y prueba de verificación/recuperación      |
| EXT-03 | Proveedor de avisos                 | Ninguno seleccionado o contratado                                                           | Antes de correo real: API HTTPS, cuota gratuita, dominio/remitente y duplicados definidos                       |
| EXT-04 | Remitente y dominio                 | `tr8.studio` no comprado                                                                    | Un dominio propio puede tener coste de compra; no se supone incluido en Free ni se compra en esta etapa         |
| EXT-05 | Proyecto OAuth de Google            | No configurado ni auditado aquí                                                             | Antes de usuarios reales: consentimiento, redirecciones, scopes, estado de publicación y verificación aplicable |
| EXT-06 | Cron y trabajador                   | Extensiones disponibles, no habilitadas                                                     | Antes de autonomía: prueba de jobs vencidos, autenticación de trabajador y recuperación tras caída              |
| EXT-07 | Elegibilidad de hosting             | Proyecto publicado existente; condiciones Hobby consultadas                                 | Antes de uso comercial o cambio de alcance: resolver elegibilidad; no activar Pro como sustitución automática   |
| EXT-08 | Operación y restauración financiera | Pulso tiene publicación pendiente; TR8 no integra bóveda                                    | Antes de finanzas reales: pruebas de dispositivo, recuperación, sesiones, restauración y publicación            |

EXT-02 puede bloquear la apertura de colaboración real aunque EXT-03 siga apagada. No exige invitar colaboradores como administradores de Supabase. Los equipos de TR8 son entidades de la aplicación, no equipos del proveedor de infraestructura.

Si una dependencia no cabe en coste cero, se mantiene su funcionalidad desactivada y se preservan las entregas independientes; no se habilita un plan de pago, una prueba temporal ni gasto automático.

# Plan de implementación y verificación

Estado inicial: solo etapa 0 autorizada en esta entrega. Las etapas siguientes describen trabajo futuro; no hay migraciones, nuevos usuarios, OAuth, correo ni finanzas activados.

## Entregas y condiciones de avance

| Etapa                     | Entrega concreta                                                                                                         | Condición de cierre                                                                                                           | Dependencias externas                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 0 · Contratos             | Decisiones D01–D18 trazables, arquitectura, modelos, matriz de acceso, migración, calendarios, jobs, Pulso y presupuesto | Revisión cruzada sin contradicciones críticas, enlaces y formato comprobados; pendientes identificados con etapa afectada     | Documentación oficial, metadatos de solo lectura                                   |
| 1 · Espacios e identidad  | Espacio personal preservado, equipos, membresías, invitaciones y acceso inicial mínimo                                   | Migración ensayada preserva datos y versiones; usuarios de prueba no cruzan espacios; aceptación idempotente de invitación    | EXT-01; EXT-02 antes de incorporar usuarios externos reales                        |
| 2 · Colaboración y roles  | Acceso por proyecto, responsable opcional, roles personalizados acumulativos, administración delegada y auditoría        | Matriz adversarial y carreras de permisos pasan; sin DML directo que evite versión/auditoría                                  | Entorno de prueba aislado                                                          |
| 3 · Calendario interno    | Consultas por ventana, calendario general y por proyecto, vencimientos y bloques horarios                                | Fechas sin desplazamiento, cambios de horario válidos, filtros y permisos consistentes en móvil y escritorio                  | Sin Google ni proveedor de correo                                                  |
| 4A · Procesos             | Outbox durable, jobs, leases, reintentos, presupuesto y estado visible                                                   | Caída después del commit no pierde trabajo; revocaciones/revisiones se aplican; trabajador no accesible con clave pública     | EXT-06                                                                             |
| 4B · Correo opcional      | Preferencias apagadas, avisos seleccionados y resumen diario                                                             | Envíos solo a destinatarios autorizados/opt-in; duplicados y fallos ambiguos tratados; prueba real del proveedor              | EXT-03/04; no bloquea 4A ni calendario                                             |
| 5 · Google Calendar       | Conexión por usuario, calendario TR8, correspondencias y ciclo de vida                                                   | OAuth/reconexión, modificación, finalización, reasignación, revocación y desconexión comprobados                              | EXT-05, 4A                                                                         |
| 6A · Compatibilidad Pulso | Contrato de autenticación/criptografía y adaptador prototipo con fixtures                                                | ADR financiero cerrado, formatos/claves/AAD conservados o importación explícita revisada; sesiones/recibos/fences demostrados | Etapas 1–2 estables; sin datos financieros reales                                  |
| 6B · Pulso privado        | Bóveda personal, cuentas, operaciones, proyección y respaldos en TR8                                                     | Recuperación/importación/restauración/contabilidad pasan; sin finanzas en servidor, logs, colas, correo o Google              | EXT-08 y pruebas del presupuesto; ver puerta financiera                            |
| 7 · Publicación integrada | Flujos reales autorizados, operación, accesibilidad, móvil y recuperación                                                | Evidencia reproducible y ensayo de reversión/recuperación; ningún riesgo crítico abierto ni garantía pública no probada       | Cada proveedor habilitado supera su puerta; módulos pendientes permanecen apagados |

Orden principal: 0 → 1 → 2 → 3 → 4A → 4B → 5. La preparación 6A puede desarrollarse después de 1–2 sin esperar correo o Google; su publicación 6B conserva sus propias puertas. No se inicia otra etapa por el mero cierre documental de esta entrega.

## Cortes pequeños sugeridos

- 1A: ampliación compatible de esquema y bootstrap personal en prueba; 1B: backfill verificado; 1C: nuevo repositorio/consulta acotada; 1D: corte de políticas y bundle compatible. Los detalles de bloqueo y reversión están en [migración](migration-and-acceptance.md).
- 2A: catálogo/roles básicos y proyectos privados; 2B: asignaciones y actividad; 2C: edición de roles con delegación protegida; 2D: carreras de revocación y revisión de acceso.
- 3A: fechas/contrato de horarios; 3B: lectura por ventana; 3C: vistas y filtros; 3D: reprogramación con versión y accesibilidad.
- 4A: productor transaccional antes que trabajador; después leases/reintentos y estado visible. 4B: proveedor en pruebas antes de permitir opt-in de usuarios reales.
- 5: autorización y revocación antes de sincronización inicial; después reconciliación, marcado «Hecha» y eliminación selectiva.
- 6A/B: caracterizar comportamiento actual antes de adaptar identidad; fixture criptográfica antes de persistencia; recuperación y restauración antes de importar un respaldo real.

## Verificación proporcional por entrega

1. Conservar evidencia del SHA/base, cambios, pruebas y límites. No usar resultados de otra versión como prueba de código nuevo.
2. Ejecutar tipos, lint, formato, pruebas relevantes y build al cambiar aplicación. Validar tipos generados después de la migración, sin editar migraciones aplicadas.
3. Probar RLS/RPC con identidades sintéticas, permisos reales de BD y conexiones simultáneas. Los mocks de interfaz no acreditan aislamiento ni transacciones.
4. Probar navegador móvil/escritorio, teclado, foco, estados de espera/error/conflicto y movimiento reducido en los componentes cambiados.
5. Probar integraciones con recursos aislados del usuario de prueba y limpiar solo esos recursos. Distinguir simulación de proveedor, prueba HTTP y entrega real.
6. Ensayar copia y restauración antes de tocar datos reales. La vuelta a un bundle anterior no equivale a poder revertir políticas o reponer datos antiguos sin reconciliar.

Las pruebas del paso 2–6 son requisitos futuros, no ejecutadas en etapa 0. Para documentación bastan revisión de contenido, formato y resolución de enlaces; no se agregan tests que repitan el texto ni se ejecutan fixtures sobre producción.

## Exclusiones de esta planificación

Sin invitados externos a proyectos, colaboración de texto tipo documento, permisos con reglas ejecutables, finanzas compartidas, banca conectada, conversión de divisas, eventos Google → TR8, correos por cada edición, archivos adjuntos, trabajo financiero offline, compras de dominio ni planes de pago.

## Registro de etapa 0

- Línea base y decisiones: [índice](README.md).
- Disponibilidad y condiciones externas: [presupuesto](free-tier-budget.md).
- Etapa 0 completada el 2026-10-23 como documentación, sin iniciar etapa 1.
- Revisión cruzada e independiente de los nueve documentos: sin hallazgos críticos/importantes pendientes. Corregidas las plantillas exactas/default de invitación y la desasignación atómica ante pérdida de permisos por roles, con revisión/tiempos y limpieza de calendario.
- Formato: Prettier comprobó el README raíz y los nueve Markdown de esta carpeta. `git diff --check` pasó.
- Enlaces locales: 37 referencias con destino existente y capitalización exacta; trazabilidad D01–D18 completa. Se inventariaron 55 enlaces web, sin afirmar una prueba exhaustiva de todos sus destinos o anclas.
- Alcance de cambios comprobado: README y documentación nueva únicamente. Sin código, migraciones, dependencias, fixtures, commits, push o despliegue.
- Comprobaciones remotas de solo lectura: documentación oficial, fuente de Pulso fijada a commit, lista de metadatos de proyectos y disponibilidad de extensiones. No se consultaron filas personales ni se activaron cron, funciones, secretos o proveedores.
- No se ejecutaron suites de aplicación o SQL: el cambio es documental y no publica. Los resultados históricos del primer entregable no se presentan como validación de las funciones futuras.
- No se afirma que las etapas 1–7 estén implementadas, probadas o autorizadas para despliegue.

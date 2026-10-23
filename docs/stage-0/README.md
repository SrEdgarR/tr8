# TR8 · Etapa 0 · Contratos técnicos

Fecha: 2026-10-23, America/La_Paz. Alcance: documentación y comprobaciones de solo lectura. Esta entrega no implementa funciones, no aplica migraciones, no habilita proveedores y no despliega.

## Lectura y autoridad

1. Este índice conserva las decisiones funcionales acordadas con el propietario.
2. [Arquitectura](architecture.md) fija las fronteras y las decisiones técnicas de esta entrega.
3. [Datos y acceso](data-and-access.md) define entidades, permisos y operaciones.
4. [Operaciones y errores](api-contract.md) fija la superficie pública y las funciones de servidor.
5. [Migración y aceptación](migration-and-acceptance.md) define conservación de datos y comprobaciones adversariales.
6. [Calendario y avisos](calendar-and-notifications.md) define fechas, trabajos, correo y Google.
7. [Adaptación de Pulso](pulso-adaptation.md) identifica compatibilidad, cambios de confianza y puertas financieras.
8. [Presupuesto gratuito](free-tier-budget.md) separa cuotas verificadas, objetivos internos y dependencias pendientes.
9. [Plan de implementación](implementation-plan.md) define entregas, condiciones de avance y exclusiones.

Las decisiones funcionales siguientes están acordadas. Los detalles técnicos de estos documentos son el diseño propuesto para implementarlas, no evidencia de implementación ni de aprobación de una publicación. Las dependencias externas pendientes no impiden diseñar o probar localmente las etapas independientes.

## Decisiones funcionales trazables

| ID  | Decisión acordada                                                                           | Contrato principal  |
| --- | ------------------------------------------------------------------------------------------- | ------------------- |
| D01 | Un espacio personal privado y varios equipos                                                | Datos y acceso      |
| D02 | Proyectos de equipo privados por defecto; acceso configurable                               | Datos y acceso      |
| D03 | Roles personalizados por equipo y acceso por proyecto                                       | Datos y acceso      |
| D04 | Propietario ve todos los proyectos de su equipo; administradores necesitan acceso explícito | Datos y acceso      |
| D05 | Solo miembros del equipo colaboran; sin invitados externos a proyectos                      | Datos y acceso      |
| D06 | Una persona responsable opcional por tarea                                                  | Datos y acceso      |
| D07 | Varios roles por miembro; permisos acumulativos                                             | Datos y acceso      |
| D08 | Calendario general filtrable y vista por proyecto                                           | Calendario y avisos |
| D09 | Vencimiento opcional y bloque horario opcional, independientes                              | Calendario y avisos |
| D10 | Sincronización TR8 → Google, no bidireccional                                               | Calendario y avisos |
| D11 | Google recibe tareas personales y asignadas al usuario en equipos, con fecha u horario      | Calendario y avisos |
| D12 | Calendario secundario TR8 propio de cada usuario                                            | Calendario y avisos |
| D13 | Avisos de asignación, cambios de fechas y cierre/archivo de proyectos                       | Calendario y avisos |
| D14 | Correo desactivado inicialmente; elección de proyectos y tipos de aviso                     | Calendario y avisos |
| D15 | Entrega inmediata o resumen diario, por usuario                                             | Calendario y avisos |
| D16 | Pulso solo para finanzas personales privadas; sin finanzas compartidas                      | Adaptación de Pulso |
| D17 | Completar conserva el evento con «Hecha»; borrar/perder acceso intenta retirarlo            | Calendario y avisos |
| D18 | Desconectar Google permite conservar o retirar los eventos propios antes de revocar acceso  | Calendario y avisos |

También se conservan la marca **TR8**, el slug **tr8**, el diseño actual y el objetivo de coste recurrente cero. `tr8.studio` no se considera comprado ni configurado.

## Línea base observada

- TR8: rama local `main`, limpia al iniciar, commit `89959e572298b0361f385ffdd7348f06ac1693e2`.
- Aplicación existente: React/Vite, Supabase Auth y dos tablas personales con RPC, RLS y allowlist de un propietario. [Contrato vigente](../database.md), [tipos](../../src/app/types.ts), [repositorio](../../src/app/data/repository.ts).
- La lectura actual descarga páginas de proyectos y tareas y refresca periódicamente. Debe sustituirse por consultas acotadas antes de ampliar usuarios; no constituye un modelo de equipos.
- Las actualizaciones comprueban versión en RPC, pero los grants existentes permiten DML directo limitado. La futura frontera debe cerrar ese bypass antes de depender de versiones, auditoría o outbox obligatorias.
- Supabase `tr8`, ref `ggbjezprlsnhidlbjivl`: estado `ACTIVE_HEALTHY`, Postgres `17.11.0.003`, según lectura de metadatos. Sin leer filas de proyectos, tareas o finanzas.
- Metadatos de extensiones: `pg_cron` 1.6.4 y `pg_net` 0.20.4 disponibles pero sin instalar; `supabase_vault` 0.3.1 y `pgcrypto` 1.3 instaladas. No se activó ninguna extensión.
- Pulso: [main observado](https://github.com/SrEdgarR/PULSO/commit/b764bc55d08626c2ca57c131aaf76c0996356972), merge de P6. Su documentación conserva algunos estados anteriores; se contrasta con código/merge. Su publicación final P7 no se presume superada.

`docs/database.md` continúa describiendo la aplicación personal publicada. Estos contratos describen el destino y no sustituyen ese estado actual hasta las futuras migraciones.

## Estado de cierre documental

Etapa 0 completada como entrega documental el 2026-10-23. La revisión cruzada e
independiente terminó sin hallazgos críticos/importantes pendientes. Se fijaron
las plantillas iniciales de permisos y la desasignación atómica cuando un cambio
de autorización vuelve inelegible al responsable. Los resultados y las
dependencias se registran en [el plan](implementation-plan.md).

El cierre no habilita las etapas siguientes ni elimina sus puertas de pruebas,
remitente, OAuth, alojamiento o publicación financiera. Ningún resultado
documental debe presentarse como una prueba ejecutada de RLS, concurrencia,
OAuth, correo, recuperación o criptografía.

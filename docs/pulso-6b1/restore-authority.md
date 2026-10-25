# ADR F02 · Restauración financiera y autoridad independiente

Estado: decisión de cierre seguro aceptada para el corte sintético 6B.1.
**La autoridad externa de restauración continúa sin resolver.** No se habilitan
finanzas con datos reales hasta cerrar esta puerta dentro de 6B.

Actualización 2026-10-25: los cortes [6B.5B](../pulso-6b5/hosted-test.md),
[C](../pulso-6b5/postgres-rehearsal.md) y [D](../pulso-6b5/control-hardening.md)
ya prueban un proveedor externo y controles de head, identidad y recuperación.
Los apartados originales describen la decisión de cierre de 6B.1; la continuidad
de la propia autoridad y la integración productiva siguen pendientes. No se
interpreta la firma de un checkpoint manual como garantía de actualidad.

## Problema

Las transacciones activas pueden impedir que PUT, revocación y reset compitan de
forma incoherente sobre la base actual. Eso no permite detectar que toda esa
base ha sido sustituida por un snapshot antiguo. El snapshot puede contener
simultáneamente una bóveda activa, sus recibos, sesiones y configuración previos
a una retirada o purga posterior.

Si retiros, watermark y permiso de servicio se recuperan exclusivamente desde
esa misma copia, sus valores también retroceden. Consultarlos con RLS, CAS o un
JWT firmado no revela ese retroceso. Un recibo histórico tampoco acredita que
un contexto siga autorizado hoy. La restauración puede revivir acceso aunque
el ciphertext conserve íntegra su autenticación criptográfica.

## Decisión

La admisión de **datos financieros reales permanece desactivada**. El backend
6B.1 solo admite ensayos explícitos en el proyecto TEST literal con allowlist
sintética. El esquema nace deshabilitado y en cuarentena. Su flag de cuarentena
es una condición de admisión operativa; no se presenta como protección
independiente frente al rollback de su propia base.

Ante una restauración conocida se cierra el acceso financiero y se mantiene la
cuarentena. La liberación futura requerirá evidencia confiable, completa y
actualizada de retiros, revocaciones y purgas ocurridos después del snapshot.
Si no existe esa evidencia o no puede verificarse, el servicio permanece cerrado.
Un operador no debe abrirlo solo porque los datos restaurados sean coherentes
entre sí o porque el login funcione.

La autoridad que permita esa decisión deberá estar fuera del mismo dominio de
rollback que la base restaurada. Aún no se ha elegido, instalado ni probado un
proveedor o mecanismo que satisfaga esa condición dentro del presupuesto Free.
El corte no promete que exista un servicio gratuito disponible para resolverlo.

## Requisitos para resolver la puerta

El diseño posterior deberá especificar y probar:

1. **Autoridad y orden.** Quién emite y conserva el estado vigente; identidad,
   autenticidad, integridad y orden de las retiradas/revocaciones/purgas. Un
   watermark permite detectar un hueco, pero no reconstruye por sí solo los
   eventos faltantes.
2. **Durabilidad independiente.** Cómo evitar que restaurar o perder la base
   financiera revierta también esa autoridad. Una segunda tabla o una firma
   guardada solo dentro del mismo snapshot no cambia esa dependencia.
3. **Punto de confirmación.** Cuándo una operación de lifecycle está confirmada
   frente a ambas autoridades y qué ocurre ante fallos parciales, respuestas
   perdidas, duplicados o reordenación. No prometer atomicidad entre sistemas
   sin demostrar el protocolo de recuperación.
4. **Arranque y cuarentena.** Cómo detectar una restauración o un estado no
   conciliado antes de admitir tráfico, mantener cerrado el servicio y comprobar
   la cobertura del replay. La ausencia de una alerta no prueba que no hubo
   rollback.
5. **Reconciliación.** Cómo aplicar eventos posteriores al snapshot sin reabrir
   contextos retirados ni devolver datos purgados. Un recibo de una operación
   antigua se evalúa después de la autoridad de lifecycle vigente.
6. **Operación y recuperación.** Custodia de credenciales, separación de
   permisos, recuperación de la propia autoridad, límites, retención mínima,
   fallos del proveedor y coste verificable. Los requisitos jurídicos de
   retención siguen pendientes; este ADR no inventa plazos legales.

La verificación debe restaurar deliberadamente un snapshot anterior a un reset,
una revocación y una purga en un entorno aislado. Debe probar retry exacto,
recibos anteriores y tentativa desde otra identidad, además de autoridad
ausente, incompleta, no verificable o fuera de servicio. Todos esos estados
insuficientes mantienen el cierre; solo una reconciliación completa permite
evaluar la reapertura.

## Opciones que no cierran esta puerta

- Un backup manual de PostgreSQL es útil para recuperación de disponibilidad,
  pero también puede restaurar permisos y retiros antiguos. No acredita por sí
  solo el estado de autorización posterior.
- Un respaldo cifrado descargado por el usuario permite conservar datos y
  ensayar importación. No es una autoridad global de revocaciones y no justifica
  restaurar el contexto retirado con sus IDs/epochs originales.
- CAS, hashes de request, recibos, RLS y filas de retiro protegen el estado
  transaccional que se está consultando. No detectan automáticamente que ese
  estado completo retrocedió.
- Mantener un flag en la base, usar su fecha más reciente o confiar en el reloj
  del cliente no constituye una autoridad independiente.

Un almacenamiento adicional, registro externo o procedimiento operado solo
podrá aceptarse después de demostrar los requisitos anteriores. Este documento
no selecciona uno ni atribuye garantías a un proveedor no instalado.

## Consecuencias del corte

Se puede ensayar el backend privado y sus transacciones con datos ficticios sin
declarar resuelta la restauración alojada. Los resultados sintéticos de 6B.1 no
autorizan activar finanzas personales reales, importar Pulso real ni presentar
una garantía anti-revival en producción.

Si no se encuentra una solución viable en el presupuesto gratuito, las finanzas
reales se aplazan o se replantea su arquitectura con una decisión explícita. No
se elimina esta condición para completar una fecha o para aprovechar una UI
terminada. La aceptación general continúa en [6B.1](README.md),
[6A](../pulso-6a/README.md) y [la adaptación original](../stage-0/pulso-adaptation.md).

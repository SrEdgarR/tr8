# Pulso 6B.3 · Dominio financiero e importación cifrada

Esta entrega continúa el [motor de bóveda 6B.2](../pulso-6b2/README.md) con el
dominio puro de Pulso, validación financiera dentro del Worker y flujos explícitos
de respaldo, importación y restauración. La pantalla financiera pertenece a
6B.4. No se importa ningún respaldo del propietario ni se habilitan finanzas con
datos reales.

Se conservan React/TypeScript, Supabase Free, Vercel Hobby y las altas externas
desactivadas. No se añaden dependencias, proveedores, migraciones, integraciones
bancarias ni operaciones financieras en correo, Google o equipos. Los proyectos
y tareas siguen utilizando su repositorio actual, separado de la bóveda.

## Modelo adaptado

La fuente permanece fijada en [Pulso
`b764bc55d08626c2ca57c131aaf76c0996356972`](https://github.com/SrEdgarR/PULSO/tree/b764bc55d08626c2ca57c131aaf76c0996356972/lib/financial-domain).
Los inventarios y cambios se registran en los avisos de procedencia del
[dominio](../../src/app/finance/domain/NOTICE.md) y la
[importación](../../src/app/finance/import/NOTICE.md).

| Concepto    | Regla                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dinero      | Enteros seguros en unidades menores; cálculos internos con BigInt y rechazo del desbordamiento                                                             |
| Monedas     | Catálogo exacto versionado; DOP, USD, EUR y BOB, con dos dígitos menores; sin conversión o total combinado implícitos                                      |
| Cuentas     | Efectivo, débito y crédito; saldo inicial y fecha; deuda, crédito a favor y capacidad disponible separados                                                 |
| Movimientos | Ingresos, gastos, transferencias, pagos de tarjeta y reembolsos con referencias válidas                                                                    |
| Planes      | Pendientes, cancelados o confirmados; un pendiente no cambia el saldo real, aunque venza su fecha                                                          |
| Proyección  | Incluye planes futuros del horizonte elegido, separada del ledger real; no confirma ni guarda movimientos                                                  |
| Versiones   | Snapshots financieros actuales v2/v3/v4; v4 añade planes. El histórico v1 se abre únicamente con su validador específico y se actualiza de forma explícita |

Las fechas financieras son días de calendario, sin conversión automática por
zona horaria. Transferencias y pagos no generan ingresos o gastos nuevos. Los
reembolsos deben referirse a un gasto permitido y respetar sus importes y fechas.
Las validaciones incluyen referencias, IDs duplicados, registros cerrados y
rangos monetarios por día y moneda; que un exceso se compense después no lo hace
válido.

Se conserva el límite de 1 MiB de plaintext y de 2 MiB de sobre/respaldo. Se
rechazan campos desconocidos, getters, prototipos ajenos, JSON ambiguo, Unicode
inválido, números no enteros, `-0` y colecciones dispersas. No se reparan ni se
truncan datos inválidos durante una importación.

## Perfil financiero del Worker

[`financial.worker.ts`](../../src/app/finance/worker/financial.worker.ts) instala
[`financialVaultPolicy`](../../src/app/finance/worker/financial-policy.ts). Valida
el dominio antes de crear o cifrar una escritura y después de descifrar, incluso
en rotaciones y recuperación. Un sobre con criptografía correcta y datos
financieros inválidos no se activa.

El perfil genérico de 6B.2 conserva sus vectores y ensayos de protocolo; no
sustituye la validación de finanzas ni ofrece importación. El
[`FinancialVaultSessionController`](../../src/app/finance/session/financial-controller.ts)
selecciona el Worker financiero por defecto. Sus reemplazos de Worker y autoridad
son dependencias de confianza para ensayos, nunca opciones elegibles por usuarios.

## Importación explícita

1. Se lee un respaldo `pulso-encrypted-backup`, versión 1, cerrado y acotado. En
   el hilo principal solo se valida y canonicaliza el formato opaco; un archivo
   con espacios de hasta 2 MiB no infla el mensaje al Worker ni amplía su límite.
2. El controlador consulta el destino mediante `readOpaque(identity)`, ligado a
   identidad, sesión y generación vigentes. Exige un head vacío y el mismo epoch.
3. El Worker abre el respaldo con el medio privado antiguo y el contexto
   original, valida el dominio y descarta la referencia a la clave fuente. El
   snapshot descifrado permanece en el Worker hasta aceptar o cancelar.
4. Devuelve solo un resumen acotado y un ID aleatorio de preview: versiones,
   necesidad de actualización, número de cuentas/movimientos/planes y monedas.
   No devuelve nombres, movimientos, claves ni plaintext del respaldo.
5. Aceptar ese ID exacto vuelve a consultar el destino vacío. El Worker realiza
   la actualización explícita a v4 y crea una nueva VDK, `vaultId`, contraseña y
   recovery. Los IDs financieros e importes se conservan; los wraps, epochs y
   contexto criptográfico del origen no se copian.
6. La custodia exige reentrada completa de ambos medios nuevos. Solo después se
   prepara el PUT con `expectedRevision=0` y se activa tras un ACK coincidente.
   El backend verifica Auth, sesión, login reciente y CAS: una lectura vacía no
   reserva el destino ni autoriza por sí sola la escritura.

No se vinculan identidades por email ni se toman booleans de autenticación del
archivo o del cliente. El respaldo original permanece intacto. Otro destino,
sesión, preview antiguo o resultado tardío no puede activar el nuevo contexto.
Mientras exista preview, las demás rutas de lectura/escritura/exportación están
bloqueadas. Cancelar, logout y los límites de ciclo de vida terminan el Worker y
descartan el origen en memoria.

## Respaldo y restauración del mismo contexto

Exportar devuelve únicamente el sobre confirmado del contexto abierto, nunca
el borrador pendiente ni claves. Restaurar exige abrir un respaldo válido del
mismo propietario y `vaultId`, previsualizarlo y aceptar su ID exacto. Recupera
solo datos: conserva VDK, wraps y epochs vigentes, genera una nueva revisión,
nonce, salt e ID de operación y espera CAS/ACK. No retrocede la autoridad del
servidor ni mezcla dos bóvedas.

Una contraseña o clave antigua todavía puede abrir una copia antigua que ya se
conserve. La restauración de datos no revoca esas copias ni resuelve el problema
de restaurar toda la base de datos.

## Rendimiento y comprobación

La proyección heredada recalculaba y validaba el ledger entero por cada fecha.
Se sustituyó por normalización inicial y un recorrido ordenado por fechas, sin
omitir puntos ni añadir límites nuevos. Las pruebas comparan resultados y
rechazos con la implementación anterior en cuentas de crédito, reembolsos,
transferencias, operaciones futuras y múltiples horizontes.

```bash
npm test -- src/app/finance
npm run typecheck:finance:test
npm run build:finance:test
npm run build:finance:domain:test
npm run serve:finance:domain:test
```

El último comando sirve el ensayo en `http://127.0.0.1:5188/`, con datos ficticios
y sin incluirlo en el `dist/` publicado. El servidor de ensayo compartido admite
un archivo privado de fixtures TEST y `--finance-6b3` para verificar el recorrido
alojado. No contiene credenciales de producción ni puede habilitar el servicio.
Consulta [la evidencia y sus límites](acceptance.md).

## Puerta para datos reales

No se ha habilitado una ruta financiera en `App`, ni cambiado la cuenta del
propietario. El backend continúa limitado al proyecto TEST literal y vuelve a
su estado cerrado tras cada ensayo. La
[autoridad independiente de restauración](../pulso-6b1/restore-authority.md)
sigue pendiente. La bandera de cuarentena de la misma base no la sustituye.

Antes de admitir datos reales faltan la interfaz 6B.4, su integración con los
callbacks de identidad/transporte/reautenticación de confianza, revisión de la
seguridad web, comprobación en dispositivos reales y resolver esa autoridad
dentro del presupuesto gratuito. Los ensayos no constituyen una auditoría externa
ni garantizan borrado verificable de memoria JavaScript.

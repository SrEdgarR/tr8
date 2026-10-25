# Verificación de 6B.3

Esta entrega se verifica con fixtures públicos y ficticios, nunca con un respaldo
o una contraseña privada del propietario. Las pruebas de dominio incluyen dinero
entero, monedas versionadas, crédito a favor y deuda, límites diarios, referencias,
reembolsos, planes, JSON estricto y 1 MiB exacto. La importación ejecuta Argon2id,
Web Crypto y validación del origen, contexto nuevo, custodia y restauración.

Resultados del 25 de octubre de 2026:

| Comprobación                                           | Resultado                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| Suite completa de la aplicación                        | 633 pruebas aprobadas en 35 archivos                             |
| Edge Functions                                         | 370 pruebas aprobadas en 8 archivos                              |
| Dominio, dentro de la suite                            | 59 pruebas, incluida comparación de proyección con la referencia |
| Respaldo e importación, dentro de la suite             | 13 pruebas con criptografía real                                 |
| Worker financiero, dentro de la suite                  | 11 pruebas con criptografía real                                 |
| Controlador financiero, dentro de la suite             | 19 pruebas de protocolo y carreras                               |
| Regresión 6B.2 en Chromium                             | 14 escenarios y 140 comprobaciones                               |
| Ensayo 6B.3 alojado en Chromium                        | 14 escenarios y 236 comprobaciones                               |
| Empaquetado genérico / financiero                      | 112 / 114 comprobaciones                                         |
| TypeScript, ESLint, formato, static SQL y build normal | Aprobados                                                        |

El ensayo alojado realizó 138 solicitudes a Auth/Edge TEST y cuatro guardados:
importación, plan, rekey y restauración de los datos importados inicialmente.
Los cuatro SHA-256 de los cuerpos HTTP coincidieron exactamente con los recibos
persistidos en PostgreSQL. La revisión final fue 4, con `keyEpoch=2` y
`credentialEpoch=2`. El contenido se reabrió en Workers nuevos con contraseña y
recuperación; el archivo fuente se mantuvo intacto. Exportación y restauración
conservaron el contexto y los medios vigentes según su operación.

Las huellas de filas completas de proyectos y tareas coincidieron al inicio y
al cierre: producción conserva dos proyectos y dos tareas; TEST, once proyectos
y veinticinco tareas. Las invitaciones externas permanecieron desactivadas y
Auth publicó `disable_signup=true`. El ensayo cerró su sesión y retiró sus
registros financieros; allowlist, actores, sobres y recibos quedaron vacíos,
con puertas apagadas y cuarentena activa. No se aplicaron migraciones ni se
cambiaron planes o proveedores.

Los tests de controlador usan dobles de protocolo para intercalar consultas
de destino, cambios de sesión, logout, cancelación, replies tardíos, ACK perdido,
conflicto definitivo y replay de previews. Esos dobles no acreditan por sí solos
un Worker del navegador o persistencia remota.

El ensayo separado utiliza Chromium, Workers, Web Crypto y WASM reales. Su
variante alojada recorre navegador → puente local → Auth/Edge TEST → PostgreSQL,
sin entregar las credenciales de la identidad ficticia al navegador. El servidor
recibe únicamente sobres cifrados; los hashes de sus cuerpos deben coincidir
con los recibos persistidos. CORS directo mantiene la evidencia de 6B.1.

## Proyección medida

Benchmark independiente de solo lectura, Node 24/V8 en Worker, mismos fixtures
antes y después de la optimización:

| Cuentas / reales / planes | Tamaño del snapshot |                         Antes | Después |
| ------------------------- | ------------------: | ----------------------------: | ------: |
| 1 / 300 / 300             |        107197 bytes |                       2148 ms |   30 ms |
| 10 / 500 / 500            |        179641 bytes | Más de 20 s; Worker terminado |  145 ms |
| 25 / 1000 / 1000          |        361096 bytes | Más de 20 s; Worker terminado |  582 ms |

Son mediciones de esa máquina y ese runtime, no tiempos garantizados para otros
dispositivos. Las comparaciones de referencia cubren 48 horizontes y casos
adversarios; la prueba estructural evita volver a normalizar todo el ledger por
cada punto. No se elevó el límite de payload ni se descartaron fechas.

## Límites de la evidencia

Los artefactos de ensayo no forman parte de la aplicación publicada. No se
certifican todavía Safari/iOS o Android físicos, importaciones reales ni la UI
financiera. La memoria se limpia por descarte de referencias y terminación del
Worker con borrado de buffers propios cuando procede; JavaScript no ofrece
zeroización verificable de todas sus copias.

El servicio financiero real permanece desactivado. No se realiza una
restauración real de toda la base en este corte ni se afirma resuelta su autoridad
independiente. Los resultados del backend 6B.1 y el cifrado 6B.2 conservan sus
documentos separados.

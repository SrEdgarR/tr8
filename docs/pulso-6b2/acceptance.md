# Verificación de 6B.2

El ensayo usa exclusivamente contenido ficticio y el vector público de Pulso.
Verificado el 23 de octubre de 2026, con los siguientes resultados:

| Comprobación                                                           | Resultado                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------ |
| Aplicación completa                                                    | 531 pruebas aprobadas en 30 archivos             |
| Edge Functions                                                         | 370 pruebas aprobadas en 8 archivos              |
| Motor criptográfico dentro de la suite                                 | 24 pruebas con KDF y cifrado reales              |
| Worker, controlador, ciclo de vida y capacidades                       | 66 pruebas aprobadas                             |
| Empaquetado separado                                                   | 99 comprobaciones de versiones, hashes e imports |
| TypeScript, ESLint, Prettier, comprobación estática SQL y build normal | Aprobados                                        |

Las pruebas financieras de compatibilidad anteriores permanecen incluidas en
la suite. Las compilaciones normales conservan los recursos de proyectos y
tareas; no incluyen los recursos Worker/WASM ni la página de ensayo.

El navegador Chromium aprobó **15 escenarios y 153 comprobaciones** con Worker
y WASM reales. La pasada alojada realizó 117 solicitudes a Auth/Edge de TEST y
confirmó cuatro revisiones de una bóveda nueva: creación, escritura, recuperación
y rekey. Los cuatro SHA-256 de los cuerpos enviados coincidieron exactamente con
los recibos guardados en PostgreSQL. Un Worker nuevo abrió el contenido
persistido; la revisión final fue 4, con `keyEpoch=2` y `credentialEpoch=3`.
El marcador de plaintext quedó ausente del sobre almacenado. La sesión Auth
sintética se cerró y se retiraron snapshot, recibos, actor y allowlist del ensayo.

Las huellas de filas completas y los recuentos de proyectos y tareas se
mantuvieron iguales al inicio y al cierre: producción conserva sus dos proyectos
y dos tareas; TEST conserva once proyectos y veinticinco tareas. No se cambió la
configuración de Auth: `disable_signup=true` en producción e invitaciones externas
desactivadas. Las puertas financieras quedaron apagadas y en cuarentena, con
allowlist vacía. No se aplicó ninguna migración ni se amplió un plan.

## Procedencia del motor

`package-lock.json` fija la integridad npm de `libsodium-sumo@0.8.4` y
`libsodium-wrappers-sumo@0.8.4`, iguales a la fuente Pulso fijada. Sus archivos ESM
instalados coinciden con los publicados en el tag `0.8.4` de
[libsodium.js](https://github.com/jedisct1/libsodium.js/tree/0.8.4):

| Artefacto        |  Bytes | SHA-256                                                            |
| ---------------- | -----: | ------------------------------------------------------------------ |
| core ESM sumo    | 413353 | `4c94708f7e78eac7a32b29e2ce0ff96f4bd599d78c129f27bf8a061e20776c8c` |
| wrapper ESM sumo | 122029 | `40de1ef7cb8f2caae02c2a8f04809151904fa28cb9364cadedc57af89a6c9284` |

El verificador del build comprueba los hashes y la ausencia del cargador de
respaldo CJS. El ensayo de navegador fuerza un fallo de
`WebAssembly.instantiate` en un Worker nuevo y exige denegación; comprobar solo
que `WebAssembly` existe no bastaría.

## Alcance de las pruebas

Las pruebas del motor ejecutan la KDF real frente a un vector generado
independientemente mediante `node:crypto`/OpenSSL en Pulso. No inyectan su clave
esperada en el descifrado. Comprueban contraseña y código, AAD, manipulación,
contexto ajeno, Unicode, custodia completa, rotaciones, rekey, errores saneados,
CSPRNG, fallo de capacidades, JSON estricto y cifrado de 1 MiB exacto.

Las pruebas del controlador y el motor Worker usan dependencias y relojes
controlados para intercalar revocación, logout, ACKs, errores de transporte y
respuestas tardías. Esas pruebas aíslan carreras; no se presentan como un
navegador real ni como prueba de durabilidad.

El ensayo separado compila los recursos con Vite y utiliza Workers, Web Crypto
y Argon2id WASM reales en Chromium del navegador integrado. Verifica contenido
reabierto, rotaciones, recuperación, rekey, reintento de bytes exactos, límites
de sesión y ausencia de persistencia local. La variante alojada recorre
navegador → puente local sin credenciales en el navegador → Edge TEST → Auth
real → PostgreSQL → snapshot cifrado → Worker nuevo. El control CORS directo
del navegador a la Edge pertenece a las pruebas HTTP de 6B.1.

Las cabeceras CSP se verifican en el servidor del ensayo: `wasm-unsafe-eval`
está limitado a los recursos Worker, cuya red está denegada; el hilo principal
no permite `unsafe-eval`. El build normal no incorpora la página ni los recursos
de la bóveda porque no existe todavía una ruta financiera activa.

## Límites

No se usan ni modifican finanzas personales reales, ni se importa Pulso. No
se prueba todavía Safari/iOS ni Android en un dispositivo físico. Los timeouts
se intercalan con reloj controlado; el evento de BFCache simulado prueba el
binding, no certifica todos los comportamientos de suspensión de un sistema
operativo. Los tests de PostgreSQL, auth y carreras remotas de 6B.1 conservan su
evidencia separada. La autoridad independiente de restauración permanece
pendiente y los gates financieros vuelven a cerrarse tras el ensayo.

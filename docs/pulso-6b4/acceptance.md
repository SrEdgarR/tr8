# Aceptación 6B.4 · 2026-10-25

## Resultado

Interfaz financiera integrada en la ruta personal y validada con datos ficticios.
La admisión financiera real permanece desactivada por el ADR F02. No se afirma
que esta entrega resuelva restauración independiente ni autorización de finanzas
reales. Supabase Free, Vercel Hobby y altas externas cerradas se conservan.

## Verificación automatizada

- 653 pruebas de aplicación y 370 de Edge aprobadas.
- 18 pruebas nuevas de transporte, estado de React y formularios financieros;
  otras dos verifican la ruta personal y su aislamiento de equipos.
- TypeScript de app, Edge y entradas financieras; ESLint, Prettier y comprobación
  SQL estática aprobados.
- Build de app y tres entradas financieras separados. Workers en formato ES;
  el KDF se importa únicamente desde Workers, con Sodium ESM fijado y sin fallback
  CJS/asm. Verificadores de empaquetado: 112, 114 y 70 comprobaciones.

Los dobles unitarios permiten detener una respuesta en vuelo y demostrar que un
head o read tardío no revive datos tras bloqueo o cambio de sesión. Se comprueba
también ocultación, custodia, reintento de bytes idénticos, no consulta financiera
en producción y rechazo de dinero ambiguo. Las pruebas no sustituyen una auditoría
independiente de criptografía o restauración.

## Navegador y backend TEST

Sesión ficticia preexistente; Worker financiero, Argon2id y AES-GCM reales. El
puente local conserva las credenciales de fixture fuera del navegador y conecta
únicamente con el Edge TEST. Se observaron cinco PUT confirmados con HTTP 200 y
revisiones 1–5:

1. Creación y custodia completa de bóveda vacía.
2. Cuenta ficticia BOB con saldo inicial 1.250,50.
3. Gasto ficticio 25,50: saldo 1.225,00.
4. Plan ficticio 100,00 con fecha futura: saldo real sigue 1.225,00 y proyección
   1.125,00.
5. Confirmación explícita del plan: saldo real 1.125,00, dos movimientos, estado
   confirmado y sin botón que permita repetir la confirmación.

Se verificaron filtros, limpieza visible al bloquear y reapertura tras recargar
desde el sobre cifrado persistido. El diseño se revisó a 390 px, sin desbordamiento
horizontal de página; la navegación de pestañas conserva su desplazamiento propio.
El informe del puente registró 126 peticiones y confirmó el cierre de su sesión.
No se realizaron estas operaciones sobre el usuario real.

La evidencia visual y el informe de hashes/revisiones se conservan fuera de Git
en el directorio privado de la etapa. No se guardan contraseñas, recuperación,
tokens o contenido de bóveda en los archivos de documentación.

## Conservación y limpieza

Comparación antes/después sobre filas completas ordenadas:

| Base       | Proyectos | Tareas | Hash proyectos                     | Hash tareas                        |
| ---------- | --------: | -----: | ---------------------------------- | ---------------------------------- |
| Producción |         2 |      2 | `24d612b15fc2caf2c2c21cfe21b0d785` | `89767fcefe177918ffc25689e8bf3ed0` |
| TEST       |        11 |     25 | `76afde8ddbd23711408dc58e6968412a` | `08340c77f33696f367702a09ec53c2a5` |

Ambas bases mantienen 16 migraciones y `external_invites_enabled=false`. Después
de cerrar la sesión ficticia se eliminaron exclusivamente sus registros de
finanzas. En ambas bases quedan cero actores, bóvedas, recibos y allowlist,
`synthetic_enabled=false` y `restore_quarantined=true`. El flag del Edge TEST se
devolvió a desactivado. Producción no recibió una función financiera ni datos de
prueba.

Los ensayos de seguridad, rotación, recuperación e importación a nivel de
controlador/Worker de 6B.2/6B.3 siguen formando parte de la suite; no se presenta
su cobertura anterior como una nueva ejecución manual de todos los formularios.

# Pulso 6A · Compatibilidad antes de la bóveda

Esta entrega implementa el contrato y un adaptador experimental con datos
sintéticos. Corresponde a la etapa **6A del plan original**, distinta de la
ampliación [Google Tasks](../stage-6/README.md). No añade una sección de finanzas,
no lee Pulso ni guarda datos financieros reales. La etapa 6B permanece pendiente.

La fuente es [SrEdgarR/PULSO, commit
b764bc55d08626c2ca57c131aaf76c0996356972](https://github.com/SrEdgarR/PULSO/tree/b764bc55d08626c2ca57c131aaf76c0996356972).
La procedencia de archivos y del vector público se conserva en
[NOTICE](../../src/app/finance/compatibility/NOTICE.md). Los contratos iniciales
siguen en [la adaptación de etapa 0](../stage-0/pulso-adaptation.md).

## Entrega comprobable

| Pieza                           | Comportamiento implementado                                                                                                                    | Límite de la evidencia                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `protocol.ts`                   | Sobre v1 cerrado, UTF-8 estricto, claves JSON duplicadas rechazadas, base64url canónico, revisiones/epochs, CAS y hash de los bytes originales | Valida estructura; el servidor no conoce el contenido cifrado                             |
| `aad.ts`                        | Conserva las tuplas, orden y nombres autenticados del protocolo de Pulso                                                                       | Cambiar propietario o contexto exige volver a cifrar; no se puede renombrar el sobre      |
| Fixture público                 | Vector de AES-256-GCM/HKDF-SHA-256 del origen fijado, verificado con Web Crypto y alteraciones rechazadas                                      | No ejecuta ni acredita Argon2 WASM, custodia o recuperación real                          |
| `ExperimentalMemoryVaultServer` | Autoridad sintética inyectada, sesión vigente, prueba de login reciente, CAS, recibos, retiros, revocación/reset y cuarentena                  | Simulador en memoria de un proceso; no es Auth real, PostgreSQL ni almacenamiento durable |
| Admisión                        | Stream real de hasta 2 MiB, parseo estricto y ciphertext de hasta 1 MiB más 16 bytes de tag, sin inspeccionar plaintext                        | Falta probar el futuro endpoint bajo la infraestructura real                              |

El sobre mantiene `pulso-v1-aes256gcm-hkdfsha256-argon2id13`, AES-GCM de 256 bits,
nonce de 96 bits y tag de 128 bits. El perfil exigido es
`argon2id-64m-t3-p1-v1`: Argon2id v1.3, 64 MiB, tres pases, paralelismo uno y
salida de 32 bytes. Esta entrega **valida esos parámetros**; no incorpora todavía
el runtime Argon2. No se añade otra KDF, CDN ni dependencia de ejecución.

El adaptador recibe una identidad acreditada por una autoridad de pruebas; no
acepta propietario o prueba de autenticación desde el body. La prueba sensible
está ligada a usuario y sesión, con login permitido en los últimos cinco minutos.
Refrescar un token, recuperación, fecha futura, otra sesión o un flag de interfaz
no satisfacen ese contrato. El mapeo de las pruebas reales de Supabase se trata
en el [ADR de transporte](transport-adr.md); aún no está implementado.

Una escritura prepara su operación, permite intercalar una revocación/reset de
prueba y revalida bajo el mismo mutex que esas acciones antes de confirmar. El
recibo y el sobre se sustituyen juntos; un fallo previo no guarda ninguno. Un ACK
perdido permite repetir **los mismos bytes** con el mismo resultado. Cambiar los
bytes con el mismo ID produce conflicto. Un contexto retirado se rechaza antes
de consultar su recibo, incluso si lo intenta otra identidad.

La identidad de bytes exactos se ensaya en PUT. El comando de reset del simulador
es un objeto interno normalizado; no prueba el parseo ni la idempotencia de bytes
de un futuro endpoint de reset.

## Pruebas y conservación

Las pruebas cubren el vector cifrado, AAD, manipulaciones, límites y formatos,
dos escritores con la misma revisión, reintentos exactos, ACK perdido, rollback,
sesiones/proofs ajenos o caducados, revocación y reset entre preparación y commit,
contextos retirados, unicidad de contexto y cuarentena.

```bash
npm test -- src/app/finance/compatibility
```

Los fixtures usan identidades, medios privados y contenido ficticios públicos.
No son claves reutilizables para la aplicación. El código no está importado por
`App`, no tiene ruta HTTP ni RPC y no participa en Google, correo, actividad,
analytics o cachés de equipos. No hay migraciones, nuevas credenciales,
dependencias, planes ni servicios en esta entrega. Se mantienen Supabase Free,
Vercel Hobby y las altas externas desactivadas.

## Condiciones pendientes para 6B

El [corte 6B.1](../pulso-6b1/README.md) implementa y verifica la autoridad y
persistencia opaca con datos sintéticos en Supabase. Las siguientes condiciones
siguen siendo la puerta para habilitar finanzas reales; ese ensayo no las cierra
en conjunto.

1. Implementar la autoridad real de Supabase y su fence común con suspensión,
   revocación, reset y purga; probar carreras en conexiones PostgreSQL reales.
   El chequeo actual `v5_require_session` no acredita ese fence por sí solo.
2. Demostrar login reciente con evidencias verificadas por el servidor y ligado
   a la sesión real, incluidos refresh, recovery y expiración adversariales.
3. Empaquetar Argon2 WASM con procedencia fijada y Worker; probar vectores
   completos, capacidad/memoria, bloqueo por logout/navegación/BFCache y descarte
   de resultados tardíos. Ninguna clave o plaintext se persiste en el navegador.
4. Implementar persistencia privada y recibos atómicos; probar reinicio, rollback,
   pérdida de respuesta y aislamiento frente a administradores de equipos.
5. Validar dominio financiero, monedas y unidades menores enteras; importar
   explícitamente una copia sintética abriéndola localmente y volviendo a cifrar
   para un contexto nuevo. No vincular cuentas por coincidencia de email.
6. Probar custodia, recovery, rekey, pérdida total y baja con equipos. Resolver
   una autoridad confiable de retiros/revocaciones independiente del snapshot
   restaurado y compatible con el presupuesto gratuito. Sin ella, una copia
   antigua permanece en cuarentena y las finanzas no se habilitan.
7. Verificar el flujo alojado y los dispositivos reales, revisar seguridad web y
   criptografía, recuperación y textos antes de habilitar finanzas personales.

Los resultados del simulador cierran el ensayo de compatibilidad de 6A; no
constituyen una auditoría criptográfica ni prueban durabilidad, anti-revival o
revocación atómica en producción.

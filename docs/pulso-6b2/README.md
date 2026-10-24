# Pulso 6B.2 · Cifrado, contraseña privada y recuperación

Este corte implementa el motor de la bóveda y su controlador de sesión, con
contenido ficticio. Continúa [6A](../pulso-6a/README.md) y el
[backend opaco 6B.1](../pulso-6b1/README.md). No incorpora todavía el dominio
financiero ni su pantalla: corresponden a 6B.3 y 6B.4. El código financiero no
está importado por `App`, no añade una ruta al despliegue normal y no ha creado
una bóveda con datos del propietario.

Se conservan Supabase Free, Vercel Hobby, los proyectos y tareas existentes y
las altas e invitaciones externas desactivadas. No hay migraciones, nuevos
proveedores ni costes añadidos en este corte.

## Motor y frontera

| Pieza                                              | Función                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`crypto`](../../src/app/finance/crypto)           | Argon2id, AES-GCM, HKDF, medios privados, custodia y rotaciones; sin red ni almacenamiento                          |
| [`worker`](../../src/app/finance/worker)           | Mantiene la VDK no extraíble y el snapshot; protocolo cerrado y acotado por sesión y generación                     |
| [`session`](../../src/app/finance/session)         | Verifica identidad antes y después de cada operación asíncrona, exige custodia y ACK, termina el Worker al bloquear |
| [`ensayo de navegador`](../../scripts/finance-6b2) | Compilación separada con Worker y WASM reales, fixtures públicos y puente opcional al backend TEST                  |

La fuente fijada es [Pulso
`b764bc55d08626c2ca57c131aaf76c0996356972`](https://github.com/SrEdgarR/PULSO/tree/b764bc55d08626c2ca57c131aaf76c0996356972/lib/vault).
Se conserva el [formato y la atribución](../../src/app/finance/crypto/NOTICE.md).
La adaptación usa **un Worker dedicado por sesión**, que ejecuta Argon2 y conserva
la VDK; evita transportar claves al hilo principal. Es una diferencia de
arquitectura respecto a los dos Workers del origen, sin cambiar el sobre v1.

La clave de bóveda aleatoria de 32 bytes es independiente de la contraseña de
Supabase y de la contraseña privada. El servidor recibe el sobre cifrado y sus
metadatos autenticados; no recibe contraseña privada, código de recuperación,
VDK ni contenido descifrado. El hilo principal recibe únicamente el contenido
necesario para mostrarlo cuando el controlador permite su lectura.

## Medios privados y operaciones

- **Contraseña privada:** NFC, sin recortar espacios ni cambiar mayúsculas;
  mínimo 16 puntos de código tras normalización y máximo 1024 bytes UTF-8.
  UTF-16 mal formado se rechaza antes de normalizar.
- **KDF:** Argon2id v1.3, 64 MiB, tres pases, un carril, salida de 32 bytes y
  salt de 16 bytes. Se fijan `libsodium-sumo` y `libsodium-wrappers-sumo` en
  `0.8.4`, con integridad en `package-lock.json` y ESM local WASM. Un fallo de
  capacidad o memoria no selecciona otra KDF ni reduce sus parámetros.
- **Recuperación:** secreto aleatorio de 256 bits, base32 canónico de 52
  caracteres, presentado en 13 grupos de cuatro. Se admite entrada compacta o
  con esos guiones, sin aceptar bits de relleno no canónicos.
- **Custodia:** creación, nuevo código, recuperación y rekey exigen reintroducir
  la contraseña privada y el código completos. Ambos deben abrir y autenticar
  el mismo snapshot preparado. Un checkbox no sustituye esta prueba.
- **Confirmación:** el sobre preparado no está activo hasta recibir un recibo
  del backend con la operación y revisión coincidentes. Ante respuesta perdida,
  se conserva la operación pendiente y se retransmiten exactamente los mismos
  bytes. No se muestra el contenido pendiente como guardado.
  Un rechazo definitivo validado por el transporte, como denegación, conflicto o
  reautenticación necesaria, termina el Worker y limpia el borrador. El transporte
  debe representarlo con `DefinitiveOpaqueSaveError`; no se infiere del mensaje
  de una excepción ni de un `5xx` genérico.
- **Recuperación:** abre inicialmente en modo de solo lectura. Para volver a
  escribir se cambian ambos envoltorios, se eligen una contraseña nueva y un
  código nuevo, se confirma su custodia y se espera el ACK.
- **Rotaciones:** cambiar contraseña conserva el código; renovar código conserva
  la contraseña; recuperación renueva ambos; rekey genera además una nueva VDK.
  Cada operación mantiene los epochs y revisiones compatibles con 6A.

AES-256-GCM conserva nonce de 96 bits, tag de 128 bits y las tuplas AAD de Pulso.
HKDF-SHA-256 separa las claves por contexto y uso. Cada nuevo cifrado emplea salts,
nonces e identificadores aleatorios. Se limita el plaintext a 1 MiB y el sobre a
2 MiB. La validación JSON genérica no acredita cuentas, monedas ni saldos: ese
dominio sigue pendiente.

## Bloqueo y recuperación de sesión

Logout, cambio de identidad o sesión, navegación, desmontaje, `pagehide` y
retorno de BFCache cierran la sesión de bóveda y terminan su Worker. La interfaz
debe borrar sus referencias al recibir `onClear`. Ocultar la pestaña limpia la
vista inmediatamente; a los 60 segundos se termina el Worker. Cinco minutos
sin actividad también bloquean. Las comprobaciones por reloj se repiten al
intentar revelar datos, incluso si el navegador suspendió sus temporizadores.

Cada continuación asíncrona está ligada a la generación y al canal capturados.
Un mensaje tardío, un ACK de otra operación o un cambio de sesión no puede
activar una sesión nueva. El binding de navegador debe montarse y desmontarse
junto con la futura pantalla; no está instalado globalmente en los proyectos.

El controlador recibe una función de identidad y un transporte de guardado
inyectados. No autentica por sí mismo una respuesta arbitraria del caller:
la futura interfaz deberá conectarlos a la autoridad verificada de 6B.1. El
ensayo alojado utiliza esa autoridad con una identidad TEST existente.

## Comprobación reproducible

```bash
npm run typecheck:finance:test
npm test -- src/app/finance
npm run build:finance:test
npm run serve:finance:test
```

Abrir `http://127.0.0.1:5188/` y pulsar **Ejecutar pruebas de bóveda**. Sirve
únicamente la compilación de ensayo en `test-results/finance-6b2-browser`, fuera
del `dist/` publicado. El servidor local aplica CSP sin `unsafe-eval` al hilo
principal; solo los recursos Worker permiten `wasm-unsafe-eval`, con red
desactivada dentro del Worker. No se usa CDN.

La variante alojada de `serve.mjs` admite una ruta privada de fixtures existente,
fuera del repositorio. Solo puede contactar el host literal del proyecto TEST,
usa una clave pública y credenciales ficticias `example.test` mantenidas en
memoria del servidor local y cierra su propia sesión al terminar. El navegador
no recibe esas credenciales. La habilitación temporal, limpieza y cierre de las
puertas sintéticas requieren operación administrativa de TEST; el script no
puede habilitar finanzas reales ni modificar proyectos o tareas.

Consulta [la evidencia y sus límites](acceptance.md) y el
[contrato de seguridad](security-contract.md).

## Puerta de datos reales

El backend financiero real permanece cerrado. La
[autoridad de restauración independiente](../pulso-6b1/restore-authority.md)
sigue pendiente y la bandera de cuarentena de la misma base no la sustituye.
Una contraseña nueva tampoco invalida criptográficamente copias antiguas que
alguien ya conserve con su clave antigua.

Antes de habilitar una bóveda personal faltan dominio e importación explícita,
interfaz completa, revisión de la seguridad web del despliegue, aceptación en
dispositivos reales y resolver esa autoridad dentro del presupuesto gratuito.
Estas pruebas no constituyen una auditoría criptográfica externa.

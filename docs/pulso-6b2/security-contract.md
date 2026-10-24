# Contrato de seguridad del cliente 6B.2

## Lo que protege

El servidor almacena ciphertext opaco por identidad acreditada, sesión,
contexto, epochs y revisión. El cliente autentica el contexto, los envoltorios
y el payload; no acepta renombrar propietario o `vaultId` de una copia cifrada.
El reintento mantiene ID y bytes exactos y solo un ACK coincidente activa el
snapshot preparado. Los límites y las capacidades se validan antes de trabajo
costoso o de exponer plaintext.

Las claves operativas Web Crypto son no extraíbles. La VDK y el estado
autoritativo del snapshot permanecen en el Worker de la sesión. `read()` devuelve
una copia del plaintext al consumidor para mostrarlo; esa copia también debe
quedar sujeta al bloqueo y al borrado de referencias. El protocolo no ofrece exportar
VDK, KEK ni claves derivadas. Un `MessageChannel` comprueba soporte de clonación
con una clave de sonda interna; no envía una clave de bóveda al hilo principal.

No se escribe material financiero en `localStorage`, `sessionStorage`, IndexedDB,
CacheStorage, React Query, actividad, correo, Google o analítica. La sesión de
Supabase de la aplicación existente es independiente de este contrato.

El caller debe mantener el contenido mostrado y los formularios únicamente en
memoria y borrar sus referencias en `onClear`, antes de mostrar una pantalla
bloqueada. El controlador deja de admitir mensajes, termina el Worker e invalida
su generación. Los buffers propios se sobrescriben en `finally` cuando procede.
No se promete borrado verificable de strings, copias internas de Web Crypto,
memoria de WASM ni del recolector de basura de JavaScript.

La futura UI debe cercar también la continuación entre `await read()` y su
renderizado con la generación, identidad y visibilidad vigentes. Una copia ya
devuelta por una promesa no puede retirarse del consumidor desde el Worker.
`onClear` debe invalidar formularios y actualizaciones de React pendientes,
además de vaciar lo que ya estaba visible.

## Contraseña y recuperación

La contraseña de Supabase abre la cuenta; la contraseña privada o el código
abren la bóveda. Restablecer la primera por email no descifra las finanzas.
El servidor no tiene una copia de los medios privados y no los envía por correo.

Si queda un dispositivo abierto, el rekey permite preparar una clave nueva y
medios nuevos, previa custodia y confirmación remota. Si se pierden contraseña,
código y todos los dispositivos abiertos, el contenido cifrado no es recuperable
por TR8. La ruta backend de reset de 6B.1 no recupera contenido: retira un contexto
y exige login reciente. Su futura pantalla de pérdida total requerirá una
confirmación irreversible específica; esta entrega no la ejecuta ni crea un
contexto sustituto automáticamente.

Tras una recuperación se exige renovar ambos medios actuales. Eso protege el
sobre nuevo; no impide descifrar un backup antiguo usando un secreto antiguo
ya conocido. Los retiros, revocaciones y restauraciones necesitan además la
autoridad independiente pendiente de 6B.1.

## Límites de confianza

El cifrado no protege contra JavaScript malicioso ejecutado en el mismo origen,
extensiones con acceso, captura de pantalla, keyloggers ni dispositivos
comprometidos. La seguridad de UI, CSP, dependencias, sesiones y despliegue
forma parte de la puerta de activación real; la separación en Worker no elimina
ese riesgo.

Los callbacks `verifyIdentity`, `saveOpaque` y `onClear` son parte de la frontera
de confianza del controlador. Un caller que invente identidad o ACK puede falsear
su propio estado local, sin adquirir autorización del servidor. La interfaz
financiera deberá usar el runtime real verificado, además de gestionar conflictos,
consulta de recibos y reautenticación de 6B.1.

La compatibilidad v1 no implica autorización para importar una bóveda por email,
conservar sus identificadores o cambiar de suite automáticamente. La importación
debe abrir una copia local, validar el dominio y volver a cifrarla para una VDK y
contexto nuevos. Ese flujo no forma parte de 6B.2.

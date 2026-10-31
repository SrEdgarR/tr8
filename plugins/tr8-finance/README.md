# TR8 · Finanzas — paquete privado de solo lectura

Paquete local preparado para revisión e instalación en un host compatible.
No está publicado ni instalado y no demuestra una conexión cloud del DOT.
No incluye contraseñas, PAT, claves de Codex, secretos de cliente ni acceso Gmail.

## Archivos

- `plugin.json`: identidad portátil del plugin.
- `mcp.json`: conexión remota y OAuth predefinido público; archivo canónico.
- `compatibility/.mcp.json`: alternativa para un host que exija el formato
  antiguo. No está activa desde esa carpeta. No cargar ambas configuraciones a
  la vez ni renombrar el archivo canónico sin adaptar el formato del host.
- `schemas/`: copias sin modificar de los esquemas portátiles oficiales 1.0.0.
- `validate.mjs`: comprueba el manifiesto, núcleo MCP y contrato OAuth de lectura;
  no llama a TR8 ni inicia OAuth.

## Configuración exacta

| Campo                  | Valor                                                         |
| ---------------------- | ------------------------------------------------------------- |
| Nombre visible         | TR8 · Finanzas (solo lectura)                                 |
| Descripción            | Consulta privada de cuentas y movimientos autorizados de TR8. |
| Transporte             | Streamable HTTP                                               |
| URL del MCP            | `https://tr8.vercel.app/api/mcp/finance`                      |
| Autenticación          | OAuth                                                         |
| Registro del cliente   | Predefinido / provided                                        |
| ID público del cliente | `tr8-dot-readonly`                                            |
| Método del token       | `none` — cliente público, sin secreto                         |
| Scope solicitado       | `finance:read`                                                |
| Recurso                | `https://tr8.vercel.app/api/mcp/finance`                      |

El ID de cliente es público y no concede acceso por sí solo. El servidor debe
tener registrado ese cliente y el callback exacto de esta conexión. No sustituir
OAuth por «Sin autenticación», una cabecera Bearer fija o credenciales del MCP
local de Codex. No añadir `finance:write`.

## Conectar desde ChatGPT

1. Abre [Plugins](https://chatgpt.com/plugins), pulsa `+` y selecciona
   **Añadir servidor MCP personalizado**. Introduce nombre, descripción y URL
   de la tabla. Selecciona OAuth.
2. Si aparecen opciones de cliente predefinido, utiliza `tr8-dot-readonly`,
   método `none` y scope `finance:read`. El secreto debe quedar vacío solo si el
   formulario permite ese cliente público; no inventar uno.
3. Si la interfaz solo ofrece OAuth automático y el botón **Crear**, no hay un
   campo documentado que permita pegar `mcp.json` en ese formulario. No asumir
   que existe carga de ZIP. Usa la importación de paquetes o marketplace privado
   **solo si tu superficie la ofrece**, entregando esta carpeta completa.
   Si exige registro DCR/CIMD y no admite cliente predefinido, hace falta ampliar
   esa compatibilidad en TR8 antes de conectar; este paquete no la activa.
4. Copia la **URI de redirección exacta** que muestre la administración del MCP
   y regístrala en TR8 para este cliente. No es secreta, pero no se debe adivinar
   ni copiar un enlace de autorización con códigos. Puede contener un
   identificador específico de conexión. No asumir el callback global estable.
5. Completa el inicio de sesión y revisa el consentimiento de TR8. Selecciona
   únicamente el permiso financiero de consulta con las cuentas autorizadas.
   Confirma solo cuando diga **Solo consultar tus finanzas**.
6. Revisa las cinco herramientas de lectura e instala/habilita el plugin para
   tu cuenta. No publicar en el directorio público ni en un equipo por defecto.

La instalación desde una carpeta local en Codex no prueba que el DOT tenga el
plugin en la nube. No se ha añadido un marketplace a tu cuenta ni modificado
configuraciones personales. La disponibilidad de importación privada varía por
superficie y políticas de cuenta.

## Prueba cloud sin registrar movimientos

En el DOT, pide: «Usa TR8 Finanzas para consultar el contexto y listar las
cuentas autorizadas. Informa solo sus nombres, monedas y si la conexión es de
lectura. No consultes Gmail ni registres o modifiques movimientos».

Debe invocar `tr8_get_finance_context` y `tr8_list_finance_accounts` desde su
entorno cloud, sin usar el PC como puente. El catálogo esperado es:

- `tr8_get_finance_context`
- `tr8_list_finance_accounts`
- `tr8_list_finance_categories`
- `tr8_list_finance_movements`
- `tr8_list_finance_reviews`

No debe aparecer `tr8_submit_finance_notice`. La importación permanece apagada.
Un resultado obtenido solo desde este Codex o un cliente local no cuenta como
prueba del DOT. No solicitar ni compartir tokens, contraseñas o cuerpos de correo.

## Validación local

Desde el repositorio de TR8, con sus dependencias instaladas:

```sh
node plugins/tr8-finance/validate.mjs
```

El validador utiliza Ajv ya incluido en el SDK MCP de TR8. No instala paquetes,
no carga variables del entorno y no se conecta a servicios externos.

Hay una discrepancia en las fuentes oficiales actuales: OpenAI documenta
`extensions.com.openai.auth` en cada servidor, pero el esquema portátil MCP
1.0.0 publicado rechaza `extensions`. Por eso el informe distingue el manifiesto
completo, el núcleo MCP sin extensiones y las comprobaciones estrictas del
contrato OAuth documentado. `mcpFullSchema: false` indica esa limitación, no una
validación íntegra aprobada. Un host que aplique solo ese esquema puede rechazar
el paquete; su instalación cloud debe comprobarse en la superficie real.

Fuentes oficiales consultadas el 31 de octubre de 2026:
[estructura y OAuth predefinido](https://developers.openai.com/plugins/build/plugins),
[crear y probar un MCP en ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt),
[callbacks OAuth](https://developers.openai.com/plugins/build/auth),
[plugins del DOT](https://learn.chatgpt.com/docs/dots/computers-and-apps).

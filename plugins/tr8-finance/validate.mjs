// Offline validation only. Never contacts TR8, OAuth or Gmail.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const sdkRequire = createRequire(new URL('../../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url));
const Ajv2020 = sdkRequire('ajv/dist/2020.js').default;
const addFormats = sdkRequire('ajv-formats').default;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const read = async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
let mcpFullSchema = false;
for (const name of ['plugin', 'mcp']) {
  const schema = await read(`./schemas/${name}.schema.json`);
  const data = await read(`./${name}.json`);
  const validate = ajv.compile(schema);
  const full = validate(data);
  if (name === 'mcp') mcpFullSchema = full;
  if (name === 'mcp' && !full) {
    // OpenAI documents extensions.com.openai.auth, while the published portable
    // 1.0.0 schema currently rejects all per-server extensions. Validate the
    // portable core separately, then assert the documented extension below.
    const core = structuredClone(data);
    for (const server of Object.values(core.mcpServers)) delete server.extensions;
    assert.ok(validate(core), `mcp.json portable core: ${JSON.stringify(validate.errors)}`);
  } else assert.ok(full, `${name}.json: ${JSON.stringify(validate.errors)}`);
}
const mcp = await read('./mcp.json');
const compatibility = await read('./compatibility/.mcp.json');
const entries = Object.entries(mcp.mcpServers);
assert.equal(entries.length, 1);
assert.equal(entries[0][0], 'tr8-finance-readonly');
const server = entries[0][1];
assert.equal(server.type, 'streamable-http');
assert.equal(server.url, 'https://tr8.vercel.app/api/mcp/finance');
assert.deepEqual(Object.keys(server).sort(), ['extensions', 'type', 'url']);
const auth = server.extensions['com.openai'].auth;
assert.deepEqual(Object.keys(server.extensions), ['com.openai']);
assert.deepEqual(Object.keys(server.extensions['com.openai']), ['auth']);
assert.deepEqual(Object.keys(auth).sort(), [
  'authorizationServerBase',
  'authorizationUrl',
  'baseScopes',
  'client',
  'defaultScopes',
  'oidcEnabled',
  'resource',
  'tokenUrl',
  'type',
]);
assert.deepEqual(auth.client, { mode: 'provided', clientId: 'tr8-dot-readonly', tokenEndpointAuthMethod: 'none' });
assert.equal(auth.type, 'oauth');
assert.equal(auth.resource, server.url);
assert.deepEqual(auth.baseScopes, ['finance:read']);
assert.deepEqual(auth.defaultScopes, ['finance:read']);
assert.equal(auth.oidcEnabled, false);
assert.ok(!Object.hasOwn(auth, 'registrationUrl'));
assert.equal(auth.authorizationUrl, 'https://tr8.vercel.app/api/oauth/authorize');
assert.equal(auth.tokenUrl, 'https://tr8.vercel.app/api/oauth/token');
assert.deepEqual(compatibility.mcpServers['tr8-finance-readonly'], { url: server.url, extensions: server.extensions });
const joined = JSON.stringify([mcp, compatibility, await read('./plugin.json')]);
assert.ok(!/finance:write|clientSecret|Authorization|tr8_mcp_|tr8_oauth_[acr]_|service_role|refresh_token|access_token/.test(joined));
process.stdout.write(
  JSON.stringify({
    pluginSchema: 'passed',
    mcpPortableCore: 'passed',
    mcpFullSchema,
    openaiOAuthContract: 'passed',
    readonlyPolicy: 'passed',
    compatibility: 'equivalent',
    network: false,
    installed: false,
  }) + '\n',
);

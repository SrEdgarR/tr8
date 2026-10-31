// Explicitly authorized hosted acceptance: no browser session, real token,
// account payload, notice submission, or financial writes. Public-key probes only.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const env = await fs.readFile(new URL('../../.env.local', import.meta.url), 'utf8');
function publicValue(name) {
  const match = env.match(new RegExp(`^${name}=(.*)$`, 'm'));
  return match?.[1].trim().replace(/^(['"])(.*)\1$/, '$2');
}
const url = publicValue('VITE_SUPABASE_URL');
const key = publicValue('VITE_SUPABASE_PUBLISHABLE_KEY');
assert.equal(new URL(url).origin, 'https://ggbjezprlsnhidlbjivl.supabase.co');
assert.ok(key, 'public project key configured');
let checks = 0;
const findings = [];
const check = (condition, label) => {
  assert.ok(condition, label);
  checks++;
  findings.push(label);
};
async function request(path, payload) {
  const r = await fetch(new URL(path, url), {
    method: payload ? 'POST' : 'GET',
    headers: { apikey: key, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  let body;
  try {
    body = await r.json();
  } catch {
    throw Error('Hosted response was not JSON');
  }
  return { status: r.status, body };
}
const settings = await request('/auth/v1/settings');
check(settings.status === 200, 'hosted Auth settings reachable with publishable key');
const registrationsDisabled = settings.body.disable_signup === true;
if (process.argv.includes('--before-migration')) {
  process.stdout.write(JSON.stringify({ checks, findings, hosted: true, registrationsDisabled, financialWrites: 0 }) + '\n');
  process.exit(0);
}
const blocked = r => r.status >= 400 && ['42501', 'PT401', 'PT403', 'PGRST301', 'PGRST303'].includes(r.body.code);
const finance = await request('/rest/v1/rpc/tr8_mcp_finance_dispatch', { p_token: `tr8_mcp_${'0'.repeat(64)}`, p_action: 'finance_context', p_input: {} });
check(blocked(finance) || finance.body._tr8_mcp_error?.code === 'PT401', 'invalid PAT cannot read financial context');
const oauth = await request('/rest/v1/rpc/tr8_mcp_oauth_finance_dispatch', {
  p_token: `tr8_oauth_a_${'0'.repeat(64)}`,
  p_action: 'finance_context',
  p_input: {},
});
check(blocked(oauth) || oauth.body._tr8_mcp_error?.code === 'PT401', 'invalid OAuth token cannot read financial context');
const consent = await request('/rest/v1/rpc/tr8_mcp_oauth_consent', { p_action: 'list', p_input: {} });
check(blocked(consent), 'browser consent list rejects anonymous public key');
const manage = await request('/rest/v1/rpc/tr8_mcp_finance_manage', { p_action: 'list', p_input: {} });
check(blocked(manage), 'financial permission management rejects anonymous public key');
const config = await request('/rest/v1/rpc/tr8_mcp_oauth_server', { p_action: 'get_client', p_input: { client_id: 'unregistered-hosted-probe' } });
check(
  config.status === 200 && (config.body === null || config.body._tr8_oauth_error?.code === 'temporarily_unavailable'),
  'OAuth protocol RPC resolves in real PostgREST with no unknown client access',
);
process.stdout.write(JSON.stringify({ checks, findings, hosted: true, registrationsDisabled, financialWrites: 0, realTokensUsed: false }) + '\n');

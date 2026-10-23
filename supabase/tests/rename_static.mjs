import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrations = new URL('../migrations/', import.meta.url);
const historical = readFileSync(new URL('20261023023410_personal_projects_tasks.sql', migrations), 'utf8').replaceAll('\r\n', '\n');
const filename = readdirSync(migrations).find(name => name.endsWith('_rename_personal_app_to_tr8.sql'));
assert.ok(filename, 'TR8 migration exists');
const migration = readFileSync(new URL(filename, migrations), 'utf8').replaceAll('\r\n', '\n');
const historicalFunctions = [...historical.matchAll(/create function [\s\S]*?\$\$;/g)].map(match =>
  match[0].replace(/^create function /, 'create or replace function ').replaceAll('gr8r_', 'tr8_'),
);
const renamedFunctions = [...migration.matchAll(/create or replace function [\s\S]*?\$\$;/g)].map(match => match[0]);
assert.equal(historicalFunctions.length, 9);
assert.deepEqual(renamedFunctions, historicalFunctions, 'all nine function bodies preserve the original behavior with TR8 identifiers');
assert.equal((migration.match(/^alter function public\.gr8r_/gm) || []).length, 6, 'all six public RPCs are renamed in place');
const structural = migration.replace(/create or replace function [\s\S]*?\$\$;/g, '').replace(/--[^\n]*/g, '');
assert.doesNotMatch(structural, /\b(?:drop|truncate)\s+(?:table|schema|function|sequence)\b/i, 'no persistent objects are dropped');
assert.doesNotMatch(structural, /\b(?:insert\s+into|delete\s+from|update\s+(?:public|tr8_private|gr8r_private)\.)/i, 'no application rows are rewritten');
assert.doesNotMatch(structural, /\b(?:restart|setval)\b/i, 'task identity sequence is not reset');
for (const expected of ['projects_hash', 'tasks_hash', 'config_hash', 'sequence_state', 'function_security', 'relation_security', 'column_security']) {
  assert.ok(migration.includes(`v_before.${expected}`), `preservation assertion for ${expected}`);
}
assert.match(migration, /notify pgrst, 'reload schema';/);
const suite = readFileSync(new URL('personal_app.sql', import.meta.url), 'utf8');
assert.doesNotMatch(suite, /gr8r/i, 'current application tests use the new brand');
assert.match(suite, /all pre-existing real projects retain their IDs/);
assert.match(suite, /all pre-existing real tasks retain their IDs/);
console.log(`TR8 static rename checks passed: ${fileURLToPath(new URL(filename, migrations))}`);

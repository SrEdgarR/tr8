// Offline SQL rehearsal: PGlite + synthetic identities, no network or app keys.
// Usage: node scripts/mcp/finance-sql-test.mjs <absolute @electric-sql/pglite root>
// Prerequisite fixture deliberately contains only dependencies used by this draft.
// This validates PostgreSQL behavior, not a hosted PostgREST/OAuth deployment.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FINANCE_SQL_BOOTSTRAP } from './finance-sql-bootstrap.mjs';

export async function createFinanceTestDatabase(moduleRoot) {
  if (!moduleRoot || !path.isAbsolute(moduleRoot)) throw Error('Pass an absolute local PGlite package root. No download is performed.');
  const { PGlite } = await import(pathToFileURL(path.join(moduleRoot, 'dist/index.js')).href);
  const { pgcrypto } = await import(pathToFileURL(path.join(moduleRoot, 'dist/contrib/pgcrypto.js')).href);
  const db = new PGlite({ extensions: { pgcrypto } });

  try {
    await db.exec(FINANCE_SQL_BOOTSTRAP);
    const migration = await fs.readFile(new URL('../../supabase/migrations/20261031210015_mcp_finance_delegated_draft.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    return db;
  } catch (error) {
    await db.close();
    throw Error(`Offline SQL bootstrap failed: ${error.code ?? ''} ${error.message} (${error.position ?? error.where ?? ''})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = await createFinanceTestDatabase(process.argv[2]);
  try {
    const testFile = new URL('../../supabase/tests/mcp_finance.sql', import.meta.url);
    const sql = await fs.readFile(testFile, 'utf8');
    const results = await db.exec(sql);
    const report = results.flatMap(result => result.rows).find(row => Object.hasOwn(row, 'checks'));
    if (!report || Number(report.checks) < 40) throw Error('Missing offline SQL assertion report.');
    process.stdout.write(JSON.stringify({ checks: Number(report.checks), mode: 'offline-pglite', hosted: false, concurrentSessions: false }) + '\n');
  } catch (error) {
    process.stderr.write(JSON.stringify({ message: error.message, code: error.code, where: error.where, position: error.position }) + '\n');
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

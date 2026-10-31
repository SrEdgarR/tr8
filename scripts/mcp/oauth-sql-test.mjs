// Disposable, offline OAuth SQL rehearsal. No hosted services or real secrets.
import fs from 'node:fs/promises';
import { createFinanceTestDatabase } from './finance-sql-test.mjs';

const db = await createFinanceTestDatabase(process.argv[2]);
try {
  await db.exec(await fs.readFile(new URL('../../supabase/migrations/20261031210021_mcp_oauth_finance_draft.sql', import.meta.url), 'utf8'));
  const result = await db.exec(await fs.readFile(new URL('../../supabase/tests/mcp_oauth.sql', import.meta.url), 'utf8'));
  const report = result.flatMap(item => item.rows).find(item => Object.hasOwn(item, 'checks'));
  if (!report || report.checks < 60) throw Error('Missing OAuth SQL checks.');
  process.stdout.write(JSON.stringify({ checks: report.checks, mode: 'offline-pglite-oauth', hosted: false, persistentRealAccess: false }) + '\n');
} catch (error) {
  const message = String(error.message).replace(/tr8_oauth_[acrp]_[a-f0-9]{64}/g, '[redacted-test-token]');
  process.stderr.write(JSON.stringify({ message, code: error.code }) + '\n');
  process.exitCode = 1;
} finally {
  await db.close();
}

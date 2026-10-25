/** Local full-app acceptance, pinned to the existing disposable test account. */
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
const fixture = JSON.parse(await readFile('C:/Users/thede/.codex/tmp/tr8-stage2-private/http-fixtures.json', 'utf8'));
if (fixture.url !== 'https://kajcbwlnqcwcpbtqyieo.supabase.co') throw Error('Test project only');
process.env.VITE_SUPABASE_URL = fixture.url;
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = fixture.key;
const server = await createServer({ server: { host: '127.0.0.1', port: 5174, strictPort: true } });
await server.listen();
console.log('TR8 staging app: http://127.0.0.1:5174');

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

// Run after `npm exec vite build -- --manifest`. Follow all static imports,
// rather than treating a smaller entry chunk as a smaller initial download.
const directory = resolve(process.argv[2] ?? 'dist');
const manifest = JSON.parse(readFileSync(resolve(directory, '.vite/manifest.json'), 'utf8'));
const visited = new Set();
const scripts = new Set();
const styles = new Set();
function visit(key) {
  if (visited.has(key)) return;
  visited.add(key);
  const chunk = manifest[key];
  if (!chunk) throw new Error(`Missing manifest entry: ${key}`);
  scripts.add(chunk.file);
  for (const file of chunk.css ?? []) styles.add(file);
  for (const dependency of chunk.imports ?? []) visit(dependency);
}
const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry);
if (!entries.length) throw new Error('The manifest has no application entry.');
for (const [key] of entries) visit(key);
function measure(files) {
  const result = { bytes: 0, gzipBytes: 0, files: [...files].sort() };
  for (const file of files) {
    const content = readFileSync(resolve(directory, file));
    result.bytes += content.length;
    result.gzipBytes += gzipSync(content).length;
  }
  return result;
}
console.log(JSON.stringify({ javascript: measure(scripts), css: measure(styles) }, null, 2));

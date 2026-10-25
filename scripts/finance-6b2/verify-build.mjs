/**
 * Reproducible static packaging gate for the isolated 6B.2 browser harness.
 * Run after: node node_modules/vite/bin/vite.js build --config scripts/finance-6b2/vite.config.ts
 * Usage: node scripts/finance-6b2/verify-build.mjs
 * Reads local sources/build only. It does not run the browser, KDF or any API.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const financial = process.argv.length === 3 && process.argv[2] === '--finance-6b3';
const profile = financial ? 'finance-6b3' : 'finance-6b2';
const output = resolve(repository, `test-results/${profile}-browser`);
const PACKAGES = [
  {
    name: 'libsodium-sumo',
    file: 'dist/modules-sumo-esm/libsodium-sumo.mjs',
    sha256: '4c94708f7e78eac7a32b29e2ce0ff96f4bd599d78c129f27bf8a061e20776c8c',
  },
  {
    name: 'libsodium-wrappers-sumo',
    file: 'dist/modules-sumo-esm/libsodium-wrappers.mjs',
    sha256: '40de1ef7cb8f2caae02c2a8f04809151904fa28cb9364cadedc57af89a6c9284',
  },
];
const FORBIDDEN = [
  /useBackupModule/,
  /Both wasm and asm failed/,
  /\basm\.js\b/,
  /\brequire\s*\(\s*['"]libsodium(?:-wrappers)?-sumo['"]\s*\)/,
  /dist\/modules-sumo\//,
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = value => value.split(sep).join('/');
let checks = 0;
class BuildError extends Error {}
function check(condition, label) {
  if (!condition) throw new BuildError(label);
  checks++;
}
function within(root, target) {
  const path = relative(root, target);
  return path && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}
function moduleReferences(source) {
  const refs = new Set();
  // Parse JS rather than matching words in strings such as the preview kind
  // "import". Computed module imports still fail closed.
  const file = ts.createSourceFile('asset.js', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  check(file.parseDiagnostics.length === 0, 'A built JS asset could not be parsed.');
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      check(ts.isStringLiteralLike(node.moduleSpecifier), 'Nonliteral static module reference.');
      refs.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      check(node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]), 'Computed dynamic import in a built asset.');
      refs.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...refs];
}

async function main() {
  check(process.argv.length === 2 || financial, 'Only the fixed --finance-6b3 profile is accepted.');
  const declared = JSON.parse(await readFile(resolve(repository, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(repository, 'package-lock.json'), 'utf8'));
  const packages = [];
  for (const spec of PACKAGES) {
    const root = resolve(repository, 'node_modules', spec.name);
    const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const bytes = await readFile(resolve(root, spec.file));
    const source = bytes.toString('utf8');
    check(metadata.name === spec.name && metadata.version === '0.8.4', 'Installed Sodium package/version differs from the audited ESM release.');
    check(
      declared.dependencies?.[spec.name] === '0.8.4' && lock.packages?.[`node_modules/${spec.name}`]?.version === '0.8.4',
      'Sodium dependency or lockfile is not pinned to 0.8.4.',
    );
    const entry = metadata.exports?.['.']?.import;
    check(
      (typeof entry === 'string' ? entry : entry?.default) === `./${spec.file}` && metadata.module === spec.file,
      'Sodium import resolution no longer selects the audited ESM entry.',
    );
    check(sha256(bytes) === spec.sha256, 'Installed Sodium ESM bytes differ from the audited SHA-256.');
    check(!FORBIDDEN.some(pattern => pattern.test(source)), 'Installed ESM contains CJS/asm fallback markers.');
    packages.push({ name: spec.name, version: metadata.version, esm: spec.file, bytes: bytes.length, sha256: spec.sha256 });
  }
  // Resolve only the core package location here, without executing CJS. The
  // actual build/import conditions above must still select its audited ESM.
  const wrapperRequire = createRequire(resolve(repository, 'node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm/libsodium-wrappers.mjs'));
  check(
    (await realpath(wrapperRequire.resolve('libsodium-sumo'))) ===
      (await realpath(resolve(repository, 'node_modules/libsodium-sumo/dist/modules-sumo/libsodium-sumo.js'))),
    'The Sodium wrapper resolves an unaudited nested core package.',
  );

  const outputReal = await realpath(output);
  const manifest = JSON.parse(await readFile(resolve(outputReal, '.vite/manifest.json'), 'utf8'));
  const manifestEntry = manifest[`scripts/${profile}/index.html`];
  check(manifestEntry?.isEntry === true && typeof manifestEntry.file === 'string', 'Isolated browser harness manifest entry is missing.');
  const assets = new Map();
  for (const name of await readdir(resolve(outputReal, 'assets'))) {
    check(/^[A-Za-z0-9._-]+\.js$/.test(name), 'Unexpected or external asset filename.');
    const file = resolve(outputReal, 'assets', name);
    const canonical = await realpath(file);
    check(within(outputReal, canonical), 'A built asset escapes the isolated harness output.');
    const bytes = await readFile(canonical);
    check(bytes.length > 0 && bytes.length < 2_200_000, 'A built JS asset is empty or unexpectedly large.');
    const source = bytes.toString('utf8');
    check(!FORBIDDEN.some(pattern => pattern.test(source)), 'Built asset contains a CJS or asm fallback marker.');
    assets.set(`assets/${name}`, { file: `assets/${name}`, source, bytes: bytes.length, sha256: sha256(bytes) });
  }
  check(assets.size >= 4 && assets.size <= 100, 'Unexpected isolated harness asset count.');

  function localReference(from, reference) {
    check(!/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(reference), 'Remote/CDN/data module import in the harness build.');
    check(
      reference.startsWith('./') || reference.startsWith('../') || reference.startsWith('/assets/'),
      'Bare or unrecognized module import in the harness build.',
    );
    const target = reference.startsWith('/') ? resolve(outputReal, `.${reference}`) : resolve(outputReal, from, '..', reference);
    check(within(outputReal, target), 'Module import escapes the isolated harness output.');
    const path = slash(relative(outputReal, target));
    check(assets.has(path), 'Referenced local JS chunk is missing.');
    return path;
  }
  const graph = new Map();
  for (const asset of assets.values()) {
    graph.set(
      asset.file,
      moduleReferences(asset.source).map(reference => localReference(asset.file, reference)),
    );
    for (const workerReference of asset.source.matchAll(/new (?:Shared)?Worker\s*\(\s*(?:new URL\s*\(\s*)?(['"])([^'"]+)\1/g))
      localReference(asset.file, workerReference[2]);
  }
  const entry = assets.get(manifestEntry.file);
  check(Boolean(entry), 'Harness main JS chunk is missing.');
  const html = await readFile(resolve(outputReal, `scripts/${profile}/index.html`), 'utf8');
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*(['"])([^'"]+)\1/g)) localReference(`scripts/${profile}/index.html`, match[2]);
  check(
    html.includes(`src="/${entry.file}"`) && !/<script[^>]+src\s*=\s*['"](?:https?:|\/\/)/i.test(html),
    'Harness HTML does not select only its local main entry.',
  );

  const pick = (pattern, label) => {
    const found = [...assets.values()].filter(asset => pattern.test(asset.file));
    check(found.length === 1, `${label} is absent or ambiguous.`);
    return found[0];
  };
  const worker = pick(/^assets\/vault\.worker-[A-Za-z0-9_-]+\.js$/, 'Vault Worker');
  const probe = pick(/^assets\/probe\.worker-[A-Za-z0-9_-]+\.js$/, 'Capability probe Worker');
  const sodium = pick(/^assets\/libsodium-wrappers-[A-Za-z0-9_-]+\.js$/, 'Bundled Sodium ESM chunk');
  const financialWorker = financial ? pick(/^assets\/financial\.worker-[A-Za-z0-9_-]+\.js$/, 'Financial domain Worker') : undefined;
  if (financialWorker) check(entry.source.includes(`/${financialWorker.file}`), 'Financial controller does not reference its domain Worker.');
  check(entry.source.includes(`/${worker.file}`) && entry.source.includes(`/${probe.file}`), 'Main entry does not reference both local module Workers.');
  check(/new Worker\(new URL\(/.test(entry.source), 'Main entry is missing its module Worker constructors.');
  check(sodium.bytes >= 450_000 && sodium.bytes <= 650_000, 'Bundled Sodium ESM chunk is outside its expected approximately 535 kB size range.');
  check(
    sodium.source.includes('WebAssembly.instantiate') && sodium.source.includes('AGFzbQE') && sodium.source.includes('crypto_pwhash'),
    'Bundled Sodium chunk does not include its local WASM payload and password KDF.',
  );

  function reachable(start) {
    const seen = new Set();
    function visit(file) {
      if (seen.has(file)) return;
      seen.add(file);
      for (const dependency of graph.get(file) ?? []) visit(dependency);
    }
    visit(start);
    return seen;
  }
  const mainGraph = reachable(entry.file);
  check(
    !mainGraph.has(sodium.file) && [...mainGraph].every(file => !assets.get(file).source.includes('crypto_pwhash')),
    'Password KDF became reachable from the harness main thread.',
  );
  check(reachable(worker.file).has(sodium.file), 'Vault Worker cannot load its local Sodium ESM chunk.');
  check(reachable(probe.file).has(sodium.file), 'Probe Worker cannot load the local KDF chunk.');
  if (financialWorker) check(reachable(financialWorker.file).has(sodium.file), 'Financial Worker cannot load the local KDF chunk.');

  const describe = asset => ({ file: asset.file, bytes: asset.bytes, sha256: asset.sha256 });
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        scope: 'Local static package/build verification only; not full-browser, hosted Auth, financial domain or restore-authority evidence.',
        checks,
        packages,
        main: describe(entry),
        vaultWorker: describe(worker),
        probeWorker: describe(probe),
        ...(financialWorker ? { financialWorker: describe(financialWorker) } : {}),
        sodiumBundle: describe(sodium),
        mainKdfReachable: false,
        remoteModuleImports: false,
        cjsOrAsmFallbackMarkers: false,
        assets: [...assets.values()].map(describe),
      },
      null,
      2,
    ),
  );
}

main().catch(error => {
  console.error(
    JSON.stringify({
      result: 'failed',
      error: error instanceof BuildError ? error.message : 'Local installed package or isolated build could not be read; rebuild and retry.',
    }),
  );
  process.exitCode = 1;
});

import { readFile, readdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--deny-file')) {
  console.error('Usage: node scripts/check-public.mjs [--deny-file /external/private-identifiers.txt]');
  process.exit(2);
}
// Keep private identifiers outside this repository. Each nonempty line is literal.
const denied = args.length ? (await readFile(args[1], 'utf8')).split(/\r?\n/).filter(Boolean).map(s => s.toLowerCase()) : [];
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const repository = manifest.repository?.url?.replace(/^git\+/, '').replace(/\.git$/, '');
const allowed = repository ? [repository + '.git', repository] : [];
const ignored = new Set(['node_modules', '.git', '.data', '.secrets', '.npm-cache', 'dist', 'coverage', 'backups', 'test-results', 'playwright-report']);
const failures = [];
let count = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const rel = relative(root, path);
    if ((await lstat(path)).isSymbolicLink()) { failures.push(rel + ': symbolic link'); continue; }
    if (entry.isDirectory()) { await walk(path); continue; }
    if (/^\.env(?:\.|$)/.test(entry.name) && entry.name !== '.env.example') {
      failures.push(rel + ': local environment file'); continue;
    }
    const bytes = await readFile(path);
    const text = bytes.toString('utf8');
    let inspected = text;
    for (const url of allowed) inspected = inspected.replaceAll(url, '');
    inspected = (rel + '\n' + inspected).toLowerCase();
    if (denied.some(value => inspected.includes(value))) failures.push(rel + ': private identifier');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) failures.push(rel + ': private key');
    if (/(?:^|\/)assets\/stickers\//.test(rel) || /(?:^|\/)infra\/profile\//.test(rel)) failures.push(rel + ': excluded asset directory');
    count++;
  }
}
await walk(root);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Public source audit passed: ${count} files; ${denied.length} external identifiers; selected repository URL allowed.`);
  console.log('Local dependencies, generated builds and test state are excluded. Package only source files.');
}

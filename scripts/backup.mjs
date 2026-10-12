import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function compose(args, capture = false) {
  const result = spawnSync('docker', ['compose', ...args], {
    cwd: root, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8',
  });
  if (result.error || result.status !== 0) throw new Error('Falló Docker Compose; revisa el comando ejecutado sin revelar secretos.');
  return result.stdout ?? '';
}
let stopped = false;
let failed = false;
try {
  const rows = compose(['ps', '--format', 'json', 'api'], true).trim();
  const services = rows.startsWith('[') ? JSON.parse(rows) : rows.split('\n').filter(Boolean).map((row) => JSON.parse(row));
  if (!services.some((service) => service.State === 'running')) throw new Error('API no está activa. No se modificará su estado para un respaldo.');
  compose(['--profile', 'ops', 'build', 'backup']);
  compose(['stop', 'api']);
  stopped = true;
  compose(['--profile', 'ops', 'run', '--rm', '--no-deps', 'backup', 'backup']);
} catch (error) {
  console.error(error.message);
  failed = true;
} finally {
  if (stopped) {
    try { compose(['up', '-d', 'api']); }
    catch { console.error('No se pudo reiniciar API: ejecutar docker compose up -d api y revisar readiness.'); failed = true; }
  }
}
if (failed) process.exitCode = 1;

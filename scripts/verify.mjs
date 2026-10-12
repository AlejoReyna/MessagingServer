import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const required = ['apps/web/index.html', 'apps/api/src/index.ts', 'apps/api/prisma/schema.prisma'];
const missing = required.filter((path) => !existsSync(resolve(root, path)));
if (missing.length) {
  console.error(`Integración pendiente; faltan componentes: ${missing.join(', ')}`);
  process.exit(1);
}
if (!process.env.INTEGRATION_DATABASE_URL) {
  console.error('Configura INTEGRATION_DATABASE_URL para una base PostgreSQL exclusiva de pruebas; verify no omite integración.');
  process.exit(1);
}
const tasks = [
  ['run', 'check:foundation'],
  ['run', 'typecheck'],
  ['run', 'test', '--workspace', '@private-chat/api'],
  ['run', 'test', '--workspace', '@private-chat/web'],
  ['run', 'build'],
  ['run', 'test:integration', '--workspace', '@private-chat/api'],
  ['run', 'test:runtime'],
];
// Compatibilidad con el fixture backend; la interfaz pública sigue siendo
// INTEGRATION_DATABASE_URL y ninguna URL se imprime.
const env = { ...process.env, TEST_DATABASE_URL: process.env.INTEGRATION_DATABASE_URL, LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' };
for (const args of tasks) {
  const result = spawnSync('npm', args, { cwd: root, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Build, tipos, pruebas e integración PostgreSQL ejecutados correctamente. Despliegue remoto requiere verificación separada.');

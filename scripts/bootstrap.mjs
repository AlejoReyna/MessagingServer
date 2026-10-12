import { spawnSync } from 'node:child_process';
import { databaseEnvironment } from './database-env.mjs';

let env;
try { env = databaseEnvironment(); }
catch (error) { console.error(error.message); process.exit(1); }

for (const task of ['db:migrate', 'db:seed', 'db:grant']) {
  const result = spawnSync('npm', ['run', task, '--workspace', '@private-chat/api'], { env, stdio: 'inherit' });
  if (result.error) { console.error(`No se pudo ejecutar ${task}.`); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Bootstrap completado. La inicialización no modifica contraseñas de cuentas existentes.');

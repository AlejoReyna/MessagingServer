import { spawnSync } from 'node:child_process';
import { localEnvironment, projectRoot } from './local-env.mjs';
import { databaseEnvironment } from './database-env.mjs';

const action = process.argv[2] ?? 'bootstrap';
const tasks = action === 'bootstrap' ? ['db:migrate', 'db:seed', 'db:grant'] : [action];
if (tasks.some((task) => !['db:migrate', 'db:seed', 'db:grant', 'db:reconcile-deletions'].includes(task))) {
  console.error('Acción inválida. Usa bootstrap o una tarea db:* del contrato.'); process.exit(1);
}
for (const task of tasks) {
  const result = spawnSync('npm', ['run', task, '--workspace', '@private-chat/api'], {
    cwd: projectRoot, env: databaseEnvironment(localEnvironment(true)), stdio: 'inherit',
  });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}

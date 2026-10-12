import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { localEnvironment, projectRoot } from './local-env.mjs';

const env = localEnvironment();
await mkdir(env.UPLOAD_DIR, { recursive: true, mode: 0o700 });
await mkdir(new URL('../.data/journal/', import.meta.url), { recursive: true, mode: 0o700 });
const child = spawn('npm', ['run', 'dev', '--workspace', '@private-chat/api'], { cwd: projectRoot, env, stdio: 'inherit' });
child.on('error', () => { console.error('No se pudo iniciar el servidor local.'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));

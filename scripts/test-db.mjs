import { spawnSync } from 'node:child_process';
import { mkdir, readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { initSecrets } from './init-secrets.mjs';
import { projectRoot } from './local-env.mjs';

const directory = resolve(projectRoot, '.data/postgres-integration');
const socketDirectory = resolve(projectRoot, '.data/postgres-integration-socket');
const log = resolve(projectRoot, '.data/postgres-integration.log');
const secretDirectory = resolve(projectRoot, '.secrets');
const port = Number(process.env.PRIVATE_CHAT_TEST_PORT ?? 55432);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PRIVATE_CHAT_TEST_PORT inválido.');
const databaseName = 'private_chat_integration';
function command(binary, args, optional = false) {
  const result = spawnSync(binary, args, { cwd: projectRoot, stdio: optional ? 'ignore' : 'inherit' });
  if (!optional && (result.error || result.status !== 0)) throw new Error(`Falló ${binary}; se necesita PostgreSQL nativo para este helper.`);
  return result.status === 0;
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function start() {
  await initSecrets(secretDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  if (!await exists(resolve(directory, 'PG_VERSION'))) {
    command('initdb', ['-D', directory, '-U', 'private_chat_owner', '--auth-host=scram-sha-256', '--auth-local=trust', `--pwfile=${resolve(secretDirectory, 'db_owner_password')}`]);
  }
  if (!command('pg_ctl', ['-D', directory, 'status'], true)) {
    command('pg_ctl', ['-D', directory, '-l', log, '-o', `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`, '-w', 'start']);
  }
  const ownerPassword = (await readFile(resolve(secretDirectory, 'db_owner_password'), 'utf8')).trim();
  const appPassword = (await readFile(resolve(secretDirectory, 'db_app_password'), 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(appPassword)) throw new Error('Formato de secretos inválido.');
  const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'private_chat_owner', password: ownerPassword, database: 'postgres', max: 1 });
  try {
    const found = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (!found.rowCount) await pool.query('CREATE DATABASE private_chat_integration');
    const role = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'private_chat_app'");
    if (!role.rowCount) await pool.query(`CREATE ROLE private_chat_app LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  } finally { await pool.end(); }
  console.log(`PostgreSQL de integración aislado preparado en loopback:${port}; sin modificar instancias existentes.`);
  return `postgresql://private_chat_owner:${encodeURIComponent(ownerPassword)}@127.0.0.1:${port}/${databaseName}`;
}

try {
  const action = process.argv[2] ?? 'start';
  if (action === 'stop') command('pg_ctl', ['-D', directory, '-m', 'fast', '-w', 'stop']);
  else if (action === 'start' || action === 'verify') {
    const databaseUrl = await start();
    if (action === 'verify') {
      const result = spawnSync('node', ['scripts/verify.mjs'], {
        cwd: projectRoot, stdio: 'inherit',
        env: { ...process.env, INTEGRATION_DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl, DATABASE_URL: databaseUrl },
      });
      if (result.error || result.status !== 0) process.exitCode = result.status ?? 1;
    }
  } else throw new Error('Acción inválida; usa start, stop o verify.');
} catch (error) {
  // No registrar error objeto de drivers: puede contener metadatos de conexión.
  console.error('No se pudo preparar/verificar PostgreSQL aislado. Comprueba binarios, puerto 55432 y logs locales de pruebas.');
  process.exitCode = 1;
}

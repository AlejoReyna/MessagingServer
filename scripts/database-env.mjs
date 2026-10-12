import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Adapta los secretos de Compose a los CLI sin poner credenciales en argv/logs. */
export function databaseEnvironment(source = process.env) {
  const env = { ...source };
  let url = env.OWNER_DATABASE_URL || env.DATABASE_URL;
  if (!url) {
    if (!env.DATABASE_PASSWORD_FILE) throw new Error('Falta el archivo de contraseña de PostgreSQL.');
    let password;
    try { password = readFileSync(env.DATABASE_PASSWORD_FILE, 'utf8').trim(); }
    catch { throw new Error('No se pudo leer el secreto de PostgreSQL.'); }
    if (!password) throw new Error('El secreto de PostgreSQL está vacío.');
    const port = Number(env.DATABASE_PORT ?? '5432');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Puerto PostgreSQL inválido.');
    const connection = new URL('postgresql://127.0.0.1');
    connection.hostname = env.DATABASE_HOST ?? '127.0.0.1';
    connection.port = String(port);
    connection.username = env.DATABASE_USER ?? 'private_chat_owner';
    connection.password = password;
    connection.pathname = `/${encodeURIComponent(env.DATABASE_NAME ?? 'private_chat')}`;
    url = connection.href;
  }
  // Sólo los procesos administrativos reciben estas variables en memoria.
  env.DATABASE_URL = url;
  env.OWNER_DATABASE_URL = url;
  env.RUNTIME_PASSWORD_FILE ??= resolve(root, '.secrets/db_app_password');
  return env;
}

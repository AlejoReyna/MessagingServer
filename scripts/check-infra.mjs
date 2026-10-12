import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const fail = (message) => { throw new Error(message); };
export function validateInfrastructure(document) {
  const config = parse(document, { merge: true });
  const services = config.services;
  if (!services?.api || !services.postgres || !services.web) fail('Faltan servicios de producción.');
  for (const [name, service] of Object.entries(services)) {
    if (name !== 'web' && (service.ports?.length || service.network_mode === 'host')) fail(`${name} no debe publicar puertos ni usar red host.`);
    if (Object.keys(service.environment ?? {}).some((key) => /PASSWORD$|SECRET$|DATABASE_URL$/.test(key))) fail(`${name} contiene secretos en environment.`);
  }
  if (!config.networks?.database?.internal) fail('La red de PostgreSQL debe ser interna.');
  const postgresNetworks = services.postgres.networks;
  const postgresNetworkNames = Array.isArray(postgresNetworks)
    ? postgresNetworks
    : typeof postgresNetworks === 'string'
      ? [postgresNetworks]
      : Object.keys(postgresNetworks ?? {});
  if (postgresNetworkNames.join(',') !== 'database') fail('PostgreSQL debe permanecer en una sola red interna.');
  if (services.api.environment.DATABASE_USER !== 'private_chat_app') fail('API debe usar rol runtime.');
  if (services.bootstrap.environment.DATABASE_USER !== 'private_chat_owner') fail('Bootstrap debe usar rol propietario.');
  if (services.bootstrap.environment.RUNTIME_PASSWORD_FILE !== '/run/secrets/db_app_password') fail('Bootstrap debe conceder la contraseña APP al runtime, no la propietaria.');
  if (services.api.secrets?.includes('db_owner_password')) fail('API no debe recibir la contraseña propietaria.');
  if (!services.api.read_only || !services.api.cap_drop?.includes('ALL') || services.api.user === '0:0') fail('Runtime API debe estar restringido y no-root.');
  if (!services.api.volumes?.includes('deletion_journal:/data/journal')) fail('Falta persistencia del journal de borrados.');
  if (!services.postgres.volumes?.includes('postgres_data:/var/lib/postgresql')) fail('Volumen PostgreSQL 18 incorrecto.');
  if (!services.api.healthcheck || !services.postgres.healthcheck) fail('Faltan healthchecks.');
  if (services.web.depends_on?.api?.condition !== 'service_healthy') fail('Web debe esperar readiness de API.');
  if (!services.bootstrap.profiles?.includes('tools') || !services.backup.profiles?.includes('ops')) fail('Herramientas administrativas deben ser opt-in.');
  for (const secret of Object.values(config.secrets ?? {})) {
    if (!secret.file?.startsWith('./.secrets/')) fail('Secretos deben provenir de archivos privados.');
  }
  return config;
}

export function validateRecovery(document) {
  const config = parse(document);
  if (!config.networks?.recovery?.internal) fail('La red de recuperación debe ser interna.');
  for (const service of Object.values(config.services ?? {})) {
    if (service.ports?.length || service.network_mode === 'host') fail('La recuperación no debe exponer servicios.');
  }
  if (config.services?.['restore-postgres']?.environment?.POSTGRES_DB !== 'private_chat_restore') fail('Destino de recuperación inválido.');
  const volumes = config.services?.['restore-reconcile']?.volumes ?? [];
  if (config.services?.['restore-reconcile']?.environment?.RECOVERY_MODE !== 'true') fail('Reconciliación de recuperación requiere RECOVERY_MODE=true.');
  if (!volumes.includes('current_deletion_journal:/journal:ro') || !config.volumes?.current_deletion_journal?.external) fail('Recuperación requiere journal vivo externo read-only.');
  if (config.volumes?.recovery_data?.external) fail('La DB de recuperación no debe reutilizar volumen externo de producción.');
  return config;
}

export function checkInfrastructure() {
  const config = validateInfrastructure(readFileSync(resolve(root, 'compose.yaml'), 'utf8'));
  const dev = parse(readFileSync(resolve(root, 'compose.dev.yaml'), 'utf8'));
  validateRecovery(readFileSync(resolve(root, 'compose.restore.yaml'), 'utf8'));
  if (dev.services.postgres.ports?.[0] !== '127.0.0.1:5432:5432') fail('PostgreSQL local debe enlazar loopback.');
  for (const service of Object.values(config.services)) {
    if (service.build && !existsSync(resolve(root, service.build.dockerfile))) fail('Dockerfile inexistente.');
  }
  const dockerignore = readFileSync(resolve(root, '.dockerignore'), 'utf8');
  for (const sensitivePath of ['.secrets', '.env', '**/.env', '.data', '.npm-cache']) {
    if (!dockerignore.split('\n').includes(sensitivePath)) fail(`Contexto Docker no excluye ${sensitivePath}.`);
  }
  const caddy = readFileSync(resolve(root, 'infra/Caddyfile'), 'utf8');
  if (!caddy.includes('reverse_proxy api:3000') || !caddy.includes('Content-Security-Policy') || caddy.includes('unsafe-inline')) fail('Proxy o CSP inválido.');
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    checkInfrastructure();
    console.log('Configuración estática comprobada: puertos, redes, roles, secretos, persistencia y proxy.');
    console.log('Esto no sustituye docker compose config/build ni la ejecución real de contenedores.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

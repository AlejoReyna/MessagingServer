import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, rm, symlink, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { initSecrets } from '../init-secrets.mjs';
import { checkInfrastructure, validateInfrastructure, validateRecovery } from '../check-infra.mjs';

test('secretos fuertes, privados, distintos y sin rotación al repetir inicialización', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'private-chat-secrets-'));
  try {
    await initSecrets(directory);
    const first = await readFile(join(directory, 'db_app_password'), 'utf8');
    const owner = await readFile(join(directory, 'db_owner_password'), 'utf8');
    assert.match(first, /^[a-f0-9]{64}\n$/);
    assert.notEqual(first, owner);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.deepEqual(await initSecrets(directory), []);
    assert.equal(await readFile(join(directory, 'db_app_password'), 'utf8'), first);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('inicialización rechaza un archivo de secretos enlazado sin modificar su destino', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'private-chat-links-'));
  try {
    const real = join(directory, 'real');
    await mkdir(real);
    await initSecrets(real);
    const source = join(real, 'db_owner_password');
    const before = await readFile(source, 'utf8');
    const linked = join(directory, 'linked');
    await mkdir(linked);
    await symlink(source, join(linked, 'db_owner_password'));
    await assert.rejects(initSecrets(linked), /inválido/);
    assert.equal(await readFile(source, 'utf8'), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('infraestructura mantiene DB interna y credencial propietaria fuera del runtime', () => {
  const valid = checkInfrastructure();
  const exposed = structuredClone(valid);
  exposed.services.postgres.ports = ['5432:5432'];
  assert.throws(() => validateInfrastructure(stringify(exposed)), /publicar puertos/);
  const privileged = structuredClone(valid);
  privileged.services.api.environment.DATABASE_USER = 'private_chat_owner';
  assert.throws(() => validateInfrastructure(stringify(privileged)), /rol runtime/);
  const leaked = structuredClone(valid);
  leaked.services.api.secrets.push('db_owner_password');
  assert.throws(() => validateInfrastructure(stringify(leaked)), /contraseña propietaria/);
});

test('recuperación aislada rechaza exposición de puertos o sustitución del journal actual', () => {
  const valid = validateRecovery(readFileSync(new URL('../../compose.restore.yaml', import.meta.url), 'utf8'));
  const publicRecovery = structuredClone(valid);
  publicRecovery.services['restore-postgres'].ports = ['5432:5432'];
  assert.throws(() => validateRecovery(stringify(publicRecovery)), /exponer servicios/);
  const oldJournal = structuredClone(valid);
  oldJournal.services['restore-reconcile'].volumes = ['snapshot_journal:/journal'];
  assert.throws(() => validateRecovery(stringify(oldJournal)), /journal vivo/);
  const reused = structuredClone(valid);
  reused.volumes.recovery_data.external = true;
  assert.throws(() => validateRecovery(stringify(reused)), /reutilizar volumen/);
});

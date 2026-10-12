import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseEnvironment } from '../database-env.mjs';

test('bootstrap conserva secretos distintos de propietario y runtime y codifica la URL', () => {
  const directory = mkdtempSync(join(tmpdir(), 'chat-db-env-'));
  try {
    const owner = join(directory, 'owner');
    const runtime = join(directory, 'runtime');
    const password = 'prueba:@/#? con espacios';
    writeFileSync(owner, `${password}\n`);
    writeFileSync(runtime, 'otra contraseña de prueba');
    const env = databaseEnvironment({ DATABASE_HOST: 'postgres', DATABASE_PORT: '5432', DATABASE_NAME: 'private_chat', DATABASE_USER: 'private_chat_owner', DATABASE_PASSWORD_FILE: owner, RUNTIME_PASSWORD_FILE: runtime });
    const url = new URL(env.DATABASE_URL);
    assert.equal(decodeURIComponent(url.password), password);
    assert.equal(url.username, 'private_chat_owner');
    assert.equal(url.hostname, 'postgres');
    assert.equal(env.OWNER_DATABASE_URL, env.DATABASE_URL);
    assert.equal(env.RUNTIME_PASSWORD_FILE, runtime);
    assert.notEqual(env.RUNTIME_PASSWORD_FILE, env.DATABASE_PASSWORD_FILE);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('bootstrap no continúa sin una credencial DB utilizable', () => {
  assert.throws(() => databaseEnvironment({}), /Falta el archivo/);
  assert.throws(() => databaseEnvironment({ DATABASE_PASSWORD_FILE: '/archivo-de-prueba-inexistente' }), /No se pudo leer/);
});

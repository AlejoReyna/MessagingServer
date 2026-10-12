import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { startTestServer, TestClient } from '../../apps/api/test/integration/helpers.ts';
import { pruneOrphanAvatars } from '../../apps/api/src/avatar-storage.ts';
import { projectRoot } from '../local-env.mjs';

test('fotos iniciales privadas, reemplazo sin historial e instalación idempotente (PostgreSQL)', { timeout: 60000 }, async () => {
  const server = await startTestServer();
  const directory = join(server.uploadDir, 'avatars');
  await fs.mkdir(server.uploadDir, { recursive: true });
  const secretDirectory = await fs.mkdtemp(join(server.uploadDir, 'seed-'));
  const adminPassword = join(secretDirectory, 'admin-password');
  const memberPassword = join(secretDirectory, 'member-password');
  const adminPin = join(secretDirectory, 'admin-pin');
  await fs.writeFile(adminPassword, server.users.adminPassword, { mode: 0o600 });
  await fs.writeFile(memberPassword, server.users.memberPassword, { mode: 0o600 });
  await fs.writeFile(adminPin, '1573', { mode: 0o600 });
  const adminAvatar = join(secretDirectory, 'admin.png');
  const memberAvatar = join(secretDirectory, 'member.png');
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#406080' } }).png().toFile(adminAvatar);
  await sharp({ create: { width: 8, height: 8, channels: 3, background: '#806040' } }).png().toFile(memberAvatar);
  const seed = (includeAvatars = true) => execFileSync('npm', ['run', 'db:seed', '--workspace', '@private-chat/api'], {
    cwd: projectRoot, stdio: 'pipe',
    env: { ...process.env, OWNER_DATABASE_URL: process.env.INTEGRATION_DATABASE_URL,
      ADMIN_USERNAME: 'admin', PARTNER_USERNAME: 'member', UPLOAD_DIR: server.uploadDir,
      ADMIN_AVATAR_FILE: includeAvatars ? adminAvatar : '', MEMBER_AVATAR_FILE: includeAvatars ? memberAvatar : '',
      ADMIN_PASSWORD_FILE: adminPassword, MEMBER_PASSWORD_FILE: memberPassword, ADMIN_PIN_FILE: adminPin },
  });
  try {
    // Base exclusiva de pruebas, sin sesiones ni mensajes en este fixture.
    await server.db.user.deleteMany();
    seed(false);
    const noAvatars = await server.db.user.findMany({ orderBy: { slot: 'asc' } });
    assert.deepEqual(noAvatars.map(u => u.displayName), ['Administrador', 'Miembro']);
    assert.ok(noAvatars.every(u => u.avatarPath === null && u.avatarVersion === 0));
    await server.db.user.update({ where: { id: noAvatars[0].id }, data: { displayName: 'Nombre editado' } });
    seed();
    const repeated = await server.db.user.findMany({ orderBy: { slot: 'asc' } });
    assert.deepEqual(repeated.map(u => [u.id, u.avatarPath, u.passwordHash, u.pinHash]), noAvatars.map(u => [u.id, u.avatarPath, u.passwordHash, u.pinHash]));
    assert.equal(repeated[0].displayName, 'Nombre editado');
    // Create a new synthetic fixture to verify explicit avatar inputs.
    await server.db.user.deleteMany();
    seed();
    const initial = await server.db.user.findMany({ orderBy: { slot: 'asc' } });
    assert.deepEqual(initial.map(u => u.displayName), ['Administrador', 'Miembro']);
    assert.equal(initial.length, 2);
    assert.ok(initial.every(u => u.avatarPath && u.avatarVersion === 1));
    assert.equal((await fs.readdir(directory)).length, 2);
    const originals = [];
    for (const user of initial) {
      const bytes = await fs.readFile(join(directory, user.avatarPath));
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.exif, undefined);
      originals.push(bytes);
    }
    seed();
    assert.deepEqual((await server.db.user.findMany({ orderBy: { slot: 'asc' } })).map(u => u.avatarPath), initial.map(u => u.avatarPath));
    assert.equal((await fs.readdir(directory)).length, 2);

    const clients = [new TestClient(server.baseUrl), new TestClient(server.baseUrl)];
    for (let i = 0; i < clients.length; i++) {
      const password = i === 0 ? server.users.adminPassword : server.users.memberPassword;
      const login = await clients[i].login(initial[i].username, password);
      assert.equal(login.status, 200);
      const changed = await clients[i].request('POST', '/api/auth/change-password', {
        body: { currentPassword: password, newPassword: `${password}-lista` },
      });
      assert.equal(changed.status, 200);
      clients[i].csrf = changed.json.csrfToken;
    }
    for (let i = 0; i < clients.length; i++) {
      const partner = await clients[i].request('GET', '/api/conversation');
      assert.equal(partner.json.partner.displayName, initial[1 - i].displayName);
      const url = partner.json.partner.avatarUrl;
      const image = await fetch(`${server.baseUrl}${url}`, { headers: { cookie: clients[i].cookies } });
      assert.equal(image.status, 200);
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), originals[1 - i]);
      assert.equal((await fetch(`${server.baseUrl}${url}`)).status, 401);
    }
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#8368a4' } }).png().toBuffer();
    async function upload(client, body = png) {
      const form = new FormData();
      form.append('avatar', new Blob([body], { type: 'image/png' }), 'photo.png');
      return client.request('POST', '/api/users/me/avatar', { rawBody: form });
    }
    const [admin, member] = clients;
    const changed = await upload(admin);
    assert.equal(changed.status, 200);
    await assert.rejects(fs.access(join(directory, initial[0].avatarPath)), { code: 'ENOENT' });
    assert.equal((await fs.readdir(directory)).length, 2);
    assert.equal((await server.db.user.findUnique({ where: { id: initial[1].id } })).avatarPath, initial[1].avatarPath);

    // Dos subidas simultáneas y un borrado usan la misma exclusión en PostgreSQL.
    const raced = await Promise.all([upload(admin), upload(admin), admin.request('DELETE', '/api/users/me/avatar', { body: {} })]);
    assert.ok(raced.every(r => r.status === 200));
    const active = await server.db.user.findMany({ select: { avatarPath: true } });
    assert.deepEqual((await fs.readdir(directory)).sort(), active.map(u => u.avatarPath).filter(Boolean).sort());

    const orphan = `${randomUUID()}.png`;
    await fs.writeFile(join(directory, orphan), png);
    await pruneOrphanAvatars(server.db, server.uploadDir);
    assert.deepEqual((await fs.readdir(directory)).sort(), active.map(u => u.avatarPath).filter(Boolean).sort());

    // El miembro también cambia únicamente su propia imagen.
    assert.equal((await upload(member)).status, 200);
    await assert.rejects(fs.access(join(directory, initial[1].avatarPath)), { code: 'ENOENT' });
    assert.equal((await member.request('DELETE', '/api/users/me/avatar', { body: {} })).status, 200);
    const beforeSeed = await server.db.user.findMany({ orderBy: { slot: 'asc' } });
    seed();
    const afterSeed = await server.db.user.findMany({ orderBy: { slot: 'asc' } });
    assert.deepEqual(afterSeed.map(u => u.avatarPath), beforeSeed.map(u => u.avatarPath));
    assert.deepEqual(afterSeed.map(u => u.avatarVersion), beforeSeed.map(u => u.avatarVersion));
    assert.equal(afterSeed[1].avatarPath, null);
    assert.deepEqual((await fs.readdir(directory)).sort(), afterSeed.map(u => u.avatarPath).filter(Boolean).sort());
  } finally {
    await server.close();
    await fs.rm(secretDirectory, { recursive: true, force: true });
  }
});

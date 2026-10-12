import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { io } from 'socket.io-client';
import { SessionResponseSchema, MessageCreatedEventSchema, MessageDeletedEventSchema, UserResponseSchema } from '@private-chat/contracts';
import { startTestServer, TestClient } from '../../apps/api/test/integration/helpers.ts';
import { buildApp } from '../../apps/api/src/http/app.ts';
import { RealtimeHub } from '../../apps/api/src/realtime.ts';
import { reconcileDeletions } from '../../apps/api/src/reconciliation.ts';
import { projectRoot } from '../local-env.mjs';

function event(socket, name) {
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => { socket.off(name, onEvent); reject(new Error(`No llegó ${name}`)); }, 5000);
    const onEvent = (payload) => { clearTimeout(timer); accept(payload); };
    socket.once(name, onEvent);
  });
}

async function connect(client, origin = 'http://app.test:5173') {
  const socket = io(client.baseUrl, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie: client.cookies, Origin: origin }, auth: { csrfToken: client.csrf } });
  await new Promise((accept, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.off('connect', onConnect); socket.off('connect_error', onError); };
    const onConnect = () => { cleanup(); accept(); };
    const onError = (error) => { cleanup(); socket.disconnect(); reject(error); };
    const timer = setTimeout(() => onError(new Error('Socket sin conexión')), 5000);
    socket.once('connect', onConnect); socket.once('connect_error', onError);
  });
  return socket;
}

test('dos usuarios con rol runtime: permisos SQL, API real y Socket.IO WebSocket', { timeout: 30000 }, async () => {
  const ownerUrl = process.env.INTEGRATION_DATABASE_URL;
  assert.ok(ownerUrl, 'INTEGRATION_DATABASE_URL es obligatoria; no hay omisiones');
  const server = await startTestServer();
  let app;
  let hub;
  let runtimeDb;
  let pool;
  let adminSocket;
  let memberSocket;
  try {
    const url = new URL(ownerUrl);
    const passwordFile = resolve(projectRoot, '.secrets/db_app_password');
    execFileSync('npm', ['run', 'db:grant', '--workspace', '@private-chat/api'], {
      cwd: projectRoot, stdio: 'pipe',
      env: { ...process.env, OWNER_DATABASE_URL: ownerUrl, DATABASE_URL: ownerUrl, DATABASE_NAME: decodeURIComponent(url.pathname.slice(1)), RUNTIME_PASSWORD_FILE: passwordFile },
    });
    url.username = 'private_chat_app';
    url.password = readFileSync(passwordFile, 'utf8').trim();
    pool = new pg.Pool({ connectionString: url.href, max: 4 });
    runtimeDb = new PrismaClient({ adapter: new PrismaPg(pool) });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM chat.users')).rows[0].count, 2);
    for (const sql of [
      "INSERT INTO chat.users (id,slot,username,display_name,role,password_hash) VALUES ('qa',3,'tercero','Tercero','member','x')",
      "UPDATE chat.users SET role='member' WHERE slot=1",
      'DELETE FROM chat.users WHERE slot=2',
      'CREATE TABLE chat.qa_permission_probe (id integer)',
    ]) await assert.rejects(pool.query(sql), (error) => error.code === '42501');
    await reconcileDeletions(runtimeDb, server.journalPath);
    app = await buildApp({ config: server.config, db: runtimeDb });
    hub = new RealtimeHub(app.server, { config: server.config, db: runtimeDb });
    app.hub = hub;
    await app.listen({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
    const admin = new TestClient(baseUrl);
    const member = new TestClient(baseUrl);
    for (const [client, username, initial, next] of [
      [admin, 'admin', server.users.adminPassword, 'QA-admin-cambiada-001'],
      [member, 'member', server.users.memberPassword, 'QA-member-cambiada-002'],
    ]) {
      assert.equal((await client.login(username, initial)).status, 200);
      const change = await client.request('POST', '/api/auth/change-password', { body: { currentPassword: initial, newPassword: next } });
      assert.equal(change.status, 200);
      client.csrf = SessionResponseSchema.parse(change.json).csrfToken;
    }
    adminSocket = await connect(admin);
    memberSocket = await connect(member);
    await assert.rejects(connect(admin, ''), /origin/);
    const receive = event(memberSocket, 'message:created');
    const key = crypto.randomUUID();
    const send = await admin.request('POST', '/api/messages', { body: { clientMessageId: key, body: 'Mensaje sintético de integración', conversationVersion: 1 } });
    assert.equal(send.status, 201);
    const message = MessageCreatedEventSchema.parse(send.json).message;
    assert.equal(MessageCreatedEventSchema.parse(await receive).message.id, message.id);
    const retry = await admin.request('POST', '/api/messages', { body: { clientMessageId: key, body: message.body, conversationVersion: 1 } });
    assert.equal(retry.status, 200);
    assert.equal((await runtimeDb.message.count()), 1);
    const profileEvent = event(memberSocket, 'profile:updated');
    const profile = await admin.request('PATCH', '/api/users/me', { body: { displayName: 'Perfil QA' } });
    assert.equal(profile.status, 200);
    assert.equal(UserResponseSchema.parse(await profileEvent).user.displayName, 'Perfil QA');
    const forbidden = await member.request('DELETE', `/api/messages/${message.id}`, { body: { conversationVersion: 1 } });
    assert.equal(forbidden.status, 403);
    const deletion = event(memberSocket, 'message:deleted');
    assert.equal((await admin.request('DELETE', `/api/messages/${message.id}`, { body: { conversationVersion: 1 } })).status, 200);
    assert.equal(MessageDeletedEventSchema.parse(await deletion).messageId, message.id);
    assert.equal((await runtimeDb.message.count()), 0);
    assert.equal((await runtimeDb.messageTombstone.count()), 1);
    const deletedOther = await member.request('DELETE', `/api/messages/${message.id}`, { body: { conversationVersion: 2 } });
    assert.equal(deletedOther.status, 403);
    const ownKey = crypto.randomUUID();
    const ownCreatedEvent = event(adminSocket, 'message:created');
    const ownCreated = await member.request('POST', '/api/messages', { body: { clientMessageId: ownKey, body: 'Mensaje propio sintético', conversationVersion: 2 } });
    assert.equal(ownCreated.status, 201);
    const ownMessage = MessageCreatedEventSchema.parse(ownCreated.json).message;
    assert.equal(MessageCreatedEventSchema.parse(await ownCreatedEvent).message.id, ownMessage.id);
    const adminDeletion = event(adminSocket, 'message:deleted');
    const memberDeletion = event(memberSocket, 'message:deleted');
    const ownDeleted = await member.request('DELETE', `/api/messages/${ownMessage.id}`, { body: { conversationVersion: 2 } });
    assert.equal(ownDeleted.status, 200);
    const expectedDeletion = { messageId: ownMessage.id, conversationVersion: 3 };
    assert.deepEqual(MessageDeletedEventSchema.parse(ownDeleted.json), expectedDeletion);
    assert.deepEqual(MessageDeletedEventSchema.parse(await adminDeletion), expectedDeletion);
    assert.deepEqual(MessageDeletedEventSchema.parse(await memberDeletion), expectedDeletion);
    for (const client of [admin, member]) {
      const history = await client.request('GET', '/api/messages', { csrf: false });
      assert.equal(history.status, 200);
      assert.deepEqual(history.json.messages, []);
      assert.equal(history.json.conversationVersion, 3);
    }
    assert.equal((await runtimeDb.messageTombstone.count()), 2);
    assert.equal((await runtimeDb.deletionAudit.findFirstOrThrow({ where: { messageId: ownMessage.id } })).actorId, server.users.memberId);
    const noResurrection = await member.request('POST', '/api/messages', { body: { clientMessageId: ownKey, body: ownMessage.body, conversationVersion: 3 } });
    assert.equal(noResurrection.status, 410);
    const clearForbidden = await member.request('DELETE', '/api/conversation/messages', { body: { conversationVersion: 3 } });
    assert.equal(clearForbidden.status, 403);
    // Foto con el mismo rol SQL restringido de producción, sin archivos públicos.
    const photoBytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#bb8f72' } }).png().toBuffer();
    const photoForm = new FormData();
    photoForm.append('photo', new Blob([photoBytes], { type: 'image/png' }), 'qa.png');
    photoForm.append('clientMessageId', crypto.randomUUID());
    photoForm.append('conversationVersion', '3');
    const photoEvent = event(adminSocket, 'message:created');
    const photoResult = await member.request('POST', '/api/messages/photo', { rawBody: photoForm });
    assert.equal(photoResult.status, 201);
    const photoMessage = MessageCreatedEventSchema.parse(photoResult.json).message;
    assert.equal(MessageCreatedEventSchema.parse(await photoEvent).message.photoUrl, photoMessage.photoUrl);
    const download = await fetch(`${baseUrl}${photoMessage.photoUrl}`, { headers: { cookie: admin.cookies } });
    assert.equal(download.status, 200);
    assert.equal((await sharp(Buffer.from(await download.arrayBuffer())).metadata()).format, 'webp');
    assert.equal((await member.request('DELETE', `/api/messages/${photoMessage.id}`, { body: { conversationVersion: 3 } })).status, 200);
    assert.equal(await runtimeDb.message.count(), 0);
    assert.equal((await admin.request('GET', photoMessage.photoUrl)).status, 404);
    // La autorización se consulta de nuevo al recibir una acción por socket.
    await server.db.session.updateMany({ where: { userId: server.users.memberId }, data: { revokedAt: new Date() } });
    const disconnected = event(memberSocket, 'disconnect');
    memberSocket.emit('typing:set', { isTyping: true });
    await disconnected;
    assert.equal(memberSocket.connected, false);
    assert.equal(adminSocket.connected, true);
  } finally {
    adminSocket?.disconnect(); memberSocket?.disconnect();
    await hub?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    await runtimeDb?.$disconnect().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await server.close();
  }
});

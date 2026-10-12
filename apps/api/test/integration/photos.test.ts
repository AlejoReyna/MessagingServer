import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { io, type Socket } from 'socket.io-client';
import { MessageSchema, PHOTO_MESSAGE_BODY, type Message } from '@private-chat/contracts';
import { startTestServer, TestClient, type TestServer } from './helpers.js';
import { reconcileDeletions } from '../../src/reconciliation.js';

function form(image: Buffer, key = randomUUID(), version = 1, caption = '') {
  const data = new FormData();
  data.append('clientMessageId', key);
  data.append('conversationVersion', String(version));
  data.append('body', caption);
  data.append('photo', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'test.png');
  return data;
}

function event<T>(socket: Socket, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Sin evento ${name}`)), 5000);
    socket.once(name, (value: T) => { clearTimeout(timeout); resolve(value); });
  });
}

describe('Fotos privadas (PostgreSQL y sockets reales)', () => {
  let server: TestServer;
  let admin: TestClient;
  let member: TestClient;
  let png: Buffer;
  before(async () => {
    server = await startTestServer();
    png = await sharp({ create: { width: 2300, height: 40, channels: 3, background: '#e19c72' } })
      .withMetadata().png().toBuffer();
  });
  after(async () => { await server.close(); });
  beforeEach(async () => {
    server.hub.disconnectAll();
    server.users = await server.reset();
    admin = new TestClient(server.baseUrl);
    member = new TestClient(server.baseUrl);
    for (const [client, username, password] of [[admin, 'admin', server.users.adminPassword], [member, 'member', server.users.memberPassword]] as const) {
      assert.equal((await client.login(username, password)).status, 200);
      const result = await client.request('POST', '/api/auth/change-password', { body: {
        currentPassword: password, newPassword: `Nueva-${username}-contraseña-2026`,
      } });
      assert.equal(result.status, 200);
      client.csrf = (result.json as { csrfToken: string }).csrfToken;
    }
  });
  async function upload(client: TestClient, image = png, key = randomUUID(), version = 1, caption = '') {
    return client.request('POST', '/api/messages/photo', { rawBody: form(image, key, version, caption) });
  }

  it('invitado envía; administrador recibe URL por socket, historial e imagen privada sin EXIF', async () => {
    const socket = io(server.baseUrl, { transports: ['websocket'], auth: { csrfToken: admin.csrf },
      extraHeaders: { Cookie: admin.cookies, Origin: server.config.appOrigin }, autoConnect: false });
    try {
      const connected = event(socket, 'connect'); socket.connect(); await connected;
      const incoming = event<{ message: Message }>(socket, 'message:created');
      const result = await upload(member, png, randomUUID(), 1, 'Mira esta foto');
      assert.equal(result.status, 201);
      const message = MessageSchema.parse((result.json as { message: unknown }).message);
      assert.equal(message.senderId, server.users.memberId);
      assert.equal((await incoming).message.photoUrl, message.photoUrl);
      assert.equal('photoData' in message, false);
      const history = await admin.request('GET', '/api/messages');
      assert.equal((history.json as { messages: Message[] }).messages[0]?.photoUrl, message.photoUrl);
      const response = await fetch(`${server.baseUrl}${message.photoUrl}`, { headers: { cookie: admin.cookies } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/webp');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const bytes = Buffer.from(await response.arrayBuffer());
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 2048);
      assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined);
      assert.equal((await fetch(`${server.baseUrl}${message.photoUrl}`)).status, 401);
      await admin.request('POST', '/api/auth/logout', { body: {} });
      assert.equal((await fetch(`${server.baseUrl}${message.photoUrl}`, { headers: { cookie: admin.cookies } })).status, 401);
    } finally { socket.disconnect(); }
  });

  it('reintento concurrente guarda una sola foto; otra foto/texto con la misma clave da 409', async () => {
    const key = randomUUID();
    const results = await Promise.all([upload(admin, png, key), upload(admin, png, key)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 201]);
    const message = MessageSchema.parse((results[0]!.json as { message: unknown }).message);
    assert.equal(message.body, PHOTO_MESSAGE_BODY);
    assert.equal(await server.db.message.count(), 1);
    const different = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#002233' } }).png().toBuffer();
    assert.equal((await upload(admin, different, key)).status, 409);
    assert.equal((await admin.request('POST', '/api/messages', { body: { clientMessageId: key, body: PHOTO_MESSAGE_BODY, conversationVersion: 1 } })).status, 409);
    assert.equal((await upload(admin, png, key, 1, 'Otro texto')).status, 409);
  });

  it('rechaza CSRF/Origin, anónimo, SVG, bytes corruptos, exceso de tamaño/píxeles y falta de foto sin persistir', async () => {
    const anonymous = new TestClient(server.baseUrl);
    await anonymous.session();
    assert.equal((await upload(anonymous)).status, 401);
    assert.equal((await member.request('POST', '/api/messages/photo', { rawBody: form(png), csrf: false })).status, 403);
    assert.equal((await member.request('POST', '/api/messages/photo', { rawBody: form(png), origin: 'https://evil.test' })).status, 403);
    for (const invalid of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('not image'), Buffer.alloc(5 * 1024 * 1024 + 1)]) {
      assert.equal((await upload(member, invalid)).status, 400);
    }
    assert.equal((await member.request('POST', '/api/messages/photo', { rawBody: new FormData() })).status, 400);
    const tooManyPixels = await sharp({ create: { width: 4096, height: 4096, channels: 3, background: '#112233' } }).png().toBuffer();
    assert.equal((await upload(member, tooManyPixels)).status, 400);
    assert.equal(await server.db.message.count(), 0);
  });

  it('borrar foto propia elimina bytes; journal impide resurrección por restauración y reintento', async () => {
    const key = randomUUID();
    const result = await upload(member, png, key);
    const message = MessageSchema.parse((result.json as { message: unknown }).message);
    const saved = await server.db.message.findUniqueOrThrow({ where: { id: message.id } });
    assert.ok(saved.photoData);
    const adminPhoto = MessageSchema.parse(((await upload(admin)).json as { message: unknown }).message);
    assert.equal((await member.request('DELETE', `/api/messages/${adminPhoto.id}`, { body: { conversationVersion: 1 } })).status, 403);
    assert.equal((await member.request('DELETE', `/api/messages/${message.id}`, { body: { conversationVersion: 1 } })).status, 200);
    assert.equal(await server.db.message.findUnique({ where: { id: message.id } }), null);
    assert.equal((await member.request('GET', message.photoUrl!)).status, 404);
    assert.equal((await upload(member, png, key, 2)).status, 410);
    await server.db.message.create({ data: saved });
    await reconcileDeletions(server.db, server.journalPath);
    assert.equal(await server.db.message.findUnique({ where: { id: message.id } }), null);
    assert.equal((await member.request('GET', message.photoUrl!)).status, 404);
    assert.equal((await admin.request('DELETE', '/api/conversation/messages', { body: { conversationVersion: (await server.db.conversation.findUniqueOrThrow({ where: { id: 1 } })).version } })).status, 200);
    assert.equal(await server.db.message.count(), 0);
    assert.equal((await member.request('GET', adminPhoto.photoUrl!)).status, 404);
    assert.equal((await upload(member, png, randomUUID(), 2)).status, 409);
  });
});

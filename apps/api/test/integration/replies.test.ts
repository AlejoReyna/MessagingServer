import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { io, type Socket } from 'socket.io-client';
import { MessageSchema, type Message } from '@private-chat/contracts';
import { startTestServer, TestClient, type TestServer } from './helpers.js';

function event<T>(socket: Socket, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Sin evento ${name}`)), 5000);
    socket.once(name, (value: T) => { clearTimeout(timeout); resolve(value); });
  });
}

describe('Respuestas citadas (PostgreSQL y sockets reales)', () => {
  let server: TestServer;
  let admin: TestClient;
  let member: TestClient;
  before(async () => { server = await startTestServer(); });
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
  async function send(client: TestClient, body: string, version = 1, key = randomUUID(), replyToMessageId?: string) {
    return client.request('POST', '/api/messages', {
      body: { clientMessageId: key, body, conversationVersion: version, ...(replyToMessageId ? { replyToMessageId } : {}) },
    });
  }

  it('cita texto con snapshot, llega por socket e historial a ambas cuentas', async () => {
    const socket = io(server.baseUrl, { transports: ['websocket'], auth: { csrfToken: admin.csrf },
      extraHeaders: { Cookie: admin.cookies, Origin: server.config.appOrigin }, autoConnect: false });
    try {
      const connected = event(socket, 'connect'); socket.connect(); await connected;
      const original = await send(member, '¿Traes pan?');
      assert.equal(original.status, 201);
      const first = MessageSchema.parse((original.json as { message: unknown }).message);
      assert.equal(first.replyTo, undefined);
      const incoming = event<{ message: Message }>(socket, 'message:created');
      const reply = await send(admin, 'Sí, integral', 1, randomUUID(), first.id);
      assert.equal(reply.status, 201);
      const message = MessageSchema.parse((reply.json as { message: unknown }).message);
      assert.deepEqual(message.replyTo, { messageId: first.id, senderId: first.senderId, body: '¿Traes pan?' });
      assert.deepEqual((await incoming).message.replyTo, message.replyTo);
      for (const client of [admin, member]) {
        const history = await client.request('GET', '/api/messages');
        const found = (history.json as { messages: Message[] }).messages.find((m) => m.id === message.id);
        assert.deepEqual(found?.replyTo, message.replyTo);
      }
      assert.equal('photoData' in message, false);
    } finally { socket.disconnect(); }
  });

  it('rechaza original inexistente (404), borrado (410) y referencia malformada', async () => {
    assert.equal((await send(admin, 'hola', 1, randomUUID(), 'no-es-uuid')).status, 400);
    const missing = await send(admin, 'hola', 1, randomUUID(), randomUUID());
    assert.equal(missing.status, 404);
    assert.equal((missing.json as { error: { code: string } }).error.code, 'MESSAGE_NOT_FOUND');
    const created = await send(member, 'temporal');
    const target = MessageSchema.parse((created.json as { message: unknown }).message);
    const version = 1;
    assert.equal((await member.request('DELETE', `/api/messages/${target.id}`, { body: { conversationVersion: version } })).status, 200);
    const gone = await send(admin, 'tarde', version + 1, randomUUID(), target.id);
    assert.equal(gone.status, 410);
    assert.equal((gone.json as { error: { code: string } }).error.code, 'MESSAGE_DELETED');
    assert.equal(await server.db.message.count(), 0);
  });

  it('la cita sobrevive al borrado del original y no resucita por reintento', async () => {
    const first = MessageSchema.parse(((await send(member, 'original')).json as { message: unknown }).message);
    const reply = MessageSchema.parse(((await send(admin, 'respuesta', 1, randomUUID(), first.id)).json as { message: unknown }).message);
    assert.equal((await member.request('DELETE', `/api/messages/${first.id}`, { body: { conversationVersion: 1 } })).status, 200);
    const history = await admin.request('GET', '/api/messages');
    const messages = (history.json as { messages: Message[] }).messages;
    assert.deepEqual(messages.map((m) => m.id), [reply.id]);
    assert.equal(messages[0]?.replyTo, undefined);
    const retry = await send(member, 'original', 2, first.clientMessageId);
    assert.equal(retry.status, 410);
  });

  it('misma clave con distinta cita da 409; foto puede citar texto', async () => {
    const first = MessageSchema.parse(((await send(member, 'mira')).json as { message: unknown }).message);
    const key = randomUUID();
    assert.equal((await send(admin, 'ok', 1, key, first.id)).status, 201);
    assert.equal((await send(admin, 'ok', 1, key, first.id)).status, 200);
    const conflict = await send(admin, 'ok', 1, key);
    assert.equal(conflict.status, 409);
    const image = await sharp({ create: { width: 30, height: 20, channels: 3, background: '#334455' } }).png().toBuffer();
    const data = new FormData();
    data.append('clientMessageId', randomUUID());
    data.append('conversationVersion', '1');
    data.append('body', 'te mando foto');
    data.append('replyToMessageId', first.id);
    data.append('photo', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'foto.png');
    const photo = await member.request('POST', '/api/messages/photo', { rawBody: data });
    assert.equal(photo.status, 201);
    const withPhoto = MessageSchema.parse((photo.json as { message: unknown }).message);
    assert.ok(withPhoto.photoUrl);
    assert.deepEqual(withPhoto.replyTo, { messageId: first.id, senderId: first.senderId, body: 'mira' });
  });
});

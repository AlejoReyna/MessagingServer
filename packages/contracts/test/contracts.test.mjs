import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SendMessageInputSchema, UpdateProfileInputSchema, PublicUserSchema,
  MessagesQuerySchema, MessagesPageSchema, NewPasswordSchema, ChangePasswordInputSchema,
  MessageDeletedEventSchema, TypingSetInputSchema, ApiErrorSchema, MessageSchema,
  SavePushSubscriptionInputSchema, DeletePushSubscriptionInputSchema, VapidKeyResponseSchema,
} from '../dist/index.js';

const id = '11111111-1111-4111-8111-111111111111';
const user = {
  id, username: 'admin', displayName: 'Mi perfil', role: 'admin', avatarUrl: null,
  avatarVersion: 0, mustChangePassword: true, updatedAt: '2026-10-10T12:00:00.000Z',
};

test('el cliente no puede inyectar autor, rol o campos de identidad al enviar/editar', () => {
  assert.equal(SendMessageInputSchema.safeParse({ clientMessageId: id, body: 'Hola', conversationVersion: 1, senderId: id }).success, false);
  assert.equal(UpdateProfileInputSchema.safeParse({ role: 'admin' }).success, false);
  assert.equal(UpdateProfileInputSchema.safeParse({ username: 'Nuevo.Nombre' }).data?.username, 'nuevo.nombre');
  assert.equal(UpdateProfileInputSchema.safeParse({}).success, false);
});

test('el DTO público rechaza secretos y URLs externas de avatar', () => {
  assert.equal(PublicUserSchema.safeParse(user).success, true);
  assert.equal(PublicUserSchema.safeParse({ ...user, passwordHash: 'secret' }).success, false);
  assert.equal(PublicUserSchema.safeParse({ ...user, avatarUrl: 'https://outside.example/avatar' }).success, false);
  assert.equal(PublicUserSchema.safeParse({ ...user, avatarUrl: `/api/users/${id}/avatar?v=2` }).success, true);
});

test('cursor válido, dirección única y límite acotado', () => {
  assert.deepEqual(MessagesQuerySchema.parse({ after: '0' }), { after: 0, limit: 50 });
  for (const query of [{ before: 2, after: 0 }, { limit: 101 }, { limit: '' }, { before: -1 }, { after: 'oops' }]) {
    assert.equal(MessagesQuerySchema.safeParse(query).success, false);
  }
});

test('rechaza mensajes vacíos, IDs inválidos, controles y versiones inseguras', () => {
  const valid = { clientMessageId: id, body: 'Hola 👋\n¿Cómo estás?', conversationVersion: 1 };
  assert.equal(SendMessageInputSchema.safeParse(valid).success, true);
  for (const patch of [{ body: '   ' }, { body: '\u0000' }, { body: 'a'.repeat(4001) }, { conversationVersion: 0 }, { conversationVersion: Number.MAX_SAFE_INTEGER + 1 }, { clientMessageId: '../secret' }]) {
    assert.equal(SendMessageInputSchema.safeParse({ ...valid, ...patch }).success, false);
  }
});

test('respuestas citadas: referencia opcional y cita autocontenida sin secretos', () => {
  const base = { clientMessageId: id, body: 'De acuerdo', conversationVersion: 1 };
  assert.equal(SendMessageInputSchema.safeParse(base).success, true);
  assert.equal(SendMessageInputSchema.safeParse({ ...base, replyToMessageId: id }).success, true);
  assert.equal(SendMessageInputSchema.safeParse({ ...base, replyToMessageId: 'no-uuid' }).success, false);
  const message = {
    id, clientMessageId: id, senderId: id, sequence: 2, body: 'De acuerdo',
    replyTo: { messageId: id, senderId: id, body: 'Hola' },
    createdAt: '2026-10-10T12:00:00.000Z',
  };
  assert.equal(MessageSchema.safeParse(message).success, true);
  assert.equal(MessageSchema.safeParse({ ...message, replyTo: { ...message.replyTo, body: 'x'.repeat(4001) } }).success, false);
  assert.equal(MessageSchema.safeParse({ ...message, replyTo: { messageId: id } }).success, false);
});

test('contraseñas conservan espacios y no permiten reutilizar la actual', () => {
  const password = '  contraseña suficientemente larga  ';
  assert.equal(NewPasswordSchema.parse(password), password);
  assert.equal(NewPasswordSchema.safeParse('corta').success, false);
  assert.equal(ChangePasswordInputSchema.safeParse({ currentPassword: password, newPassword: password }).success, false);
});

test('páginas y eventos de borrado exigen versión y no aceptan cuerpos de mensajes', () => {
  assert.equal(MessagesPageSchema.safeParse({ messages: [], hasMore: false, nextCursor: null, conversationVersion: 1 }).success, true);
  assert.equal(MessagesPageSchema.safeParse({ messages: [], hasMore: false, nextCursor: null }).success, false);
  assert.equal(MessageDeletedEventSchema.safeParse({ messageId: id, conversationVersion: 2, body: 'No conservar' }).success, false);
  assert.equal(TypingSetInputSchema.safeParse({ isTyping: true, userId: id }).success, false);
  assert.equal(ApiErrorSchema.safeParse({ error: { code: 'FORBIDDEN', message: 'No tienes permiso', stack: 'secret' } }).success, false);
});

test('push v5: suscripción https con claves base64url, sin texto ni secretos', () => {
  const valid = {
    subscription: {
      endpoint: 'https://web.push.apple.com/abc123',
      keys: { p256dh: `${'B'}${'A'.repeat(86)}`, auth: 'A'.repeat(22) },
    },
  };
  assert.equal(SavePushSubscriptionInputSchema.safeParse(valid).success, true);
  assert.equal(SavePushSubscriptionInputSchema.safeParse({
    subscription: { ...valid.subscription, expirationTime: null },
  }).success, true);
  for (const bad of [
    { subscription: { ...valid.subscription, endpoint: 'http://push.example.com/x' } },
    { subscription: { ...valid.subscription, endpoint: 'https://push.example.com/x', extra: 1 } },
    { subscription: { endpoint: valid.subscription.endpoint, keys: { p256dh: 'corta', auth: 'A'.repeat(22) } } },
    { subscription: { endpoint: valid.subscription.endpoint, keys: { p256dh: `${'B'}${'A'.repeat(86)}`, auth: 'corta' } } },
    { subscription: { ...valid.subscription, keys: { ...valid.subscription.keys, body: 'No conservar' } } },
  ]) {
    assert.equal(SavePushSubscriptionInputSchema.safeParse(bad).success, false);
  }
  assert.equal(DeletePushSubscriptionInputSchema.safeParse({ endpoint: valid.subscription.endpoint }).success, true);
  assert.equal(DeletePushSubscriptionInputSchema.safeParse({ endpoint: 'http://push.example.com/x' }).success, false);
  assert.equal(VapidKeyResponseSchema.safeParse({ publicKey: null, enabled: false }).success, true);
  assert.equal(VapidKeyResponseSchema.safeParse({ publicKey: `${'B'}${'A'.repeat(86)}`, enabled: true }).success, true);
});

import { z } from 'zod';

export const CONTRACT_VERSION = 6;
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_CHAT_PHOTO_BYTES = 5 * 1024 * 1024;
export const PHOTO_MESSAGE_BODY = '📷 Foto';
export const MAX_CHAT_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_CHAT_VIDEO_SECONDS = 180;
export const VIDEO_MESSAGE_BODY = '🎬 Video';
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'] as const;
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export const PUSH_ENDPOINT_MAX_LENGTH = 2000;
export const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const CONVERSATION_ID = 1;

const uuid = z.uuid();
const timestamp = z.iso.datetime();
const nonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const RoleSchema = z.enum(['admin', 'member']);
export const UsernameSchema = z.string().trim().toLowerCase().min(3).max(32)
  .regex(/^[a-z0-9_.-]+$/);
export const DisplayNameSchema = z.string().trim().min(1).max(60)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Nombre no válido');
export const NewPasswordSchema = z.string().min(15).max(128);
export const MessageBodySchema = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'Texto no válido');

export const PublicUserSchema = z.strictObject({
  id: uuid,
  username: UsernameSchema,
  displayName: DisplayNameSchema,
  role: RoleSchema,
  avatarUrl: z.string().regex(/^\/api\/users\/[0-9a-f-]{36}\/avatar(?:\?v=\d+)?$/i).nullable(),
  avatarVersion: nonnegativeInteger,
  mustChangePassword: z.boolean(),
  updatedAt: timestamp,
});
export type PublicUser = z.infer<typeof PublicUserSchema>;
export type Role = z.infer<typeof RoleSchema>;

export const LoginInputSchema = z.strictObject({
  username: UsernameSchema,
  password: z.string().min(1).max(128),
});
// Acceso con PIN de 4 dígitos (v2): sustituye al login en la UI. El servidor
// decide a qué cuenta (slot) pertenece el PIN; el cliente nunca elige cuenta.
export const PinSchema = z.string().regex(/^\d{4}$/, 'El código debe tener 4 dígitos');
export const PinLoginInputSchema = z.strictObject({ pin: PinSchema });
export const PinSetupInputSchema = z.strictObject({
  answer: z.string().trim().min(1).max(100),
  pin: PinSchema,
});
export const PinStatusResponseSchema = z.strictObject({ memberPinSet: z.boolean() });
export const ChangePinInputSchema = z.strictObject({
  currentPin: PinSchema,
  newPin: PinSchema,
}).refine((value) => value.currentPin !== value.newPin, 'Elige un código diferente');
export const ChangePasswordInputSchema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: NewPasswordSchema,
}).refine((value) => value.currentPassword !== value.newPassword, 'Elige una contraseña diferente');
export const UpdateProfileInputSchema = z.strictObject({
  username: UsernameSchema.optional(),
  displayName: DisplayNameSchema.optional(),
}).refine((value) => value.username !== undefined || value.displayName !== undefined, 'Faltan cambios');
export const SessionResponseSchema = z.strictObject({
  user: PublicUserSchema.nullable(),
  csrfToken: z.string().min(16).max(512),
});
export const UserResponseSchema = z.strictObject({ user: PublicUserSchema });
export const HealthResponseSchema = z.strictObject({ status: z.literal('ok') });
export type LoginInput = z.infer<typeof LoginInputSchema>;
export type PinLoginInput = z.infer<typeof PinLoginInputSchema>;
export type PinSetupInput = z.infer<typeof PinSetupInputSchema>;
export type PinStatusResponse = z.infer<typeof PinStatusResponseSchema>;
export type ChangePinInput = z.infer<typeof ChangePinInputSchema>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordInputSchema>;
export type UpdateProfileInput = z.infer<typeof UpdateProfileInputSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
export type UserResponse = z.infer<typeof UserResponseSchema>;

export const ReadStateSchema = z.strictObject({
  userId: uuid,
  lastReadSequence: nonnegativeInteger,
  readAt: timestamp.nullable(),
});
export const ConversationSchema = z.strictObject({
  id: z.literal(CONVERSATION_ID),
  version: positiveInteger,
  lastSequence: nonnegativeInteger,
  readState: z.array(ReadStateSchema).max(2),
});
export const ConversationResponseSchema = z.strictObject({
  conversation: ConversationSchema,
  partner: PublicUserSchema,
});
export const MessageSchema = z.strictObject({
  id: uuid,
  clientMessageId: uuid,
  senderId: uuid,
  sequence: positiveInteger,
  body: MessageBodySchema,
  photoUrl: z.string().regex(/^\/api\/messages\/[0-9a-f-]{36}\/photo$/i).optional(),
  videoUrl: z.string().regex(/^\/api\/messages\/[0-9a-f-]{36}\/video$/i).optional(),
  replyTo: z.strictObject({
    messageId: uuid,
    senderId: uuid,
    body: MessageBodySchema,
    photoUrl: z.string().regex(/^\/api\/messages\/[0-9a-f-]{36}\/photo$/i).optional(),
    videoUrl: z.string().regex(/^\/api\/messages\/[0-9a-f-]{36}\/video$/i).optional(),
  }).refine((value) => !(value.photoUrl && value.videoUrl), 'Sólo un adjunto por mensaje').optional(),
  createdAt: timestamp,
}).refine((value) => !(value.photoUrl && value.videoUrl), 'Sólo un adjunto por mensaje');
export const SendMessageInputSchema = z.strictObject({
  clientMessageId: uuid,
  body: MessageBodySchema,
  conversationVersion: positiveInteger,
  replyToMessageId: uuid.optional(),
});
export const MessageCreatedEventSchema = z.strictObject({ message: MessageSchema });
export const MessagesQuerySchema = z.strictObject({
  before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).refine((value) => !(value.before !== undefined && value.after !== undefined), 'Usa sólo before o after');
export const MessagesPageSchema = z.strictObject({
  messages: z.array(MessageSchema).max(100),
  hasMore: z.boolean(),
  nextCursor: nonnegativeInteger.nullable(),
  conversationVersion: positiveInteger,
});
export const MarkReadInputSchema = z.strictObject({
  lastReadSequence: nonnegativeInteger,
  conversationVersion: positiveInteger,
});
// Borrado individual: administrador o autor; vaciado: sólo administrador.
// Ambos conservan el mismo DTO y el borrado se sincroniza para las dos cuentas.
export const DeleteInputSchema = z.strictObject({ conversationVersion: positiveInteger });
export const MessageDeletedEventSchema = z.strictObject({
  messageId: uuid,
  conversationVersion: positiveInteger,
});
export const ConversationClearedEventSchema = z.strictObject({ conversationVersion: positiveInteger });
export const ReadUpdatedEventSchema = z.strictObject({
  userId: uuid,
  lastReadSequence: nonnegativeInteger,
  readAt: timestamp,
});
export const PresenceUpdatedEventSchema = z.strictObject({ userId: uuid, online: z.boolean() });
export const TypingUpdatedEventSchema = z.strictObject({ userId: uuid, isTyping: z.boolean() });
export const TypingSetInputSchema = z.strictObject({ isTyping: z.boolean() });
export const SocketAuthSchema = z.strictObject({ csrfToken: z.string().min(16).max(512) });

// Notificaciones push v5: PWA instalada en inicio (iOS 16.4+) con Web Push
// VAPID y service worker. El payload del push es vacío: el aviso mostrado es
// genérico ("Nuevo mensaje"), sin texto ni remitente, para no exponer el
// contenido a los servidores de push (Apple/Google). Sin nuevos eventos de
// socket: el push es un aviso fuera de banda al crear el mensaje.
const base64url = z.string().regex(/^[A-Za-z0-9-_]+$/, 'Clave no válida');
const pushEndpoint = z.string().min(1).max(PUSH_ENDPOINT_MAX_LENGTH)
  .refine((value) => value.startsWith('https://'), 'Endpoint no válido')
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Endpoint no válido');
export const PushSubscriptionKeysSchema = z.strictObject({
  p256dh: base64url.min(80).max(90),
  auth: base64url.min(20).max(30),
});
export const PushSubscriptionSchema = z.strictObject({
  endpoint: pushEndpoint,
  keys: PushSubscriptionKeysSchema,
  expirationTime: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});
export const SavePushSubscriptionInputSchema = z.strictObject({
  subscription: PushSubscriptionSchema,
});
export const DeletePushSubscriptionInputSchema = z.strictObject({
  endpoint: pushEndpoint,
});
export const VapidKeyResponseSchema = z.strictObject({
  publicKey: z.string().nullable(),
  enabled: z.boolean(),
});
export const PushSubscriptionSavedResponseSchema = z.strictObject({
  saved: z.literal(true),
});

export type Conversation = z.infer<typeof ConversationSchema>;
export type ConversationResponse = z.infer<typeof ConversationResponseSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;
export type MessagesQuery = z.infer<typeof MessagesQuerySchema>;
export type MessagesPage = z.infer<typeof MessagesPageSchema>;
export type MarkReadInput = z.infer<typeof MarkReadInputSchema>;
export type DeleteInput = z.infer<typeof DeleteInputSchema>;
export type MessageCreatedEvent = z.infer<typeof MessageCreatedEventSchema>;
export type MessageDeletedEvent = z.infer<typeof MessageDeletedEventSchema>;
export type ConversationClearedEvent = z.infer<typeof ConversationClearedEventSchema>;
export type ReadUpdatedEvent = z.infer<typeof ReadUpdatedEventSchema>;
export type PresenceUpdatedEvent = z.infer<typeof PresenceUpdatedEventSchema>;
export type TypingUpdatedEvent = z.infer<typeof TypingUpdatedEventSchema>;
export type TypingSetInput = z.infer<typeof TypingSetInputSchema>;
export type PushSubscriptionKeys = z.infer<typeof PushSubscriptionKeysSchema>;
export type PushSubscription = z.infer<typeof PushSubscriptionSchema>;
export type SavePushSubscriptionInput = z.infer<typeof SavePushSubscriptionInputSchema>;
export type DeletePushSubscriptionInput = z.infer<typeof DeletePushSubscriptionInputSchema>;
export type VapidKeyResponse = z.infer<typeof VapidKeyResponseSchema>;

export const ErrorCodeSchema = z.enum([
  'UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_ERROR', 'INVALID_CREDENTIALS',
  'RATE_LIMITED', 'PASSWORD_CHANGE_REQUIRED', 'USERNAME_TAKEN', 'CONVERSATION_CHANGED',
  'MESSAGE_NOT_FOUND', 'MESSAGE_DELETED', 'UPLOAD_INVALID', 'CSRF_INVALID',
  'IDEMPOTENCY_CONFLICT', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR',
  'PIN_LOCKED', 'PIN_REQUIRED',
]);
export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({ code: ErrorCodeSchema, message: z.string().min(1).max(300) }),
});
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;

export interface ServerToClientEvents {
  'message:created': (event: MessageCreatedEvent) => void;
  'message:deleted': (event: MessageDeletedEvent) => void;
  'conversation:cleared': (event: ConversationClearedEvent) => void;
  'profile:updated': (event: UserResponse) => void;
  'read:updated': (event: ReadUpdatedEvent) => void;
  'presence:updated': (event: PresenceUpdatedEvent) => void;
  'typing:updated': (event: TypingUpdatedEvent) => void;
}
export interface ClientToServerEvents {
  'typing:set': (event: TypingSetInput) => void;
}

export const SERVER_EVENT_SCHEMAS = {
  'message:created': MessageCreatedEventSchema,
  'message:deleted': MessageDeletedEventSchema,
  'conversation:cleared': ConversationClearedEventSchema,
  'profile:updated': UserResponseSchema,
  'read:updated': ReadUpdatedEventSchema,
  'presence:updated': PresenceUpdatedEventSchema,
  'typing:updated': TypingUpdatedEventSchema,
} as const;

export const API_ROUTES = {
  health: '/api/health', ready: '/api/ready', session: '/api/auth/session',
  login: '/api/auth/login', logout: '/api/auth/logout', changePassword: '/api/auth/change-password',
  pinStatus: '/api/auth/pin-status', pinSetup: '/api/auth/pin-setup', pinLogin: '/api/auth/pin-login',
  changePin: '/api/auth/change-pin',
  me: '/api/users/me', myAvatar: '/api/users/me/avatar', conversation: '/api/conversation',
  messages: '/api/messages', sendPhoto: '/api/messages/photo', sendVideo: '/api/messages/video', read: '/api/conversation/read', clearMessages: '/api/conversation/messages',
  vapidKey: '/api/push/vapid-key', pushSubscriptions: '/api/push/subscriptions',
  message: (id: string) => `/api/messages/${encodeURIComponent(id)}`,
  messagePhoto: (id: string) => `/api/messages/${encodeURIComponent(id)}/photo`,
  messageVideo: (id: string) => `/api/messages/${encodeURIComponent(id)}/video`,
  avatar: (id: string, version: number) => `/api/users/${encodeURIComponent(id)}/avatar?v=${version}`,
} as const;

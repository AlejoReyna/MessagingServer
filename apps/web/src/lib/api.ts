import {
  API_ROUTES,
  ApiErrorSchema,
  ChangePasswordInputSchema,
  ChangePinInputSchema,
  ConversationResponseSchema,
  LoginInputSchema,
  MessageSchema,
  MAX_CHAT_VIDEO_BYTES,
  VIDEO_MIME_TYPES,
  MessagesPageSchema,
  PinLoginInputSchema,
  PinSetupInputSchema,
  PinStatusResponseSchema,
  PushSubscriptionSavedResponseSchema,
  ReadUpdatedEventSchema,
  SessionResponseSchema,
  UpdateProfileInputSchema,
  UserResponseSchema,
  VapidKeyResponseSchema,
  type ChangePasswordInput,
  type ChangePinInput,
  type ConversationResponse,
  type DeleteInput,
  type LoginInput,
  type MarkReadInput,
  type Message,
  type MessagesPage,
  type PinLoginInput,
  type PinSetupInput,
  type PinStatusResponse,
  type PublicUser,
  type PushSubscription,
  type SendMessageInput,
  type SessionResponse,
  type UpdateProfileInput,
  type VapidKeyResponse,
} from '@private-chat/contracts';

export type { ConversationResponse, Message, MessagesPage, PublicUser, SessionResponse };

export interface ApiFailure extends Error {
  status: number;
  code: string;
}

export function toApiFailure(status: number, code: string, message: string): ApiFailure {
  const err = new Error(message) as ApiFailure;
  err.status = status;
  err.code = code;
  return err;
}

/** Mensajes de error legibles en español por código de contrato. */
export function friendlyErrorMessage(code: string, fallback: string): string {
  switch (code) {
    case 'INVALID_CREDENTIALS': return 'Usuario o contraseña incorrectos.';
    case 'PIN_LOCKED': return 'Código bloqueado por demasiados intentos. Espera unos minutos.';
    case 'PIN_REQUIRED': return 'Esta cuenta usa código de 4 dígitos.';
    case 'PASSWORD_CHANGE_REQUIRED': return 'Debes cambiar tu contraseña antes de continuar.';
    case 'CONVERSATION_CHANGED': return 'La conversación cambió. Se recargó el historial.';
    case 'IDEMPOTENCY_CONFLICT': return 'Ese mensaje ya se había enviado con otro contenido.';
    case 'USERNAME_TAKEN': return 'Ese nombre de usuario ya está en uso.';
    case 'VALIDATION_ERROR': return fallback || 'Revisa los datos ingresados.';
    case 'UNAUTHENTICATED': return 'Tu sesión expiró. Inicia sesión de nuevo.';
    case 'FORBIDDEN': return 'No tienes permiso para hacer eso.';
    case 'RATE_LIMITED': return 'Demasiados intentos. Espera un momento e inténtalo de nuevo.';
    case 'UPLOAD_INVALID': return 'Imagen no válida. Usa JPEG, PNG o WebP de hasta 5 MiB.';
    case 'MESSAGE_NOT_FOUND': return 'Ese mensaje ya no existe.';
    case 'SERVICE_UNAVAILABLE': return 'El servicio no está disponible. Inténtalo más tarde.';
    default: return fallback || 'Ocurrió un error. Inténtalo de nuevo.';
  }
}

async function parseFailure(res: Response, messages: Record<string, string> = {}): Promise<never> {
  let code = 'INTERNAL_ERROR';
  let message = `Error ${res.status}`;
  try {
    const json: unknown = await res.json();
    const parsed = ApiErrorSchema.safeParse(json);
    if (parsed.success) {
      code = parsed.data.error.code;
      message = parsed.data.error.message;
    } else if (typeof json === 'object' && json !== null) {
      const maybe = (json as { error?: { message?: unknown } }).error;
      if (maybe && typeof maybe.message === 'string' && maybe.message.length > 0) {
        message = maybe.message;
      }
    }
  } catch {
    message = res.statusText ? `Error ${res.status}: ${res.statusText}` : `Error ${res.status}`;
  }
  throw toApiFailure(res.status, code, messages[code] ?? friendlyErrorMessage(code, message));
}

async function json<T>(res: Response, parse: (v: unknown) => T, messages?: Record<string, string>): Promise<T> {
  if (!res.ok) await parseFailure(res, messages);
  const data: unknown = res.status === 204 ? {} : await res.json();
  return parse(data);
}

export interface RequestOpts {
  csrfToken?: string;
  signal?: AbortSignal;
}

function headers(csrfToken?: string, extra?: Record<string, string>): HeadersInit {
  const h: Record<string, string> = { Accept: 'application/json', ...(extra ?? {}) };
  if (csrfToken) h['X-CSRF-Token'] = csrfToken;
  return h;
}

export async function getSession(signal?: AbortSignal): Promise<SessionResponse> {
  const res = await fetch(API_ROUTES.session, { credentials: 'include', signal });
  return json(res, (v) => SessionResponseSchema.parse(v));
}

export async function login(input: LoginInput, csrfToken: string, signal?: AbortSignal): Promise<SessionResponse> {
  const parsed = LoginInputSchema.parse(input);
  const res = await fetch(API_ROUTES.login, {
    method: 'POST',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(parsed),
    signal,
  });
  return json(res, (v) => SessionResponseSchema.parse(v));
}

export async function logout(csrfToken: string): Promise<void> {
  const res = await fetch(API_ROUTES.logout, {
    method: 'POST',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  });
  if (!res.ok && res.status !== 401) await parseFailure(res);
}

export async function changePassword(input: ChangePasswordInput, csrfToken: string): Promise<SessionResponse> {
  const parsed = ChangePasswordInputSchema.parse(input);
  const res = await fetch(API_ROUTES.changePassword, {
    method: 'POST',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(parsed),
  });
  return json(res, (v) => SessionResponseSchema.parse(v));
}

/** Cambio del código de 4 dígitos (autenticado). Devuelve el perfil actualizado. */
export async function changePin(input: ChangePinInput, csrfToken: string): Promise<PublicUser> {
  const parsed = ChangePinInputSchema.parse(input);
  const res = await fetch(API_ROUTES.changePin, {
    method: 'POST',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(parsed),
  });
  const data = await json(res, (v) => UserResponseSchema.parse(v));
  return data.user;
}

/** Acceso con PIN v2: estado del alta del invitado (público, sin secretos). */
export async function getPinStatus(signal?: AbortSignal): Promise<PinStatusResponse> {
  const res = await fetch(API_ROUTES.pinStatus, { credentials: 'include', signal });
  return json(res, (v) => PinStatusResponseSchema.parse(v));
}

/** Alta del invitado: respuesta secreta + código de 4 dígitos (una sola vez). */
export async function pinSetup(input: PinSetupInput, csrfToken: string): Promise<SessionResponse> {
  const parsed = PinSetupInputSchema.parse(input);
  const res = await fetch(API_ROUTES.pinSetup, {
    method: 'POST',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(parsed),
  });
  return json(res, (v) => SessionResponseSchema.parse(v), {
    INVALID_CREDENTIALS: 'La respuesta a la pregunta no es correcta. Revísala e inténtalo de nuevo.',
    IDEMPOTENCY_CONFLICT: 'El código de invitado ya fue creado. Ingresa con ese código.',
  });
}

/** Entrada con código de 4 dígitos (el servidor decide la cuenta). */
export async function pinLogin(input: PinLoginInput, csrfToken: string): Promise<SessionResponse> {
  const parsed = PinLoginInputSchema.parse(input);
  const res = await fetch(API_ROUTES.pinLogin, {
    method: 'POST',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(parsed),
  });
  return json(res, (v) => SessionResponseSchema.parse(v), {
    INVALID_CREDENTIALS: 'Código incorrecto. Inténtalo de nuevo.',
  });
}

export async function updateProfile(input: UpdateProfileInput, csrfToken: string): Promise<PublicUser> {
  const parsed = UpdateProfileInputSchema.parse(input);
  const res = await fetch(API_ROUTES.me, {
    method: 'PATCH',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(parsed),
  });
  const data = await json(res, (v) => UserResponseSchema.parse(v));
  return data.user;
}

const ACCEPTED_AVATARS = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function validateAvatarFile(file: File): string | null {
  if (!ACCEPTED_AVATARS.has(file.type)) return 'Usa una imagen JPEG, PNG o WebP.';
  if (file.size > 5 * 1024 * 1024) return 'La imagen no debe superar 5 MiB.';
  if (file.size === 0) return 'La imagen está vacía.';
  return null;
}

export async function uploadAvatar(file: File, csrfToken: string): Promise<PublicUser> {
  const problem = validateAvatarFile(file);
  if (problem) throw toApiFailure(400, 'UPLOAD_INVALID', problem);
  const form = new FormData();
  form.append('avatar', file, file.name);
  const h: Record<string, string> = { Accept: 'application/json' };
  if (csrfToken) h['X-CSRF-Token'] = csrfToken;
  const res = await fetch(API_ROUTES.myAvatar, { method: 'POST', credentials: 'include', headers: h, body: form });
  const data = await json(res, (v) => UserResponseSchema.parse(v));
  return data.user;
}

export async function deleteAvatar(csrfToken: string): Promise<PublicUser> {
  const res = await fetch(API_ROUTES.myAvatar, {
    method: 'DELETE',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({}),
  });
  const data = await json(res, (v) => UserResponseSchema.parse(v));
  return data.user;
}

export function avatarSrc(user: Pick<PublicUser, 'id' | 'avatarUrl' | 'avatarVersion'>): string | null {
  if (!user.avatarUrl) return null;
  // La URL privada viene del contrato; se pide con cookies del navegador.
  return `/api/users/${encodeURIComponent(user.id)}/avatar?v=${user.avatarVersion}`;
}

export async function getConversation(signal?: AbortSignal): Promise<ConversationResponse> {
  const res = await fetch(API_ROUTES.conversation, { credentials: 'include', signal });
  return json(res, (v) => ConversationResponseSchema.parse(v));
}

export interface MessagesParams {
  limit?: number;
  before?: number;
  after?: number;
  signal?: AbortSignal;
}

export async function getMessages(params: MessagesParams = {}): Promise<MessagesPage> {
  const q = new URLSearchParams();
  q.set('limit', String(params.limit ?? 50));
  if (params.before !== undefined) q.set('before', String(params.before));
  if (params.after !== undefined) q.set('after', String(params.after));
  const res = await fetch(`${API_ROUTES.messages}?${q.toString()}`, { credentials: 'include', signal: params.signal });
  return json(res, (v) => MessagesPageSchema.parse(v));
}

export async function sendMessage(input: SendMessageInput, csrfToken: string, replyToMessageId?: string): Promise<{ message: Message; repeated: boolean }> {
  const res = await fetch(API_ROUTES.messages, {
    method: 'POST',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(replyToMessageId ? { ...input, replyToMessageId } : input),
  });
  if (!res.ok) await parseFailure(res);
  const data: unknown = await res.json();
  const parsed = MessageSchema.safeParse((data as { message?: unknown })?.message);
  if (!parsed.success) throw toApiFailure(res.status, 'INTERNAL_ERROR', 'Respuesta no válida del servidor.');
  return { message: parsed.data, repeated: res.status === 200 };
}

export async function sendPhoto(file: File, input: SendMessageInput, csrfToken: string, replyToMessageId?: string): Promise<{ message: Message; repeated: boolean }> {
  const problem = validateAvatarFile(file);
  if (problem) throw toApiFailure(400, 'UPLOAD_INVALID', problem);
  const form = new FormData();
  form.append('clientMessageId', input.clientMessageId);
  form.append('conversationVersion', String(input.conversationVersion));
  form.append('body', input.body);
  if (replyToMessageId) form.append('replyToMessageId', replyToMessageId);
  form.append('photo', file, 'photo');
  const res = await fetch(API_ROUTES.sendPhoto, {
    method: 'POST', credentials: 'include', headers: headers(csrfToken), body: form,
  });
  if (!res.ok) await parseFailure(res);
  const data = await res.json() as { message: unknown };
  return { message: MessageSchema.parse(data.message), repeated: res.status === 200 };
}

export function validateVideoFile(file: File): string | null {
  if (!file.size || file.size > MAX_CHAT_VIDEO_BYTES) return 'El video debe pesar como máximo 50 MiB.';
  if (file.type && !(VIDEO_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'Elige un video MP4, MOV o WebM.';
  }
  if (!file.type && !/\.(mp4|mov|webm)$/i.test(file.name)) return 'Elige un video MP4, MOV o WebM.';
  return null;
}

export async function sendVideo(file: File, input: SendMessageInput, csrfToken: string, replyToMessageId?: string): Promise<{ message: Message; repeated: boolean }> {
  const problem = validateVideoFile(file);
  if (problem) throw toApiFailure(400, 'UPLOAD_INVALID', problem);
  const form = new FormData();
  form.append('clientMessageId', input.clientMessageId);
  form.append('conversationVersion', String(input.conversationVersion));
  form.append('body', input.body);
  if (replyToMessageId) form.append('replyToMessageId', replyToMessageId);
  form.append('video', file, 'video');
  const res = await fetch(API_ROUTES.sendVideo, {
    method: 'POST', credentials: 'include', headers: headers(csrfToken), body: form,
  });
  if (!res.ok) await parseFailure(res, { UPLOAD_INVALID: 'Video no válido. Usa MP4, MOV o WebM de hasta 50 MiB y 3 minutos.' });
  const data = await res.json() as { message: unknown };
  return { message: MessageSchema.parse(data.message), repeated: res.status === 200 };
}

export async function markRead(input: MarkReadInput, csrfToken: string): Promise<{ userId: string; lastReadSequence: number; readAt: string }> {
  const res = await fetch(API_ROUTES.read, {
    method: 'POST',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
  });
  return json(res, (v) => ReadUpdatedEventSchema.parse(v));
}

export async function deleteMessage(messageId: string, input: DeleteInput, csrfToken: string): Promise<{ messageId: string; conversationVersion: number }> {
  const res = await fetch(API_ROUTES.message(messageId), {
    method: 'DELETE',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
  });
  if (!res.ok) await parseFailure(res);
  const data: unknown = await res.json();
  const id = (data as { messageId?: unknown }).messageId;
  const version = (data as { conversationVersion?: unknown }).conversationVersion;
  if (typeof id !== 'string' || typeof version !== 'number') {
    throw toApiFailure(res.status, 'INTERNAL_ERROR', 'Respuesta no válida del servidor.');
  }
  return { messageId: id, conversationVersion: version };
}

export async function clearConversation(input: DeleteInput, csrfToken: string): Promise<{ conversationVersion: number }> {
  const res = await fetch(API_ROUTES.clearMessages, {
    method: 'DELETE',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(input),
  });
  if (!res.ok) await parseFailure(res);
  const data: unknown = await res.json();
  const version = (data as { conversationVersion?: unknown }).conversationVersion;
  if (typeof version !== 'number') throw toApiFailure(res.status, 'INTERNAL_ERROR', 'Respuesta no válida del servidor.');
  return { conversationVersion: version };
}

/** Clave pública VAPID (pública por diseño). Dice si el servidor tiene push activo. */
export async function getVapidKey(signal?: AbortSignal): Promise<VapidKeyResponse> {
  const res = await fetch(API_ROUTES.vapidKey, { credentials: 'include', signal });
  return json(res, (v) => VapidKeyResponseSchema.parse(v));
}

/** Guarda la suscripción push de este navegador/dispositivo (autenticado + CSRF). */
export async function savePushSubscription(subscription: PushSubscription, csrfToken: string): Promise<void> {
  const res = await fetch(API_ROUTES.pushSubscriptions, {
    method: 'POST',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ subscription }),
  });
  if (!res.ok) await parseFailure(res);
  PushSubscriptionSavedResponseSchema.parse(await res.json());
}

/** Borra la suscripción push de este navegador/dispositivo (idempotente). */
export async function deletePushSubscription(endpoint: string, csrfToken: string): Promise<void> {
  const res = await fetch(API_ROUTES.pushSubscriptions, {
    method: 'DELETE',
    credentials: 'include',
    headers: headers(csrfToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok && res.status !== 204) await parseFailure(res);
}

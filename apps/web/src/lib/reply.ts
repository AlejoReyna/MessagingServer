import { PHOTO_MESSAGE_BODY, VIDEO_MESSAGE_BODY, type Message } from '@private-chat/contracts';

/** Cita lista para mostrar o enviar como pendiente (autor resuelto al elegir). */
export interface ReplySnapshot {
  author: string;
  messageId: string;
  senderId: string;
  body: string;
  photoUrl?: string;
  videoUrl?: string;
}

export function snapshotOf(message: Message, author: string): ReplySnapshot {
  return {
    author,
    messageId: message.id,
    senderId: message.senderId,
    body: message.body,
    ...(message.photoUrl ? { photoUrl: message.photoUrl } : {}),
    ...(message.videoUrl ? { videoUrl: message.videoUrl } : {}),
  };
}

/** Texto corto de la cita: foto, video o inicio del texto. */
export function snippetOf(body: string, photoUrl?: string, videoUrl?: string): string {
  if (photoUrl && body === PHOTO_MESSAGE_BODY) return '📷 Foto';
  if (videoUrl && body === VIDEO_MESSAGE_BODY) return '🎬 Video';
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

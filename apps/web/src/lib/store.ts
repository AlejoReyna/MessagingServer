/** Lógica pura del cliente para no perder ni duplicar mensajes. Sin React: testeable. */
import type { Message } from '@private-chat/contracts';
import type { ReplySnapshot } from './reply';

export interface PendingMessage {
  clientMessageId: string;
  body: string;
  conversationVersion: number;
  status: 'pending' | 'failed';
  error?: string;
  photo?: File;
  video?: File;
  replyTo?: ReplySnapshot;
}

/** Inserta ordenando por sequence y deduplicando por id. */
export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) {
    if (!byId.has(m.id)) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

/** Elimina duplicados entre HTTP y socket por id o por clientMessageId. */
export function dedupeCreated(existing: Message[], event: { message: Message }): Message[] {
  const msg = event.message;
  if (existing.some((m) => m.id === msg.id || m.clientMessageId === msg.clientMessageId)) {
    // Si ya existía por clientMessageId pero con otro id temporal, reemplazar.
    return existing.map((m) =>
      m.clientMessageId === msg.clientMessageId && m.id !== msg.id ? msg : m,
    );
  }
  return [...existing, msg].sort((a, b) => a.sequence - b.sequence);
}

/** Aplica borrado individual: quita el mensaje y sube la versión. */
export function applyDeleted(
  messages: Message[],
  event: { messageId: string; conversationVersion: number },
  version: number,
): { messages: Message[]; version: number } {
  return {
    messages: messages.filter((m) => m.id !== event.messageId),
    version: Math.max(version, event.conversationVersion),
  };
}

export interface ClearedResult {
  messages: Message[];
  pending: PendingMessage[];
  version: number;
}

/**
 * Aplica un vaciado: limpia historial y DESCARTA pendientes de versión anterior.
 * Nunca se reenvían automáticamente textos pendientes antiguos ni se resucitan borrados.
 */
export function applyCleared(
  messages: Message[],
  pending: PendingMessage[],
  event: { conversationVersion: number },
  version: number,
): ClearedResult {
  const nextVersion = Math.max(version, event.conversationVersion);
  void messages;
  return { messages: [], pending: [], version: nextVersion };
}

/** ¿El evento/socket trae una versión más nueva que la conocida? Entonces invalidar y recargar. */
export function isVersionStale(knownVersion: number, incomingVersion: number): boolean {
  return incomingVersion > knownVersion;
}

/** Filtra eventos bufferizados anteriores o duplicados respecto al historial HTTP. */
export function reconcileBuffer(
  httpMessages: Message[],
  bufferedCreated: Array<{ message: Message }>,
  lastSequence: number,
): Message[] {
  const ids = new Set(httpMessages.map((m) => m.id));
  const clientIds = new Set(httpMessages.map((m) => m.clientMessageId));
  const fresh = bufferedCreated
    .map((e) => e.message)
    .filter((m) => m.sequence > lastSequence || (!ids.has(m.id) && !clientIds.has(m.clientMessageId)));
  return mergeMessages(httpMessages, fresh);
}

/** Al confirmar por HTTP, quitar el pendiente con el mismo clientMessageId (idempotencia). */
export function dropPendingFor(pending: PendingMessage[], clientMessageId: string): PendingMessage[] {
  return pending.filter((p) => p.clientMessageId !== clientMessageId);
}

/** Reintento manual: sólo si la versión sigue vigente; si cambió, se descarta. */
export function canRetry(pending: PendingMessage, currentVersion: number): boolean {
  return pending.conversationVersion === currentVersion;
}

export function maxSequence(messages: Message[]): number {
  let max = 0;
  for (const m of messages) if (m.sequence > max) max = m.sequence;
  return max;
}

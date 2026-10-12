import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  SERVER_EVENT_SCHEMAS,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '@private-chat/contracts';

export type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface SocketHandlers {
  onCreated: (e: { message: import('@private-chat/contracts').Message }) => void;
  onDeleted: (e: { messageId: string; conversationVersion: number }) => void;
  onCleared: (e: { conversationVersion: number }) => void;
  onProfile: (e: { user: import('@private-chat/contracts').PublicUser }) => void;
  onRead: (e: { userId: string; lastReadSequence: number; readAt: string }) => void;
  onPresence: (e: { userId: string; online: boolean }) => void;
  onTyping: (e: { userId: string; isTyping: boolean }) => void;
  onConnectState: (connected: boolean) => void;
}

/** Valida cada payload con el schema del contrato; ignora eventos inválidos. */
function valid<K extends keyof typeof SERVER_EVENT_SCHEMAS>(key: K, payload: unknown): boolean {
  return SERVER_EVENT_SCHEMAS[key].safeParse(payload).success;
}

/**
 * Crea el socket con path estándar /socket.io, cookies y auth {csrfToken}.
 * El llamador debe reconectar obteniendo sesión actual (nuevo csrf) ante reconnect.
 */
export function useChatSocket(
  enabled: boolean,
  csrfToken: string,
  sessionEpoch: number,
  handlers: SocketHandlers,
): ChatSocket | null {
  const socketRef = useRef<ChatSocket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled || !csrfToken) return;
    const socket: ChatSocket = io({
      path: '/socket.io',
      // El handshake WS de los navegadores incluye Origin incluso en mismo
      // origen; el servidor lo exige junto con cookies y CSRF.
      transports: ['websocket'],
      withCredentials: true,
      auth: { csrfToken },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
    });
    socketRef.current = socket;

    socket.on('connect', () => handlersRef.current.onConnectState(true));
    socket.on('disconnect', () => handlersRef.current.onConnectState(false));
    socket.on('message:created', (p) => { if (valid('message:created', p)) handlersRef.current.onCreated(p); });
    socket.on('message:deleted', (p) => { if (valid('message:deleted', p)) handlersRef.current.onDeleted(p); });
    socket.on('conversation:cleared', (p) => { if (valid('conversation:cleared', p)) handlersRef.current.onCleared(p); });
    socket.on('profile:updated', (p) => { if (valid('profile:updated', p)) handlersRef.current.onProfile(p); });
    socket.on('read:updated', (p) => { if (valid('read:updated', p)) handlersRef.current.onRead(p); });
    socket.on('presence:updated', (p) => { if (valid('presence:updated', p)) handlersRef.current.onPresence(p); });
    socket.on('typing:updated', (p) => { if (valid('typing:updated', p)) handlersRef.current.onTyping(p); });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
    // sessionEpoch fuerza recrear el socket con el csrf fresco tras refresh/reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, csrfToken, sessionEpoch]);

  // Exponer instancia actual (se actualiza por render; suficiente para emitir typing:set).
  return socketRef.current;
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PHOTO_MESSAGE_BODY, VIDEO_MESSAGE_BODY, type Message, type PublicUser } from '@private-chat/contracts';
import {
  clearConversation,
  deleteMessage as apiDeleteMessage,
  getConversation,
  getMessages,
  markRead as apiMarkRead,
  sendMessage as apiSendMessage,
  sendPhoto as apiSendPhoto,
  sendVideo as apiSendVideo,
  type ApiFailure,
} from '../lib/api';
import {
  applyCleared,
  applyDeleted,
  canRetry,
  dedupeCreated,
  dropPendingFor,
  isVersionStale,
  maxSequence,
  mergeMessages,
  reconcileBuffer,
  type PendingMessage,
} from '../lib/store';
import { useChatSocket } from './useSocket';
import { snapshotOf } from '../lib/reply';

export interface ReadEntry { lastReadSequence: number; readAt: string | null; }

/** Cita elegida en el compositor: mensaje original y autor ya resuelto. */
export interface ReplyTarget { message: Message; author: string; }

interface ChatApi {
  messages: Message[];
  pending: PendingMessage[];
  partner: PublicUser | null;
  version: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadError: string | null;
  connected: boolean;
  partnerTyping: boolean;
  partnerOnline: boolean | null;
  readByPartner: number;
  myRead: number;
  send: (body: string, replyTo?: ReplyTarget | null) => Promise<void>;
  sendPhoto: (file: File, caption: string, replyTo?: ReplyTarget | null) => Promise<void>;
  sendVideo: (file: File, caption: string, replyTo?: ReplyTarget | null) => Promise<void>;
  retry: (clientMessageId: string) => Promise<void>;
  discardPending: (clientMessageId: string) => void;
  loadMore: () => Promise<void>;
  reload: () => Promise<void>;
  removeMessage: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  setTyping: (isTyping: boolean) => void;
  notice: string | null;
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function useChat(me: PublicUser | null, csrfToken: string, sessionEpoch: number, onSessionExpired: () => void): ChatApi {
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [partner, setPartner] = useState<PublicUser | null>(null);
  const [version, setVersion] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [beforeCursor, setBeforeCursor] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [presence, setPresence] = useState<Map<string, boolean>>(new Map());
  const [reads, setReads] = useState<Map<string, ReadEntry>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);

  const versionRef = useRef(1);
  const lastSeqRef = useRef(0);
  const loadedRef = useRef(false);
  const bufferRef = useRef<Array<{ message: Message }>>([]);
  const pendingVersionBumpRef = useRef<number | null>(null);
  const readTimer = useRef<number | null>(null);
  const typingTimer = useRef<number | null>(null);
  const typingSent = useRef(false);
  const socketEmitRef = useRef<((event: 'typing:set', data: { isTyping: boolean }) => void) | null>(null);

  versionRef.current = version;

  const fail = useCallback((e: unknown, fallback: string) => {
    const f = e as ApiFailure;
    if (f?.status === 401 || f?.code === 'UNAUTHENTICATED') {
      onSessionExpired();
      return f?.message ?? 'Tu sesión expiró. Inicia sesión de nuevo.';
    }
    return (f?.message as string | undefined) ?? fallback;
  }, [onSessionExpired]);

  const catchUp = useCallback(async (after: number, csrfIgnored?: string) => {
    void csrfIgnored;
    let cursor = after;
    for (let i = 0; i < 20; i++) {
      const page = await getMessages({ after: cursor, limit: 100 });
      if (isVersionStale(versionRef.current, page.conversationVersion)) {
        // Versión más nueva: invalidar y recargar todo.
        return { stale: true as const, version: page.conversationVersion };
      }
      if (page.messages.length === 0) return { stale: false as const };
      setMessages((prev) => mergeMessages(prev, page.messages));
      const m = maxSequence(page.messages);
      if (m > lastSeqRef.current) lastSeqRef.current = m;
      if (!page.hasMore || page.nextCursor == null) return { stale: false as const };
      cursor = page.nextCursor;
    }
    return { stale: false as const };
  }, []);

  const fullReload = useCallback(async () => {
    const conv = await getConversation();
    setPartner(conv.partner);
    setVersion(conv.conversation.version);
    versionRef.current = conv.conversation.version;
    lastSeqRef.current = conv.conversation.lastSequence;
    const initial = new Map<string, ReadEntry>();
    for (const r of conv.conversation.readState) {
      initial.set(r.userId, { lastReadSequence: r.lastReadSequence, readAt: r.readAt });
    }
    setReads(initial);
    const page = await getMessages({ limit: 50 });
    if (isVersionStale(versionRef.current, page.conversationVersion)) {
      setVersion(page.conversationVersion);
      versionRef.current = page.conversationVersion;
    }
    const merged = reconcileBuffer(page.messages, bufferRef.current, maxSequence(page.messages));
    bufferRef.current = [];
    setMessages(merged);
    const mx = Math.max(maxSequence(merged), conv.conversation.lastSequence);
    lastSeqRef.current = mx;
    setHasMore(page.hasMore);
    setBeforeCursor(page.nextCursor);
    // Recuperar lo que llegó por socket durante la carga.
    if (merged.length > 0 || bufferRef.current.length > 0) {
      await catchUp(maxSequence(merged)).then((r) => {
        if (r.stale) return fullReload();
      });
    }
  }, [catchUp]);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      await fullReload();
    } catch (e) {
      setLoadError(fail(e, 'No se pudo cargar la conversación.'));
    }
  }, [fullReload, fail]);

  // Carga inicial: el socket ya está suscrito (efecto de useChatSocket corre en paralelo
  // y bufferiza), aquí reconciliamos HTTP + buffer para no perder mensajes intermedios.
  useEffect(() => {
    if (!me || !csrfToken) return;
    let cancelled = false;
    loadedRef.current = false;
    bufferRef.current = [];
    pendingVersionBumpRef.current = null;
    setLoading(true);
    setLoadError(null);
    setMessages([]);
    setPending([]); // pendientes sólo en memoria: al remontar no se resucitan
    (async () => {
      try {
        const conv = await getConversation();
        if (cancelled) return;
        setPartner(conv.partner);
        setVersion(conv.conversation.version);
        versionRef.current = conv.conversation.version;
        lastSeqRef.current = conv.conversation.lastSequence;
        const initial = new Map<string, ReadEntry>();
        for (const r of conv.conversation.readState) {
          initial.set(r.userId, { lastReadSequence: r.lastReadSequence, readAt: r.readAt });
        }
        setReads(initial);
        const page = await getMessages({ limit: 50 });
        if (cancelled) return;
        let v = versionRef.current;
        if (isVersionStale(v, page.conversationVersion)) {
          v = page.conversationVersion;
          setVersion(v);
          versionRef.current = v;
        }
        // Si un vaciado/borrado llegó por socket durante la carga, recargar.
        const bump = pendingVersionBumpRef.current;
        if (bump != null && isVersionStale(v, bump)) {
          const page2 = await getMessages({ limit: 50 });
          if (cancelled) return;
          setMessages(page2.messages);
          lastSeqRef.current = maxSequence(page2.messages);
          setVersion(Math.max(v, page2.conversationVersion));
          versionRef.current = Math.max(v, page2.conversationVersion);
          setHasMore(page2.hasMore);
          setBeforeCursor(page2.nextCursor);
          bufferRef.current = [];
        } else {
          const merged = reconcileBuffer(page.messages, bufferRef.current, maxSequence(page.messages));
          bufferRef.current = [];
          setMessages(merged);
          const mx = Math.max(maxSequence(merged), conv.conversation.lastSequence);
          lastSeqRef.current = mx;
          setHasMore(page.hasMore);
          setBeforeCursor(page.nextCursor);
          // Cazar mensajes que llegaron entre HTTP y reconciliación.
          try {
            const r = await catchUp(mx);
            if (!cancelled && r.stale) {
              await fullReload();
              if (cancelled) return;
            }
          } catch {
            // Sin red en el catch-up: se conserva el historial cargado.
          }
        }
        if (!cancelled) {
          loadedRef.current = true;
          setLoading(false);
        }
      } catch (e) {
        if (cancelled) return;
        setLoading(false);
        setLoadError(fail(e, 'No se pudo cargar la conversación. Revisa tu conexión.'));
      }
    })();
    return () => { cancelled = true; };
    // sessionEpoch reinicia la carga con csrf fresco.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id, csrfToken, sessionEpoch]);

  const handlers = useMemo(() => ({
    onConnectState: (c: boolean) => {
      setConnected(c);
      if (c && loadedRef.current) {
        // Reconexión: recuperar faltantes por after; ante cambio de versión, recargar.
        void (async () => {
          try {
            const conv = await getConversation();
            if (isVersionStale(versionRef.current, conv.conversation.version)) {
              await fullReload();
              return;
            }
            const r = await catchUp(lastSeqRef.current);
            if (r.stale) await fullReload();
          } catch {
            // Se reintentará en la próxima reconexión o recarga manual.
          }
        })();
      }
    },
    onCreated: (e: { message: Message }) => {
      if (!loadedRef.current) {
        bufferRef.current.push(e); // bufferizar antes de reconciliar la carga HTTP
        return;
      }
      setMessages((prev) => {
        const next = dedupeCreated(prev, e);
        if (e.message.sequence > lastSeqRef.current) lastSeqRef.current = e.message.sequence;
        return next;
      });
      setPending((prev) => dropPendingFor(prev, e.message.clientMessageId));
    },
    onDeleted: (e: { messageId: string; conversationVersion: number }) => {
      if (!loadedRef.current) {
        pendingVersionBumpRef.current = Math.max(pendingVersionBumpRef.current ?? 0, e.conversationVersion);
        return;
      }
      if (isVersionStale(versionRef.current, e.conversationVersion)) {
        // Cambio de versión: invalidar y recargar historial.
        void fullReload().catch(() => setNotice('La conversación cambió. Recarga para verla actualizada.'));
        return;
      }
      setMessages((prev) => applyDeleted(prev, e, versionRef.current).messages);
      setVersion(e.conversationVersion);
      versionRef.current = e.conversationVersion;
    },
    onCleared: (e: { conversationVersion: number }) => {
      if (!loadedRef.current) {
        pendingVersionBumpRef.current = Math.max(pendingVersionBumpRef.current ?? 0, e.conversationVersion);
        return;
      }
      // Un vaciado no reenvía pendientes antiguos ni resucita borrados.
      setMessages([]);
      setPending([]);
      lastSeqRef.current = 0;
      setVersion(e.conversationVersion);
      versionRef.current = e.conversationVersion;
      setHasMore(false);
      setBeforeCursor(null);
      setNotice('La conversación fue vaciada por el administrador.');
    },
    onProfile: (e: { user: PublicUser }) => {
      setPartner((prev) => (prev && prev.id === e.user.id ? e.user : prev));
    },
    onRead: (e: { userId: string; lastReadSequence: number; readAt: string }) => {
      setReads((prev) => {
        const next = new Map(prev);
        next.set(e.userId, { lastReadSequence: e.lastReadSequence, readAt: e.readAt });
        return next;
      });
    },
    onPresence: (e: { userId: string; online: boolean }) => {
      setPresence((prev) => new Map(prev).set(e.userId, e.online));
    },
    onTyping: (e: { userId: string; isTyping: boolean }) => {
      if (me && e.userId === me.id) return;
      setPartnerTyping(e.isTyping);
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
      if (e.isTyping) {
        typingTimer.current = window.setTimeout(() => setPartnerTyping(false), 6000);
      }
    },
  }), [catchUp, fullReload, me]);

  const socket = useChatSocket(!!me && !!csrfToken, csrfToken, sessionEpoch, handlers);
  useEffect(() => {
    socketEmitRef.current = socket ? socket.emit.bind(socket) : null;
  });

  const setTyping = useCallback((isTyping: boolean) => {
    const emit = socketEmitRef.current;
    if (!emit) return;
    if (isTyping === typingSent.current) return;
    typingSent.current = isTyping;
    try {
      emit('typing:set', { isTyping }); // único evento que el cliente puede emitir
    } catch { /* sin conexión: se ignora */ }
  }, []);

  const sendContent = useCallback(async (raw: string, photo?: File, replyTo?: ReplyTarget | null, video?: File) => {
    const body = raw.trim() || (photo ? PHOTO_MESSAGE_BODY : video ? VIDEO_MESSAGE_BODY : '');
    if (!body || !me) return;
    if (body.length > 4000) {
      setNotice('El mensaje no debe superar 4000 caracteres.');
      return;
    }
    const clientMessageId = uuid();
    const v = versionRef.current;
    const replySnapshot = replyTo ? snapshotOf(replyTo.message, replyTo.author) : undefined;
    setPending((prev) => [...prev, { clientMessageId, body, conversationVersion: v, status: 'pending', photo, video, ...(replySnapshot ? { replyTo: replySnapshot } : {}) }]);
    try {
      const input = { clientMessageId, body, conversationVersion: v };
      const replyId = replyTo?.message.id;
      const { message } = await (video
        ? apiSendVideo(video, input, csrfToken, replyId)
        : photo
        ? apiSendPhoto(photo, input, csrfToken, replyId)
        : apiSendMessage(input, csrfToken, replyId));
      setMessages((prev) => dedupeCreated(prev, { message }));
      if (message.sequence > lastSeqRef.current) lastSeqRef.current = message.sequence;
      setPending((prev) => dropPendingFor(prev, clientMessageId));
    } catch (e) {
      const f = e as ApiFailure;
      if (f?.code === 'CONVERSATION_CHANGED') {
        // Versión obsoleta: invalidar, recargar y NO reenviar automáticamente.
        setPending((prev) => prev.map((p) =>
          p.clientMessageId === clientMessageId ? { ...p, status: 'failed' as const, error: 'La conversación cambió. Revisa el historial antes de reenviar.' } : p,
        ));
        try { await fullReload(); } catch { /* se muestra aviso */ }
        setNotice('La conversación cambió. Se recargó el historial.');
        return;
      }
      if (f?.code === 'IDEMPOTENCY_CONFLICT') {
        // El id ya existe con otro texto: recuperar el original, no duplicar.
        try {
          const r = await catchUp(lastSeqRef.current);
          if (r.stale) await fullReload();
        } catch { /* ignore */ }
        setPending((prev) => dropPendingFor(prev, clientMessageId));
        setNotice('Ese mensaje ya se había enviado con otro contenido.');
        return;
      }
      setPending((prev) => prev.map((p) =>
        p.clientMessageId === clientMessageId
          ? { ...p, status: 'failed' as const, error: fail(e, 'No se pudo enviar. Inténtalo de nuevo.') }
          : p,
      ));
    }
  }, [me, csrfToken, catchUp, fullReload, fail]);

  const send = useCallback((body: string, replyTo?: ReplyTarget | null) => sendContent(body, undefined, replyTo), [sendContent]);
  const sendPhoto = useCallback((file: File, caption: string, replyTo?: ReplyTarget | null) => sendContent(caption, file, replyTo), [sendContent]);
  const sendVideo = useCallback((file: File, caption: string, replyTo?: ReplyTarget | null) => sendContent(caption, undefined, replyTo, file), [sendContent]);

  const retry = useCallback(async (clientMessageId: string) => {
    const item = pending.find((p) => p.clientMessageId === clientMessageId);
    if (!item) return;
    if (!canRetry(item, versionRef.current)) {
      // Pendiente de versión anterior (p. ej. tras vaciado): descartar, no resucitar.
      setPending((prev) => dropPendingFor(prev, clientMessageId));
      setNotice('Ese mensaje es anterior al último cambio de la conversación y no se reenvió.');
      return;
    }
    setPending((prev) => prev.map((p) => (p.clientMessageId === clientMessageId ? { ...p, status: 'pending' as const, error: undefined } : p)));
    try {
      const input = { clientMessageId: item.clientMessageId, body: item.body, conversationVersion: versionRef.current };
      const replyId = item.replyTo?.messageId;
      const { message } = await (item.video
        ? apiSendVideo(item.video, input, csrfToken, replyId)
        : item.photo
        ? apiSendPhoto(item.photo, input, csrfToken, replyId)
        : apiSendMessage(input, csrfToken, replyId));
      setMessages((prev) => dedupeCreated(prev, { message }));
      if (message.sequence > lastSeqRef.current) lastSeqRef.current = message.sequence;
      setPending((prev) => dropPendingFor(prev, clientMessageId));
    } catch (e) {
      setPending((prev) => prev.map((p) =>
        p.clientMessageId === clientMessageId
          ? { ...p, status: 'failed' as const, error: fail(e, 'No se pudo enviar. Inténtalo de nuevo.') }
          : p,
      ));
    }
  }, [pending, csrfToken, fail]);

  const discardPending = useCallback((clientMessageId: string) => {
    setPending((prev) => dropPendingFor(prev, clientMessageId));
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || beforeCursor == null) return;
    setLoadingMore(true);
    try {
      const page = await getMessages({ before: beforeCursor, limit: 50 });
      if (isVersionStale(versionRef.current, page.conversationVersion)) {
        await fullReload();
        return;
      }
      setMessages((prev) => mergeMessages(page.messages, prev));
      setHasMore(page.hasMore);
      setBeforeCursor(page.nextCursor);
    } catch (e) {
      setNotice(fail(e, 'No se pudieron cargar mensajes anteriores.'));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, beforeCursor, fullReload, fail]);

  const removeMessage = useCallback(async (id: string) => {
    try {
      const r = await apiDeleteMessage(id, { conversationVersion: versionRef.current }, csrfToken);
      setMessages((prev) => prev.filter((m) => m.id !== r.messageId));
      setVersion(r.conversationVersion);
      versionRef.current = r.conversationVersion;
    } catch (e) {
      const f = e as ApiFailure;
      if (f?.code === 'CONVERSATION_CHANGED') {
        await fullReload();
        setNotice('La conversación cambió. Se recargó el historial.');
        return;
      }
      setNotice(fail(e, 'No se pudo borrar el mensaje.'));
      throw e;
    }
  }, [csrfToken, fullReload, fail]);

  const clearAll = useCallback(async () => {
    try {
      const r = await clearConversation({ conversationVersion: versionRef.current }, csrfToken);
      setMessages([]);
      setPending([]);
      lastSeqRef.current = 0;
      setVersion(r.conversationVersion);
      versionRef.current = r.conversationVersion;
      setHasMore(false);
      setBeforeCursor(null);
    } catch (e) {
      const f = e as ApiFailure;
      if (f?.code === 'CONVERSATION_CHANGED') {
        await fullReload();
        setNotice('La conversación cambió. Se recargó el historial.');
        return;
      }
      setNotice(fail(e, 'No se pudo vaciar la conversación.'));
      throw e;
    }
  }, [csrfToken, fullReload, fail]);

  // Marcar lectura: monótono, con la versión actual, del último mensaje visible.
  useEffect(() => {
    if (!me || !loadedRef.current || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!last) return;
    const myEntry = reads.get(me.id);
    if (myEntry && myEntry.lastReadSequence >= last.sequence) return;
    if (readTimer.current) window.clearTimeout(readTimer.current);
    readTimer.current = window.setTimeout(() => {
      void apiMarkRead({ lastReadSequence: last.sequence, conversationVersion: versionRef.current }, csrfToken)
        .then((r) => {
          setReads((prev) => {
            const next = new Map(prev);
            const cur = next.get(r.userId);
            if (!cur || r.lastReadSequence > cur.lastReadSequence) {
              next.set(r.userId, { lastReadSequence: r.lastReadSequence, readAt: r.readAt });
            }
            return next;
          });
        })
        .catch(() => { /* reintento en el próximo mensaje visible */ });
    }, 600);
    return () => { if (readTimer.current) window.clearTimeout(readTimer.current); };
  }, [messages, me, reads, csrfToken]);

  const partnerOnline = partner ? (presence.get(partner.id) ?? null) : null;
  const readByPartner = partner ? (reads.get(partner.id)?.lastReadSequence ?? 0) : 0;
  const myRead = me ? (reads.get(me.id)?.lastReadSequence ?? 0) : 0;

  return {
    messages, pending, partner, version,
    loading, loadingMore, hasMore, loadError, connected,
    partnerTyping, partnerOnline, readByPartner, myRead,
    send, sendPhoto, sendVideo, retry, discardPending, loadMore, reload,
    removeMessage, clearAll, setTyping, notice,
  };
}

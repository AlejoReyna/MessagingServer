import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Eraser, Github, Settings, Volume2, VolumeX, WifiOff } from 'lucide-react';
import type { Message, PublicUser } from '@private-chat/contracts';
import type { PendingMessage } from '../lib/store';
import type { ReplyTarget } from '../hooks/useChat';
import { playNotification, useSoundEnabled } from '../lib/sound';
import { formatDay } from '../lib/format';
import { AvatarView } from './AvatarView';
import { AvatarPreview } from './AvatarPreview';
import { Composer } from './Composer';
import { MessageBubble, PendingBubble } from './MessageBubble';

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function ChatPanel({
  me, partner, messages, pending, loading, loadingMore, hasMore, loadError,
  connected, partnerTyping, partnerOnline, readByPartner,
  notice, showSidebarToggle, onOpenSettings, onLoadMore, onReload,
  onSend, onSendPhoto, onSendVideo, onRetry, onDiscardPending, onTyping, onDeleteMessage, onClear, isAdmin, clearArmed,
}: {
  me: PublicUser;
  partner: PublicUser | null;
  messages: Message[];
  pending: PendingMessage[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  loadError: string | null;
  connected: boolean;
  partnerTyping: boolean;
  partnerOnline: boolean | null;
  readByPartner: number;
  notice: string | null;
  showSidebarToggle: boolean;
  onOpenSettings: () => void;
  onLoadMore: () => Promise<void>;
  onReload: () => void;
  onSend: (body: string, replyTo?: ReplyTarget | null) => Promise<void>;
  onSendPhoto?: (file: File, caption: string, replyTo?: ReplyTarget | null) => Promise<void>;
  onSendVideo?: (file: File, caption: string, replyTo?: ReplyTarget | null) => Promise<void>;
  onRetry: (id: string) => Promise<void>;
  onDiscardPending: (id: string) => void;
  onTyping: (t: boolean) => void;
  onDeleteMessage: (id: string) => void;
  onClear: () => void;
  isAdmin: boolean;
  clearArmed: boolean;
}) {
  const [partnerAvatarOpen, setPartnerAvatarOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const prevCount = useRef(0);
  // Entrada animada sólo para mensajes nuevos: el historial inicial y la
  // paginación aparecen fijos, como en WhatsApp.
  const readyRef = useRef(false);
  const maxSeenRef = useRef(0);
  // Halo bajito, desactivable, por cuenta en este navegador. Activado por defecto.
  const { enabled: soundOn, toggle: toggleSound } = useSoundEnabled(me.id);
  const soundOnRef = useRef(soundOn);
  soundOnRef.current = soundOn;

  // Registra el máximo sequence ya pintado; lo nuevo (sequence mayor) anima.
  // Si lo nuevo trae mensaje de la pareja, suena el tono una vez (bajito).
  useEffect(() => {
    if (loading) return;
    const last = messages[messages.length - 1];
    const mx = last ? last.sequence : maxSeenRef.current;
    if (!readyRef.current) {
      readyRef.current = true;
      maxSeenRef.current = Math.max(maxSeenRef.current, mx);
      return;
    }
    if (mx > maxSeenRef.current) {
      const fresh = messages.some((m) => m.sequence > maxSeenRef.current && m.senderId !== me.id);
      maxSeenRef.current = mx;
      if (fresh && soundOnRef.current) playNotification();
    }
  }, [messages, loading, me.id]);

  // Scroll al fondo sólo cuando corresponde (estábamos abajo o llegó mensaje propio).
  // La burbuja de "escribiendo" también baja la vista si estábamos abajo.
  const prevTypingRef = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || loading) return;
    const total = messages.length + pending.length;
    const grewBy = total - prevCount.current;
    prevCount.current = total;
    const typingStarted = partnerTyping && !prevTypingRef.current;
    prevTypingRef.current = partnerTyping;
    if ((grewBy > 0 || typingStarted) && stickRef.current) {
      const reduce = typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const top = el.scrollHeight;
      if (!reduce && grewBy <= 3 && typeof el.scrollTo === 'function') {
        try {
          el.scrollTo({ top, behavior: 'smooth' });
        } catch {
          el.scrollTop = top;
        }
      } else {
        el.scrollTop = top;
      }
    } else if (total === 0) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, pending, loading, partnerTyping]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    prevCount.current = messages.length + pending.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partner?.id]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distance < 120;
    // Mantener posición al cargar anteriores: anclar por altura previa.
    if (el.scrollTop < 80 && hasMore && !loadingMore) {
      const prevHeight = el.scrollHeight;
      void onLoadMore().then(() => {
        requestAnimationFrame(() => {
          const cur = scrollRef.current;
          if (cur) cur.scrollTop = cur.scrollHeight - prevHeight + cur.scrollTop;
        });
      });
    }
  }

  function authorOf(senderId: string): string {
    if (senderId === me.id) return me.displayName;
    return partner?.displayName ?? 'Contacto';
  }

  function jumpToOriginal(messageId: string) {
    const target = document.getElementById(`msg-${messageId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightId(messageId);
    if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlightId(null), 1600);
  }

  return (
    <section
      aria-label="Conversación"
      className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-surface-muted"
    >
      {/* Cabecera con avatar del contacto */}
      <header className="chat-header flex shrink-0 items-center gap-3 border-b border-line/70 bg-surface px-4 pb-3 pt-4 text-ink sm:px-6">
        {showSidebarToggle && (
          <span className="grid h-10 w-10 place-items-center rounded-full bg-surface-muted text-muted" aria-hidden="true">
            <ArrowLeft className="h-5 w-5" />
          </span>
        )}
        {partner ? (
          <>
            <button type="button" onClick={() => setPartnerAvatarOpen(true)}
              aria-label={`Ver foto de perfil de ${partner.displayName}`} title="Ver foto de perfil"
              className="relative shrink-0 rounded-full transition hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
              <AvatarView user={partner} size={44} ring />
              <span
                aria-hidden="true"
                title={partnerOnline ? 'En línea' : 'Desconectado'}
                key={partnerOnline ? 'online' : 'offline'}
                className={`status-pop absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-surface transition-colors ${
                  partnerOnline ? 'bg-success' : 'bg-line'
                }`}
              />
            </button>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[17px] font-bold leading-tight">{partner.displayName}</h2>
              <p
                aria-live="polite"
                key={partnerTyping ? 'typing' : partnerOnline ? 'online' : 'offline'}
                className="enter-up text-xs text-muted"
              >
                {partnerTyping ? 'escribiendo…' : partnerOnline ? 'En línea' : partnerOnline === false ? 'Desconectado' : ' '}
              </p>
            </div>
          </>
        ) : (
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-bold">Conversación</h2>
            <p className="text-xs text-muted">Cargando contacto…</p>
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const wasOff = !soundOnRef.current;
              toggleSound();
              if (wasOff) playNotification();
            }}
            aria-label={soundOn ? 'Silenciar sonido de notificación' : 'Activar sonido de notificación'}
            aria-pressed={soundOn}
            title={soundOn ? 'Silenciar notificaciones' : 'Activar sonido (tono suave)'}
            className="inline-grid min-h-[44px] min-w-[44px] place-items-center rounded-full text-muted transition-all duration-200 hover:scale-105 hover:bg-surface-hover hover:text-ink active:scale-95"
          >
            {soundOn ? <Volume2 className="h-5 w-5" aria-hidden="true" /> : <VolumeX className="h-5 w-5" aria-hidden="true" />}
          </button>
          {!connected && (
            <span role="status" className="enter-down inline-flex items-center gap-1 rounded-full bg-surface-muted px-3 py-1.5 text-xs font-semibold text-muted">
              <WifiOff className="h-3.5 w-3.5" aria-hidden="true" /> Reconectando
            </span>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={onClear}
              aria-label="Vaciar conversación para ambos"
              title="Vaciar conversación (administrador)"
              className="inline-grid min-h-[44px] min-w-[44px] place-items-center rounded-full text-muted transition-all duration-200 hover:scale-105 hover:bg-surface-hover hover:text-ink active:scale-95"
            >
              <Eraser className="h-5 w-5" aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Abrir ajustes y perfil"
            className="inline-grid min-h-[44px] min-w-[44px] place-items-center rounded-full text-muted transition-all duration-200 hover:scale-105 hover:bg-surface-hover hover:text-ink active:scale-95"
          >
            <Settings className="h-5 w-5" aria-hidden="true" />
          </button>
          <a
            href="https://github.com/AlejoReyna/MessagingServer"
            target="_blank"
            rel="noreferrer"
            aria-label="Abrir repositorio en GitHub"
            title="GitHub"
            className="inline-grid min-h-[44px] min-w-[44px] place-items-center rounded-full text-muted transition-all duration-200 hover:scale-105 hover:bg-surface-hover hover:text-ink active:scale-95 md:hidden"
          >
            <Github className="h-5 w-5" aria-hidden="true" />
          </a>
        </div>
      </header>

      {notice && (
        <p key={notice} role="status" className="enter-down mx-4 mt-3 rounded-2xl border border-line/70 bg-surface px-4 py-2 text-sm text-muted sm:mx-6">
          {notice}
        </p>
      )}
      {clearArmed && (
        <p className="mx-4 mt-2 text-xs text-muted sm:mx-6">Confirma el vaciado en el diálogo.</p>
      )}

      {/* Historial */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Mensajes"
        aria-live="off"
        tabIndex={0}
        className="chat-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-4 sm:px-6"
      >
        {loading ? (
          <div className="space-y-2.5" aria-label="Cargando mensajes">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`flex ${i % 2 ? 'justify-end' : 'justify-start'}`}>
                <div className="h-11 w-2/3 animate-pulse rounded-3xl bg-line/60" />
              </div>
            ))}
          </div>
        ) : loadError && messages.length === 0 ? (
          <div className="grid place-items-center py-16 text-center">
            <div className="max-w-xs rounded-3xl bg-surface p-6 text-ink">
              <p className="font-bold">No se pudo cargar el chat</p>
              <p className="mt-1 text-sm text-muted">{loadError}</p>
              <button type="button" onClick={onReload}
                className="mt-4 min-h-[44px] w-full rounded-2xl bg-accent text-sm font-bold text-on-accent transition-all duration-200 hover:brightness-110 active:scale-[0.98]">
                Reintentar
              </button>
            </div>
          </div>
        ) : messages.length === 0 && pending.length === 0 ? (
          <div className="grid min-h-full place-items-center text-center" aria-label="Chat vacío">
            <div className="enter-up flex flex-col items-center gap-5 py-6">
              <svg
                className="chat-empty-face"
                viewBox="0 0 360 220"
                fill="none"
                stroke="currentColor"
                strokeWidth="8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M40 25 C35 108 32 183 87 183 C140 183 134 96 134 25" />
                <path d="M152 150 C151 179 154 187 168 184 C180 183 182 163 184 155 C187 170 195 190 209 186 C222 184 226 168 227 150" />
                <path d="M252 25 C245 108 238 190 294 190 C350 190 345 100 345 25" />
              </svg>
              <p className="chat-empty-caption text-muted">También podíamos usar Wasap...</p>
            </div>
          </div>
        ) : (
          <>
            {hasMore && (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void onLoadMore()}
                  disabled={loadingMore}
                  className="min-h-[40px] rounded-full border border-line bg-surface px-5 text-sm font-semibold text-muted transition-all duration-200 hover:bg-surface-hover active:scale-95 disabled:opacity-60"
                >
                  {loadingMore ? 'Cargando anteriores…' : 'Cargar mensajes anteriores'}
                </button>
              </div>
            )}
            {messages.map((m, i) => {
              const prev = i > 0 ? messages[i - 1] : undefined;
              const showDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
              return (
                <div key={m.id} id={`msg-${m.id}`}
                  className={highlightId === m.id ? 'reply-flash rounded-3xl' : undefined}>
                  {showDay && (
                    <p className="enter-up mb-2 mt-3 text-center text-xs font-medium text-muted">
                      <time dateTime={m.createdAt}>{formatDay(m.createdAt)}</time>
                    </p>
                  )}
                  <MessageBubble
                    message={m}
                    mine={m.senderId === me.id}
                    read={readByPartner >= m.sequence}
                    isAdmin={isAdmin}
                    onDelete={onDeleteMessage}
                    onReply={(target) => setReplyTo({ message: target, author: authorOf(target.senderId) })}
                    replyAuthorName={m.replyTo ? authorOf(m.replyTo.senderId) : undefined}
                    onQuoteClick={jumpToOriginal}
                    animate={readyRef.current && m.sequence > maxSeenRef.current}
                  />
                </div>
              );
            })}
            {pending.map((p) => (
              <PendingBubble
                key={p.clientMessageId}
                body={p.body}
                photo={p.photo}
                video={p.video}
                replyTo={p.replyTo}
                failed={p.status === 'failed'}
                error={p.error}
                onRetry={() => void onRetry(p.clientMessageId)}
                onDiscard={() => onDiscardPending(p.clientMessageId)}
                onQuoteClick={jumpToOriginal}
              />
            ))}
            {partnerTyping && (
              <div className="enter-up flex justify-start">
                <div className="flex items-center gap-1.5 rounded-3xl rounded-bl-lg border border-line/70 bg-surface px-4 py-3.5" role="status" aria-label="La otra persona está escribiendo">
                  <span className="typing-dot h-2 w-2 rounded-full bg-muted" aria-hidden="true" />
                  <span className="typing-dot h-2 w-2 rounded-full bg-muted" aria-hidden="true" />
                  <span className="typing-dot h-2 w-2 rounded-full bg-muted" aria-hidden="true" />
                  <span className="sr-only">escribiendo…</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Entrada */}
      <footer className="chat-footer shrink-0 border-t border-line/70 bg-surface px-3 pb-3 pt-3 sm:px-6 sm:pb-5">
        <Composer onSendPhoto={onSendPhoto} onSendVideo={onSendVideo} onSend={onSend} onTyping={onTyping}
          disabled={loading || !!loadError} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />
      </footer>
      {partnerAvatarOpen && partner && <AvatarPreview user={partner} onClose={() => setPartnerAvatarOpen(false)} />}
    </section>
  );
}

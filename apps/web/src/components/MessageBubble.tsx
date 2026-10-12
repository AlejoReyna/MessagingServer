import { useEffect, useRef, useState } from 'react';
import { Check, CheckCheck, ChevronDown, Clock3, Reply, TriangleAlert, Trash2 } from 'lucide-react';
import { PHOTO_MESSAGE_BODY, VIDEO_MESSAGE_BODY, type Message } from '@private-chat/contracts';
import { MessagePhoto, PendingPhoto } from './MessagePhoto';
import { MessageVideo, PendingVideo } from './MessageVideo';
import { formatTime, fullDate } from '../lib/format';
import { snippetOf, type ReplySnapshot } from '../lib/reply';

function QuoteBlock({ author, snippet, messageId, onQuoteClick }: {
  author: string;
  snippet: string;
  messageId: string;
  onQuoteClick?: (messageId: string) => void;
}) {
  const inner = <>
    <span className="block truncate text-[14px] font-bold text-accent">{author}</span>
    <span className="block truncate text-[15px] text-muted">{snippet}</span>
  </>;
  const cls = 'mb-1 block w-full rounded-md border-l-2 border-accent bg-black/[0.04] px-2 py-1 text-left transition hover:bg-black/[0.08]';
  return onQuoteClick
    ? <button type="button" onClick={() => onQuoteClick(messageId)}
        aria-label={`Ver mensaje original de ${author}`} className={cls}>{inner}</button>
    : <div className={cls} aria-label={`En respuesta a ${author}`}>{inner}</div>;
}

/** Hora + checks al estilo WhatsApp: al final del texto, abajo a la derecha. */
function MetaInline({ createdAt, mine, read, animate, light = false }: {
  createdAt: string;
  mine: boolean;
  read: boolean;
  animate?: boolean;
  light?: boolean;
}) {
  const time = formatTime(createdAt);
  const tickPop = animate ? ' tick-pop' : '';
  return (
    <span className={`ml-2 inline-flex translate-y-[2px] select-none items-center gap-1 whitespace-nowrap align-middle text-[12px] font-normal leading-none ${
      light ? 'text-white/90' : 'text-muted'
    }`}>
      <time dateTime={createdAt} title={fullDate(createdAt)}>{time}</time>
      {mine && (
        read
          ? <span key="read" className={`inline-flex items-center${tickPop}`}><CheckCheck className="h-3.5 w-3.5" aria-hidden="true" /><span className="sr-only">Leído</span></span>
          : <span key="sent" className={`inline-flex items-center${tickPop}`}><Check className="h-3.5 w-3.5" aria-hidden="true" /><span className="sr-only">Enviado</span></span>
      )}
    </span>
  );
}

const LONG_PRESS_MS = 550;
const SWIPE_REPLY_DX = 48;

export function MessageBubble({
  message, mine, read, isAdmin, onDelete, onReply, replyAuthorName, onQuoteClick, animate = false,
}: {
  message: Message;
  mine: boolean;
  read: boolean;
  isAdmin: boolean;
  onDelete: (id: string) => void;
  onReply: (message: Message) => void;
  replyAuthorName?: string;
  onQuoteClick?: (messageId: string) => void;
  /** Entrada con pop estilo WhatsApp; el historial se muestra con `false`. */
  animate?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const longPressTimer = useRef<number | null>(null);
  const touchOrigin = useRef<{ x: number; y: number } | null>(null);
  const swipedRef = useRef(false);
  const canDelete = isAdmin || mine;
  const timeLabel = formatTime(message.createdAt);

  const hasPhoto = Boolean(message.photoUrl || message.videoUrl);
  const hasCaption = hasPhoto && message.body !== (message.videoUrl ? VIDEO_MESSAGE_BODY : PHOTO_MESSAGE_BODY);
  const tickCls = animate ? 'tick-pop items-center gap-0.5 font-medium' : 'inline-flex items-center gap-0.5 font-medium';

  function clearLongPress() {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  // Cerrar el menú al pulsar fuera o con Escape, como en WhatsApp Web.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: MouseEvent | TouchEvent) {
      if (bubbleRef.current && !bubbleRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => () => clearLongPress(), []);

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setMenuOpen(true);
  }

  // WhatsApp móvil: pulsación larga abre el menú de la burbuja.
  function handleTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    touchOrigin.current = { x: t.clientX, y: t.clientY };
    swipedRef.current = false;
    clearLongPress();
    longPressTimer.current = window.setTimeout(() => {
      setMenuOpen(true);
      touchOrigin.current = null;
    }, LONG_PRESS_MS);
  }

  function handleTouchMove(e: React.TouchEvent) {
    const origin = touchOrigin.current;
    const t = e.touches[0];
    if (!origin || !t) return;
    const dx = t.clientX - origin.x;
    const dy = t.clientY - origin.y;
    // Desplazamiento vertical: es scroll, no menú.
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
      clearLongPress();
      touchOrigin.current = null;
      return;
    }
    // WhatsApp móvil: deslizar a la derecha responde el mensaje.
    if (!swipedRef.current && dx > SWIPE_REPLY_DX && Math.abs(dx) > Math.abs(dy) * 1.2) {
      swipedRef.current = true;
      clearLongPress();
      touchOrigin.current = null;
      onReply(message);
    }
  }

  function handleTouchEnd() {
    clearLongPress();
    touchOrigin.current = null;
  }

  function handleReply() {
    setMenuOpen(false);
    onReply(message);
  }

  function handleDelete() {
    setMenuOpen(false);
    onDelete(message.id);
  }

  const bubbleBg = hasPhoto
      ? mine
        ? 'border-accent-soft bg-accent-soft'
        : 'border-line/70 bg-surface'
      : mine
        ? 'border-accent-soft bg-accent-soft'
        : 'border-line/70 bg-surface';

  return (
    <div className={`group flex w-full ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        ref={bubbleRef}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        className={`relative max-w-[82%] rounded-lg text-[17px] leading-[1.45] shadow-[0_1px_0.5px_rgba(0,0,0,0.13)] sm:max-w-[70%] ${
          // pr-10 en burbujas de texto: reserva ~32px del chevron + margen para que
          // la hora no quede debajo del botón en mensajes cortos de una línea.
          hasPhoto ? `border p-1.5 ${bubbleBg}` : `border py-2 pl-3 pr-10 ${bubbleBg}`
        }${animate ? (mine ? ' enter-pop-mine' : ' enter-pop-theirs') : ''}`}
      >
        {/* Cola estilo WhatsApp (sólo burbujas con fondo). */}
        {(mine
          ? <span aria-hidden="true" className="absolute -right-2 top-0 h-0 w-0 border-b-0 border-l-0 border-r-8 border-t-8 border-r-transparent border-t-accent-soft" />
          : <span aria-hidden="true" className="absolute -left-2 top-0 h-0 w-0 border-b-0 border-l-8 border-r-0 border-t-8 border-l-transparent border-t-surface" />
        )}

        {/* Chevron estilo WhatsApp Web: aparece al hover, siempre visible en táctil.
            El gutter es transparente y estrecho para no tapar la hora; sólo muestra
            degradado cuando el menú está abierto (y ocupa el padding reservado). */}
        <span className={`message-menu-gutter pointer-events-none absolute right-0 top-0 z-10 rounded-tr-lg p-1 ${
          menuOpen
            ? mine
                ? 'bg-gradient-to-l from-accent-soft from-60% to-transparent'
                : 'bg-gradient-to-l from-surface from-60% to-transparent'
            : 'bg-transparent'
        }`}>
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={`Opciones del mensaje de las ${timeLabel}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="Opciones"
            className={`message-menu-trigger pointer-events-auto grid h-6 w-6 place-items-center rounded-full transition active:scale-95 ${
              'text-muted hover:bg-black/10 hover:text-ink'
            }`}
          >
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          </button>
        </span>

        {/* Menú estilo WhatsApp: Responder / Borrar para ambos. */}
        {menuOpen && (
          <div
            role="menu"
            aria-label={`Opciones del mensaje de las ${timeLabel}`}
            className="absolute right-1 top-8 z-30 min-w-[200px] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-[0_8px_30px_rgba(0,0,0,0.18)]"
          >
            <button
              type="button"
              onClick={handleReply}
              aria-label={`Responder mensaje enviado ${timeLabel}`}
              title="Responder"
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[17px] text-ink transition hover:bg-surface-hover active:bg-surface-hover"
            >
              <Reply className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              Responder
            </button>
            {canDelete && (
              <button
                type="button"
                onClick={handleDelete}
                aria-label={`Borrar mensaje enviado ${timeLabel}`}
                title="Borrar para ambos"
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[17px] text-danger transition hover:bg-surface-hover active:bg-surface-hover"
              >
                <Trash2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                Borrar para ambos
              </button>
            )}
          </div>
        )}

        {message.replyTo && replyAuthorName && (
          <QuoteBlock author={replyAuthorName} messageId={message.replyTo.messageId}
            snippet={snippetOf(message.replyTo.body, message.replyTo.photoUrl, message.replyTo.videoUrl)} onQuoteClick={onQuoteClick} />
        )}
        {(message.photoUrl || message.videoUrl) && (
          <div className="relative">
            {message.videoUrl ? <MessageVideo src={message.videoUrl} /> : <MessagePhoto src={message.photoUrl!} />}
            {!hasCaption && !message.videoUrl && (
              <span className="absolute bottom-2.5 right-2 inline-flex select-none items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-[12px] font-normal leading-none text-white">
                <time dateTime={message.createdAt} title={fullDate(message.createdAt)}>{timeLabel}</time>
                {mine && (
                  read
                    ? <span key="read" className={`${tickCls} text-[#53bdeb]`}><CheckCheck className="h-3.5 w-3.5" aria-hidden="true" /><span className="sr-only">Leído</span></span>
                    : <span key="sent" className={tickCls}><Check className="h-3.5 w-3.5" aria-hidden="true" /><span className="sr-only">Enviado</span></span>
                )}
              </span>
            )}
          </div>
        )}
        {(!hasPhoto || hasCaption) && (
          // En fotos con pie, el bubble es p-1.5 sin reserva: el pr-8 del pie evita que el chevron lo tape.
          <p className={`whitespace-pre-wrap break-words px-0.5${hasPhoto ? ' pr-8' : ''}`} lang="es">{message.body}<MetaInline createdAt={message.createdAt} mine={mine} read={read} animate={animate} /></p>
        )}
        {message.videoUrl && !hasCaption && <div className="mt-1 flex justify-end pb-1"><MetaInline
          createdAt={message.createdAt} mine={mine} read={read} animate={animate} /></div>}
      </div>
    </div>
  );
}

export function PendingBubble({
  body, photo, video, replyTo, failed, error, onRetry, onDiscard, onQuoteClick,
}: {
  body: string;
  photo?: File;
  video?: File;
  replyTo?: ReplySnapshot;
  failed: boolean;
  error?: string;
  onRetry: () => void;
  onDiscard: () => void;
  onQuoteClick?: (messageId: string) => void;
}) {
  return (
    <div className="flex w-full justify-end">
      <div className="enter-pop-mine relative max-w-[82%] rounded-lg rounded-tr-none border border-dashed border-line bg-accent-soft/70 px-3 py-2 text-[17px] leading-[1.45] text-ink shadow-[0_1px_0.5px_rgba(0,0,0,0.13)] sm:max-w-[70%]">
        <span aria-hidden="true" className="absolute -right-2 top-0 h-0 w-0 border-b-0 border-l-0 border-r-8 border-t-8 border-r-transparent border-t-accent-soft/70" />
        {replyTo && (
          <QuoteBlock author={replyTo.author} messageId={replyTo.messageId}
            snippet={snippetOf(replyTo.body, replyTo.photoUrl, replyTo.videoUrl)} onQuoteClick={onQuoteClick} />
        )}
        {photo && <PendingPhoto file={photo} />}
        {video && <PendingVideo file={video} />}
        {((!photo && !video) || body !== (video ? VIDEO_MESSAGE_BODY : PHOTO_MESSAGE_BODY)) && <p className="whitespace-pre-wrap break-words px-0.5 opacity-80" lang="es">{body}<span className="ml-2 inline-flex translate-y-[2px] select-none items-center gap-1 whitespace-nowrap align-middle text-[12px] font-normal leading-none text-muted">
            {failed ? (
              <span className="inline-flex items-center gap-1 font-semibold text-danger">
                <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" /> No enviado
              </span>
            ) : (
              <span className="inline-flex animate-pulse items-center gap-1">
                <Clock3 className="h-3.5 w-3.5" aria-hidden="true" /> Enviando…
              </span>
            )}
          </span></p>}
        {failed ? (
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <button type="button" onClick={onRetry} className="min-h-[28px] rounded-full bg-accent px-3 text-[14px] font-bold text-on-accent transition hover:brightness-110 active:scale-95">
              Reintentar
            </button>
            <button type="button" onClick={onDiscard} className="min-h-[28px] rounded-full bg-surface-hover px-3 text-[14px] font-semibold transition hover:bg-black/10 active:scale-95">
              Descartar
            </button>
          </div>
        ) : (photo || video) && (
          <div className="mt-0.5 flex items-center justify-end text-[12px] text-muted">
            <span className="inline-flex animate-pulse items-center gap-1">
              <Clock3 className="h-3.5 w-3.5" aria-hidden="true" /> Enviando…
            </span>
          </div>
        )}
        {failed && error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}

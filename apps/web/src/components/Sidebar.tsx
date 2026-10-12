import { Github, LogOut, MessageCircle } from 'lucide-react';
import type { PublicUser } from '@private-chat/contracts';
import { AvatarView } from './AvatarView';

export function Sidebar({
  me, partner, unread, onOpenConversation, onOpenAvatar, onLogout, busy,
}: {
  me: PublicUser;
  partner: PublicUser | null;
  unread: number;
  onOpenConversation: () => void;
  onOpenAvatar: () => void;
  onLogout: () => void;
  busy: boolean;
}) {
  const iconButton = 'grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-muted transition-all duration-200 hover:scale-105 hover:bg-surface-hover hover:text-ink active:scale-95';
  const conversationLabel = partner ? `Conversación con ${partner.displayName}` : 'Conversación';

  return (
    <aside
      aria-label="Navegación del chat"
      className="hidden h-full w-[72px] shrink-0 flex-col items-center border-r border-line/70 bg-surface py-4 md:flex"
    >
      <button
        type="button"
        onClick={onOpenAvatar}
        aria-label={`Cambiar imagen de ${me.displayName}`}
        title="Cambiar imagen"
        className={iconButton}
      >
        <AvatarView user={me} size={44} />
      </button>

      <nav aria-label="Conversación privada" className="mt-6">
        <button
          type="button"
          onClick={onOpenConversation}
          aria-label={`${conversationLabel}${unread > 0 ? `, ${unread} sin leer` : ''}`}
          aria-current="page"
          title={conversationLabel}
          className="relative grid h-11 w-11 place-items-center rounded-2xl bg-accent-soft text-accent transition-all duration-200 hover:scale-105 hover:bg-surface-hover active:scale-95"
        >
          <MessageCircle className="h-5 w-5" aria-hidden="true" />
          {unread > 0 && <span aria-hidden="true" className="absolute right-2 top-2 h-2 w-2 animate-pulse rounded-full bg-success" />}
        </button>
      </nav>

      <nav aria-label="Repositorio del proyecto" className="mt-2">
        <a
          href="https://github.com/AlejoReyna/MessagingServer"
          target="_blank"
          rel="noreferrer"
          aria-label="Abrir repositorio en GitHub"
          title="GitHub"
          className={iconButton}
        >
          <Github className="h-5 w-5" aria-hidden="true" />
        </a>
      </nav>

      <div className="mt-auto flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={onLogout}
          disabled={busy}
          aria-label={busy ? 'Cerrando sesión' : 'Cerrar sesión'}
          title="Cerrar sesión"
          className={`${iconButton} disabled:opacity-50`}
        >
          <LogOut className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}

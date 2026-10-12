import { useCallback, useMemo, useState } from 'react';
import { SessionProvider, useSession } from './state/session';
import { useChat } from './hooks/useChat';
import { GateScreen } from './components/GateScreen';
import { PasswordGate } from './components/PasswordGate';
import { Sidebar } from './components/Sidebar';
import { ChatPanel } from './components/ChatPanel';
import { ProfileDialog } from './components/ProfileDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { AvatarEditor } from './components/AvatarEditor';
import { useTheme } from './lib/themes';

function Shell() {
  const session = useSession();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const closeAvatar = useCallback(() => setAvatarOpen(false), []);
  // Tema guardado de la cuenta; se expone en el diálogo de ajustes.
  const { theme, chooseTheme } = useTheme(session.user?.id);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sessionEpoch, setSessionEpoch] = useState(0);

  const chat = useChat(
    session.user,
    session.csrfToken,
    sessionEpoch,
    () => { void session.refresh().then(() => setSessionEpoch((n) => n + 1)); },
  );

  const lastMessage = useMemo(
    () => (chat.messages.length > 0 ? chat.messages[chat.messages.length - 1] ?? null : null),
    [chat.messages],
  );
  const unread = useMemo(() => {
    if (!lastMessage) return 0;
    const n = lastMessage.sequence - chat.myRead;
    return n > 0 ? n : 0;
  }, [lastMessage, chat.myRead]);

  if (session.status === 'loading') {
    return (
      <div className="grid min-h-dvh place-items-center p-4" aria-label="Cargando sesión">
        <div className="w-full max-w-sm rounded-[2rem] bg-surface p-8 text-center shadow-panel">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-accent border-t-transparent" aria-hidden="true" />
          <p className="mt-4 font-bold text-ink">Cargando tu chat…</p>
          <p className="mt-1 text-sm text-muted">Comprobando tu sesión.</p>
        </div>
      </div>
    );
  }

  if (session.status === 'anonymous') {
    return (
      <>
        {session.error && (
          <p role="alert" className="mx-auto mt-4 max-w-md rounded-2xl bg-red-50 px-4 py-3 text-center text-sm text-red-800">
            {session.error}
          </p>
        )}
        <GateScreen />
      </>
    );
  }

  if (session.status === 'needs-password' || !session.user) {
    return <PasswordGate mode="mandatory" />;
  }

  const me = session.user;
  const isAdmin = me.role === 'admin';

  async function handleDelete() {
    if (!deleteTarget) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await chat.removeMessage(deleteTarget);
      setDeleteTarget(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'No se pudo borrar el mensaje.');
    } finally {
      setActionBusy(false);
    }
  }

  async function handleClear() {
    setActionBusy(true);
    setActionError(null);
    try {
      await chat.clearAll();
      setClearOpen(false);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'No se pudo vaciar la conversación.');
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-canvas">
      <Sidebar
        me={me}
        partner={chat.partner}
        unread={unread}
        onOpenConversation={() => document.getElementById('composer')?.focus()}
        onOpenAvatar={() => setAvatarOpen(true)}
        onLogout={() => void session.logout()}
        busy={session.busy}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {session.error && (
          <p role="alert" className="shrink-0 bg-red-50 px-4 py-2 text-sm text-red-800">
            {session.error}{' '}
            <button type="button" className="font-bold underline" onClick={() => { void session.refresh().then(() => setSessionEpoch((n) => n + 1)); }}>
              Reintentar
            </button>
          </p>
        )}
        {!session.online && (
          <p role="status" className="shrink-0 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-900">
            Sin conexión. Los mensajes pendientes se conservan sólo en esta pantalla.
          </p>
        )}
        {actionError && (
          <p role="alert" className="shrink-0 bg-red-50 px-4 py-2 text-sm text-red-800">
            {actionError}
          </p>
        )}
        <ChatPanel
          me={me}
          partner={chat.partner}
          messages={chat.messages}
          pending={chat.pending}
          loading={chat.loading}
          loadingMore={chat.loadingMore}
          hasMore={chat.hasMore}
          loadError={chat.loadError}
          connected={chat.connected}
          partnerTyping={chat.partnerTyping}
          partnerOnline={chat.partnerOnline}
          readByPartner={chat.readByPartner}
          notice={chat.notice}
          showSidebarToggle={false}
          onOpenSettings={() => setSettingsOpen(true)}
          onLoadMore={chat.loadMore}
          onReload={chat.reload}
          onSend={chat.send}
          onSendPhoto={chat.sendPhoto}
          onSendVideo={chat.sendVideo}
          onRetry={chat.retry}
          onDiscardPending={chat.discardPending}
          onTyping={chat.setTyping}
          onDeleteMessage={(id) => {
            const target = chat.messages.find((message) => message.id === id);
            if (!target || (!isAdmin && target.senderId !== me.id)) return;
            setDeleteTarget(id);
          }}
          onClear={() => {
            if (!isAdmin) return;
            setClearOpen(true);
          }}
          isAdmin={isAdmin}
          clearArmed={clearOpen}
        />
      </div>

      {settingsOpen && <ProfileDialog me={me} theme={theme} onChooseTheme={chooseTheme}
        avatarOpen={avatarOpen} onOpenAvatar={() => setAvatarOpen(true)} onClose={closeSettings} />}
      {avatarOpen && <AvatarEditor me={me} csrfToken={session.csrfToken}
        onSaved={session.setUser} onClose={closeAvatar} />}

      {deleteTarget && (
        <ConfirmDialog
          title="Borrar mensaje para ambos"
          body="Este mensaje desaparecerá de la conversación para ambos. Esta acción no se puede deshacer."
          confirmLabel="Borrar para ambos"
          busy={actionBusy}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void handleDelete()}
        />
      )}
      {clearOpen && (
        <ConfirmDialog
          title="Vaciar conversación"
          body="Se borrará todo el historial para ambos. Los textos pendientes de esta pantalla no se reenviarán. Esta acción no se puede deshacer."
          confirmLabel="Vaciar todo"
          busy={actionBusy}
          onCancel={() => setClearOpen(false)}
          onConfirm={() => void handleClear()}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

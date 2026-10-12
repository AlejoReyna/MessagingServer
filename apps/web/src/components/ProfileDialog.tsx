import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LogOut, Pencil, X } from 'lucide-react';
import { UsernameSchema, DisplayNameSchema } from '@private-chat/contracts';
import type { PublicUser } from '@private-chat/contracts';
import { updateProfile, type ApiFailure } from '../lib/api';
import { useSession } from '../state/session';
import { AvatarView } from './AvatarView';
import { PinChangeForm } from './PinChangeForm';
import { PushSettings } from './PushSettings';
import { ThemePicker } from './ThemePicker';
import type { ThemeId } from '../lib/themes';

export function ProfileDialog({ me, theme, onChooseTheme, avatarOpen, onOpenAvatar, onClose }: {
  me: PublicUser;
  theme: ThemeId;
  onChooseTheme: (theme: ThemeId) => void;
  avatarOpen: boolean;
  onOpenAvatar: () => void;
  onClose: () => void;
}) {
  const { csrfToken, setUser, logout, busy } = useSession();
  const [username, setUsername] = useState(me.username);
  const [displayName, setDisplayName] = useState(me.displayName);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (avatarOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'Tab') return;
      const elements = panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type="radio"]), input[type="radio"]:checked');
      const first = elements?.[0];
      const last = elements?.[elements.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose, avatarOpen]);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const u = username.trim().toLowerCase();
    const d = displayName.trim();
    if (UsernameSchema.safeParse(u).success === false) {
      setMsg({ kind: 'err', text: 'Usuario: 3–32 caracteres, sólo minúsculas, números y . _ -' });
      return;
    }
    if (DisplayNameSchema.safeParse(d).success === false) {
      setMsg({ kind: 'err', text: 'Nombre: 1–60 caracteres.' });
      return;
    }
    if (u === me.username && d === me.displayName) {
      setMsg({ kind: 'err', text: 'No hay cambios para guardar.' });
      return;
    }
    setSaving(true);
    try {
      const updated = await updateProfile(
        { ...(u !== me.username ? { username: u } : {}), ...(d !== me.displayName ? { displayName: d } : {}) },
        csrfToken,
      );
      setUser(updated);
      setMsg({ kind: 'ok', text: 'Perfil actualizado.' });
    } catch (err) {
      const f = err as ApiFailure;
      setMsg({ kind: 'err', text: f?.message ?? 'No se pudo actualizar el perfil.' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-overlay/50 p-4"
      role="presentation" aria-hidden={avatarOpen || undefined} inert={avatarOpen || undefined}
      onClick={() => { if (!avatarOpen) onClose(); }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
        onClick={(e) => e.stopPropagation()}
        className="relative max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-[2rem] border border-line/70 bg-surface p-6 shadow-dialog"
      >
        <div className="flex items-center gap-3 text-left">
          <div className="flex min-w-0 flex-row items-center gap-3">
            <button type="button" onClick={onOpenAvatar} aria-label={`Cambiar imagen de ${me.displayName}`}
              title="Toca para cambiar tu foto"
              className="shrink-0 rounded-full transition-all duration-200 hover:scale-105 hover:opacity-80 active:scale-95">
              <AvatarView user={me} size={56} />
            </button>
            <div className="min-w-0">
              <p className="text-xs text-muted">Mi perfil</p>
              <h2 id="profile-title" className="text-lg font-semibold text-ink">
                <button type="button" aria-label={`Editar nombre de ${me.displayName}`}
                  className="group flex max-w-full items-center gap-2 rounded-lg text-left"
                  onClick={() => { nameRef.current?.focus(); nameRef.current?.select(); }}>
                  <span className="truncate">{me.displayName}</span>
                  <span className="name-edit-icon grid h-7 w-7 shrink-0 place-items-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                    <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
                  </span>
                </button>
              </h2>
              <p className="text-xs text-muted">{me.role === 'admin' ? 'Administrador · puede borrar cualquier mensaje' : 'Miembro · puede borrar sus mensajes'}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar ajustes"
            className="grid max-h-[44px] min-h-[44px] min-w-[44px] place-items-center rounded-full bg-surface-muted text-ink transition-all duration-200 hover:scale-105 hover:bg-surface-hover active:scale-95 ml-auto">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {msg && (
          <p role={msg.kind === 'err' ? 'alert' : 'status'}
            className={`mt-4 rounded-2xl px-4 py-3 text-left text-sm font-medium ${msg.kind === 'err' ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-900'}`}>
            {msg.text}
          </p>
        )}

        <form onSubmit={saveProfile} className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="profile-username" className="mb-1 block text-left text-xs font-bold text-ink">Usuario</label>
              <input id="profile-username" value={username} onChange={(e) => setUsername(e.target.value)}
                autoCapitalize="none" spellCheck={false} minLength={3} maxLength={32}
                className="min-h-[48px] w-full rounded-2xl border border-line bg-surface-muted px-3 text-left text-[16px]" />
            </div>
            <div>
              <label htmlFor="profile-display" className="mb-1 block text-left text-xs font-bold text-ink">Nombre visible</label>
              <input ref={nameRef} id="profile-display" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                minLength={1} maxLength={60}
                className="min-h-[48px] w-full rounded-2xl border border-line bg-surface-muted px-3 text-left text-[16px]" />
            </div>
          </div>
          <button type="submit" disabled={saving}
            className="min-h-[48px] w-full rounded-2xl bg-accent text-sm font-bold text-on-accent transition-all duration-200 hover:brightness-110 active:scale-[0.98] disabled:opacity-60">
            {saving ? 'Guardando…' : 'Guardar perfil'}
          </button>
        </form>

        <div className="mt-4">
          <PinChangeForm />
        </div>

        <ThemePicker theme={theme} onChange={onChooseTheme} />

        <PushSettings />

        <button type="button" onClick={() => void logout()} disabled={busy}
          className="mt-4 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl bg-surface-muted text-sm font-semibold text-ink hover:bg-surface-hover disabled:opacity-60">
          <LogOut className="h-4 w-4" aria-hidden="true" /> {busy ? 'Cerrando…' : 'Cerrar sesión'}
        </button>
      </div>
    </div>
  );
}

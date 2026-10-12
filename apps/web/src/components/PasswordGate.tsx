import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { useSession } from '../state/session';
import type { ApiFailure } from '../lib/api';

export function PasswordGate({ mode }: { mode: 'mandatory' | 'settings' }) {
  const { user, changePassword, logout, busy } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setOk(null);
    if (next.length < 15) {
      setError('La nueva contraseña debe tener al menos 15 caracteres.');
      return;
    }
    if (next.length > 128) {
      setError('La nueva contraseña no debe superar 128 caracteres.');
      return;
    }
    if (next !== confirm) {
      setError('La confirmación no coincide con la nueva contraseña.');
      return;
    }
    if (next === current) {
      setError('Elige una contraseña diferente a la actual.');
      return;
    }
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setOk(mode === 'mandatory' ? 'Contraseña actualizada. Cargando tu chat…' : 'Contraseña actualizada.');
    } catch (err) {
      const f = err as ApiFailure;
      setError(f?.message ?? 'No se pudo cambiar la contraseña.');
    }
  }

  if (mode === 'settings') {
    return (
      <form onSubmit={onSubmit} className="space-y-3 rounded-3xl bg-surface-muted p-4">
        <h3 className="flex items-center gap-2 text-sm font-bold text-ink">
          <KeyRound className="h-4 w-4" aria-hidden="true" /> Cambiar contraseña
        </h3>
        <div>
          <label htmlFor="pw-current" className="mb-1 block text-xs font-semibold text-ink">Contraseña actual</label>
          <input id="pw-current" type="password" autoComplete="current-password" required value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className="min-h-[44px] w-full rounded-2xl border border-line bg-surface px-3 text-[16px]" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="pw-next" className="mb-1 block text-xs font-semibold text-ink">Nueva (mín. 15 caracteres)</label>
            <input id="pw-next" type="password" autoComplete="new-password" required minLength={15} maxLength={128} value={next}
              onChange={(e) => setNext(e.target.value)}
              className="min-h-[44px] w-full rounded-2xl border border-line bg-surface px-3 text-[16px]" />
          </div>
          <div>
            <label htmlFor="pw-confirm" className="mb-1 block text-xs font-semibold text-ink">Confirmar nueva</label>
            <input id="pw-confirm" type="password" autoComplete="new-password" required minLength={15} maxLength={128} value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="min-h-[44px] w-full rounded-2xl border border-line bg-surface px-3 text-[16px]" />
          </div>
        </div>
        {error && <p role="alert" className="rounded-2xl bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        {ok && <p role="status" className="rounded-2xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900">{ok}</p>}
        <button type="submit" disabled={busy}
          className="min-h-[44px] rounded-2xl bg-accent px-5 text-sm font-bold text-on-accent hover:bg-accent-hover disabled:opacity-60">
          {busy ? 'Guardando…' : 'Guardar contraseña'}
        </button>
      </form>
    );
  }

  return (
    <div className="mx-auto grid min-h-dvh w-full max-w-lg place-items-center p-4">
      <main className="w-full rounded-[2rem] border border-line/70 bg-surface p-6 shadow-panel sm:p-8" aria-label="Cambio de contraseña obligatorio">
        <span className="inline-grid h-12 w-12 place-items-center rounded-2xl bg-accent text-on-accent">
          <KeyRound className="h-6 w-6" aria-hidden="true" />
        </span>
        <h1 className="mt-3 text-2xl font-extrabold text-ink">Cambia tu contraseña</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Hola{user ? `, ${user.displayName}` : ''}. Tu cuenta necesita una contraseña nueva de al menos 15 caracteres
          antes de cargar el chat.
        </p>
        <form onSubmit={onSubmit} className="mt-5 space-y-4">
          <div>
            <label htmlFor="m-current" className="mb-1 block text-sm font-semibold text-ink">Contraseña actual</label>
            <input id="m-current" type="password" autoComplete="current-password" required value={current}
              onChange={(e) => setCurrent(e.target.value)}
              className="min-h-[48px] w-full rounded-2xl border border-line bg-surface-muted px-4 text-[16px]" />
          </div>
          <div>
            <label htmlFor="m-next" className="mb-1 block text-sm font-semibold text-ink">Nueva contraseña</label>
            <input id="m-next" type="password" autoComplete="new-password" required minLength={15} maxLength={128} value={next}
              onChange={(e) => setNext(e.target.value)}
              className="min-h-[48px] w-full rounded-2xl border border-line bg-surface-muted px-4 text-[16px]" />
          </div>
          <div>
            <label htmlFor="m-confirm" className="mb-1 block text-sm font-semibold text-ink">Confirmar nueva contraseña</label>
            <input id="m-confirm" type="password" autoComplete="new-password" required minLength={15} maxLength={128} value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="min-h-[48px] w-full rounded-2xl border border-line bg-surface-muted px-4 text-[16px]" />
          </div>
          {error && <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
          {ok && <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900">{ok}</p>}
          <button type="submit" disabled={busy}
            className="min-h-[52px] w-full rounded-2xl bg-accent text-base font-bold text-on-accent hover:bg-accent-hover disabled:opacity-60">
            {busy ? 'Guardando…' : 'Guardar y entrar'}
          </button>
          <button type="button" onClick={() => void logout()}
            className="min-h-[44px] w-full rounded-2xl bg-surface-muted text-sm font-semibold text-ink hover:bg-surface-hover">
            Cerrar sesión
          </button>
        </form>
      </main>
    </div>
  );
}

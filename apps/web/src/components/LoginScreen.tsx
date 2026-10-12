import { useState, type FormEvent } from 'react';
import { MessageCircleHeart } from 'lucide-react';
import { useSession } from '../state/session';

export function LoginScreen() {
  const { login, busy, loginError, online } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (!username.trim() || !password) {
      setLocalError('Escribe tu usuario y tu contraseña.');
      return;
    }
    try {
      await login(username, password);
    } catch {
      // loginError ya viene del contexto con texto en español.
    }
  }

  return (
    <div className="mx-auto grid min-h-dvh w-full max-w-6xl place-items-center gap-6 p-4 md:grid-cols-2 md:p-8">
      <section aria-label="Presentación" className="hidden w-full max-w-md md:block">
        <div className="rounded-[2rem] border border-line/70 bg-surface-muted p-8 text-ink">
          <MessageCircleHeart className="h-10 w-10" aria-hidden="true" />
          <h1 className="mt-4 text-3xl font-extrabold leading-tight">Chat privado para dos</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Una única conversación entre dos cuentas. Historial persistente, presencia y lectura,
            sin registro público. Tus fotos y nombres viven en tu propio servidor.
          </p>
          <ul className="mt-5 space-y-2 text-sm text-muted">
            <li>· Exactamente dos cuentas, un contacto.</li>
            <li>· Texto y emojis, fotos de perfil editables.</li>
            <li>· Puedes borrar tus mensajes; el administrador puede borrar cualquiera.</li>
          </ul>
        </div>
      </section>

      <main className="w-full max-w-md rounded-[2rem] border border-line/70 bg-surface p-6 shadow-panel sm:p-8" aria-label="Iniciar sesión">
        <div className="md:hidden">
          <span className="inline-grid h-12 w-12 place-items-center rounded-2xl bg-accent text-on-accent">
            <MessageCircleHeart className="h-6 w-6" aria-hidden="true" />
          </span>
          <h1 className="mt-3 text-2xl font-extrabold text-ink">Chat privado</h1>
          <p className="mt-1 text-sm text-muted">Sólo las dos cuentas creadas pueden entrar.</p>
        </div>
        <h2 className="hidden text-2xl font-extrabold text-ink md:block">Hola de nuevo</h2>
        <p className="mt-1 hidden text-sm text-muted md:block">Inicia sesión con tu cuenta.</p>

        {!online && (
          <p role="alert" className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
            Sin conexión a internet. Conéctate para entrar.
          </p>
        )}

        <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate={false}>
          <div>
            <label htmlFor="login-user" className="mb-1 block text-sm font-semibold text-ink">
              Usuario
            </label>
            <input
              id="login-user"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              minLength={3}
              maxLength={32}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="tu_usuario"
              className="min-h-[48px] w-full rounded-2xl border border-line bg-surface-muted px-4 text-[16px] text-ink placeholder:text-subtle focus:border-accent"
            />
          </div>
          <div>
            <label htmlFor="login-pass" className="mb-1 block text-sm font-semibold text-ink">
              Contraseña
            </label>
            <input
              id="login-pass"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="•••••••••••••••"
              className="min-h-[48px] w-full rounded-2xl border border-line bg-surface-muted px-4 text-[16px] text-ink placeholder:text-subtle focus:border-accent"
            />
          </div>

          {(localError || loginError) && (
            <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-medium text-red-800">
              {localError ?? loginError}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="min-h-[52px] w-full rounded-2xl bg-accent text-base font-bold text-on-accent shadow-sm hover:bg-accent-hover disabled:opacity-60"
          >
            {busy ? 'Entrando…' : 'Entrar al chat'}
          </button>
          <p className="text-center text-xs leading-relaxed text-muted">
            No hay registro público. Si no tienes cuenta, pídele acceso al administrador.
          </p>
        </form>
      </main>
    </div>
  );
}

import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { useSession } from '../state/session';
import { changePin, type ApiFailure } from '../lib/api';

const PIN_RE = /^\d{4}$/;

/** Cambio del código de 4 dígitos desde los ajustes. */
export function PinChangeForm() {
  const { csrfToken, setUser } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [shakeKey, setShakeKey] = useState(0);

  function fail(text: string) {
    setError(text);
    setOk(null);
    setShakeKey((n) => n + 1);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!PIN_RE.test(current)) {
      fail('Escribe tu código actual (4 dígitos).');
      return;
    }
    if (!PIN_RE.test(next)) {
      fail('El código nuevo debe tener exactamente 4 dígitos.');
      return;
    }
    if (next !== confirm) {
      fail('La confirmación no coincide con el código nuevo.');
      return;
    }
    if (next === current) {
      fail('Elige un código diferente al actual.');
      return;
    }
    setError(null);
    setOk(null);
    setBusy(true);
    try {
      const updated = await changePin({ currentPin: current, newPin: next }, csrfToken);
      setUser(updated);
      setCurrent('');
      setNext('');
      setConfirm('');
      setOk('Código actualizado. Sólo quien lo conozca podrá entrar con tu cuenta.');
    } catch (err) {
      const f = err as ApiFailure;
      fail(f?.message ?? 'No se pudo cambiar el código.');
    } finally {
      setBusy(false);
    }
  }

  const inputCls = 'min-h-[48px] w-full rounded-2xl border border-line bg-surface px-3 text-left text-lg tracking-[0.5em] text-[16px]';
  const labelCls = 'mb-1 block text-xs font-semibold text-ink text-left';

  return (
    <form onSubmit={onSubmit} className="rounded-3xl bg-surface-muted p-4">
      <h3 className="flex items-center justify-start gap-2 text-sm font-bold text-ink">
        <KeyRound className="h-4 w-4" aria-hidden="true" /> Cambiar código
      </h3>
      <p className="mt-0.5 text-left text-xs text-muted">
        Tu código de 4 dígitos. Guárdalo bien: es la única llave de tu cuenta.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="pin-current" className={labelCls}>Código actual</label>
          <input id="pin-current" type="password" inputMode="numeric" autoComplete="current-password"
            required maxLength={4} value={current} disabled={busy}
            onChange={(e) => { setCurrent(e.target.value.replace(/\D/g, '').slice(0, 4)); setError(null); }}
            placeholder="••••" className={inputCls} />
        </div>
        <div>
          <label htmlFor="pin-next" className={labelCls}>Código nuevo</label>
          <input id="pin-next" type="password" inputMode="numeric" autoComplete="new-password"
            required maxLength={4} value={next} disabled={busy}
            onChange={(e) => { setNext(e.target.value.replace(/\D/g, '').slice(0, 4)); setError(null); }}
            placeholder="••••" className={inputCls} />
        </div>
        <div>
          <label htmlFor="pin-confirm" className={labelCls}>Confirmar nuevo</label>
          <input id="pin-confirm" type="password" inputMode="numeric" autoComplete="new-password"
            required maxLength={4} value={confirm} disabled={busy}
            onChange={(e) => { setConfirm(e.target.value.replace(/\D/g, '').slice(0, 4)); setError(null); }}
            placeholder="••••" className={inputCls} />
        </div>
      </div>
      <div key={shakeKey} className={shakeKey > 0 && error ? 'shake' : undefined}>
        {error && <p role="alert" className="mt-3 rounded-2xl bg-red-50 px-3 py-2 text-left text-sm text-red-800">{error}</p>}
      </div>
      {ok && <p role="status" className="mt-3 rounded-2xl bg-emerald-50 px-3 py-2 text-left text-sm text-emerald-900">{ok}</p>}
      <button type="submit" disabled={busy}
        className="mt-3 min-h-[48px] w-full rounded-2xl bg-accent text-sm font-bold text-on-accent transition-all duration-200 hover:brightness-110 active:scale-[0.98] disabled:opacity-60">
        {busy ? 'Guardando…' : 'Guardar código'}
      </button>
    </form>
  );
}

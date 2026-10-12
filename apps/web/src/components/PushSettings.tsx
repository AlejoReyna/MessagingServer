import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { useSession } from '../state/session';
import { deletePushSubscription, getVapidKey, savePushSubscription, type ApiFailure } from '../lib/api';
import {
  currentBrowserSubscription,
  ensureServiceWorker,
  isPushSupported,
  isStandalone,
  pushPermission,
  subscribeBrowserPush,
  unsubscribeBrowserPush,
} from '../lib/push';

/** Ajuste de notificaciones push (contrato v5): aviso genérico "Nuevo mensaje", sin texto. */
export function PushSettings() {
  const { csrfToken } = useSession();
  const [supported] = useState(() => isPushSupported());
  const [standalone, setStandalone] = useState(false);
  const [permission, setPermission] = useState<'default' | 'denied' | 'granted'>('default');
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [preparing, setPreparing] = useState(true);
  const [active, setActive] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setPreparing(true);
    setPublicKey(null);
    setRegistration(null);
    setStandalone(isStandalone());
    setPermission(pushPermission());
    if (!isPushSupported()) {
      setActive(false);
      setPreparing(false);
      return;
    }
    try {
      const key = await getVapidKey();
      setServerEnabled(key.enabled);
      if (!key.enabled || !key.publicKey) {
        setActive(false);
        return;
      }
      const reg = await ensureServiceWorker();
      setPublicKey(key.publicKey);
      setRegistration(reg);
      const current = await currentBrowserSubscription(reg);
      // A local subscription alone does not mean the server has it. Repair
      // the association with the signed-in account without prompting again.
      if (current && pushPermission() === 'granted') {
        await savePushSubscription(current, csrfToken);
        setActive(true);
      } else {
        setActive(false);
      }
    } catch (err) {
      setActive(false);
      setMsg({ kind: 'err', text: (err as ApiFailure)?.message ?? 'No se pudieron preparar las notificaciones. Inténtalo de nuevo.' });
    } finally {
      setPreparing(false);
    }
  }, [csrfToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function enable() {
    if (!publicKey || !registration || preparing) return;
    setBusy(true);
    setMsg(null);
    try {
      // No fetch before this call: permission must be requested in the tap.
      const { dto } = await subscribeBrowserPush(publicKey, registration);
      await savePushSubscription(dto, csrfToken);
      setActive(true);
      setPermission(pushPermission());
      setMsg({ kind: 'ok', text: 'Notificaciones activadas en este iPhone. Llegarán como “Nuevo mensaje”.' });
    } catch (err) {
      const f = err as ApiFailure;
      const text = err instanceof Error && err.message.includes('denegado')
        ? 'Permiso denegado. Actívalo en Ajustes del iPhone > Notificaciones > Chat.'
        : (f?.message ?? 'No se pudieron activar. Inténtalo de nuevo.');
      setMsg({ kind: 'err', text });
    } finally {
      setPermission(pushPermission());
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setMsg(null);
    try {
      const endpoint = await unsubscribeBrowserPush();
      if (endpoint) {
        try {
          await deletePushSubscription(endpoint, csrfToken);
        } catch {
          // La suscripción local ya se canceló; el servidor la podará solo.
        }
      }
      setActive(false);
      setPermission(pushPermission());
      setMsg({ kind: 'ok', text: 'Notificaciones desactivadas en este iPhone.' });
    } catch {
      setMsg({ kind: 'err', text: 'No se pudieron desactivar. Inténtalo de nuevo.' });
    } finally {
      setBusy(false);
    }
  }

  async function testNotification() {
    if (!registration || pushPermission() !== 'granted') return;
    setBusy(true);
    setMsg(null);
    try {
      await registration.showNotification('Nuevo mensaje', {
        body: 'Tienes un mensaje nuevo en el chat.',
        icon: '/icon-192.png',
        tag: 'private-chat-test',
      });
      setMsg({ kind: 'ok', text: 'Aviso de prueba enviado. Si no aparece, revisa las notificaciones de Chat en Ajustes del iPhone.' });
    } catch {
      setMsg({ kind: 'err', text: 'No se pudo mostrar el aviso de prueba. Revisa el permiso de Chat en Ajustes del iPhone.' });
    } finally {
      setBusy(false);
    }
  }

  if (!supported) {
    return (
      <section aria-label="Notificaciones" className="mt-4 rounded-2xl border border-line bg-surface-muted p-4 text-left">
        <h3 className="text-sm font-bold text-ink">Notificaciones</h3>
        <p className="mt-1 text-sm text-muted">Este navegador no admite notificaciones push.</p>
        <p className="mt-2 text-sm text-muted">
          En iPhone necesitas iOS 16.4 o posterior y abrir Chat desde su icono en la pantalla de inicio.
          Si aún no está instalada, abre la página en Safari y elige Compartir › Añadir a pantalla de inicio.
        </p>
      </section>
    );
  }

  const isActive = active === true;
  return (
    <section aria-label="Notificaciones" className="mt-4 rounded-2xl border border-line bg-surface-muted p-4 text-left">
      <div className="flex items-center gap-2">
        {isActive
          ? <Bell className="h-4 w-4 text-ink" aria-hidden="true" />
          : <BellOff className="h-4 w-4 text-ink" aria-hidden="true" />}
        <h3 className="text-sm font-bold text-ink">Notificaciones en este iPhone</h3>
      </div>
      {isActive && (
        <button type="button" onClick={() => void testNotification()} disabled={busy || preparing}
          className="mt-2 min-h-[44px] rounded-xl px-3 text-sm font-bold text-ink underline disabled:opacity-60">
          Probar aviso
        </button>
      )}
      <p className="mt-1 text-sm text-muted">
        Aviso del sistema como el del banco, pero genérico: sólo dice “Nuevo mensaje”, sin texto ni fotos.
      </p>
      {serverEnabled === false && (
        <p role="status" className="mt-2 text-sm font-medium text-amber-900">
          Avisos desactivados en el servidor.
        </p>
      )}
      {!standalone && serverEnabled !== false && (
        <p role="status" className="mt-2 text-sm text-muted">
          En iPhone instálala desde Compartir › Añadir a pantalla de inicio y ábrela desde el icono para activarlas (iOS 16.4+).
        </p>
      )}
      {permission === 'denied' && (
        <p role="alert" className="mt-2 text-sm font-medium text-red-800">
          Permiso bloqueado. Actívalo en Ajustes del iPhone › Notificaciones › Chat.
        </p>
      )}
      {msg && (
        <p role={msg.kind === 'err' ? 'alert' : 'status'}
          className={`mt-2 rounded-2xl px-3 py-2 text-sm font-medium ${msg.kind === 'err' ? 'bg-red-50 text-red-800' : 'bg-emerald-50 text-emerald-900'}`}>
          {msg.text}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        {isActive ? (
          <button type="button" onClick={() => void disable()} disabled={busy || preparing}
            className="min-h-[48px] flex-1 rounded-2xl bg-surface px-4 text-sm font-bold text-ink transition-all duration-200 hover:brightness-95 active:scale-[0.98] disabled:opacity-60">
            {busy ? 'Apagando…' : 'Desactivar en este iPhone'}
          </button>
        ) : (
          <button type="button" onClick={() => void enable()}
            disabled={busy || preparing || !publicKey || !registration || permission === 'denied'}
            className="min-h-[48px] flex-1 rounded-2xl bg-accent px-4 text-sm font-bold text-on-accent transition-all duration-200 hover:brightness-110 active:scale-[0.98] disabled:opacity-60">
            {preparing ? 'Preparando…' : busy ? 'Activando…' : 'Activar notificaciones'}
          </button>
        )}
      </div>
      {!preparing && !busy && serverEnabled !== false && (!publicKey || !registration) && (
        <button type="button" onClick={() => { setMsg(null); void refresh(); }}
          className="mt-2 min-h-[44px] rounded-xl px-3 text-sm font-bold text-ink underline">
          Reintentar preparación
        </button>
      )}
      {isActive && (
        <p className="mt-2 text-sm text-muted">
          Para ver tiras y avisos en la pantalla bloqueada, activa esas opciones en Ajustes del iPhone › Notificaciones › Chat.
          Revisa también los modos de concentración y el resumen programado si los avisos no aparecen al momento.
        </p>
      )}
      <p className="mt-2 text-xs text-muted">
        Estado: {preparing ? 'comprobando…' : isActive ? 'activadas' : 'desactivadas'}
        {permission !== 'default' ? ` · permiso ${permission === 'granted' ? 'concedido' : 'denegado'}` : ''}
      </p>
    </section>
  );
}

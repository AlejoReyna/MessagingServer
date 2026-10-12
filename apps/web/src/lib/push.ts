import type { PushSubscription as PushSubscriptionDto } from '@private-chat/contracts';

/** Push del navegador (contrato v5): PWA + Web Push, aviso genérico sin texto. */

export function isPushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

/** true si la página corre instalada desde inicio (pantalla completa). Requerido en iOS para push. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const mq = typeof window.matchMedia === 'function'
    && window.matchMedia('(display-mode: standalone)').matches;
  const ios = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return mq || ios;
}

export type PushPermission = 'default' | 'denied' | 'granted';

export function pushPermission(): PushPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'default';
  return Notification.permission as PushPermission;
}

export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  return navigator.serviceWorker.ready;
}

/** Convierte base64url VAPID a bytes para PushManager.subscribe. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padded = base64url + '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface BrowserSubscription {
  dto: PushSubscriptionDto;
  fresh: boolean;
}

function toDto(sub: globalThis.PushSubscription): PushSubscriptionDto {
  const json = sub.toJSON() as { endpoint?: unknown; keys?: unknown; expirationTime?: unknown };
  const endpoint = typeof json.endpoint === 'string' ? json.endpoint : '';
  const keys = (json.keys ?? {}) as Record<string, unknown>;
  const p256dh = typeof keys['p256dh'] === 'string' ? keys['p256dh'] as string : '';
  const auth = typeof keys['auth'] === 'string' ? keys['auth'] as string : '';
  const expirationTime = typeof json.expirationTime === 'number' ? json.expirationTime : null;
  return { endpoint, keys: { p256dh, auth }, ...(expirationTime === null ? {} : { expirationTime }) };
}

/** Suscripción actual del navegador, si existe. */
export async function currentBrowserSubscription(registration?: ServiceWorkerRegistration): Promise<PushSubscriptionDto | null> {
  const reg = registration ?? await ensureServiceWorker();
  const sub = await reg.pushManager.getSubscription();
  return sub ? toDto(sub) : null;
}

/** Crea la suscripción push (pide permiso con gesto del usuario en iOS). Reutiliza la existente. */
export async function subscribeBrowserPush(
  vapidPublicKey: string,
  registration?: ServiceWorkerRegistration,
): Promise<BrowserSubscription> {
  // This must run before any network/worker await so iOS sees the user's tap.
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permiso de notificaciones denegado.');
  const reg = registration ?? await ensureServiceWorker();
  const existing = await reg.pushManager.getSubscription();
  if (existing) return { dto: toDto(existing), fresh: false };
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey).buffer as ArrayBuffer,
  });
  return { dto: toDto(sub), fresh: true };
}

/** Cancela la suscripción de este navegador. Devuelve el endpoint cancelado, si había. */
export async function unsubscribeBrowserPush(): Promise<string | null> {
  const reg = await ensureServiceWorker();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = toDto(sub).endpoint;
  await sub.unsubscribe();
  return endpoint || null;
}

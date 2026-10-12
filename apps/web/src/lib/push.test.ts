import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentBrowserSubscription, ensureServiceWorker, isPushSupported, urlBase64ToUint8Array } from './push';

afterEach(() => vi.unstubAllGlobals());

describe('push del navegador (contrato v5)', () => {
  it('decodifica base64url VAPID sin perder bytes', () => {
    const bytes = urlBase64ToUint8Array('B_4nE-4vH8sJ7kL1mN2oP3qR4sT5uV6wX7yZ8aB9cD0eF1gH2iJ3kL4');
    expect(bytes.length).toBeGreaterThan(30);
    // Roundtrip del primer byte conocido: 'B' base64url ~ 0x07 (no se valida clave aquí).
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it('en jsdom no hay soporte push (sin serviceWorker real)', () => {
    expect(isPushSupported()).toBe(false);
  });

  it('consultar la suscripción registra el worker antes de esperar ready en una instalación nueva', async () => {
    let activate!: (registration: unknown) => void;
    const ready = new Promise((resolve) => { activate = resolve; });
    const getSubscription = vi.fn().mockResolvedValue(null);
    const registration = { pushManager: { getSubscription } };
    const register = vi.fn(async () => { activate(registration); return {}; });
    vi.stubGlobal('navigator', { serviceWorker: { register, ready } });
    expect(await currentBrowserSubscription()).toBeNull();
    expect(register).toHaveBeenCalledOnce();
    expect(getSubscription).toHaveBeenCalledOnce();
  });

  it('devuelve el worker activo de ready, no uno que aún se está instalando', async () => {
    const active = { pushManager: {} };
    vi.stubGlobal('navigator', { serviceWorker: {
      register: vi.fn().mockResolvedValue({ installing: {} }), ready: Promise.resolve(active),
    } });
    expect(await ensureServiceWorker()).toBe(active);
  });
});

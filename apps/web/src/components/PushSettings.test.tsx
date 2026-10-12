import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PushSettings } from './PushSettings';

const api = vi.hoisted(() => ({
  getVapidKey: vi.fn(), savePushSubscription: vi.fn(), deletePushSubscription: vi.fn(),
}));
vi.mock('../lib/api', () => api);
vi.mock('../state/session', () => ({ useSession: () => ({ csrfToken: 'csrf-push-test' }) }));

const publicKey = 'B' + 'A'.repeat(86);
const dto = { endpoint: 'https://web.push.apple.com/test-device', keys: { p256dh: publicKey, auth: 'A'.repeat(22) } };
const subscription = { toJSON: () => dto, unsubscribe: vi.fn() };
let permission: NotificationPermission;
let inTap: boolean;
let requestPermission: ReturnType<typeof vi.fn>;
let getSubscription: ReturnType<typeof vi.fn>;
let subscribe: ReturnType<typeof vi.fn>;
let register: ReturnType<typeof vi.fn>;
let showNotification: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  permission = 'default';
  inTap = false;
  requestPermission = vi.fn(async () => { permission = 'granted'; return permission; });
  getSubscription = vi.fn().mockResolvedValue(null);
  subscribe = vi.fn().mockResolvedValue(subscription);
  showNotification = vi.fn().mockResolvedValue(undefined);
  const registration = { pushManager: { getSubscription, subscribe }, showNotification };
  register = vi.fn().mockResolvedValue(registration);
  vi.stubGlobal('navigator', {
    userAgent: 'test', standalone: true,
    serviceWorker: { register, ready: Promise.resolve(registration) },
  });
  vi.stubGlobal('PushManager', function () {});
  vi.stubGlobal('Notification', {
    get permission() { return permission; }, requestPermission,
  });
  api.getVapidKey.mockResolvedValue({ enabled: true, publicKey });
  api.savePushSubscription.mockResolvedValue({ saved: true });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('activación push en iOS', () => {
  it('prepara el worker sin pedir permiso y lo pide durante el tap, sin fetch previo', async () => {
    requestPermission.mockImplementation(async () => {
      expect(inTap).toBe(true);
      permission = 'granted';
      return permission;
    });
    render(<PushSettings />);
    const button = await screen.findByRole('button', { name: 'Activar notificaciones' });
    await waitFor(() => expect(button).toBeEnabled());
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/', updateViaCache: 'none' });
    expect(requestPermission).not.toHaveBeenCalled();
    // A second network request would never finish; permission must not wait for it.
    api.getVapidKey.mockImplementation(() => new Promise(() => {}));
    inTap = true;
    fireEvent.click(button);
    inTap = false;
    expect(requestPermission).toHaveBeenCalledOnce();
    await waitFor(() => expect(api.savePushSubscription).toHaveBeenCalledWith(dto, 'csrf-push-test'));
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: expect.any(ArrayBuffer) });
    expect(api.getVapidKey).toHaveBeenCalledOnce();
    expect(await screen.findByRole('button', { name: 'Desactivar en este iPhone' })).toBeEnabled();
  });

  it('repara una suscripción local guardándola para la cuenta actual, sin otro permiso', async () => {
    permission = 'granted';
    getSubscription.mockResolvedValue(subscription);
    render(<PushSettings />);
    await screen.findByRole('button', { name: 'Desactivar en este iPhone' });
    expect(api.savePushSubscription).toHaveBeenCalledWith(dto, 'csrf-push-test');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('no muestra activadas cuando falla guardar la suscripción en el servidor', async () => {
    api.savePushSubscription.mockRejectedValue(new Error('Sin conexión con el servidor.'));
    render(<PushSettings />);
    const button = await screen.findByRole('button', { name: 'Activar notificaciones' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sin conexión con el servidor.');
    expect(screen.queryByRole('button', { name: 'Desactivar en este iPhone' })).toBeNull();
  });

  it('si iOS deniega el permiso no crea ni guarda una suscripción', async () => {
    requestPermission.mockImplementation(async () => { permission = 'denied'; return permission; });
    render(<PushSettings />);
    const button = await screen.findByRole('button', { name: 'Activar notificaciones' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(subscribe).not.toHaveBeenCalled();
    expect(api.savePushSubscription).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('Ajustes del iPhone'))).toBe(true);
  });

  it('permite reintentar un fallo de preparación sin confundirlo con push desactivado', async () => {
    api.getVapidKey.mockRejectedValueOnce(new Error('Sin conexión.'));
    render(<PushSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar preparación' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Activar notificaciones' })).toBeEnabled());
    expect(screen.queryByText('Avisos desactivados en el servidor.')).toBeNull();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('da instrucciones de instalación cuando Safari no expone PushManager', () => {
    vi.stubGlobal('PushManager', undefined);
    // Remove the property: feature detection checks its presence.
    Reflect.deleteProperty(window, 'PushManager');
    render(<PushSettings />);
    expect(screen.getByText(/En iPhone necesitas iOS 16.4/)).toBeInTheDocument();
    expect(api.getVapidKey).not.toHaveBeenCalled();
  });

  it('el aviso de prueba usa la notificación del sistema con texto genérico y sin enviar un mensaje', async () => {
    permission = 'granted';
    getSubscription.mockResolvedValue(subscription);
    render(<PushSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Probar aviso' }));
    await waitFor(() => expect(showNotification).toHaveBeenCalledWith('Nuevo mensaje', {
      body: 'Tienes un mensaje nuevo en el chat.', icon: '/icon-192.png', tag: 'private-chat-test',
    }));
    expect(await screen.findByText(/Aviso de prueba enviado/)).toBeInTheDocument();
    expect(api.savePushSubscription).toHaveBeenCalledOnce();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('informa cuando el sistema rechaza el aviso de prueba', async () => {
    permission = 'granted';
    getSubscription.mockResolvedValue(subscription);
    showNotification.mockRejectedValue(new Error('System notifications unavailable'));
    render(<PushSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Probar aviso' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo mostrar el aviso de prueba.');
  });
});

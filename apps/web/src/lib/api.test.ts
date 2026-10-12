import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  avatarSrc,
  friendlyErrorMessage,
  getMessages,
  login,
  pinLogin,
  pinSetup,
  sendMessage,
  validateAvatarFile,
} from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('friendlyErrorMessage (textos en español)', () => {
  it('traduce sesión expirada y cambio de contraseña', () => {
    expect(friendlyErrorMessage('UNAUTHENTICATED', 'x')).toMatch(/sesión expiró/i);
    expect(friendlyErrorMessage('PASSWORD_CHANGE_REQUIRED', 'x')).toMatch(/cambiar tu contraseña/i);
  });

  it('explica CONVERSATION_CHANGED como recarga del historial', () => {
    expect(friendlyErrorMessage('CONVERSATION_CHANGED', 'x')).toMatch(/recargó el historial/i);
  });
});

describe('validateAvatarFile', () => {
  function file(type: string, size: number): File {
    return new File([new Uint8Array(size)], 'foto.png', { type });
  }

  it('acepta JPEG/PNG/WebP hasta 5 MiB', () => {
    expect(validateAvatarFile(file('image/jpeg', 100))).toBeNull();
    expect(validateAvatarFile(file('image/png', 100))).toBeNull();
    expect(validateAvatarFile(file('image/webp', 5 * 1024 * 1024))).toBeNull();
  });

  it('rechaza SVG y tipos ajenos', () => {
    expect(validateAvatarFile(file('image/svg+xml', 100))).toMatch(/JPEG, PNG o WebP/);
    expect(validateAvatarFile(file('application/pdf', 100))).not.toBeNull();
  });

  it('rechaza archivos de más de 5 MiB', () => {
    expect(validateAvatarFile(file('image/png', 5 * 1024 * 1024 + 1))).toMatch(/5 MiB/);
  });
});

describe('avatarSrc (URLs privadas de la API)', () => {
  it('construye la URL privada con versión y nada externo', () => {
    const src = avatarSrc({
      id: '11111111-1111-4111-8111-111111111111',
      avatarUrl: '/api/users/11111111-1111-4111-8111-111111111111/avatar?v=3',
      avatarVersion: 3,
    });
    expect(src).toBe('/api/users/11111111-1111-4111-8111-111111111111/avatar?v=3');
  });

  it('devuelve null sin avatar (se dibujan iniciales, no servicios externos)', () => {
    expect(avatarSrc({ id: 'x', avatarUrl: null, avatarVersion: 0 })).toBeNull();
  });
});

describe('contrato HTTP del cliente', () => {
  it('explica el rechazo según sea respuesta secreta, PIN o contraseña', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'INVALID_CREDENTIALS', message: 'Credenciales no válidas' } }),
      { status: 401 },
    )));
    await expect(pinSetup({ answer: 'respuesta-de-prueba', pin: '1234' }, 'csrf'))
      .rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS', message: expect.stringMatching(/respuesta.*no es correcta/i) });
    await expect(pinLogin({ pin: '1234' }, 'csrf'))
      .rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Código incorrecto. Inténtalo de nuevo.' });
    await expect(login({ username: 'admin', password: 'password-de-prueba' }, 'csrf'))
      .rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Usuario o contraseña incorrectos.' });
  });

  it('explica un alta ya completada sin confundirla con un mensaje de chat', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Conflicto' } }),
      { status: 409 },
    )));
    await expect(pinSetup({ answer: 'respuesta-de-prueba', pin: '1234' }, 'csrf'))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT', message: expect.stringMatching(/código.*ya fue creado/i) });
  });

  it('sendMessage distingue 201 nuevo de 200 repetición idéntica', async () => {
    const body = {
      message: {
        id: '22222222-2222-4222-8222-222222222222',
        clientMessageId: '33333333-3333-4333-8333-333333333333',
        senderId: '11111111-1111-4111-8111-111111111111',
        sequence: 1,
        body: 'hola',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await sendMessage(
      { clientMessageId: '33333333-3333-4333-8333-333333333333', body: 'hola', conversationVersion: 1 },
      'csrf-token-largo-1234567890',
    );
    const second = await sendMessage(
      { clientMessageId: '33333333-3333-4333-8333-333333333333', body: 'hola', conversationVersion: 1 },
      'csrf-token-largo-1234567890',
    );
    expect(first.repeated).toBe(false);
    expect(second.repeated).toBe(true); // reintento idempotente: mismo mensaje, sin duplicar
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('propaga CONVERSATION_CHANGED para invalidar y recargar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'CONVERSATION_CHANGED', message: 'La conversación cambió' } }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )));
    await expect(sendMessage(
      { clientMessageId: '33333333-3333-4333-8333-333333333333', body: 'hola', conversationVersion: 1 },
      'csrf-token-largo-1234567890',
    )).rejects.toMatchObject({ code: 'CONVERSATION_CHANGED', status: 409 });
  });

  it('propaga sesión expirada (401) para forzar re-login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'No autenticado' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )));
    await expect(getMessages({ limit: 10 })).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 });
  });
});

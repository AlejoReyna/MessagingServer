import { describe, expect, it, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { NOTIFICATION_VOLUME, playNotification, useSoundEnabled } from './sound';

beforeEach(() => {
  if (typeof window.localStorage === 'undefined') {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
      },
      configurable: true,
    });
  }
  try { window.localStorage.clear(); } catch { /* sin almacenamiento */ }
});

describe('sonido de notificación (tono suave, desactivable)', () => {
  it('el volumen queda bajito (≤ 0.3)', () => {
    expect(NOTIFICATION_VOLUME).toBeLessThanOrEqual(0.3);
  });

  it('activado por defecto y el interruptor persiste por cuenta', () => {
    const { result } = renderHook(() => useSoundEnabled('cuenta-qa-sonido'));
    expect(result.current.enabled).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.enabled).toBe(false);
    expect(window.localStorage.getItem('private-chat:sound:cuenta-qa-sonido')).toBe('0');
    act(() => result.current.toggle());
    expect(result.current.enabled).toBe(true);
    expect(window.localStorage.getItem('private-chat:sound:cuenta-qa-sonido')).toBe('1');
  });

  it('reproducir nunca rompe el chat aunque el audio falle', () => {
    expect(() => playNotification()).not.toThrow();
  });
});

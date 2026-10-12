import { useCallback, useEffect, useState } from 'react';
import notificationUrl from '../assets/sounds/notification.wav';

/** Volumen bajo fijo: el tono se escucha tenue, sin sobresaltos. */
export const NOTIFICATION_VOLUME = 0.25;

function keyFor(userId?: string): string | null {
  return userId ? `private-chat:sound:${userId}` : null;
}

/** Reproduce el tono una vez, bajito. Sin throw: si el navegador bloquea el audio se ignora. */
export function playNotification(): void {
  try {
    if (typeof Audio === 'undefined') return;
    const audio = new Audio(notificationUrl);
    audio.volume = NOTIFICATION_VOLUME;
    const p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(() => undefined);
  } catch {
    /* audio no disponible: el chat sigue funcionando en silencio */
  }
}

/** Preferencia de sonido por cuenta en este navegador. Activado por defecto. */
export function useSoundEnabled(userId?: string): { enabled: boolean; toggle: () => void } {
  const [enabled, setEnabled] = useState(true);
  const key = keyFor(userId);

  useEffect(() => {
    let saved: string | null = null;
    try {
      if (key) saved = window.localStorage.getItem(key);
    } catch {
      /* sin almacenamiento: queda activado en memoria */
    }
    setEnabled(saved === null ? true : saved === '1');
  }, [key]);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try {
        if (key) window.localStorage.setItem(key, next ? '1' : '0');
      } catch {
        /* sigue funcionando en memoria */
      }
      return next;
    });
  }, [key]);

  return { enabled, toggle };
}

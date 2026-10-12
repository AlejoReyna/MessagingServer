import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PublicUser } from '@private-chat/contracts';
import { changePassword as apiChangePassword, getSession, login as apiLogin, logout as apiLogout, pinLogin as apiPinLogin, pinSetup as apiPinSetup, type ApiFailure } from '../lib/api';

interface SessionState {
  status: 'loading' | 'anonymous' | 'needs-password' | 'ready';
  user: PublicUser | null;
  csrfToken: string;
  error: string | null;
  online: boolean;
  login: (username: string, password: string) => Promise<void>;
  pinLogin: (pin: string) => Promise<void>;
  pinSetup: (answer: string, pin: string) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (u: PublicUser | null) => void;
  loginError: string | null;
  busy: boolean;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionState['status']>('loading');
  const [user, setUserState] = useState<PublicUser | null>(null);
  const [csrfToken, setCsrfToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const applySession = useCallback((u: PublicUser | null, csrf: string) => {
    setCsrfToken(csrf);
    setUserState(u);
    if (!u) setStatus('anonymous');
    else if (u.mustChangePassword) setStatus('needs-password');
    else setStatus('ready');
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const s = await getSession();
      if (!mounted.current) return;
      applySession(s.user, s.csrfToken);
    } catch (e) {
      if (!mounted.current) return;
      const f = e as ApiFailure;
      // Sin red o backend caído: mostrar error de red, no sesión anónima falsa.
      if (f?.status === 0 || /fetch|network|failed/i.test(f?.message ?? '')) {
        setError('Sin conexión con el servidor. Revisa tu red e inténtalo de nuevo.');
        return;
      }
      // 401 en /session no ocurre según contrato (público); ante duda, anónimo.
      setCsrfToken((t) => t);
      setStatus((prev) => (prev === 'loading' ? 'anonymous' : prev));
      if (status === 'loading') {
        // Reintentar obtener csrf: el contrato garantiza csrfToken aun sin login.
        try {
          const s2 = await getSession();
          if (mounted.current) applySession(s2.user, s2.csrfToken);
        } catch {
          if (mounted.current) setStatus('anonymous');
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applySession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    setBusy(true);
    setLoginError(null);
    try {
      // El CSRF inicial viene de GET /session (incluso antes del login).
      let csrf = csrfToken;
      if (!csrf) {
        const s = await getSession();
        csrf = s.csrfToken;
        if (mounted.current) applySession(s.user, s.csrfToken);
      }
      const s = await apiLogin({ username: username.trim().toLowerCase(), password }, csrf);
      if (!mounted.current) return;
      applySession(s.user, s.csrfToken);
    } catch (e) {
      if (!mounted.current) return;
      const f = e as ApiFailure;
      setLoginError(f?.message ?? 'No se pudo iniciar sesión.');
      throw e;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [applySession, csrfToken]);

  async function sessionFromPin(action: Promise<import('@private-chat/contracts').SessionResponse>): Promise<void> {
    setBusy(true);
    setLoginError(null);
    try {
      const s = await action;
      if (!mounted.current) return;
      applySession(s.user, s.csrfToken);
    } catch (e) {
      if (!mounted.current) return;
      const f = e as ApiFailure;
      setLoginError(f?.message ?? 'No se pudo entrar con el código.');
      throw e;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const pinLogin = useCallback(async (pin: string) => {
    let csrf = csrfToken;
    if (!csrf) {
      const s = await getSession();
      csrf = s.csrfToken;
      if (mounted.current) applySession(s.user, s.csrfToken);
    }
    await sessionFromPin(apiPinLogin({ pin }, csrf));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applySession, csrfToken]);

  const pinSetup = useCallback(async (answer: string, pin: string) => {
    let csrf = csrfToken;
    if (!csrf) {
      const s = await getSession();
      csrf = s.csrfToken;
      if (mounted.current) applySession(s.user, s.csrfToken);
    }
    await sessionFromPin(apiPinSetup({ answer, pin }, csrf));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applySession, csrfToken]);

  const logout = useCallback(async () => {
    setBusy(true);
    try {
      if (csrfToken) await apiLogout(csrfToken);
    } catch {
      // Logout idempotente: aunque falle, limpiar estado local.
    } finally {
      if (!mounted.current) return;
      setBusy(false);
      try {
        const s = await getSession();
        if (mounted.current) applySession(s.user, s.csrfToken);
      } catch {
        if (mounted.current) {
          setUserState(null);
          setStatus('anonymous');
        }
      }
    }
  }, [applySession, csrfToken]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    setBusy(true);
    try {
      const s = await apiChangePassword({ currentPassword, newPassword }, csrfToken);
      if (!mounted.current) return;
      applySession(s.user, s.csrfToken);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [applySession, csrfToken]);

  const setUser = useCallback((u: PublicUser | null) => {
    setUserState(u);
    if (u && !u.mustChangePassword) setStatus('ready');
  }, []);

  const value = useMemo<SessionState>(() => ({
    status, user, csrfToken, error, online, login, pinLogin, pinSetup, logout, changePassword, refresh, setUser, loginError, busy,
  }), [status, user, csrfToken, error, online, login, pinLogin, pinSetup, logout, changePassword, refresh, setUser, loginError, busy]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession fuera del proveedor');
  return ctx;
}

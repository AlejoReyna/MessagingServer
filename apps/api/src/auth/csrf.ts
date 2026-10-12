import { hmacHex, randomToken, safeEqual } from "../lib/crypto.js";

const CSRF_TOKEN_CONTEXT = "private-chat csrf-token v1";
const CSRF_COOKIE_CONTEXT = "private-chat csrf-cookie v1";
// 30 días en segundos.
const CSRF_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

export interface IssuedCsrf {
  /** Valor de la cookie `pc_csrf`. */
  cookieValue: string;
  /** Token que el cliente envía en `X-CSRF-Token`. */
  token: string;
  maxAge: number;
}

/**
 * CSRF sin estado en servidor: la cookie guarda un secreto aleatorio firmado
 * con el secreto de servidor; el token es un HMAC derivado de ese secreto.
 * Rotar = emitir un secreto nuevo.
 */
export function issueCsrf(csrfSecret: string, nowMs: number = Date.now()): IssuedCsrf {
  const secret = randomToken();
  const exp = Math.floor(nowMs / 1000) + CSRF_COOKIE_MAX_AGE;
  const payload = `${secret}.${exp}`;
  const sig = hmacHex(csrfSecret, `${CSRF_COOKIE_CONTEXT}:${payload}`);
  return {
    cookieValue: `${payload}.${sig}`,
    token: hmacHex(csrfSecret, `${CSRF_TOKEN_CONTEXT}:${secret}`),
    maxAge: CSRF_COOKIE_MAX_AGE,
  };
}

/** Comprueba cookie + token sin revelar el motivo exacto. */
export function verifyCsrf(csrfSecret: string, cookieValue: string | undefined, token: string | undefined): boolean {
  if (!cookieValue || !token) return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 3) return false;
  const [secret, expRaw, sig] = parts as [string, string, string];
  if (!secret || !expRaw || !sig) return false;
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isInteger(exp)) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false;
  const expectedSig = hmacHex(csrfSecret, `${CSRF_COOKIE_CONTEXT}:${secret}.${expRaw}`);
  if (!safeEqual(sig, expectedSig)) return false;
  const expectedToken = hmacHex(csrfSecret, `${CSRF_TOKEN_CONTEXT}:${secret}`);
  return safeEqual(token, expectedToken);
}

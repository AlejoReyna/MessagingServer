import { createPrivateKey, createSign, generateKeyPairSync, sign } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "./config.js";
import { sha256Hex } from "./lib/crypto.js";

// Web Push VAPID (contrato v5): aviso genérico sin texto, como una
// transferencia bancaria pero diciendo sólo "Nuevo mensaje".
//
// Privacidad: el push viaja vacío (sin body, sin remitente, sin texto) por
// los servidores de push (Apple/Google) y sólo despierta al service worker,
// que pinta el aviso genérico local. Borrar el mensaje no retira avisos ya
// mostrados. Deshabilitado por defecto; el operador lo activa con
// VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY_FILE + VAPID_SUBJECT. Nunca registra
// endpoints completos, claves ni contenido.

export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;
const PUSH_TIMEOUT_MS = 10000;
const PUSH_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushFetchFn = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number }>;

/** id estable = SHA-256 hex del endpoint (64 caracteres, apto como PK text). */
export function subscriptionIdFor(endpoint: string): string {
  return sha256Hex(endpoint);
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(value: string): Buffer {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Convierte firma ECDSA DER a raw R||S de 64 bytes (JWS ES256). */
export function derToRawSignature(der: Buffer): Buffer {
  if (der[0] !== 0x30) throw new Error("Firma DER inválida");
  let offset = 2;
  if (der[1]! & 0x80) offset = 2 + (der[1]! & 0x7f);
  if (der[offset] !== 0x02) throw new Error("Firma DER inválida");
  const rLen = der[offset + 1]!;
  const r = der.subarray(offset + 2, offset + 2 + rLen);
  offset = offset + 2 + rLen;
  if (der[offset] !== 0x02) throw new Error("Firma DER inválida");
  const sLen = der[offset + 1]!;
  const s = der.subarray(offset + 2, offset + 2 + sLen);
  const raw = Buffer.alloc(64, 0);
  const rTrim = r[0] === 0 ? r.subarray(1) : r;
  const sTrim = s[0] === 0 ? s.subarray(1) : s;
  // Copia alineada a la derecha en cada mitad de 32 bytes.
  Buffer.from(rTrim).copy(raw, 32 - rTrim.length, 0);
  Buffer.from(sTrim).copy(raw, 64 - sTrim.length, 0);
  return raw;
}

export function buildVapidHeaders(input: {
  publicKey: string;
  privateKey: string;
  subject: string;
  audience: string;
  expiresInSeconds?: number;
  nowMs?: number;
}): { authorization: string; cryptoKey: string } {
  const pubBytes = base64urlToBytes(input.publicKey);
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) throw new Error("Clave pública VAPID no válida");
  const x = base64urlEncode(pubBytes.subarray(1, 33));
  const y = base64urlEncode(pubBytes.subarray(33, 65));
  const privateJwk = { kty: "EC", crv: "P-256", x, y, d: input.privateKey };
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const header = base64urlEncode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" }), "utf8"));
  const payload = base64urlEncode(Buffer.from(JSON.stringify({
    aud: input.audience,
    exp: nowSeconds + (input.expiresInSeconds ?? 12 * 60 * 60),
    sub: input.subject,
  }), "utf8"));
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey({ key: privateJwk, format: "jwk" });
  void createSign;
  const der = sign("sha256", Buffer.from(signingInput, "utf8"), key);
  const raw = derToRawSignature(der);
  const jwt = `${signingInput}.${base64urlEncode(raw)}`;
  const publicKeyTrimmed = input.publicKey.replace(/=+$/, "");
  return {
    authorization: `vapid t=${jwt}, k=${publicKeyTrimmed}`,
    cryptoKey: `p256ecdsa=${publicKeyTrimmed}`,
  };
}

export function pushAudienceFor(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") throw new Error("Endpoint push no válido");
  return url.origin;
}

async function defaultPushFetch(url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }): Promise<{ status: number }> {
  const res = await fetch(url, { method: init.method, headers: init.headers, signal: init.signal });
  return { status: res.status };
}

/** Envía un push vacío (sin payload) a un endpoint. 404/410 = suscripción caducada. */
export async function sendEmptyPush(input: {
  subscription: PushSubscriptionRow;
  config: Pick<AppConfig, "push">;
  fetchFn?: PushFetchFn;
  timeoutMs?: number;
}): Promise<{ ok: boolean; gone: boolean; status: number }> {
  const audience = pushAudienceFor(input.subscription.endpoint);
  const { authorization, cryptoKey } = buildVapidHeaders({
    publicKey: input.config.push.publicKey,
    privateKey: input.config.push.privateKey,
    subject: input.config.push.subject,
    audience,
  });
  const timeoutMs = input.timeoutMs ?? PUSH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const send = input.fetchFn ?? defaultPushFetch;
    const res = await send(input.subscription.endpoint, {
      method: "POST",
      headers: {
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: "high",
        Authorization: authorization,
        "Crypto-Key": cryptoKey,
      },
      signal: controller.signal,
    });
    const gone = res.status === 404 || res.status === 410;
    return { ok: res.status >= 200 && res.status < 300, gone, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/** Genera un par VAPID P-256 (para el script del operador). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubDer = publicKey.export({ format: "der", type: "spki" });
  // SPKI termina en el punto sin comprimir de 65 bytes (0x04 || X || Y).
  const raw = pubDer.subarray(pubDer.length - 65);
  const privJwk = privateKey.export({ format: "jwk" });
  const d = privJwk.d;
  if (!d || raw.length !== 65 || raw[0] !== 0x04) throw new Error("No se pudo generar el par VAPID");
  return { publicKey: base64urlEncode(Buffer.from(raw)), privateKey: d };
}

export async function notifyPushNewMessage(input: {
  config: AppConfig;
  db: Pick<PrismaClient, "user" | "pushSubscription">;
  senderId: string;
  fetchFn?: PushFetchFn;
}): Promise<{ sent: number; pruned: number; reason: string }> {
  if (!input.config.push.enabled) return { sent: 0, pruned: 0, reason: "disabled" };
  const users = await input.db.user.findMany({ select: { id: true } });
  const recipient = users.find((u) => u.id !== input.senderId);
  if (!recipient) return { sent: 0, pruned: 0, reason: "no-recipient" };
  const subscriptions = await input.db.pushSubscription.findMany({
    where: { userId: recipient.id },
    select: { endpoint: true, p256dh: true, auth: true },
  });
  if (subscriptions.length === 0) return { sent: 0, pruned: 0, reason: "no-subscriptions" };
  let sent = 0;
  let pruned = 0;
  await Promise.all(subscriptions.map(async (sub) => {
    try {
      const result = await sendEmptyPush({ subscription: sub, config: input.config, fetchFn: input.fetchFn });
      if (result.ok) {
        sent += 1;
      } else if (result.gone) {
        pruned += 1;
        await input.db.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } }).catch(() => undefined);
      }
    } catch {
      // Red o push service caído: se conserva la suscripción para el próximo mensaje.
    }
  }));
  return { sent, pruned, reason: "sent" };
}

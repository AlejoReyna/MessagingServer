import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** SHA-256 hexadecimal para guardar hashes de tokens opacos. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Token opaco aleatorio de 32 bytes en base64url (43 caracteres). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Comparación en tiempo constante sobre las representaciones UTF-8. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

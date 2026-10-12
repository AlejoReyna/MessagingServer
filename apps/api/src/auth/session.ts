import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { hmacHex, randomToken, safeEqual, sha256Hex } from "../lib/crypto.js";

export const SESSION_COOKIE_NAME = "pc_session";
export const CSRF_COOKIE_NAME = "pc_csrf";
// 30 días en milisegundos.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE_CONTEXT = "private-chat session-cookie v1";

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

/** Firma la cookie de sesión para detectar manipulación antes de ir a la DB. */
export function signSessionCookie(cookieSecret: string, token: string): string {
  return `${token}.${hmacHex(cookieSecret, `${SESSION_COOKIE_CONTEXT}:${token}`)}`;
}

export function parseSessionCookie(cookieSecret: string, cookieValue: string | undefined): string | null {
  if (!cookieValue) return null;
  const idx = cookieValue.lastIndexOf(".");
  if (idx <= 0) return null;
  const token = cookieValue.slice(0, idx);
  const sig = cookieValue.slice(idx + 1);
  if (!token || !sig) return null;
  const expected = hmacHex(cookieSecret, `${SESSION_COOKIE_CONTEXT}:${token}`);
  if (!safeEqual(sig, expected)) return null;
  return token;
}

export async function createSession(db: PrismaClient, userId: string, now: Date = new Date()): Promise<{ record: SessionRecord; token: string }> {
  const token = randomToken();
  const record = await db.session.create({
    data: {
      id: randomUUID(),
      tokenHash: sha256Hex(token),
      userId,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    },
    select: { id: true, userId: true, tokenHash: true, expiresAt: true },
  });
  return { record, token };
}

export async function findSession(db: PrismaClient, token: string): Promise<SessionRecord | null> {
  const row = await db.session.findUnique({
    where: { tokenHash: sha256Hex(token) },
    select: { id: true, userId: true, tokenHash: true, expiresAt: true, revokedAt: true },
  });
  if (!row) return null;
  const now = new Date();
  if (row.revokedAt !== null || row.expiresAt.getTime() <= now.getTime()) return null;
  return { id: row.id, userId: row.userId, tokenHash: row.tokenHash, expiresAt: row.expiresAt };
}

export async function touchSession(db: PrismaClient, sessionId: string): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { lastSeenAt: new Date() },
  });
}

export async function revokeSession(db: PrismaClient, sessionId: string): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllUserSessions(db: PrismaClient, userId: string): Promise<void> {
  await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

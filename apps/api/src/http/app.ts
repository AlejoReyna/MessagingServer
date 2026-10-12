import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import helmet from "@fastify/helmet";
import {
  LoginInputSchema,
  ChangePasswordInputSchema,
  ChangePinInputSchema,
  UpdateProfileInputSchema,
  SendMessageInputSchema,
  MessagesQuerySchema,
  MarkReadInputSchema,
  DeleteInputSchema,
  PinSetupInputSchema,
  PinLoginInputSchema,
  PinStatusResponseSchema,
  SavePushSubscriptionInputSchema,
  DeletePushSubscriptionInputSchema,
  VapidKeyResponseSchema,
  PushSubscriptionSavedResponseSchema,
  MAX_AVATAR_BYTES,
  PHOTO_MESSAGE_BODY,
  VIDEO_MESSAGE_BODY,
  MAX_CHAT_VIDEO_BYTES,
  type SendMessageInput,
  type Message,
} from "@private-chat/contracts";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../config.js";
import { ERRORS, errorBody, type ApiHttpError } from "./errors.js";
import { hmacHex, safeEqual, sha256Hex } from "../lib/crypto.js";
import { issueCsrf, verifyCsrf } from "../auth/csrf.js";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  createSession,
  findSession,
  parseSessionCookie,
  revokeAllUserSessions,
  revokeSession,
  signSessionCookie,
} from "../auth/session.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { MemoryRateLimiter } from "../lib/rate-limit.js";
import { toPublicUser } from "../users.js";
import { detectImageFormat, processAvatarImage } from "../avatar.js";
import { processChatPhoto } from "../photo.js";
import { processChatVideo, parseVideoRange } from "../video.js";
import { replaceAvatar } from "../avatar-storage.js";
import { applyConversationClear, applyMessageDeletion, lockConversation } from "../deletions.js";
import { appendJournalEntry, type JournalEntry } from "../deletion-journal.js";
import {
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  notifyPushNewMessage,
  subscriptionIdFor,
  type PushFetchFn,
} from "../push.js";
import { RealtimeHub } from "../realtime.js";

export interface BuildAppOptions {
  config: AppConfig;
  db: PrismaClient;
  /** Transporte push inyectable (pruebas). Por defecto fetch al push service. */
  pushFetchFn?: PushFetchFn;
}

interface AuthenticatedContext {
  userId: string;
  sessionId: string;
  sessionHash: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthenticatedContext | null;
    csrfToken: string;
  }
  interface FastifyInstance {
    hub: RealtimeHub | null;
  }
}

const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

function cookieFlags(isProd: boolean): { httpOnly: true; secure: boolean; sameSite: "lax"; path: "/" } {
  return { httpOnly: true, secure: isProd, sameSite: "lax", path: "/" };
}

const messageSelect = { id: true, clientMessageId: true, senderId: true, sequence: true,
  body: true, createdAt: true, photoHash: true, videoHash: true, replyToMessageId: true } as const;

type ReplyTarget = { id: string; senderId: string; body: string; photoHash: string | null; videoHash: string | null };
const replyTargetSelect = { id: true, senderId: true, body: true, photoHash: true, videoHash: true } as const;

function replySnapshot(target: ReplyTarget): NonNullable<Message["replyTo"]> {
  return {
    messageId: target.id,
    senderId: target.senderId,
    body: target.body,
    ...(target.photoHash ? { photoUrl: `/api/messages/${target.id}/photo` } : {}),
    ...(target.videoHash ? { videoUrl: `/api/messages/${target.id}/video` } : {}),
  };
}

// La cita viaja autocontenida en el DTO para que el historial la muestre sin
// rondas extra; si el original se borró después, la cita se omite y el mensaje
// conserva su texto. Nunca incluye bytes, sólo la URL privada existente.
async function fetchReplyTargets(
  client: Pick<PrismaClient, "message">,
  ids: string[],
): Promise<Map<string, ReplyTarget>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const targets = await client.message.findMany({
    where: { id: { in: unique } },
    select: replyTargetSelect,
  });
  return new Map(targets.map((t) => [t.id, t]));
}

function serializeMessage(row: {
  id: string;
  clientMessageId: string;
  senderId: string;
  sequence: number;
  body: string;
  createdAt: Date;
  photoHash?: string | null;
  videoHash?: string | null;
  replyToMessageId?: string | null;
}, replies?: Map<string, ReplyTarget>): Message {
  const target = row.replyToMessageId ? replies?.get(row.replyToMessageId) : undefined;
  return {
    id: row.id,
    clientMessageId: row.clientMessageId,
    senderId: row.senderId,
    sequence: row.sequence,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    ...(row.photoHash ? { photoUrl: `/api/messages/${row.id}/photo` } : {}),
    ...(row.videoHash ? { videoUrl: `/api/messages/${row.id}/video` } : {}),
    ...(target ? { replyTo: replySnapshot(target) } : {}),
  };
}

function zodDetails(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "issues" in error) {
    const issues = (error as { issues: Array<{ message?: string }> }).issues;
    const first = issues[0]?.message;
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, db } = options;
  const pushFetchFn = options.pushFetchFn;
  const app: FastifyInstance = Fastify({
    logger: {
      level: process.env["LOG_LEVEL"] ?? "info",
      redact: {
        paths: [
          "req.headers.cookie",
          "req.headers.authorization",
          "req.headers['x-csrf-token']",
          "res.headers['set-cookie']",
        ],
        censor: "[oculto]",
      },
    },
    // Nunca registrar el cuerpo: sólo método, URL, estado y latencia.
    disableRequestLogging: false,
  });

  await app.register(cookie);
  await app.register(helmet, {
    global: true,
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  await app.register(multipart, {
    limits: { fileSize: MAX_AVATAR_BYTES, files: 1, fields: 10 },
  });
  app.decorate("hub", null);
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  const loginByAccount = new MemoryRateLimiter({ maxAttempts: 10, windowMs: 10 * 60 * 1000 });
  const loginByIp = new MemoryRateLimiter({ maxAttempts: 200, windowMs: 10 * 60 * 1000 });
  const pinLoginByIp = new MemoryRateLimiter({ maxAttempts: 20, windowMs: 10 * 60 * 1000 });
  const pinSetupByIp = new MemoryRateLimiter({ maxAttempts: 10, windowMs: 10 * 60 * 1000 });
  // Bloqueo por cuenta ante PIN erróneos: 10 fallos globales → 30 min.
  // El espacio es de 10.000 códigos; el bloqueo global frena el barrido
  // distribuido que el límite por IP no cubre. Bloquea ambos slots a la vez
  // para no revelar por oráculo a qué cuenta pertenece cada intento.
  const PIN_MAX_FAILURES = 10;
  const PIN_LOCK_MS = 30 * 60 * 1000;
  const sendByUser = new MemoryRateLimiter({ maxAttempts: 60, windowMs: 60 * 1000 });
  const videoByUser = new MemoryRateLimiter({ maxAttempts: 6, windowMs: 60 * 1000 });
  let convertingVideo = false;
  const pushByUser = new MemoryRateLimiter({ maxAttempts: 30, windowMs: 60 * 1000 });

  // --- Sesión y CSRF -------------------------------------------------------
  app.addHook("onRequest", async (request, reply) => {
    // Socket.IO gestiona sus propias peticiones; Fastify no debe responderlas
    // (evita doble respuesta en el servidor HTTP compartido).
    if (request.url.startsWith("/socket.io")) {
      reply.hijack();
      return;
    }
    request.auth = null;
    request.csrfToken = "";
    const csrfCookie = request.cookies[CSRF_COOKIE_NAME];
    const csrfHeader = request.headers["x-csrf-token"];
    const headerToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
    if (csrfCookie && headerToken && verifyCsrf(config.csrfSecret, csrfCookie, headerToken)) {
      request.csrfToken = headerToken;
    }

    const rawSession = request.cookies[SESSION_COOKIE_NAME];
    const token = parseSessionCookie(config.cookieSecret, rawSession);
    if (!token) return;
    const session = await findSession(db, token);
    if (!session) return;
    request.auth = { userId: session.userId, sessionId: session.id, sessionHash: session.tokenHash };
  });

  function issueCsrfPair(): { cookieValue: string; token: string } {
    const issued = issueCsrf(config.csrfSecret);
    return { cookieValue: issued.cookieValue, token: issued.token };
  }

  function setCsrfCookie(reply: import("fastify").FastifyReply, cookieValue: string): void {
    // HttpOnly: el cliente lee el token del JSON, nunca de la cookie.
    reply.setCookie(CSRF_COOKIE_NAME, cookieValue, {
      ...cookieFlags(config.isProd),
      maxAge: 30 * 24 * 60 * 60,
    });
  }

  function setSessionCookie(reply: import("fastify").FastifyReply, token: string): void {
    reply.setCookie(SESSION_COOKIE_NAME, signSessionCookie(config.cookieSecret, token), {
      ...cookieFlags(config.isProd),
      maxAge: SESSION_MAX_AGE,
    });
  }

  function clearSessionCookie(reply: import("fastify").FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  }

  async function requireCsrf(request: FastifyRequest): Promise<ApiHttpError | null> {
    const csrfCookie = request.cookies[CSRF_COOKIE_NAME];
    const csrfHeader = request.headers["x-csrf-token"];
    const headerToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
    if (!verifyCsrf(config.csrfSecret, csrfCookie, headerToken)) {
      return ERRORS.csrfInvalid();
    }
    return null;
  }

  async function requireAuth(request: FastifyRequest): Promise<ApiHttpError | null> {
    if (!request.auth) return ERRORS.unauthenticated();
    const user = await db.user.findUnique({
      where: { id: request.auth.userId },
      select: { id: true, mustChangePassword: true },
    });
    if (!user) return ERRORS.unauthenticated();
    const url = request.url.split("?")[0] ?? "";
    const exempt =
      url === "/api/auth/session" || url === "/api/auth/logout" || url === "/api/auth/change-password";
    if (user.mustChangePassword && !exempt) return ERRORS.passwordChangeRequired();
    return null;
  }

  async function guard(request: FastifyRequest, opts: { auth: boolean; csrf: boolean }): Promise<ApiHttpError | null> {
    if (opts.csrf) {
      const csrfError = await requireCsrf(request);
      if (csrfError) return csrfError;
    }
    if (opts.auth) return requireAuth(request);
    return null;
  }

  function fail(reply: import("fastify").FastifyReply, err: ApiHttpError): import("fastify").FastifyReply {
    return reply.status(err.status).send(errorBody(err));
  }

  // --- Salud ---------------------------------------------------------------
  app.get("/api/health", async (_request, reply) => reply.send({ status: "ok" }));

  app.get("/api/ready", async (_request, reply) => {
    try {
      await db.$queryRaw`SELECT 1`;
      const [userCount, conversation] = await Promise.all([
        db.user.count(),
        db.conversation.findUnique({ where: { id: 1 }, select: { id: true } }),
      ]);
      if (userCount !== 2 || !conversation) {
        return reply.status(503).send(errorBody(ERRORS.unavailable()));
      }
      return reply.send({ status: "ok" });
    } catch {
      return reply.status(503).send(errorBody(ERRORS.unavailable()));
    }
  });

  // --- Sesión --------------------------------------------------------------
  app.get("/api/auth/session", async (request, reply) => {
    let csrfCookie = request.cookies[CSRF_COOKIE_NAME];
    let token = readCsrfTokenFromCookie(csrfCookie);
    if (!csrfCookie || !token) {
      const issued = issueCsrfPair();
      csrfCookie = issued.cookieValue;
      token = issued.token;
      setCsrfCookie(reply, csrfCookie);
    }
    if (!request.auth) return reply.send({ user: null, csrfToken: token });
    const user = await db.user.findUnique({ where: { id: request.auth.userId } });
    if (!user) return reply.send({ user: null, csrfToken: token });
    return reply.send({ user: toPublicUser(user), csrfToken: token });
  });

  /**
   * Si la cookie CSRF es auténtica y vigente, deriva el token que le
   * corresponde (el mismo que se entregó al emitirla). Null en otro caso.
   */
  function readCsrfTokenFromCookie(cookieValue: string | undefined): string | null {
    if (!cookieValue) return null;
    const parts = cookieValue.split(".");
    if (parts.length !== 3) return null;
    const secret = parts[0] ?? "";
    if (!secret) return null;
    const derived = hmacHex(config.csrfSecret, `private-chat csrf-token v1:${secret}`);
    if (!verifyCsrf(config.csrfSecret, cookieValue, derived)) return null;
    return derived;
  }

  // --- Login ---------------------------------------------------------------
  // Hash ficticio para igualar tiempos cuando el usuario no existe.
  let cachedDummyHash: string | null = null;
  async function dummyHash(): Promise<string> {
    if (!cachedDummyHash) {
      cachedDummyHash = await hashPassword(`ficticio-${randomUUID()}`);
    }
    return cachedDummyHash;
  }

  app.post("/api/auth/login", async (request, reply) => {
    const csrfError = await requireCsrf(request);
    if (csrfError) return fail(reply, csrfError);

    const parsed = LoginInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, ERRORS.validation(zodDetails(parsed.error) ?? "Datos no válidos"));

    const ip = request.ip;
    if (!loginByIp.take(`ip:${ip}`) || !loginByAccount.take(`user:${parsed.data.username}`)) {
      return fail(reply, ERRORS.rateLimited());
    }

    const user = await db.user.findUnique({ where: { username: parsed.data.username } });
    // Cuenta de invitado con PIN definido: sólo entra con el código.
    if (user && user.slot === 2 && user.pinHash !== null) {
      return fail(reply, ERRORS.pinRequired());
    }
    // Tiempo comparable exista o no el usuario: si no existe, se verifica
    // contra un hash ficticio para no revelar su existencia por timing.
    const ok = user
      ? await verifyPassword(user.passwordHash, parsed.data.password)
      : await verifyPassword(await dummyHash(), parsed.data.password).then(() => false);
    if (!user || !ok) {
      // Respuesta genérica: no revela si el usuario existe.
      return fail(reply, ERRORS.invalidCredentials());
    }

    loginByAccount.reset(`user:${user.username}`);
    const { token } = await createSession(db, user.id);
    setSessionCookie(reply, token);
    const issued = issueCsrfPair();
    setCsrfCookie(reply, issued.cookieValue);
    return reply.send({ user: toPublicUser(user), csrfToken: issued.token });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const csrfError = await requireCsrf(request);
    if (csrfError) return fail(reply, csrfError);
    if (request.auth) {
      await revokeSession(db, request.auth.sessionId);
      app.hub?.closeSessionSockets(request.auth.sessionHash);
    }
    clearSessionCookie(reply);
    const issued = issueCsrfPair();
    setCsrfCookie(reply, issued.cookieValue);
    return reply.status(204).send();
  });

  app.post("/api/auth/change-password", async (request, reply) => {
    const error = await guard(request, { auth: false, csrf: true });
    if (error) return fail(reply, error);
    if (!request.auth) return fail(reply, ERRORS.unauthenticated());

    const parsed = ChangePasswordInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, ERRORS.validation(zodDetails(parsed.error) ?? "Datos no válidos"));

    const user = await db.user.findUnique({ where: { id: request.auth.userId } });
    if (!user) return fail(reply, ERRORS.unauthenticated());
    const currentOk = await verifyPassword(user.passwordHash, parsed.data.currentPassword);
    if (!currentOk) return fail(reply, ERRORS.invalidCredentials());

    const passwordHash = await hashPassword(parsed.data.newPassword);
    const updated = await db.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: false },
    });
    // Revoca TODAS las sesiones (incluida la actual) y cierra sus sockets.
    await revokeAllUserSessions(db, user.id);
    app.hub?.closeUserSockets(user.id);
    const { token } = await createSession(db, user.id);
    setSessionCookie(reply, token);
    const issued = issueCsrfPair();
    setCsrfCookie(reply, issued.cookieValue);
    return reply.send({ user: toPublicUser(updated), csrfToken: issued.token });
  });

  // --- Acceso con PIN (contrato v2: la UI usa esto en vez del login) --------
  // El servidor decide a qué cuenta pertenece cada PIN; el cliente nunca
  // elige cuenta, así no hay oráculo de slot por respuesta ni por tiempo
  // (se verifican ambos hashes siempre).

  app.get("/api/auth/pin-status", async (_request, reply) => {
    const member = await db.user.findFirst({ where: { slot: 2 }, select: { pinHash: true } });
    return reply.send(PinStatusResponseSchema.parse({ memberPinSet: member?.pinHash != null }));
  });

  app.post("/api/auth/pin-setup", async (request, reply) => {
    const csrfError = await requireCsrf(request);
    if (csrfError) return fail(reply, csrfError);

    const parsed = PinSetupInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, ERRORS.validation(zodDetails(parsed.error) ?? "Datos no válidos"));

    const ip = request.ip;
    if (!pinSetupByIp.take(`ip:${ip}`)) return fail(reply, ERRORS.rateLimited());

    const member = await db.user.findFirst({ where: { slot: 2 } });
    // Un solo alta: creado el PIN, nadie más puede usar esta vía.
    if (!member || member.pinHash !== null) {
      return fail(reply, ERRORS.idempotencyConflict());
    }
    if (config.guestSetupSecret.trim().length === 0) {
      return fail(reply, ERRORS.unavailable());
    }
    // Comparación en tiempo constante sobre hashes (longitud siempre igual).
    const answerOk = safeEqual(
      sha256Hex(parsed.data.answer.trim().toLowerCase()),
      sha256Hex(config.guestSetupSecret.trim().toLowerCase()),
    );
    if (!answerOk) return fail(reply, ERRORS.invalidCredentials());

    const updated = await db.user.update({
      where: { id: member.id },
      data: {
        pinHash: await hashPassword(parsed.data.pin),
        pinFailedAttempts: 0,
        pinLockedUntil: null,
        mustChangePassword: false,
      },
    });
    const { token } = await createSession(db, member.id);
    setSessionCookie(reply, token);
    const issued = issueCsrfPair();
    setCsrfCookie(reply, issued.cookieValue);
    return reply.status(201).send({ user: toPublicUser(updated), csrfToken: issued.token });
  });

  app.post("/api/auth/pin-login", async (request, reply) => {
    const csrfError = await requireCsrf(request);
    if (csrfError) return fail(reply, csrfError);

    const parsed = PinLoginInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, ERRORS.validation(zodDetails(parsed.error) ?? "Datos no válidos"));

    const ip = request.ip;
    if (!pinLoginByIp.take(`ip:${ip}`)) return fail(reply, ERRORS.rateLimited());

    const now = new Date();
    const slots = await db.user.findMany({ where: { slot: { in: [1, 2] } } });
    let matched: (typeof slots)[number] | null = null;
    let anyLocked = false;
    for (const candidate of slots) {
      const locked = candidate.pinLockedUntil !== null && candidate.pinLockedUntil.getTime() > now.getTime();
      if (locked) {
        anyLocked = true;
        continue;
      }
      const ok = candidate.pinHash
        ? await verifyPassword(candidate.pinHash, parsed.data.pin)
        : await verifyPassword(await dummyHash(), parsed.data.pin).then(() => false);
      if (ok && !matched) matched = candidate;
    }

    if (matched) {
      const updated = await db.user.update({
        where: { id: matched.id },
        data: { pinFailedAttempts: 0, pinLockedUntil: null, mustChangePassword: false },
      });
      const { token } = await createSession(db, matched.id);
      setSessionCookie(reply, token);
      const issued = issueCsrfPair();
      setCsrfCookie(reply, issued.cookieValue);
      return reply.send({ user: toPublicUser(updated), csrfToken: issued.token });
    }

    // Fallo: endurecer todos los slots con PIN (sin revelar cuál se intentó).
    for (const candidate of slots) {
      if (!candidate.pinHash) continue;
      if (candidate.pinLockedUntil !== null && candidate.pinLockedUntil.getTime() > now.getTime()) continue;
      const attempts = candidate.pinFailedAttempts + 1;
      await db.user.update({
        where: { id: candidate.id },
        data: {
          pinFailedAttempts: attempts,
          pinLockedUntil: attempts >= PIN_MAX_FAILURES ? new Date(now.getTime() + PIN_LOCK_MS) : candidate.pinLockedUntil,
        },
      });
    }
    if (anyLocked) return fail(reply, ERRORS.pinLocked());
    return fail(reply, ERRORS.invalidCredentials());
  });

  // --- Perfil --------------------------------------------------------------

  app.post("/api/auth/change-pin", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: true });
    if (error) return fail(reply, error);
    const userId = request.auth!.userId;

    const parsed = ChangePinInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, ERRORS.validation(zodDetails(parsed.error) ?? "Datos no válidos"));

    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user || !user.pinHash) {
      // Sin PIN: el alta es por la puerta de invitado, no por aquí.
      return fail(reply, ERRORS.pinRequired());
    }
    const now = new Date();
    if (user.pinLockedUntil !== null && user.pinLockedUntil.getTime() > now.getTime()) {
      return fail(reply, ERRORS.pinLocked());
    }
    const ok = await verifyPassword(user.pinHash, parsed.data.currentPin);
    if (!ok) {
      const attempts = user.pinFailedAttempts + 1;
      await db.user.update({
        where: { id: user.id },
        data: {
          pinFailedAttempts: attempts,
          pinLockedUntil: attempts >= PIN_MAX_FAILURES ? new Date(now.getTime() + PIN_LOCK_MS) : user.pinLockedUntil,
        },
      });
      return fail(reply, ERRORS.invalidCredentials());
    }
    const updated = await db.user.update({
      where: { id: user.id },
      data: {
        pinHash: await hashPassword(parsed.data.newPin),
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      },
    });
    return reply.send({ user: toPublicUser(updated) });
  });
  app.patch("/api/users/me", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: true });
    if (error) return fail(reply, error);
    const userId = request.auth!.userId;

    const parsed = UpdateProfileInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, ERRORS.validation(zodDetails(parsed.error) ?? "Datos no válidos"));

    try {
      const updated = await db.user.update({
        where: { id: userId },
        data: {
          ...(parsed.data.username !== undefined ? { username: parsed.data.username } : {}),
          ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
        },
      });
      const publicUser = toPublicUser(updated);
      app.hub?.profileUpdated(publicUser);
      return reply.send({ user: publicUser });
    } catch (e: unknown) {
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
        return fail(reply, ERRORS.usernameTaken());
      }
      throw e;
    }
  });

  // --- Avatares ------------------------------------------------------------
  const AVATAR_MIME: Record<string, "jpeg" | "png" | "webp"> = {
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
  };

  function avatarFilePath(filename: string): string {
    const safe = basename(filename);
    const base = resolve(config.uploadDir, "avatars");
    const full = join(base, safe);
    if (!full.startsWith(base)) throw ERRORS.uploadInvalid();
    return full;
  }

  app.post("/api/users/me/avatar", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: true });
    if (error) return fail(reply, error);
    const userId = request.auth!.userId;

    let file: Awaited<ReturnType<FastifyRequest["file"]>>;
    try {
      file = await request.file();
    } catch {
      return fail(reply, ERRORS.uploadInvalid("No se pudo leer el archivo"));
    }
    if (!file) return fail(reply, ERRORS.uploadInvalid("Falta el campo avatar"));

    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of file.file) {
        size += chunk.length;
        if (size > MAX_AVATAR_BYTES) {
          return fail(reply, ERRORS.uploadInvalid("El archivo supera los 5 MiB"));
        }
        chunks.push(chunk as Buffer);
      }
    } catch {
      return fail(reply, ERRORS.uploadInvalid("No se pudo leer el archivo"));
    }
    const buffer = Buffer.concat(chunks);
    const detected = detectImageFormat(buffer);
    const declared = AVATAR_MIME[file.mimetype];
    if (!detected || (declared && declared !== detected)) {
      return fail(reply, ERRORS.uploadInvalid("Formato no admitido. Usa JPEG, PNG o WebP"));
    }

    let processed: Buffer;
    try {
      processed = await processAvatarImage(buffer, detected);
    } catch {
      return fail(reply, ERRORS.uploadInvalid("El archivo no es una imagen válida"));
    }

    const updated = await replaceAvatar(db, config.uploadDir, userId, { bytes: processed, format: detected });

    const publicUser = toPublicUser(updated);
    app.hub?.profileUpdated(publicUser);
    return reply.send({ user: publicUser });
  });

  app.delete("/api/users/me/avatar", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: true });
    if (error) return fail(reply, error);
    const userId = request.auth!.userId;

    const updated = await replaceAvatar(db, config.uploadDir, userId, null);
    const publicUser = toPublicUser(updated);
    app.hub?.profileUpdated(publicUser);
    return reply.send({ user: publicUser });
  });

  app.get("/api/users/:userId/avatar", async (request, reply) => {
    const authError = await requireAuth(request);
    if (authError) return fail(reply, authError);
    const params = request.params as { userId?: string };
    const userId = params.userId ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return fail(reply, ERRORS.validation("Identificador no válido"));

    const user = await db.user.findUnique({ where: { id: userId }, select: { avatarPath: true } });
    if (!user?.avatarPath) return reply.status(404).send(errorBody(ERRORS.messageNotFound()));
    const ext = basename(user.avatarPath).split(".").pop()?.toLowerCase();
    const contentType = ext === "jpg" ? "image/jpeg" : ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : null;
    if (!contentType) return reply.status(404).send(errorBody(ERRORS.messageNotFound()));
    try {
      const data = await fs.readFile(avatarFilePath(user.avatarPath));
      return reply
        .header("content-type", contentType)
        .header("cache-control", "no-store")
        .header("content-length", data.length)
        .send(data);
    } catch {
      return reply.status(404).send(errorBody(ERRORS.messageNotFound()));
    }
  });

  // --- Conversación y mensajes ---------------------------------------------
  async function currentConversation() {
    return db.conversation.findUnique({ where: { id: 1 } });
  }

  app.get("/api/conversation", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: false });
    if (error) return fail(reply, error);
    const userId = request.auth!.userId;

    const conversation = await currentConversation();
    if (!conversation) return fail(reply, ERRORS.unavailable());
    const users = await db.user.findMany({ orderBy: { slot: "asc" } });
    const partner = users.find((u) => u.id !== userId);
    if (!partner || users.length !== 2) return fail(reply, ERRORS.unavailable());
    const receipts = await db.readReceipt.findMany();
    return reply.send({
      conversation: {
        id: 1,
        version: conversation.version,
        lastSequence: conversation.lastSequence,
        readState: receipts.map((r) => ({
          userId: r.userId,
          lastReadSequence: r.lastReadSequence,
          readAt: r.readAt ? r.readAt.toISOString() : null,
        })),
      },
      partner: toPublicUser(partner),
    });
  });

  app.get("/api/messages", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: false });
    if (error) return fail(reply, error);

    const parsed = MessagesQuerySchema.safeParse(request.query);
    if (!parsed.success) return fail(reply, ERRORS.validation(zodDetails(parsed.error) ?? "Datos no válidos"));
    const { before, after, limit } = parsed.data;

    const conversation = await currentConversation();
    if (!conversation) return fail(reply, ERRORS.unavailable());

    let rows: Array<{
      id: string;
      clientMessageId: string;
      senderId: string;
      sequence: number;
      body: string;
      createdAt: Date;
      photoHash: string | null;
      videoHash: string | null;
      replyToMessageId: string | null;
    }>;
    let hasMore = false;
    let nextCursor: number | null = null;

    if (after !== undefined) {
      const fetched = await db.message.findMany({
        where: { conversationId: 1, sequence: { gt: after } },
        orderBy: { sequence: "asc" },
        take: limit + 1,
        select: messageSelect,
      });
      hasMore = fetched.length > limit;
      rows = (hasMore ? fetched.slice(0, limit) : fetched);
      nextCursor = hasMore && rows.length > 0 ? rows[rows.length - 1]!.sequence : null;
    } else {
      const fetched = await db.message.findMany({
        where: before !== undefined ? { conversationId: 1, sequence: { lt: before } } : { conversationId: 1 },
        orderBy: { sequence: "desc" },
        take: limit + 1,
        select: messageSelect,
      });
      hasMore = fetched.length > limit;
      const page = (hasMore ? fetched.slice(0, limit) : fetched).reverse();
      rows = page;
      nextCursor = hasMore && page.length > 0 ? page[0]!.sequence : null;
    }

    return reply.send({
      messages: await withReplies(rows),
      hasMore,
      nextCursor,
      conversationVersion: conversation.version,
    });
  });

  async function withReplies<T extends Parameters<typeof serializeMessage>[0]>(rows: T[]) {
    const replies = await fetchReplyTargets(db,
      rows.map((r) => r.replyToMessageId).filter((v): v is string => !!v));
    return rows.map((r) => serializeMessage(r, replies));
  }

  app.post("/api/messages", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: true });
    if (error) return fail(reply, error);
    const userId = request.auth!.userId;

    const parsed = SendMessageInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, ERRORS.validation(zodDetails(parsed.error) ?? "Datos no válidos"));
    // El límite de frecuencia sólo cuenta intentos bien formados.
    if (!sendByUser.take(userId)) return fail(reply, ERRORS.rateLimited());

    return persistMessage(userId, parsed.data, reply);
  });

  app.post("/api/messages/photo", async (request, reply) => {
    if (request.headers.origin && request.headers.origin !== config.appOrigin) return fail(reply, ERRORS.csrfInvalid());
    const error = await guard(request, { auth: true, csrf: true });
    if (error) return fail(reply, error);
    const userId = request.auth!.userId;
    if (!sendByUser.take(userId)) return fail(reply, ERRORS.rateLimited());
    let photo: Buffer | undefined;
    const fields: Record<string, string> = {};
    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (part.fieldname !== "photo" || photo) throw new Error("INVALID_IMAGE");
          photo = await part.toBuffer();
          if (part.file.truncated) throw new Error("INVALID_IMAGE");
        } else {
          if (!["body", "clientMessageId", "conversationVersion", "replyToMessageId"].includes(part.fieldname) ||
            part.fieldname in fields || typeof part.value !== "string" || part.valueTruncated) {
            throw new Error("INVALID_FIELDS");
          }
          fields[part.fieldname] = part.value;
        }
      }
      if (!photo) throw new Error("INVALID_IMAGE");
    } catch { return fail(reply, ERRORS.uploadInvalid()); }
    const parsed = SendMessageInputSchema.safeParse({ ...fields,
      body: fields["body"]?.trim() || PHOTO_MESSAGE_BODY, conversationVersion: Number(fields["conversationVersion"]) });
    if (!parsed.success) return fail(reply, ERRORS.validation("Datos no válidos"));
    let processed: Buffer;
    try { processed = await processChatPhoto(photo); }
    catch { return fail(reply, ERRORS.uploadInvalid()); }
    return persistMessage(userId, parsed.data, reply, processed);
  });

  app.get("/api/messages/:messageId/photo", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: false });
    if (error) return fail(reply, error);
    const { messageId } = request.params as { messageId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) {
      return fail(reply, ERRORS.validation("Identificador no válido"));
    }
    const row = await db.message.findUnique({ where: { id: messageId }, select: { photoData: true } });
    if (!row?.photoData) return fail(reply, ERRORS.messageNotFound());
    return reply.type("image/webp").header("x-content-type-options", "nosniff").send(Buffer.from(row.photoData));
  });

  app.post("/api/messages/video", async (request, reply) => {
    if (request.headers.origin && request.headers.origin !== config.appOrigin) return fail(reply, ERRORS.csrfInvalid());
    const error = await guard(request, { auth: true, csrf: true });
    if (error) return fail(reply, error);
    const userId = request.auth!.userId;
    if (convertingVideo || !videoByUser.take(userId)) return fail(reply, ERRORS.rateLimited());
    // Reserve before reading: at most one 50 MiB upload/conversion in memory.
    convertingVideo = true;
    try {
      let video: Buffer | undefined;
      const fields: Record<string, string> = {};
      try {
        for await (const part of request.parts({ limits: { fileSize: MAX_CHAT_VIDEO_BYTES, files: 1, fields: 4, parts: 5 } })) {
          if (part.type === "file") {
            if (part.fieldname !== "video" || video) throw new Error("INVALID_VIDEO");
            video = await part.toBuffer();
            if (part.file.truncated) throw new Error("INVALID_VIDEO");
          } else {
            if (!["body", "clientMessageId", "conversationVersion", "replyToMessageId"].includes(part.fieldname) ||
              part.fieldname in fields || typeof part.value !== "string" || part.valueTruncated) throw new Error("INVALID_FIELDS");
            fields[part.fieldname] = part.value;
          }
        }
        if (!video?.length) throw new Error("INVALID_VIDEO");
      } catch { return fail(reply, ERRORS.uploadInvalid("Video no válido. Usa MP4, MOV o WebM de hasta 50 MiB y 3 minutos.")); }
      const parsed = SendMessageInputSchema.safeParse({ ...fields,
        body: fields["body"]?.trim() || VIDEO_MESSAGE_BODY, conversationVersion: Number(fields["conversationVersion"]) });
      if (!parsed.success) return fail(reply, ERRORS.validation("Datos no válidos"));
      const hash = createHash("sha256").update(video).digest("hex");
      let processed: Buffer;
      try { processed = await processChatVideo(video); }
      catch { return fail(reply, ERRORS.uploadInvalid("Video no válido. Usa MP4, MOV o WebM de hasta 50 MiB y 3 minutos.")); }
      return await persistMessage(userId, parsed.data, reply, undefined, { data: processed, hash });
    } finally {
      convertingVideo = false;
    }
  });

  app.get("/api/messages/:messageId/video", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: false });
    if (error) return fail(reply, error);
    const { messageId } = request.params as { messageId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) {
      return fail(reply, ERRORS.validation("Identificador no válido"));
    }
    const row = await db.message.findUnique({ where: { id: messageId }, select: { videoData: true } });
    if (!row?.videoData) return fail(reply, ERRORS.messageNotFound());
    const data = Buffer.from(row.videoData);
    reply.type("video/mp4").header("x-content-type-options", "nosniff").header("accept-ranges", "bytes");
    const header = request.headers.range;
    if (header) {
      const range = parseVideoRange(header, data.length);
      if (!range) return reply.code(416).header("content-range", `bytes */${data.length}`).send();
      const bytes = data.subarray(range.start, range.end + 1);
      return reply.code(206).header("content-range", `bytes ${range.start}-${range.end}/${data.length}`)
        .header("content-length", bytes.length).send(bytes);
    }
    return reply.header("content-length", data.length).send(data);
  });

  async function persistMessage(userId: string, input: SendMessageInput, reply: FastifyReply,
    photo?: Buffer, video?: { data: Buffer; hash: string }) {
    const { clientMessageId, body, conversationVersion, replyToMessageId } = input;

    const photoHash = photo ? createHash("sha256").update(photo).digest("hex") : null;
    const videoHash = video?.hash ?? null;
    const sameReply = (value: string | null | undefined): boolean =>
      (value ?? null) === (replyToMessageId ?? null);

    const send = async (): Promise<{ message: Message; created: boolean }> =>
      db.$transaction(async (tx) => {
        const conv = await lockConversation(tx);
        if (conv.version !== conversationVersion) {
          throw Object.assign(new Error("CONVERSATION_CHANGED"), { code: "CONVERSATION_CHANGED" });
        }
        const existing = await tx.message.findUnique({
          where: { senderId_clientMessageId: { senderId: userId, clientMessageId } },
          select: messageSelect,
        });
        if (existing) {
          if (existing.body !== body || existing.photoHash !== photoHash || existing.videoHash !== videoHash || !sameReply(existing.replyToMessageId)) {
            throw Object.assign(new Error("IDEMPOTENCY_CONFLICT"), { code: "IDEMPOTENCY_CONFLICT" });
          }
          const replies = await fetchReplyTargets(tx,
            existing.replyToMessageId ? [existing.replyToMessageId] : []);
          return { message: serializeMessage(existing, replies), created: false };
        }
        const tombstone = await tx.messageTombstone.findUnique({
          where: { senderId_clientMessageId: { senderId: userId, clientMessageId } },
        });
        if (tombstone) {
          throw Object.assign(new Error("MESSAGE_DELETED"), { code: "MESSAGE_DELETED" });
        }
        // La cita se valida y congela dentro de la misma transacción: el
        // original debe existir; si se borró, 410; si nunca existió, 404.
        let target: ReplyTarget | undefined;
        if (replyToMessageId) {
          const found = await tx.message.findUnique({
            where: { id: replyToMessageId },
            select: replyTargetSelect,
          });
          if (!found) {
            const gone = await tx.messageTombstone.findUnique({ where: { messageId: replyToMessageId } });
            throw Object.assign(
              new Error(gone ? "MESSAGE_DELETED" : "MESSAGE_NOT_FOUND"),
              { code: gone ? "MESSAGE_DELETED" : "MESSAGE_NOT_FOUND" },
            );
          }
          target = found;
        }
        const nextSequence = conv.lastSequence + 1;
        const created = await tx.message.create({
          data: {
            id: randomUUID(),
            conversationId: 1,
            senderId: userId,
            clientMessageId,
            sequence: nextSequence,
            body,
            ...(photo ? { photoData: new Uint8Array(photo), photoHash } : {}),
            ...(video ? { videoData: new Uint8Array(video.data), videoHash } : {}),
            ...(replyToMessageId ? { replyToMessageId } : {}),
          },
          select: messageSelect,
        });
        await tx.conversation.update({ where: { id: 1 }, data: { lastSequence: nextSequence } });
        const replies = target ? new Map([[target.id, target]]) : new Map<string, ReplyTarget>();
        return { message: serializeMessage(created, replies), created: true };
      });

    try {
      const result = await send();
      if (result.created) {
        app.hub?.messageCreated(result.message);
        // Push genérico (contrato v5, opcional, fuera del DTO): push vacío,
        // sin texto ni remitente. No bloquea la respuesta ni registra
        // contenido o endpoints. Los reintentos idempotentes no reenvían.
        void notifyPushNewMessage({ config, db, senderId: userId, fetchFn: pushFetchFn })
          .then((outcome) => {
            if (outcome.reason !== "disabled" && outcome.reason !== "no-subscriptions" && outcome.sent === 0) {
              app.log.warn(`Aviso push omitido (${outcome.reason})`);
            }
          })
          .catch((err: unknown) => {
            const detail = err instanceof Error ? err.message : "error desconocido";
            app.log.error(`No se pudo enviar el aviso push: ${detail}`);
          });
      }
      return reply.status(result.created ? 201 : 200).send({ message: result.message });
    } catch (e: unknown) {
      const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
      // Carrera con el mismo (senderId, clientMessageId): releer y decidir.
      if (code === "P2002") {
        const existing = await db.message.findUnique({
          where: { senderId_clientMessageId: { senderId: userId, clientMessageId } },
          select: messageSelect,
        });
        if (existing) {
          if (existing.body !== body || existing.photoHash !== photoHash || existing.videoHash !== videoHash || !sameReply(existing.replyToMessageId)) return fail(reply, ERRORS.idempotencyConflict());
          const replies = await fetchReplyTargets(db,
            existing.replyToMessageId ? [existing.replyToMessageId] : []);
          return reply.status(200).send({ message: serializeMessage(existing, replies) });
        }
        const tombstone = await db.messageTombstone.findUnique({
          where: { senderId_clientMessageId: { senderId: userId, clientMessageId } },
        });
        if (tombstone) return fail(reply, ERRORS.messageDeleted());
        return fail(reply, ERRORS.internal());
      }
      if (code === "CONVERSATION_CHANGED") return fail(reply, ERRORS.conversationChanged());
      if (code === "IDEMPOTENCY_CONFLICT") return fail(reply, ERRORS.idempotencyConflict());
      if (code === "MESSAGE_DELETED") return fail(reply, ERRORS.messageDeleted());
      if (code === "MESSAGE_NOT_FOUND") return fail(reply, ERRORS.messageNotFound());
      if (code === "NOT_PROVISIONED") return fail(reply, ERRORS.unavailable());
      throw e;
    }
  }

  app.post("/api/conversation/read", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: true });
    if (error) return fail(reply, error);
    const userId = request.auth!.userId;

    const parsed = MarkReadInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, ERRORS.validation(zodDetails(parsed.error) ?? "Datos no válidos"));

    const conversation = await currentConversation();
    if (!conversation) return fail(reply, ERRORS.unavailable());
    const target = Math.min(parsed.data.lastReadSequence, conversation.lastSequence);

    const current = await db.readReceipt.findUnique({ where: { userId } });
    const now = new Date();
    if (!current || target > current.lastReadSequence) {
      const updated = await db.readReceipt.upsert({
        where: { userId },
        create: { userId, lastReadSequence: target, readAt: now },
        update: { lastReadSequence: target, readAt: now },
      });
      const event = {
        userId,
        lastReadSequence: updated.lastReadSequence,
        readAt: (updated.readAt ?? now).toISOString(),
      };
      app.hub?.readUpdated(event);
      return reply.send(event);
    }
    return reply.send({
      userId,
      lastReadSequence: current.lastReadSequence,
      readAt: current.readAt ? current.readAt.toISOString() : now.toISOString(),
    });
  });

  // --- Push (contrato v5: PWA + Web Push, aviso genérico sin texto) ---------
  // La clave pública es pública por diseño VAPID; el endpoint no requiere
  // sesión para que la UI explique el estado antes de entrar.
  app.get("/api/push/vapid-key", async (_request, reply) => {
    return reply.send(VapidKeyResponseSchema.parse({
      publicKey: config.push.enabled ? config.push.publicKey : null,
      enabled: config.push.enabled,
    }));
  });

  function pushKeysValid(p256dh: string, auth: string): boolean {
    try {
      const pad = (value: string): string => {
        const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
        return padded.replace(/-/g, "+").replace(/_/g, "/");
      };
      const pub = Buffer.from(pad(p256dh), "base64");
      const sec = Buffer.from(pad(auth), "base64");
      return pub.length === 65 && pub[0] === 0x04 && sec.length === 16;
    } catch {
      return false;
    }
  }

  app.post("/api/push/subscriptions", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: true });
    if (error) return fail(reply, error);
    if (!config.push.enabled) return fail(reply, ERRORS.unavailable());
    const userId = request.auth!.userId;
    if (!pushByUser.take(userId)) return fail(reply, ERRORS.rateLimited());

    const parsed = SavePushSubscriptionInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, ERRORS.validation(zodDetails(parsed.error) ?? "Datos no válidos"));
    const { endpoint, keys } = parsed.data.subscription;
    if (!pushKeysValid(keys.p256dh, keys.auth)) {
      return fail(reply, ERRORS.validation("Suscripción push no válida"));
    }

    const id = subscriptionIdFor(endpoint);
    // Un mismo navegador puede cambiar de cuenta: el endpoint se reasigna al
    // usuario actual en vez de duplicarse.
    await db.pushSubscription.upsert({
      where: { endpoint },
      create: { id, userId, endpoint, p256dh: keys.p256dh, auth: keys.auth },
      update: { userId, p256dh: keys.p256dh, auth: keys.auth },
    });
    // Tope por cuenta: conservar las más recientes.
    const count = await db.pushSubscription.count({ where: { userId } });
    if (count > MAX_PUSH_SUBSCRIPTIONS_PER_USER) {
      const oldest = await db.pushSubscription.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        take: count - MAX_PUSH_SUBSCRIPTIONS_PER_USER,
        select: { id: true },
      });
      if (oldest.length > 0) {
        await db.pushSubscription.deleteMany({ where: { id: { in: oldest.map((o) => o.id) } } });
      }
    }
    return reply.status(201).send(PushSubscriptionSavedResponseSchema.parse({ saved: true }));
  });

  app.delete("/api/push/subscriptions", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: true });
    if (error) return fail(reply, error);
    const userId = request.auth!.userId;
    if (!pushByUser.take(userId)) return fail(reply, ERRORS.rateLimited());

    const parsed = DeletePushSubscriptionInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, ERRORS.validation(zodDetails(parsed.error) ?? "Datos no válidos"));
    // Idempotente y sólo propia: no revela si el endpoint era de otra cuenta.
    await db.pushSubscription.deleteMany({ where: { endpoint: parsed.data.endpoint, userId } });
    return reply.status(204).send();
  });

  // --- Borrados (propios o admin; vaciado sólo admin) -------------------------
  async function requireAdmin(request: FastifyRequest): Promise<ApiHttpError | null> {
    if (!request.auth) return ERRORS.unauthenticated();
    const user = await db.user.findUnique({ where: { id: request.auth.userId }, select: { role: true } });
    if (!user) return ERRORS.unauthenticated();
    if (user.role !== "admin") return ERRORS.forbidden();
    return null;
  }

  function journalWriteError(stage: string): ApiHttpError {
    app.log.error(`No se pudo escribir el journal de borrados (${stage})`);
    return ERRORS.unavailable();
  }

  app.delete("/api/messages/:messageId", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: true });
    if (error) return fail(reply, error);
    const actorId = request.auth!.userId;

    const params = request.params as { messageId?: string };
    const messageId = params.messageId ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(messageId)) return fail(reply, ERRORS.validation("Identificador no válido"));
    const parsed = DeleteInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, ERRORS.validation(zodDetails(parsed.error) ?? "Datos no válidos"));

    const journalId = randomUUID();
    const nowIso = new Date().toISOString();
    const intent: JournalEntry = {
      v: 1,
      op: "message.delete.intent",
      journalId,
      actorId,
      messageId,
      conversationVersion: parsed.data.conversationVersion,
      createdAt: nowIso,
    };
    const newVersion = parsed.data.conversationVersion + 1;
    try {
      await db.$transaction(async (tx) => {
        const conv = await lockConversation(tx);
        if (conv.version !== parsed.data.conversationVersion) {
          throw Object.assign(new Error("CONVERSATION_CHANGED"), { code: "CONVERSATION_CHANGED" });
        }
        const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true } });
        if (!actor) throw ERRORS.unauthenticated();
        const target = await tx.message.findUnique({ where: { id: messageId }, select: { id: true, senderId: true } });
        if (!target) {
          const deleted = await tx.messageTombstone.findUnique({ where: { messageId }, select: { senderId: true } });
          if (deleted && actor.role !== "admin" && deleted.senderId !== actorId) throw ERRORS.forbidden();
          const code = deleted ? "MESSAGE_DELETED" : "MESSAGE_NOT_FOUND";
          throw Object.assign(new Error(code), { code });
        }
        if (actor.role !== "admin" && target.senderId !== actorId) throw ERRORS.forbidden();
        // Sólo una operación válida llega al journal, dentro del mismo lock
        // que usan los envíos. Un 404/409/410 no se ejecutará al reiniciar.
        try { appendJournalEntry(config.deletionJournalPath, intent); }
        catch { throw Object.assign(new Error("JOURNAL_WRITE_FAILED"), { code: "JOURNAL_WRITE_FAILED" }); }
        await applyMessageDeletion(tx, { messageId, actorId, newVersion });
      });
    } catch (e: unknown) {
      const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
      if (code === "CONVERSATION_CHANGED") return fail(reply, ERRORS.conversationChanged());
      if (code === "MESSAGE_NOT_FOUND") return fail(reply, ERRORS.messageNotFound());
      if (code === "MESSAGE_DELETED") return fail(reply, ERRORS.messageDeleted());
      if (code === "NOT_PROVISIONED") return fail(reply, ERRORS.unavailable());
      if (code === "JOURNAL_WRITE_FAILED") return fail(reply, journalWriteError("intención"));
      throw e;
    }

    try {
      appendJournalEntry(config.deletionJournalPath, {
        v: 1,
        op: "message.delete.commit",
        journalId,
        actorId,
        messageId,
        conversationVersion: newVersion,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // El borrado ya se aplicó; se devuelve error para no declarar éxito
      // sin journal. La reconciliación confirmará la operación.
      return fail(reply, journalWriteError("confirmación"));
    }

    app.hub?.messageDeleted(messageId, newVersion);
    return reply.send({ messageId, conversationVersion: newVersion });
  });

  app.delete("/api/conversation/messages", async (request, reply) => {
    const error = await guard(request, { auth: true, csrf: true });
    if (error) return fail(reply, error);
    const adminError = await requireAdmin(request);
    if (adminError) return fail(reply, adminError);
    const actorId = request.auth!.userId;

    const parsed = DeleteInputSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, ERRORS.validation(zodDetails(parsed.error) ?? "Datos no válidos"));

    const journalId = randomUUID();
    let messageIds: string[] = [];
    const intent: JournalEntry = {
      v: 1,
      op: "conversation.clear.intent",
      journalId,
      actorId,
      messageIds,
      messageCount: 0,
      conversationVersion: parsed.data.conversationVersion,
      createdAt: new Date().toISOString(),
    };
    const newVersion = parsed.data.conversationVersion + 1;
    try {
      await db.$transaction(async (tx) => {
        const conv = await lockConversation(tx);
        if (conv.version !== parsed.data.conversationVersion) {
          throw Object.assign(new Error("CONVERSATION_CHANGED"), { code: "CONVERSATION_CHANGED" });
        }
        // Capturar IDs bajo lock: incluye exactamente lo que se eliminará.
        const active = await tx.message.findMany({ where: { conversationId: 1 }, select: { id: true } });
        messageIds = active.map((row) => row.id);
        intent.messageIds = messageIds;
        intent.messageCount = messageIds.length;
        try { appendJournalEntry(config.deletionJournalPath, intent); }
        catch { throw Object.assign(new Error("JOURNAL_WRITE_FAILED"), { code: "JOURNAL_WRITE_FAILED" }); }
        await applyConversationClear(tx, { actorId, newVersion });
      });
    } catch (e: unknown) {
      const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
      if (code === "CONVERSATION_CHANGED") return fail(reply, ERRORS.conversationChanged());
      if (code === "NOT_PROVISIONED") return fail(reply, ERRORS.unavailable());
      if (code === "JOURNAL_WRITE_FAILED") return fail(reply, journalWriteError("intención"));
      throw e;
    }

    try {
      appendJournalEntry(config.deletionJournalPath, {
        v: 1,
        op: "conversation.clear.commit",
        journalId,
        actorId,
        messageIds,
        messageCount: messageIds.length,
        conversationVersion: newVersion,
        createdAt: new Date().toISOString(),
      });
    } catch {
      return fail(reply, journalWriteError("confirmación"));
    }

    app.hub?.conversationCleared(newVersion);
    return reply.send({ conversationVersion: newVersion });
  });

  // --- Errores ---------------------------------------------------------------
  app.setErrorHandler((error, request, reply) => {
    if (typeof error === "object" && error !== null && "status" in error && "code" in error) {
      const api = error as unknown as ApiHttpError;
      if (typeof api.status === "number" && typeof api.code === "string") {
        return reply.status(api.status).send(errorBody(api));
      }
    }
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500;
    if (statusCode === 413) {
      return reply.status(400).send(errorBody(ERRORS.uploadInvalid("El archivo supera los 5 MiB")));
    }
    if (statusCode >= 400 && statusCode < 500) {
      request.log.warn(`Solicitud rechazada: ${request.method} ${request.url} -> ${statusCode}`);
      return reply.status(statusCode).send(errorBody(ERRORS.validation()));
    }
    request.log.error(`Error interno en ${request.method} ${request.url}`);
    return reply.status(500).send(errorBody(ERRORS.internal()));
  });

  return app;
}

/** Arranca el servidor HTTP + Socket.IO. */
export async function startServer(app: FastifyInstance, config: AppConfig, db: PrismaClient): Promise<RealtimeHub> {
  const hub = new RealtimeHub(app.server, { config, db });
  app.hub = hub;
  await app.listen({ host: config.host, port: config.port });
  return hub;
}

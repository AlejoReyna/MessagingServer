import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import {
  MessageCreatedEventSchema,
  MessageDeletedEventSchema,
  ConversationClearedEventSchema,
  UserResponseSchema,
  ReadUpdatedEventSchema,
  PresenceUpdatedEventSchema,
  TypingUpdatedEventSchema,
  TypingSetInputSchema,
  type Message,
  type PublicUser,
  type ReadUpdatedEvent,
} from "@private-chat/contracts";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "./config.js";
import { verifyCsrf } from "./auth/csrf.js";
import { CSRF_COOKIE_NAME, parseSessionCookie, findSession, type SessionRecord } from "./auth/session.js";
import { MemoryRateLimiter } from "./lib/rate-limit.js";

export const CONVERSATION_ROOM = "conversation:1";
const TYPING_TTL_MS = 5000;
const TYPING_MIN_INTERVAL_MS = 500;

interface RealtimeDeps {
  config: AppConfig;
  db: PrismaClient;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

function validEvent(schema: { safeParse: (v: unknown) => { success: boolean } }, payload: unknown): boolean {
  return schema.safeParse(payload).success;
}

export class RealtimeHub {
  private readonly io: Server;
  private readonly db: PrismaClient;
  private readonly config: AppConfig;
  private readonly userSockets = new Map<string, Set<string>>();
  private readonly sessionSockets = new Map<string, Set<string>>();
  private readonly typingState = new Map<string, boolean>();
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly typingLimit = new MemoryRateLimiter({ maxAttempts: 2, windowMs: 1000 });
  private readonly userBySocket = new Map<string, string>();

  constructor(httpServer: HttpServer, deps: RealtimeDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.io = new Server(httpServer, {
      path: "/socket.io",
      // Sin CORS: el cliente web opera en el mismo origen.
    });
    this.io.use(async (socket, next) => this.authenticate(socket, next));
    this.io.on("connection", (socket) => this.onConnection(socket));
  }

  private async authenticate(
    socket: Socket,
    next: (err?: Error) => void,
  ): Promise<void> {
    try {
      const headers = socket.handshake.headers;
      const origin = headers["origin"];
      if (origin !== this.config.appOrigin) {
        next(new Error("origin"));
        return;
      }
      const cookies = parseCookies(headers["cookie"]);
      const token = parseSessionCookie(this.config.cookieSecret, cookies["pc_session"]);
      if (!token) {
        next(new Error("session"));
        return;
      }
      const session = await findSession(this.db, token);
      if (!session) {
        next(new Error("session"));
        return;
      }
      const user = await this.db.user.findUnique({
        where: { id: session.userId },
        select: { id: true, mustChangePassword: true },
      });
      if (!user || user.mustChangePassword) {
        next(new Error("session"));
        return;
      }
      const csrfToken = (socket.handshake.auth as { csrfToken?: unknown } | undefined)?.["csrfToken"];
      if (typeof csrfToken !== "string" || !verifyCsrf(this.config.csrfSecret, cookies[CSRF_COOKIE_NAME], csrfToken)) {
        next(new Error("csrf"));
        return;
      }
      socket.data["userId"] = user.id;
      socket.data["sessionHash"] = session.tokenHash;
      socket.data["sessionToken"] = token;
      socket.data["expiresAt"] = session.expiresAt;
      next();
    } catch {
      next(new Error("internal"));
    }
  }

  private async onConnection(socket: Socket): Promise<void> {
    const userId = socket.data["userId"] as string;
    const sessionHash = socket.data["sessionHash"] as string;
    const token = socket.data["sessionToken"] as string;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const sessionValid = async (): Promise<SessionRecord | null> => {
      try { return await findSession(this.db, token); } catch { return null; }
    };
    const scheduleExpiry = (expiresAt: Date): void => {
      const remaining = expiresAt.getTime() - Date.now();
      if (remaining <= 0) { socket.disconnect(true); return; }
      expiryTimer = setTimeout(() => {
        void sessionValid().then((session) => {
          if (!socket.connected) return;
          if (!session) socket.disconnect(true);
          else scheduleExpiry(session.expiresAt);
        });
      }, Math.min(remaining, 60_000));
      expiryTimer.unref();
    };
    socket.use((_packet, next) => {
      void sessionValid().then((session) => {
        if (!session) { socket.disconnect(true); next(new Error("session")); }
        else next();
      });
    });
    await socket.join(CONVERSATION_ROOM);
    this.userBySocket.set(socket.id, userId);

    let set = this.userSockets.get(userId);
    const firstConnection = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.userSockets.set(userId, set);
    }
    set.add(socket.id);

    let sset = this.sessionSockets.get(sessionHash);
    if (!sset) {
      sset = new Set();
      this.sessionSockets.set(sessionHash, sset);
    }
    sset.add(socket.id);

    if (firstConnection) {
      this.broadcast("presence:updated", PresenceUpdatedEventSchema, { userId, online: true });
    }
    // Estado actual para el recién conectado (reconciliación sin huecos).
    for (const [otherId, sockets] of this.userSockets) {
      socket.emit("presence:updated", { userId: otherId, online: sockets.size > 0 });
    }

    socket.on("typing:set", (raw: unknown) => {
      const parsed = TypingSetInputSchema.safeParse(raw);
      if (!parsed.success) return;
      if (!this.typingLimit.take(socket.id)) return;
      this.setTyping(userId, parsed.data.isTyping);
    });

    socket.on("disconnect", () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      this.userBySocket.delete(socket.id);
      const current = this.userSockets.get(userId);
      if (current) {
        current.delete(socket.id);
        if (current.size === 0) {
          this.userSockets.delete(userId);
          this.clearTyping(userId, true);
          this.broadcast("presence:updated", PresenceUpdatedEventSchema, { userId, online: false });
        }
      }
      const currentSession = this.sessionSockets.get(sessionHash);
      if (currentSession) {
        currentSession.delete(socket.id);
        if (currentSession.size === 0) this.sessionSockets.delete(sessionHash);
      }
    });
    scheduleExpiry(socket.data["expiresAt"] as Date);
  }

  private setTyping(userId: string, isTyping: boolean): void {
    const previous = this.typingState.get(userId) ?? false;
    const existing = this.typingTimers.get(userId);
    if (existing) {
      clearTimeout(existing);
      this.typingTimers.delete(userId);
    }
    if (isTyping) {
      this.typingState.set(userId, true);
      if (!previous) {
        this.broadcast("typing:updated", TypingUpdatedEventSchema, { userId, isTyping: true });
      }
      const timer = setTimeout(() => this.clearTyping(userId, true), TYPING_TTL_MS);
      this.typingTimers.set(userId, timer);
    } else if (previous) {
      this.clearTyping(userId, true);
    }
  }

  private clearTyping(userId: string, emit: boolean): void {
    const existing = this.typingTimers.get(userId);
    if (existing) {
      clearTimeout(existing);
      this.typingTimers.delete(userId);
    }
    if (this.typingState.get(userId) === true) {
      this.typingState.set(userId, false);
      if (emit) {
        this.broadcast("typing:updated", TypingUpdatedEventSchema, { userId, isTyping: false });
      }
    }
  }

  private broadcast(
    event: "message:created" | "message:deleted" | "conversation:cleared" | "profile:updated" | "read:updated" | "presence:updated" | "typing:updated",
    schema: { safeParse: (v: unknown) => { success: boolean } },
    payload: unknown,
  ): void {
    if (!validEvent(schema, payload)) return;
    this.io.to(CONVERSATION_ROOM).emit(event, payload);
  }

  messageCreated(message: Message): void {
    this.broadcast("message:created", MessageCreatedEventSchema, { message });
  }

  messageDeleted(messageId: string, conversationVersion: number): void {
    this.broadcast("message:deleted", MessageDeletedEventSchema, { messageId, conversationVersion });
  }

  conversationCleared(conversationVersion: number): void {
    this.broadcast("conversation:cleared", ConversationClearedEventSchema, { conversationVersion });
  }

  profileUpdated(user: PublicUser): void {
    this.broadcast("profile:updated", UserResponseSchema, { user });
  }

  readUpdated(event: ReadUpdatedEvent): void {
    this.broadcast("read:updated", ReadUpdatedEventSchema, event);
  }

  onlineCount(): number {
    return this.userSockets.size;
  }

  /** Cierra los sockets de una sesión (logout, expiración local). */
  closeSessionSockets(sessionHash: string): void {
    const sockets = this.sessionSockets.get(sessionHash);
    if (!sockets) return;
    for (const id of sockets) {
      this.io.sockets.sockets.get(id)?.disconnect(true);
    }
  }

  /** Cierra todos los sockets de un usuario (cambio de contraseña). */
  closeUserSockets(userId: string): void {
    const sockets = this.userSockets.get(userId);
    if (!sockets) return;
    for (const id of [...sockets]) {
      this.io.sockets.sockets.get(id)?.disconnect(true);
    }
  }

  /** Desconecta todos los sockets sin cerrar el servidor (aislamiento en pruebas). */
  disconnectAll(): void {
    for (const socket of this.io.sockets.sockets.values()) {
      socket.disconnect(true);
    }
  }

  async close(): Promise<void> {
    await this.io.close();
  }
}

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { buildApp } from "../../src/http/app.js";
import { RealtimeHub } from "../../src/realtime.js";
import { hashPassword } from "../../src/auth/password.js";

const { Pool } = pg;

export const API_DIR = new URL("../..", import.meta.url).pathname;

export interface TestUsers {
  adminId: string;
  memberId: string;
  adminPassword: string;
  memberPassword: string;
}

export interface TestServer {
  app: FastifyInstance;
  hub: RealtimeHub;
  db: PrismaClient;
  config: AppConfig;
  baseUrl: string;
  journalPath: string;
  uploadDir: string;
  users: TestUsers;
  reset: () => Promise<TestUsers>;
  close: () => Promise<void>;
}

export function requireTestDatabaseUrl(): string {
  const url = process.env["INTEGRATION_DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"];
  if (!url) {
    throw new Error(
      "Falta INTEGRATION_DATABASE_URL: define la URL de la base dedicada para pruebas (no se usan SQLite ni omisiones)",
    );
  }
  return url;
}

/** Aplica migraciones con prisma migrate deploy sobre la base de pruebas. */
export function migrateTestDb(databaseUrl: string): void {
  try {
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: API_DIR,
      env: { ...process.env, OWNER_DATABASE_URL: databaseUrl, DATABASE_URL: databaseUrl },
      stdio: "pipe",
    });
  } catch (error: unknown) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
    throw new Error(`No se pudo migrar la base de pruebas: ${stderr.slice(0, 500)}`);
  }
}

async function truncateAll(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    `TRUNCATE "chat"."messages", "chat"."message_tombstones", "chat"."deletion_audit", "chat"."sessions", "chat"."read_receipts", "chat"."push_subscriptions", "chat"."users", "chat"."conversation" CASCADE`,
  );
}

export async function seedTestUsers(db: PrismaClient): Promise<TestUsers> {
  const adminPassword = "Contraseña-admin-001-segura";
  const memberPassword = "Contraseña-member-002-segura";
  await db.conversation.create({ data: { id: 1, version: 1, lastSequence: 0 } });
  const admin = await db.user.create({
    data: {
      id: randomUUID(),
      slot: 1,
      username: "admin",
      displayName: "Admin",
      role: "admin",
      passwordHash: await hashPassword(adminPassword),
      mustChangePassword: true,
    },
  });
  const member = await db.user.create({
    data: {
      id: randomUUID(),
      slot: 2,
      username: "member",
      displayName: "Contacto",
      role: "member",
      passwordHash: await hashPassword(memberPassword),
      mustChangePassword: true,
    },
  });
  for (const id of [admin.id, member.id]) {
    await db.readReceipt.create({ data: { userId: id, lastReadSequence: 0, readAt: null } });
  }
  return { adminId: admin.id, memberId: member.id, adminPassword, memberPassword };
}

export async function startTestServer(): Promise<TestServer> {
  const databaseUrl = requireTestDatabaseUrl();
  migrateTestDb(databaseUrl);

  const dir = mkdtempSync(join(tmpdir(), "pc-api-test-"));
  const uploadDir = join(dir, "uploads");
  const journalPath = join(dir, "deletion-journal.jsonl");
  const config = loadConfig({
    ...process.env,
    APP_ENV: "test",
    APP_ORIGIN: "http://app.test:5173",
    DATABASE_URL: databaseUrl,
    UPLOAD_DIR: uploadDir,
    DELETION_JOURNAL_PATH: journalPath,
  });
  // Secretos de prueba (nunca producción).
  config.cookieSecret = "cookie-secret-de-prueba-00000000000000000000";
  config.csrfSecret = "csrf-secret-de-prueba-000000000000000000000";

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });

  const users = await seedTestUsers(db).catch(async () => {
    await truncateAll(db);
    return seedTestUsers(db);
  });

  const app = await buildApp({ config, db });
  const hub = new RealtimeHub(app.server, { config, db });
  app.hub = hub;
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Sin dirección de escucha");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const reset = async (): Promise<TestUsers> => {
    await truncateAll(db);
    // Limpia también el journal entre escenarios.
    const { rmSync } = await import("node:fs");
    rmSync(journalPath, { force: true });
    return seedTestUsers(db);
  };
  const close = async (): Promise<void> => {
    try {
      (app.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    } catch {
      // Mejor esfuerzo.
    }
    await hub.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  };
  return { app, hub, db, config, baseUrl, journalPath, uploadDir, users, reset, close };
}

// --- Cliente HTTP con jar de cookies ----------------------------------------

export class TestClient {
  private jar = new Map<string, string>();
  csrf = "";

  constructor(readonly baseUrl: string) {}

  get cookies(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  snapshotState(): { cookie: string; csrf: string } {
    return { cookie: this.cookies, csrf: this.csrf };
  }

  restoreState(state: { cookie: string; csrf: string }): void {
    this.jar.clear();
    for (const part of state.cookie.split(";")) {
      const idx = part.indexOf("=");
      if (idx > 0) {
        this.jar.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
      }
    }
    this.csrf = state.csrf;
  }

  private storeCookies(response: Response): void {
    const setCookies: string[] =
      typeof (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (response.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
        : [];
    for (const line of setCookies) {
      const [pair] = line.split(";");
      const idx = (pair ?? "").indexOf("=");
      if (idx > 0) {
        const name = pair!.slice(0, idx).trim();
        const value = pair!.slice(idx + 1).trim();
        if (value === "" || /expires=thu, 01 jan 1970/i.test(line)) this.jar.delete(name);
        else this.jar.set(name, value);
      }
    }
  }

  async request(
    method: string,
    path: string,
    options: { body?: unknown; csrf?: boolean; origin?: string; rawBody?: BodyInit; contentType?: string } = {},
  ): Promise<{ status: number; json: unknown; text: string }> {
    const headers: Record<string, string> = {};
    const cookies = this.cookies;
    if (cookies) headers["cookie"] = cookies;
    if (options.origin !== undefined) headers["origin"] = options.origin;
    let body: BodyInit | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
      if (options.contentType) headers["content-type"] = options.contentType;
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["content-type"] = "application/json";
    }
    if (options.csrf !== false && this.csrf) headers["x-csrf-token"] = this.csrf;
    const response = await fetch(`${this.baseUrl}${path}`, { method, headers, body });
    this.storeCookies(response);
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  }

  /** GET /api/auth/session: refresca csrf y jar. Devuelve el cuerpo. */
  async session(): Promise<{ user: { id: string } | null; csrfToken: string }> {
    const res = await this.request("GET", "/api/auth/session", { csrf: false });
    const body = res.json as { user: { id: string } | null; csrfToken: string };
    this.csrf = body.csrfToken;
    return body;
  }

  async login(username: string, password: string): Promise<{ status: number; json: unknown }> {
    await this.session();
    const res = await this.request("POST", "/api/auth/login", { body: { username, password } });
    if (res.status === 200) {
      const body = res.json as { csrfToken: string };
      this.csrf = body.csrfToken;
    }
    return res;
  }
}

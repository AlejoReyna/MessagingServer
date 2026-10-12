import { readFileSync, existsSync } from "node:fs";

export type AppEnv = "development" | "test" | "production";

export interface AppConfig {
  env: AppEnv;
  isProd: boolean;
  host: string;
  port: number;
  appOrigin: string;
  databaseUrl: string;
  cookieSecret: string;
  csrfSecret: string;
  uploadDir: string;
  deletionJournalPath: string;
  adminUsername: string;
  partnerUsername: string;
  /** Respuesta de la pregunta de alta del invitado (env, minúsculas al comparar). Vacía = alta deshabilitada. */
  guestSetupSecret: string;
  /** Web Push VAPID (contrato v5): aviso genérico sin texto. Deshabilitado si faltan claves o asunto. */
  push: PushConfig;
}

export interface PushConfig {
  enabled: boolean;
  /** Clave pública VAPID en base64url (65 bytes sin comprimir, empieza en 0x04). Vacía = push deshabilitado. */
  publicKey: string;
  /** Clave privada VAPID en base64url (32 bytes). Nunca se registra ni se expone. Vacía = push deshabilitado. */
  privateKey: string;
  /** Contacto del operador: mailto: o https://. Vacío = push deshabilitado. */
  subject: string;
}

function base64urlToBytes(value: string): Buffer | null {
  if (!/^[A-Za-z0-9-_]+$/.test(value) || value.length > 120) return null;
  try {
    const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
    const buf = Buffer.from(padded, "base64");
    // Re-codificar para rechazar alfabetos o longitudes inválidas.
    const roundtrip = buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (roundtrip !== value.replace(/=+$/, "")) return null;
    return buf;
  } catch {
    return null;
  }
}

function parsePushConfig(env: NodeJS.ProcessEnv, isProd: boolean): PushConfig {
  const publicKey = (env["VAPID_PUBLIC_KEY"] ?? "").trim();
  const subject = (env["VAPID_SUBJECT"] ?? "").trim();
  const privateKey = readSecretFile(env["VAPID_PRIVATE_KEY_FILE"], "VAPID_PRIVATE_KEY_FILE", false).trim();
  if (!publicKey && !privateKey && !subject) {
    return { enabled: false, publicKey: "", privateKey: "", subject: "" };
  }
  const pubBytes = publicKey ? base64urlToBytes(publicKey) : null;
  if (!publicKey || !pubBytes || pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
    throw new Error("VAPID_PUBLIC_KEY no válida (base64url de 65 bytes sin comprimir)");
  }
  if (!privateKey) {
    throw new Error("Falta VAPID_PRIVATE_KEY_FILE: define el archivo con la clave privada");
  }
  const privBytes = base64urlToBytes(privateKey);
  if (!privBytes || privBytes.length !== 32) {
    throw new Error("VAPID_PRIVATE_KEY_FILE no válida (base64url de 32 bytes)");
  }
  if (!subject || subject.length > 320 ||
    (!subject.startsWith("mailto:") && !subject.startsWith("https://"))) {
    throw new Error("VAPID_SUBJECT no válido (mailto: o https://)");
  }
  if (isProd && subject.startsWith("mailto:") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject.slice(7))) {
    throw new Error("VAPID_SUBJECT no válido");
  }
  void isProd;
  return { enabled: true, publicKey, privateKey, subject };
}

function readSecretFile(path: string | undefined, name: string, required: boolean): string {
  if (!path) {
    if (required) throw new Error(`Falta ${name}: define la variable de entorno correspondiente`);
    return "";
  }
  if (!existsSync(path)) {
    if (required) throw new Error(`No existe el archivo secreto ${name} (${path})`);
    return "";
  }
  const value = readFileSync(path, "utf8").trim();
  if (required && value.length === 0) throw new Error(`El archivo secreto ${name} está vacío`);
  return value;
}

/** Secreto opcional: respuesta de la pregunta de alta del invitado. */
function readOptionalSecret(path: string | undefined): string {
  if (!path || !existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

function buildDatabaseUrl(env: NodeJS.ProcessEnv): string {
  if (env["DATABASE_URL"]) return env["DATABASE_URL"];
  const host = env["DATABASE_HOST"] ?? "127.0.0.1";
  const port = env["DATABASE_PORT"] ?? "5432";
  const name = env["DATABASE_NAME"] ?? "private_chat";
  const user = env["DATABASE_USER"] ?? "private_chat_app";
  const passwordFile = env["DATABASE_PASSWORD_FILE"];
  let password = "";
  if (passwordFile) password = readSecretFile(passwordFile, "DATABASE_PASSWORD_FILE", true);
  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : `${encodeURIComponent(user)}@`;
  return `postgresql://${auth}${host}:${port}/${encodeURIComponent(name)}`;
}

/** Carga la configuración. Nunca registra secretos. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawEnv = (env["APP_ENV"] ?? "development").toLowerCase();
  if (!["development", "test", "production"].includes(rawEnv)) throw new Error("APP_ENV no válido");
  const appEnv: AppEnv = rawEnv === "production" ? "production" : rawEnv === "test" ? "test" : "development";
  const isProd = appEnv === "production";

  const rawOrigin = env["APP_ORIGIN"] ?? "http://127.0.0.1:5173";
  let parsedOrigin: URL;
  try { parsedOrigin = new URL(rawOrigin); } catch { throw new Error("APP_ORIGIN no válido"); }
  if (!["http:", "https:"].includes(parsedOrigin.protocol) || parsedOrigin.username || parsedOrigin.password || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) throw new Error("APP_ORIGIN debe ser un origen sin ruta ni credenciales");
  const appOrigin = parsedOrigin.origin;
  const host = env["HOST"] ?? "127.0.0.1";
  const port = Number(env["PORT"] ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT no válido");
  }

  const cookieSecret = readSecretFile(env["COOKIE_SECRET_FILE"], "COOKIE_SECRET_FILE", isProd);
  const csrfSecret = readSecretFile(env["CSRF_SECRET_FILE"], "CSRF_SECRET_FILE", isProd);
  if (isProd) {
    if (cookieSecret.length < 32) throw new Error("COOKIE_SECRET_FILE demasiado corto (mínimo 32 caracteres)");
    if (csrfSecret.length < 32) throw new Error("CSRF_SECRET_FILE demasiado corto (mínimo 32 caracteres)");
    if (!/^https:\/\//.test(appOrigin)) {
      throw new Error("En producción APP_ORIGIN debe ser una URL https válida");
    }
    readSecretFile(env["DATABASE_PASSWORD_FILE"], "DATABASE_PASSWORD_FILE", true);
  }

  return {
    env: appEnv,
    isProd,
    host,
    port,
    appOrigin,
    databaseUrl: buildDatabaseUrl(env),
    cookieSecret: cookieSecret || "dev-cookie-secret-no-usar-en-produccion-000000",
    csrfSecret: csrfSecret || "dev-csrf-secret-no-usar-en-produccion-0000000",
    uploadDir: env["UPLOAD_DIR"] ?? "./data/uploads",
    deletionJournalPath: env["DELETION_JOURNAL_PATH"] ?? "./data/deletion-journal.jsonl",
    adminUsername: (env["ADMIN_USERNAME"] ?? "admin").toLowerCase(),
    partnerUsername: (env["PARTNER_USERNAME"] ?? "member").toLowerCase(),
    guestSetupSecret: readOptionalSecret(env["GUEST_SETUP_SECRET_FILE"]),
    push: parsePushConfig(env, isProd),
  };
}

/** Vista segura para logs: sin URLs ni secretos. */
export function configSummary(config: AppConfig): Record<string, string | number | boolean> {
  return {
    env: config.env,
    host: config.host,
    port: config.port,
    appOrigin: config.appOrigin,
    uploadDir: config.uploadDir,
    deletionJournalPath: config.deletionJournalPath,
    databaseConfigured: config.databaseUrl.length > 0,
    pushEnabled: config.push.enabled,
  };
}

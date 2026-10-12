import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DisplayNameSchema, NewPasswordSchema, UsernameSchema } from "@private-chat/contracts";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { hashPassword } from "../auth/password.js";
import { avatarExtension, detectImageFormat, processAvatarImage } from "../avatar.js";
import { removeAvatarFile } from "../avatar-storage.js";

const { Pool } = pg;

function ownerDatabaseUrl(): string {
  const url = process.env["OWNER_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("Define OWNER_DATABASE_URL (o DATABASE_URL) con la conexión del propietario");
  }
  return url;
}

function readPasswordFile(path: string | undefined): string | null {
  if (!path || !existsSync(path)) return null;
  const value = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  return value.length > 0 ? value : null;
}

/** Lee una contraseña por terminal sin eco (no queda en historial ni logs). */
async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    let value = "";
    const decoder = new StringDecoder("utf8");
    const onData = (chunk: Buffer): void => {
      for (const char of decoder.write(chunk)) {
      if (char === "\n" || char === "\r" || char === "\u0004") {
        if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
        stdin.removeListener("data", onData);
        stdin.pause();
        process.stdout.write("\n");
        resolve(value);
        return;
      } else if (char === "\u0003") {
        process.stdout.write("\n");
        process.exit(1);
      } else if (char === "\u007f" || char === "\b") {
        value = Array.from(value).slice(0, -1).join("");
      } else if (char >= " " && char !== "\u007f") {
        value += char;
      }
      }
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

async function initialPassword(label: string, fileEnv: string, username: string): Promise<string> {
  const fromFile = readPasswordFile(process.env[fileEnv]);
  if (fromFile) {
    if (!NewPasswordSchema.safeParse(fromFile).success) throw new Error("Contraseña inicial inválida: usa entre 15 y 128 caracteres");
    return fromFile;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      `Falta ${fileEnv} y no hay terminal: define el archivo secreto para CI`,
    );
  }
  const value = await promptHidden(`Contraseña inicial para ${username} (${label}, mín. 15 caracteres): `);
  if (!NewPasswordSchema.safeParse(value).success) throw new Error("Contraseña inicial inválida: usa entre 15 y 128 caracteres");
  return value;
}

async function initialPin(label: string, fileEnv: string | undefined, username: string): Promise<string> {
  const fromFile = readPasswordFile(fileEnv ? process.env[fileEnv] : undefined);
  if (fromFile) {
    if (!/^\d{4}$/.test(fromFile)) throw new Error("PIN inicial inválido: usa exactamente 4 dígitos");
    return fromFile;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      `Falta ${fileEnv} y no hay terminal: define el archivo secreto para CI`,
    );
  }
  const value = await promptHidden(`Código PIN inicial para ${username} (${label}, 4 dígitos): `);
  if (!/^\d{4}$/.test(value)) throw new Error("PIN inicial inválido: usa exactamente 4 dígitos");
  return value;
}

async function main(): Promise<void> {
  const admin = UsernameSchema.safeParse(process.env["ADMIN_USERNAME"] ?? "admin");
  const partner = UsernameSchema.safeParse(process.env["PARTNER_USERNAME"] ?? "member");
  if (!admin.success || !partner.success || admin.data === partner.data) throw new Error("Configura dos nombres de usuario válidos y distintos");
  const adminUsername = admin.data;
  const partnerUsername = partner.data;

  const pool = new Pool({ connectionString: ownerDatabaseUrl(), max: 3 });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    await db.$queryRaw`SELECT 1`;

    await db.conversation.upsert({
      where: { id: 1 },
      create: { id: 1, version: 1, lastSequence: 0 },
      update: {},
    });

    const slots: Array<{ slot: number; username: string; role: string; displayName: string; fileEnv: string; pinFileEnv?: string; avatarFileEnv: string }> = [
      { slot: 1, username: adminUsername, role: "admin", displayName: DisplayNameSchema.parse(process.env["ADMIN_DISPLAY_NAME"] ?? "Administrador"), fileEnv: "ADMIN_PASSWORD_FILE", pinFileEnv: "ADMIN_PIN_FILE", avatarFileEnv: "ADMIN_AVATAR_FILE" },
      { slot: 2, username: partnerUsername, role: "member", displayName: DisplayNameSchema.parse(process.env["MEMBER_DISPLAY_NAME"] ?? "Miembro"), fileEnv: "MEMBER_PASSWORD_FILE", avatarFileEnv: "MEMBER_AVATAR_FILE" },
    ];

    for (const spec of slots) {
      const bySlot = await db.user.findFirst({ where: { slot: spec.slot } });
      if (bySlot) {
        // Idempotente: no toca cuentas existentes (ni contraseña ni nombre).
        // Única excepción: dotar de PIN al admin si aún no tiene y se aporta
        // el archivo secreto (despliegue del acceso v2 sobre datos previos).
        if (spec.pinFileEnv && bySlot.pinHash === null) {
          const pin = readPasswordFile(process.env[spec.pinFileEnv]);
          if (pin) {
            if (!/^\d{4}$/.test(pin)) throw new Error("PIN inválido en archivo: usa exactamente 4 dígitos");
            await db.user.update({
              where: { id: bySlot.id },
              data: { pinHash: await hashPassword(pin), pinFailedAttempts: 0, pinLockedUntil: null },
            });
            process.stdout.write(`slot ${spec.slot}: PIN definido (alta v2)\n`);
          }
        }
        await db.readReceipt.upsert({
          where: { userId: bySlot.id },
          create: { userId: bySlot.id, lastReadSequence: 0, readAt: null },
          update: {},
        });
        process.stdout.write(`slot ${spec.slot}: existe (${bySlot.username}), sin cambios\n`);
        continue;
      }
      const taken = await db.user.findUnique({ where: { username: spec.username } });
      if (taken) {
        throw new Error(`El nombre ${spec.username} ya está en uso por otra cuenta`);
      }
      const password = await initialPassword(`slot ${spec.slot}`, spec.fileEnv, spec.username);
      const pinHash = spec.pinFileEnv ? await hashPassword(await initialPin(`slot ${spec.slot}`, spec.pinFileEnv, spec.username)) : null;
      const uploadDir = resolve(process.env["UPLOAD_DIR"] ?? "./data/uploads");
      let avatarPath: string | null = null;
      const sourcePath = process.env[spec.avatarFileEnv];
      if (sourcePath) {
        const source = readFileSync(resolve(sourcePath));
        const format = detectImageFormat(source);
        if (!format) throw new Error("Avatar inicial inválido: JPEG/PNG/WebP hasta 5 MiB");
        const image = await processAvatarImage(source, format);
        avatarPath = `${randomUUID()}.${avatarExtension(format)}`;
        await fs.mkdir(join(uploadDir, "avatars"), { recursive: true, mode: 0o700 });
        await fs.writeFile(join(uploadDir, "avatars", avatarPath), image, { flag: "wx", mode: 0o600 });
      }
      const created = await db.user.create({
        data: {
          id: randomUUID(),
          slot: spec.slot,
          username: spec.username,
          displayName: spec.displayName,
          role: spec.role,
          passwordHash: await hashPassword(password),
          pinHash,
          avatarPath,
          avatarVersion: avatarPath ? 1 : 0,
          mustChangePassword: true,
        },
      }).catch(async (error: unknown) => {
        if (avatarPath) await removeAvatarFile(uploadDir, avatarPath);
        throw error;
      });
      await db.readReceipt.upsert({
        where: { userId: created.id },
        create: { userId: created.id, lastReadSequence: 0, readAt: null },
        update: {},
      });
      process.stdout.write(`slot ${spec.slot}: creada cuenta ${created.username}\n`);
    }
    process.stdout.write("Seed completo: 2 cuentas y conversación 1 listas\n");
  } finally {
    await db.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`db:seed falló: ${message}\n`);
  process.exit(1);
});

import { existsSync, readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const { Pool } = pg;

// Nombre del rol runtime. Debe coincidir con DATABASE_USER en producción.
const APP_ROLE = process.env["APP_DB_ROLE"] ?? "private_chat_app";

function ownerDatabaseUrl(): string {
  const url = process.env["OWNER_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!url) throw new Error("Define OWNER_DATABASE_URL (o DATABASE_URL) con la conexión del propietario");
  return url;
}

function quoteIdent(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Nombre de rol no válido: ${value}`);
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const passwordFile = process.env["RUNTIME_PASSWORD_FILE"] ?? process.env["DATABASE_PASSWORD_FILE"];
  let password = "";
  if (passwordFile && existsSync(passwordFile)) {
    password = readFileSync(passwordFile, "utf8").trim();
  }
  if (!password) {
    throw new Error("Falta la contraseña del rol runtime (RUNTIME_PASSWORD_FILE o DATABASE_PASSWORD_FILE)");
  }

  const pool = new Pool({ connectionString: ownerDatabaseUrl(), max: 3 });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  const role = quoteIdent(APP_ROLE);
  // La contraseña viaja como parámetro, nunca interpolada ni registrada.
  try {
    const existing = await db.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}) AS "exists"`;
    if (!existing[0]?.exists) {
      await db.$executeRawUnsafe(`CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
      process.stdout.write(`Rol ${APP_ROLE} creado\n`);
    } else {
      process.stdout.write(`Rol ${APP_ROLE} ya existe\n`);
    }
    await db.$executeRawUnsafe(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${quoteLiteral(password)}`);

    const dbName = process.env["DATABASE_NAME"] ?? "private_chat";
    await db.$executeRawUnsafe(`GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${role}`);
    await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "chat" TO ${role}`);

    // users: lectura + actualización sólo de perfil/contraseña/PIN. Nunca
    // INSERT/DELETE ni cambios de slot/role (a nivel de columnas).
    await db.$executeRawUnsafe(`GRANT SELECT ON "chat"."users" TO ${role}`);
    await db.$executeRawUnsafe(
      `GRANT UPDATE ("display_name", "username", "avatar_path", "avatar_version", "password_hash", "must_change_password", "pin_hash", "pin_failed_attempts", "pin_locked_until", "updated_at") ON "chat"."users" TO ${role}`,
    );

    // Operativa de sesiones, mensajes, recibos, auditoría y tombstones.
    for (const table of ["sessions", "conversation", "messages", "read_receipts", "deletion_audit", "message_tombstones"]) {
      await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON "chat"."${table}" TO ${role}`);
    }
    // conversation sólo necesita UPDATE de version/last_sequence, pero sin
    // INSERT/DELETE no puede crear ni borrar conversaciones; se concede el
    // DML completo de filas menos DDL por simplicidad operativa.
    await db.$executeRawUnsafe(`REVOKE INSERT, DELETE ON "chat"."conversation" FROM ${role}`);
    await db.$executeRawUnsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "chat" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );

    process.stdout.write(`Permisos mínimos concedidos a ${APP_ROLE}\n`);
  } finally {
    await db.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`db:grant falló: ${message}\n`);
  process.exit(1);
});

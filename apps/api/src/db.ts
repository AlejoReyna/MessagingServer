import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const { Pool } = pg;

let client: PrismaClient | null = null;
let pool: pg.Pool | null = null;

/** Cliente Prisma con adaptador pg. La URL nunca se registra. */
export function getDb(databaseUrl: string): PrismaClient {
  if (client) return client;
  pool = new Pool({ connectionString: databaseUrl, max: 10 });
  const adapter = new PrismaPg(pool);
  client = new PrismaClient({ adapter });
  return client;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.$disconnect().catch(() => undefined);
    client = null;
  }
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = null;
  }
}

export { randomUUID };

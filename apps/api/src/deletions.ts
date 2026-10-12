import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Aplica el borrado de un mensaje de forma idempotente dentro de la
 * transacción que ya bloqueó la fila de conversación (SELECT ... FOR UPDATE).
 *
 * - Si el mensaje no existe pero hay tombstone: no hace nada (ya borrado).
 * - Si no existe ni hay tombstone: lanza MESSAGE_NOT_FOUND.
 * - Reaplicar tras una interrupción es seguro (upsert sin cambios).
 */
export async function applyMessageDeletion(
  db: Db,
  input: { messageId: string; actorId: string; newVersion: number },
): Promise<{ deleted: boolean; tombstoned: boolean }> {
  const existing = await db.message.findUnique({
    where: { id: input.messageId },
    select: { id: true, senderId: true, clientMessageId: true },
  });
  if (!existing) {
    const tombstone = await db.messageTombstone.findUnique({ where: { messageId: input.messageId } });
    if (tombstone) {
      // Ya borrado: no hay nada que hacer, pero quien reintenta debe saber
      // que el mensaje fue eliminado (410), no que no existe (404).
      const err = new Error("MESSAGE_DELETED") as Error & { code: string };
      err.code = "MESSAGE_DELETED";
      throw err;
    }
    const err = new Error("MESSAGE_NOT_FOUND") as Error & { code: string };
    err.code = "MESSAGE_NOT_FOUND";
    throw err;
  }
  await deleteMessageRows(db, [existing], { actorId: input.actorId, newVersion: input.newVersion, action: "message_deleted" });
  return { deleted: true, tombstoned: true };
}

/** Borrado físico + tombstones + auditoría (sin texto) + bump de versión. */
export async function deleteMessageRows(
  db: Db,
  rows: Array<{ id: string; senderId: string; clientMessageId: string }>,
  input: { actorId: string; newVersion: number; action: "message_deleted" | "conversation_cleared" },
): Promise<void> {
  if (rows.length > 0) {
    await db.message.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    for (const row of rows) {
      await db.messageTombstone.upsert({
        where: { messageId: row.id },
        create: {
          messageId: row.id,
          senderId: row.senderId,
          clientMessageId: row.clientMessageId,
          conversationVersion: input.newVersion,
        },
        update: {},
      });
    }
  }
  await db.deletionAudit.create({
    data: {
      id: randomUUID(),
      actorId: input.actorId,
      action: input.action,
      messageId: input.action === "message_deleted" ? (rows[0]?.id ?? null) : null,
      conversationVersion: input.newVersion,
    },
  });
  await db.conversation.update({
    where: { id: 1 },
    data: { version: input.newVersion },
  });
}

/**
 * Aplica el vaciado del historial de forma idempotente. Cada mensaje activo
 * deja su tombstone para que reintentos con la misma clave de idempotencia
 * no lo recreen.
 */
export async function applyConversationClear(
  db: Db,
  input: { actorId: string; newVersion: number },
): Promise<{ cleared: number }> {
  const active = await db.message.findMany({
    where: { conversationId: 1 },
    select: { id: true, senderId: true, clientMessageId: true },
  });
  await deleteMessageRows(db, active, {
    actorId: input.actorId,
    newVersion: input.newVersion,
    action: "conversation_cleared",
  });
  return { cleared: active.length };
}

/** Bloquea la fila de conversación y devuelve su estado actual. */
export async function lockConversation(db: Db): Promise<{ version: number; lastSequence: number }> {
  const rows = await db.$queryRaw<Array<{ version: number; last_sequence: number }>>`
    SELECT "version", "last_sequence" FROM "chat"."conversation" WHERE "id" = 1 FOR UPDATE`;
  const row = rows[0];
  if (!row) {
    const err = new Error("NOT_PROVISIONED") as Error & { code: string };
    err.code = "NOT_PROVISIONED";
    throw err;
  }
  return { version: row.version, lastSequence: row.last_sequence };
}

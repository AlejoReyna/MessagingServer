import { existsSync } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import { appendJournalEntry, initializeJournal, readJournal, type JournalEntry } from "./deletion-journal.js";
import { deleteMessageRows, lockConversation } from "./deletions.js";

/** Converge antes de abrir HTTP. Recuperación usa el journal vivo sin escribirlo. */
export async function reconcileDeletions(db: PrismaClient, journalPath: string, recovery = false): Promise<{ applied: number; restored: number }> {
  if (!existsSync(journalPath)) {
    const conversation = await db.conversation.findUnique({ where: { id: 1 }, select: { version: true } });
    const audits = await db.deletionAudit.count();
    const tombstones = await db.messageTombstone.count();
    if (recovery || !conversation || conversation.version !== 1 || audits > 0 || tombstones > 0) {
      throw new Error("Falta el journal esperado; no se abrirá el historial");
    }
    initializeJournal(journalPath);
  }
  const plan = readJournal(journalPath);
  let applied = 0;
  let restored = 0;
  for (const intent of plan.intents) {
    const committed = plan.committed.has(intent.journalId);
    const ids = [...new Set([...(intent.messageId ? [intent.messageId] : []), ...(intent.messageIds ?? [])])];
    const result = await db.$transaction(async (tx) => {
      const conversation = await lockConversation(tx);
      const rows = ids.length ? await tx.message.findMany({ where: { id: { in: ids } }, select: { id: true, senderId: true, clientMessageId: true } }) : [];
      const version = Math.max(conversation.version + (rows.length ? 1 : 0), intent.conversationVersion + 1);
      if (rows.length || version > conversation.version) {
        // Sólo IDs capturados bajo lock; preservar mensajes posteriores a una
        // intención pendiente, aunque la versión de la conversación avanzara.
        await deleteMessageRows(tx, rows, {
          actorId: intent.actorId,
          newVersion: version,
          action: intent.op === "conversation.clear.intent" ? "conversation_cleared" : "message_deleted",
        });
      }
      return { count: rows.length, version };
    });
    if (!committed) {
      if (!recovery) {
        const entry: JournalEntry = {
          ...intent,
          op: intent.op === "conversation.clear.intent" ? "conversation.clear.commit" : "message.delete.commit",
          conversationVersion: result.version,
          createdAt: new Date().toISOString(),
        };
        appendJournalEntry(journalPath, entry);
      }
      applied += 1;
    } else { restored += result.count; }
  }
  if (recovery) await db.session.deleteMany();
  return { applied, restored };
}

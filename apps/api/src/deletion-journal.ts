import { constants, mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, lstatSync } from "node:fs";
import { dirname } from "node:path";

export const JOURNAL_VERSION = 1;

export type JournalOp =
  | "message.delete.intent"
  | "message.delete.commit"
  | "conversation.clear.intent"
  | "conversation.clear.commit";

export interface JournalEntry {
  v: number;
  op: JournalOp;
  /** Identificador opaco de la operación (une intención y confirmación). */
  journalId: string;
  actorId: string;
  messageId?: string;
  /** IDs opacos incluidos en un vaciado (sin texto). Permiten verificar
   * restauraciones antiguas: ningún ID confirmado puede volver a existir. */
  messageIds?: string[];
  /** Número de mensajes incluidos en un vaciado (sin texto). */
  messageCount?: number;
  conversationVersion: number;
  createdAt: string;
}

export function formatJournalLine(entry: JournalEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

export function parseJournalLine(line: string): JournalEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<JournalEntry>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (parsed.v !== JOURNAL_VERSION) return null;
    if (
      parsed.op !== "message.delete.intent" &&
      parsed.op !== "message.delete.commit" &&
      parsed.op !== "conversation.clear.intent" &&
      parsed.op !== "conversation.clear.commit"
    ) {
      return null;
    }
    if (typeof parsed.journalId !== "string" || typeof parsed.actorId !== "string") return null;
    if (!parsed.journalId || !parsed.actorId) return null;
    if (!Number.isSafeInteger(parsed.conversationVersion) || (parsed.conversationVersion ?? 0) < 1) return null;
    if (typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt))) return null;
    const allowed = new Set(["v", "op", "journalId", "actorId", "messageId", "messageIds", "messageCount", "conversationVersion", "createdAt"]);
    if (Object.keys(parsed).some((key) => !allowed.has(key))) return null;
    if (parsed.messageId !== undefined && (typeof parsed.messageId !== "string" || !parsed.messageId)) return null;
    if (parsed.messageIds !== undefined && (!Array.isArray(parsed.messageIds) || parsed.messageIds.some((id) => typeof id !== "string" || !id))) return null;
    if (parsed.messageCount !== undefined && (!Number.isSafeInteger(parsed.messageCount) || parsed.messageCount < 0)) return null;
    if (parsed.op === "message.delete.intent" && !parsed.messageId && !parsed.messageIds?.length) return null;
    if (parsed.op === "conversation.clear.intent" && !Array.isArray(parsed.messageIds)) return null;
    return parsed as JournalEntry;
  } catch {
    return null;
  }
}

/**
 * Añade una entrada al journal y la lleva a disco (fsync) antes de devolver.
 * Garantía: si esta función devuelve, la entrada sobrevivirá a una caída,
 * salvo fallo catastrófico del almacenamiento.
 */
export function appendJournalEntry(journalPath: string, entry: JournalEntry): void {
  if (!parseJournalLine(formatJournalLine(entry))) throw new Error("Entrada de journal no válida");
  mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
  const fd = openSync(journalPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.from(formatJournalLine(entry));
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("Escritura de journal incompleta");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface JournalPlan {
  intents: JournalEntry[];
  committed: Set<string>;
}

/** Un journal perdido/corrupto impide abrir datos que podrían contener borrados. */
export function readJournal(journalPath: string): JournalPlan {
  if (!lstatSync(journalPath).isFile()) throw new Error("El journal debe ser un archivo regular");
  const content = readFileSync(journalPath, "utf8");
  const intents: JournalEntry[] = [];
  const committed = new Set<string>();
  const byId = new Map<string, JournalEntry>();
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    const entry = parseJournalLine(line);
    if (!entry) throw new Error(`Journal corrupto en línea ${index + 1}; recuperación detenida`);
    if (entry.op.endsWith(".intent")) {
      if (byId.has(entry.journalId)) throw new Error("Intención duplicada en journal");
      byId.set(entry.journalId, entry);
      intents.push(entry);
    } else {
      const intent = byId.get(entry.journalId);
      if (!intent || intent.op.replace(".intent", ".commit") !== entry.op || intent.actorId !== entry.actorId || entry.conversationVersion <= intent.conversationVersion) {
        throw new Error("Confirmación inconsistente en journal");
      }
      if (entry.messageId && entry.messageId !== intent.messageId) throw new Error("IDs inconsistentes en journal");
      if (entry.messageIds && JSON.stringify(entry.messageIds) !== JSON.stringify(intent.messageIds)) throw new Error("IDs inconsistentes en journal");
      committed.add(entry.journalId);
    }
  }
  return { intents, committed };
}

/** Sólo para una instalación nueva sin borrados, nunca para una restauración. */
export function initializeJournal(journalPath: string): void {
  mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
  const fd = openSync(journalPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const parent = openSync(dirname(journalPath), constants.O_RDONLY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

/** Intenciones sin confirmación: hay que reaplicarlas idempotentemente. */
export function pendingIntents(plan: JournalPlan): JournalEntry[] {
  return plan.intents.filter((entry) => !plan.committed.has(entry.journalId));
}

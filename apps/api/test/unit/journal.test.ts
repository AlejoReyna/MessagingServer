import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendJournalEntry,
  parseJournalLine,
  pendingIntents,
  readJournal,
  formatJournalLine,
  type JournalEntry,
} from "../../src/deletion-journal.js";

function intent(id: string): JournalEntry {
  return {
    v: 1,
    op: "message.delete.intent",
    journalId: id,
    actorId: "actor",
    messageId: "msg",
    conversationVersion: 1,
    createdAt: new Date().toISOString(),
  };
}

describe("journal de borrados", () => {
  it("formato y parseo simétricos, sin texto de mensajes", () => {
    const line = formatJournalLine(intent("a"));
    assert.ok(!line.includes("body"));
    const parsed = parseJournalLine(line);
    assert.equal(parsed?.journalId, "a");
  });

  it("ignora líneas vacías o corruptas", () => {
    assert.equal(parseJournalLine(""), null);
    assert.equal(parseJournalLine("no-json"), null);
    assert.equal(parseJournalLine('{"v":99,"op":"x"}'), null);
  });

  it("detecta intenciones pendientes y confirmadas", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-"));
    const path = join(dir, "j.jsonl");
    appendJournalEntry(path, intent("pendiente"));
    appendJournalEntry(path, intent("hecha"));
    appendJournalEntry(path, {
      v: 1,
      op: "message.delete.commit",
      journalId: "hecha",
      actorId: "actor",
      conversationVersion: 2,
      createdAt: new Date().toISOString(),
    });
    const plan = readJournal(path);
    const pending = pendingIntents(plan);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.journalId, "pendiente");
    const content = readFileSync(path, "utf8");
    assert.ok(!content.includes("hola secreto"));
  });

  it("journal ausente o corrupto detiene la recuperación", () => {
    assert.throws(() => readJournal(join(tmpdir(), `no-existe-${Date.now()}.jsonl`)));
    const dir = mkdtempSync(join(tmpdir(), "journal-corrupt-"));
    const path = join(dir, "j.jsonl");
    appendJournalEntry(path, intent("válida"));
    writeFileSync(path, `${readFileSync(path, "utf8")}fragmento truncado\n`);
    assert.throws(() => readJournal(path), /Journal corrupto/);
  });
});

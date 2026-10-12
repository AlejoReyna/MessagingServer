import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  startTestServer,
  TestClient,
  requireTestDatabaseUrl,
  API_DIR,
  type TestServer,
} from "./helpers.js";
import { appendJournalEntry, readJournal } from "../../src/deletion-journal.js";
import { reconcileDeletions } from "../../src/reconciliation.js";

describe("API chat (PostgreSQL real)", () => {
  let server: TestServer;
  let admin: TestClient;
  let member: TestClient;
  const testDbUrl = requireTestDatabaseUrl();

  before(async () => {
    server = await startTestServer();
    admin = new TestClient(server.baseUrl);
    member = new TestClient(server.baseUrl);
  });

  after(async () => {
    await server.close();
  });

  async function changePassword(client: TestClient, current: string, next: string): Promise<void> {
    const res = await client.request("POST", "/api/auth/change-password", {
      body: { currentPassword: current, newPassword: next },
    });
    assert.equal(res.status, 200);
    client.csrf = (res.json as { csrfToken: string }).csrfToken;
  }

  /** Estado limpio: reseed + login + cambio de contraseña de ambas cuentas. */
  async function cleanSlate(): Promise<{ version: number }> {
    const fresh = await server.reset();
    server.users = fresh;
    // Cierra sockets de escenarios anteriores para aislar presencia
    // (los IDs cambian con el reseed, así que se desconecta todo).
    server.hub.disconnectAll();
    const deadline = Date.now() + 2000;
    while (server.hub.onlineCount() !== 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    admin = new TestClient(server.baseUrl);
    member = new TestClient(server.baseUrl);
    await admin.login("admin", server.users.adminPassword);
    await changePassword(admin, server.users.adminPassword, "X-contraseña-admin-100");
    await member.login("member", server.users.memberPassword);
    await changePassword(member, server.users.memberPassword, "X-contraseña-member-200");
    const conv = await admin.request("GET", "/api/conversation", { csrf: false });
    assert.equal(conv.status, 200);
    return { version: (conv.json as { conversation: { version: number } }).conversation.version };
  }

  async function send(
    client: TestClient,
    body: string,
    version: number,
    key: string = randomUUID(),
  ): Promise<{ status: number; json: unknown }> {
    return client.request("POST", "/api/messages", {
      body: { clientMessageId: key, body, conversationVersion: version },
    });
  }

  async function versionOf(): Promise<number> {
    const conv = await admin.request("GET", "/api/conversation", { csrf: false });
    assert.equal(conv.status, 200);
    return (conv.json as { conversation: { version: number } }).conversation.version;
  }

  function runReconcile(extra: NodeJS.ProcessEnv = {}): string {
    return execFileSync("npx", ["tsx", "src/cli/reconcile-deletions.ts"], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: testDbUrl, DELETION_JOURNAL_PATH: server.journalPath, ...extra },
      encoding: "utf8",
    });
  }

  it("enviar persiste con secuencia creciente del servidor", async () => {
    const { version } = await cleanSlate();
    const r1 = await send(admin, "hola", version);
    assert.equal(r1.status, 201);
    const m1 = (r1.json as { message: { sequence: number } }).message;
    assert.equal(m1.sequence, 1);
    const r2 = await send(member, "hola de vuelta", version);
    assert.equal(r2.status, 201);
    assert.equal((r2.json as { message: { sequence: number } }).message.sequence, 2);
  });

  it("idempotencia: reintento idéntico 200, distinto 409", async () => {
    const { version } = await cleanSlate();
    const key = randomUUID();
    const first = await send(admin, "mensaje único", version, key);
    assert.equal(first.status, 201);
    const id = (first.json as { message: { id: string } }).message.id;
    const retry = await send(admin, "mensaje único", version, key);
    assert.equal(retry.status, 200);
    assert.equal((retry.json as { message: { id: string } }).message.id, id);
    const conflict = await send(admin, "otro texto", version, key);
    assert.equal(conflict.status, 409);
    assert.equal((conflict.json as { error: { code: string } }).error.code, "IDEMPOTENCY_CONFLICT");
  });

  it("versión obsoleta devuelve 409", async () => {
    const { version } = await cleanSlate();
    await send(admin, "uno", version);
    // El envío no cambia la versión; forzar desfase borrando como admin.
    const del = await admin.request("DELETE", "/api/conversation/messages", {
      body: { conversationVersion: version },
    });
    assert.equal(del.status, 200);
    const stale = await send(member, "tardío", version);
    assert.equal(stale.status, 409);
    assert.equal((stale.json as { error: { code: string } }).error.code, "CONVERSATION_CHANGED");
  });

  it("validación de cuerpo: vacío y sobrelargo", async () => {
    const { version } = await cleanSlate();
    const empty = await send(admin, "   ", version);
    assert.equal(empty.status, 400);
    const long = await send(admin, "x".repeat(4001), version);
    assert.equal(long.status, 400);
  });

  it("paginación before/after sin huecos", async () => {
    const { version } = await cleanSlate();
    for (let i = 1; i <= 5; i++) {
      const r = await send(admin, `m${i}`, version);
      assert.equal(r.status, 201);
    }
    const first = await admin.request("GET", "/api/messages?limit=2", { csrf: false });
    assert.equal(first.status, 200);
    const p1 = first.json as { messages: Array<{ sequence: number }>; hasMore: boolean; nextCursor: number | null; conversationVersion: number };
    assert.deepEqual(p1.messages.map((m) => m.sequence), [4, 5]);
    assert.equal(p1.hasMore, true);
    assert.equal(p1.nextCursor, 4);
    assert.equal(p1.conversationVersion, version);

    const before = await admin.request("GET", "/api/messages?before=4&limit=2", { csrf: false });
    const p2 = before.json as typeof p1;
    assert.deepEqual(p2.messages.map((m) => m.sequence), [2, 3]);
    assert.equal(p2.hasMore, true);
    assert.equal(p2.nextCursor, 2);

    const oldest = await admin.request("GET", "/api/messages?before=2&limit=2", { csrf: false });
    const p3 = oldest.json as typeof p1;
    assert.deepEqual(p3.messages.map((m) => m.sequence), [1]);
    assert.equal(p3.hasMore, false);
    assert.equal(p3.nextCursor, null);

    const after = await admin.request("GET", "/api/messages?after=3&limit=10", { csrf: false });
    const p4 = after.json as typeof p1;
    assert.deepEqual(p4.messages.map((m) => m.sequence), [4, 5]);
    assert.equal(p4.hasMore, false);

    const both = await admin.request("GET", "/api/messages?before=3&after=1", { csrf: false });
    assert.equal(both.status, 400);
  });

  it("lectura monotónica y acotada", async () => {
    const { version } = await cleanSlate();
    await send(admin, "a", version);
    await send(admin, "b", version);
    await send(admin, "c", version);
    const r1 = await member.request("POST", "/api/conversation/read", {
      body: { lastReadSequence: 2, conversationVersion: version },
    });
    assert.equal(r1.status, 200);
    assert.equal((r1.json as { lastReadSequence: number }).lastReadSequence, 2);
    const r2 = await member.request("POST", "/api/conversation/read", {
      body: { lastReadSequence: 1, conversationVersion: version },
    });
    assert.equal((r2.json as { lastReadSequence: number }).lastReadSequence, 2);
    const r3 = await member.request("POST", "/api/conversation/read", {
      body: { lastReadSequence: 999, conversationVersion: version },
    });
    assert.equal((r3.json as { lastReadSequence: number }).lastReadSequence, 3);
  });

  it("borrado admin sube versión y deja tombstone", async () => {
    const { version } = await cleanSlate();
    const key = randomUUID();
    const created = await send(member, "bórrame", version, key);
    const id = (created.json as { message: { id: string } }).message.id;
    const del = await admin.request("DELETE", `/api/messages/${id}`, {
      body: { conversationVersion: version },
    });
    assert.equal(del.status, 200);
    assert.equal((del.json as { conversationVersion: number }).conversationVersion, version + 1);

    const list = await admin.request("GET", "/api/messages?limit=50", { csrf: false });
    const ids = ((list.json as { messages: Array<{ id: string }> }).messages).map((m) => m.id);
    assert.ok(!ids.includes(id));

    // Reintentar la misma clave no resucita el mensaje.
    const retry = await send(member, "bórrame", version + 1, key);
    assert.equal(retry.status, 410);
    assert.equal((retry.json as { error: { code: string } }).error.code, "MESSAGE_DELETED");

    // Borrar de nuevo informa que ya fue eliminado, sin subir la versión.
    const again = await admin.request("DELETE", `/api/messages/${id}`, {
      body: { conversationVersion: version + 1 },
    });
    assert.equal(again.status, 410);
    assert.equal(await versionOf(), version + 1);

    // Borrar inexistente: 404.
    const missing = await admin.request("DELETE", `/api/messages/${randomUUID()}`, {
      body: { conversationVersion: version + 1 },
    });
    assert.equal(missing.status, 404);
  });

  it("miembro borra sólo su mensaje para ambos, con auditoría y sin resurrección", async () => {
    const { version } = await cleanSlate();
    const key = randomUUID();
    const secret = `mensaje propio-${randomUUID()}`;
    const created = await send(member, secret, version, key);
    assert.equal(created.status, 201);
    const id = (created.json as { message: { id: string } }).message.id;
    const other = await send(admin, "mensaje ajeno que permanece", version);
    const otherId = (other.json as { message: { id: string } }).message.id;
    const del = await member.request("DELETE", `/api/messages/${id}`, { body: { conversationVersion: version } });
    assert.equal(del.status, 200);
    assert.deepEqual(del.json, { messageId: id, conversationVersion: version + 1 });
    for (const client of [admin, member]) {
      const list = await client.request("GET", "/api/messages", { csrf: false });
      assert.deepEqual((list.json as { messages: Array<{ id: string }> }).messages.map((m) => m.id), [otherId]);
    }
    assert.equal((await server.db.conversation.findUniqueOrThrow({ where: { id: 1 } })).lastSequence, 2);
    const audit = await server.db.deletionAudit.findFirstOrThrow({ where: { messageId: id } });
    assert.equal(audit.actorId, server.users.memberId);
    const journal = readJournal(server.journalPath);
    assert.equal(journal.intents.length, 1);
    assert.equal(journal.intents[0].actorId, server.users.memberId);
    assert.ok(!readFileSync(server.journalPath, "utf8").includes(secret));
    const retry = await send(member, secret, version + 1, key);
    assert.equal(retry.status, 410);
    const again = await member.request("DELETE", `/api/messages/${id}`, { body: { conversationVersion: version + 1 } });
    assert.equal(again.status, 410);
    assert.equal(await versionOf(), version + 1);
  });

  it("rechaza borrados ajenos y vaciado del miembro sin journal ni cambios de datos", async () => {
    const { version } = await cleanSlate();
    const own = await send(member, "propio", version);
    const ownId = (own.json as { message: { id: string } }).message.id;
    const other = await send(admin, "ajeno", version);
    const otherId = (other.json as { message: { id: string } }).message.id;
    const forbidden = await member.request("DELETE", `/api/messages/${otherId}`, { body: { conversationVersion: version } });
    assert.equal(forbidden.status, 403);
    assert.equal((forbidden.json as { error: { code: string } }).error.code, "FORBIDDEN");
    const clear = await member.request("DELETE", "/api/conversation/messages", { body: { conversationVersion: version } });
    assert.equal(clear.status, 403);
    const stale = await member.request("DELETE", `/api/messages/${ownId}`, { body: { conversationVersion: version + 1 } });
    assert.equal(stale.status, 409);
    const missing = await member.request("DELETE", `/api/messages/${randomUUID()}`, { body: { conversationVersion: version } });
    assert.equal(missing.status, 404);
    const noCsrf = await member.request("DELETE", `/api/messages/${ownId}`, { body: { conversationVersion: version }, csrf: false });
    assert.equal(noCsrf.status, 403);
    const anon = new TestClient(server.baseUrl);
    await anon.session();
    assert.equal((await anon.request("DELETE", `/api/messages/${ownId}`, { body: { conversationVersion: version } })).status, 401);
    await reconcileDeletions(server.db, server.journalPath);
    assert.equal(readJournal(server.journalPath).intents.length, 0);
    assert.equal(await versionOf(), version);
    assert.equal(await server.db.message.count(), 2);
    assert.equal(await server.db.deletionAudit.count(), 0);
  });

  it("borrados simultáneos del miembro sólo aplican una vez", async () => {
    const { version } = await cleanSlate();
    const created = await send(member, "borrar una vez", version);
    const id = (created.json as { message: { id: string } }).message.id;
    const results = await Promise.all(Array.from({ length: 2 }, () =>
      member.request("DELETE", `/api/messages/${id}`, { body: { conversationVersion: version } })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await versionOf(), version + 1);
    assert.equal(await server.db.messageTombstone.count(), 1);
    assert.equal(await server.db.deletionAudit.count(), 1);
    assert.equal(readJournal(server.journalPath).intents.length, 1);
  });

  it("vaciado conserva lastSequence y bloquea reintentos viejos", async () => {
    const { version } = await cleanSlate();
    await send(admin, "uno", version);
    await send(member, "dos", version);
    const clear = await admin.request("DELETE", "/api/conversation/messages", {
      body: { conversationVersion: version },
    });
    assert.equal(clear.status, 200);
    assert.equal((clear.json as { conversationVersion: number }).conversationVersion, version + 1);

    const conv = await admin.request("GET", "/api/conversation", { csrf: false });
    const body = conv.json as { conversation: { version: number; lastSequence: number } };
    assert.equal(body.conversation.lastSequence, 2);

    const list = await admin.request("GET", "/api/messages?limit=50", { csrf: false });
    assert.deepEqual((list.json as { messages: unknown[] }).messages, []);

    const next = await send(admin, "nuevo", version + 1);
    assert.equal(next.status, 201);
    assert.equal((next.json as { message: { sequence: number } }).message.sequence, 3);
  });

  it("journal registra intención y confirmación sin texto", async () => {
    const { version } = await cleanSlate();
    const secret = `secreto-${randomUUID()}`;
    const created = await send(admin, secret, version);
    const id = (created.json as { message: { id: string } }).message.id;
    await admin.request("DELETE", `/api/messages/${id}`, { body: { conversationVersion: version } });
    const journal = readFileSync(server.journalPath, "utf8");
    assert.ok(journal.includes("message.delete.intent"));
    assert.ok(journal.includes("message.delete.commit"));
    assert.ok(journal.includes(id));
    assert.ok(!journal.includes(secret));
    // Auditoría sin columna de texto.
    const cols = await server.db.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'chat' AND table_name = 'deletion_audit'`;
    const names = cols.map((c) => c.column_name);
    assert.ok(!names.includes("body"));
    assert.ok(names.includes("action"));
  });

  it("reconciliación aplica una intención sin confirmación (caída simulada)", async () => {
    const { version } = await cleanSlate();
    const created = await send(member, "previo a la caída", version);
    const id = (created.json as { message: { id: string } }).message.id;
    const journalId = randomUUID();
    appendJournalEntry(server.journalPath, {
      v: 1,
      op: "message.delete.intent",
      journalId,
      actorId: server.users.adminId,
      messageId: id,
      conversationVersion: version,
      createdAt: new Date().toISOString(),
    });
    // La caída ocurrió antes de tocar la DB: el mensaje sigue visible.
    const before = await admin.request("GET", "/api/messages?limit=50", { csrf: false });
    assert.ok(((before.json as { messages: Array<{ id: string }> }).messages).some((m) => m.id === id));

    const out = runReconcile();
    assert.ok(out.includes("1 pendientes"));

    const after = await admin.request("GET", "/api/messages?limit=50", { csrf: false });
    assert.ok(!((after.json as { messages: Array<{ id: string }> }).messages).some((m) => m.id === id));
    assert.equal(await versionOf(), version + 1);
  });

  it("restauración antigua no resucita borrados (journal manda)", async () => {
    const { version } = await cleanSlate();
    const r1 = await send(admin, "mantener", version);
    const m1 = (r1.json as { message: { id: string; clientMessageId: string; sequence: number } }).message;
    const r2 = await send(admin, "eliminar", version);
    const m2 = (r2.json as { message: { id: string; clientMessageId: string; sequence: number } }).message;
    const del = await admin.request("DELETE", `/api/messages/${m2.id}`, {
      body: { conversationVersion: version },
    });
    assert.equal(del.status, 200);

    // Simula restaurar un respaldo anterior al borrado.
    await server.db.$executeRawUnsafe(`DELETE FROM "chat"."message_tombstones" WHERE "message_id" = '${m2.id}'`);
    await server.db.$executeRawUnsafe(
      `INSERT INTO "chat"."messages" ("id","conversation_id","sender_id","client_message_id","sequence","body") VALUES ('${m2.id}',1,'${server.users.adminId}','${m2.clientMessageId}',${m2.sequence},'texto restaurado')`,
    );
    await server.db.$executeRawUnsafe(`UPDATE "chat"."conversation" SET "version" = ${version} WHERE "id" = 1`);

    const out = runReconcile();
    assert.ok(out.includes("Restauración detectada"));

    const list = await admin.request("GET", "/api/messages?limit=50", { csrf: false });
    const ids = ((list.json as { messages: Array<{ id: string }> }).messages).map((m) => m.id);
    assert.ok(ids.includes(m1.id));
    assert.ok(!ids.includes(m2.id));
  });

  it("borrados rechazados no dejan intenciones que se ejecuten al reiniciar", async () => {
    const { version } = await cleanSlate();
    const created = await send(admin, "conservar tras 409", version);
    const id = (created.json as { message: { id: string } }).message.id;
    const missing = await admin.request("DELETE", `/api/messages/${randomUUID()}`, { body: { conversationVersion: version } });
    assert.equal(missing.status, 404);
    const stale = await admin.request("DELETE", `/api/messages/${id}`, { body: { conversationVersion: version + 5 } });
    assert.equal(stale.status, 409);
    const clear = await admin.request("DELETE", "/api/conversation/messages", { body: { conversationVersion: version + 5 } });
    assert.equal(clear.status, 409);
    await reconcileDeletions(server.db, server.journalPath);
    assert.equal(readJournal(server.journalPath).intents.length, 0);
    assert.equal(await versionOf(), version);
    assert.equal(await server.db.message.count({ where: { id } }), 1);
  });

  it("recuperación preserva journal read-only e invalida todas las sesiones", async () => {
    const { version } = await cleanSlate();
    const created = await send(member, "borrado pendiente de una caída", version);
    const id = (created.json as { message: { id: string } }).message.id;
    appendJournalEntry(server.journalPath, { v: 1, op: "message.delete.intent", journalId: randomUUID(), actorId: server.users.adminId, messageId: id, conversationVersion: version, createdAt: new Date().toISOString() });
    const before = readFileSync(server.journalPath, "utf8");
    assert.ok(await server.db.session.count() > 0);
    assert.ok(runReconcile({ RECOVERY_MODE: "true" }).includes("sesiones invalidadas"));
    assert.equal(readFileSync(server.journalPath, "utf8"), before);
    assert.equal(await server.db.message.count({ where: { id } }), 0);
    assert.equal(await server.db.session.count(), 0);
    // Repetir la recuperación tampoco cambia la versión ni el journal.
    runReconcile({ RECOVERY_MODE: "true" });
    assert.equal(readFileSync(server.journalPath, "utf8"), before);
    assert.equal((await server.db.conversation.findUniqueOrThrow({ where: { id: 1 } })).version, version + 1);
  });

  it("journal corrupto detiene reconciliación antes de tocar datos o sesiones", async () => {
    const { version } = await cleanSlate();
    await send(admin, "preservar hasta reparar journal", version);
    const sessions = await server.db.session.count();
    writeFileSync(server.journalPath, "JSON truncado\n");
    await assert.rejects(reconcileDeletions(server.db, server.journalPath, true), /Journal corrupto/);
    assert.equal(await server.db.message.count(), 1);
    assert.equal(await server.db.session.count(), sessions);
  });

  it("vaciado pendiente elimina sus IDs y conserva mensajes posteriores", async () => {
    const { version } = await cleanSlate();
    const old = await send(admin, "incluido en intención", version);
    const oldId = (old.json as { message: { id: string } }).message.id;
    appendJournalEntry(server.journalPath, { v: 1, op: "conversation.clear.intent", journalId: randomUUID(), actorId: server.users.adminId, messageIds: [oldId], messageCount: 1, conversationVersion: version, createdAt: new Date().toISOString() });
    const later = await send(member, "posterior a intención", version);
    const laterId = (later.json as { message: { id: string } }).message.id;
    await server.db.conversation.update({ where: { id: 1 }, data: { version: version + 2 } });
    await reconcileDeletions(server.db, server.journalPath);
    assert.equal(await server.db.message.count({ where: { id: oldId } }), 0);
    assert.equal(await server.db.message.count({ where: { id: laterId } }), 1);
    assert.equal(readJournal(server.journalPath).committed.size, 1);
  });

  it("constraints de DB: tercer slot, rol y conversación rechazados", async () => {
    await cleanSlate();
    await assert.rejects(
      server.db.$executeRawUnsafe(
        `INSERT INTO "chat"."users" ("id","slot","username","display_name","role","password_hash") VALUES ('${randomUUID()}',3,'tercero','Tercero','member','x')`,
      ),
    );
    await assert.rejects(
      server.db.$executeRawUnsafe(
        `INSERT INTO "chat"."users" ("id","slot","username","display_name","role","password_hash") VALUES ('${randomUUID()}',1,'otro','Otro','member','x')`,
      ),
    );
    await assert.rejects(
      server.db.$executeRawUnsafe(`INSERT INTO "chat"."conversation" ("id") VALUES (2)`),
    );
    await assert.rejects(
      server.db.$executeRawUnsafe(
        `INSERT INTO "chat"."users" ("id","slot","username","display_name","role","password_hash") VALUES ('${randomUUID()}',2,'ADMIN','Otro','member','x')`,
      ),
    );
  });

  it("concurrencia envío/vaciado sin duplicados ni huecos", async () => {
    const { version } = await cleanSlate();
    const sends = Array.from({ length: 12 }, (_, i) =>
      send(i % 2 === 0 ? admin : member, `c${i}`, version),
    );
    const results = await Promise.allSettled([...sends, admin.request("DELETE", "/api/conversation/messages", {
      body: { conversationVersion: version },
    })]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    assert.equal(fulfilled.length, results.length);

    const list = await admin.request("GET", "/api/messages?limit=100", { csrf: false });
    const messages = (list.json as { messages: Array<{ sequence: number; id: string }> }).messages;
    const seqs = messages.map((m) => m.sequence);
    assert.equal(new Set(seqs).size, seqs.length);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs);
    const finalVersion = await versionOf();
    assert.ok(finalVersion === version || finalVersion === version + 1);
    if (finalVersion === version + 1) {
      assert.deepEqual(messages, []);
      const deleted = await server.db.messageTombstone.findMany({ select: { messageId: true } });
      const intent = readJournal(server.journalPath).intents.find((entry) => entry.op === "conversation.clear.intent");
      assert.ok(intent);
      assert.deepEqual([...(intent.messageIds ?? [])].sort(), deleted.map((row) => row.messageId).sort());
    }
  });

  it("envíos concurrentes con la misma clave crean un solo mensaje", async () => {
    const { version } = await cleanSlate();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => send(admin, "mismo", version, key)),
    );
    for (const r of results) {
      assert.ok(r.status === 201 || r.status === 200);
    }
    const ids = new Set(results.map((r) => (r.json as { message: { id: string } }).message.id));
    assert.equal(ids.size, 1);
    const count = await server.db.message.count({ where: { senderId: server.users.adminId, clientMessageId: key } });
    assert.equal(count, 1);
  });

  it("ready cae a 503 sin provisioning", async () => {
    await server.db.$executeRawUnsafe(
      `TRUNCATE "chat"."messages", "chat"."message_tombstones", "chat"."deletion_audit", "chat"."sessions", "chat"."read_receipts", "chat"."users", "chat"."conversation" CASCADE`,
    );
    const ready = await admin.request("GET", "/api/ready", { csrf: false });
    assert.equal(ready.status, 503);
    assert.equal((ready.json as { error: { code: string } }).error.code, "SERVICE_UNAVAILABLE");
    await cleanSlate();
  });

  // --- Socket.IO ------------------------------------------------------------

  interface SocketConn {
    sid: string;
    postStatus: number;
    poll: string;
    pollAgain: () => Promise<string>;
  }

  async function socketConnect(client: TestClient, origin: string): Promise<SocketConn> {
    const qs = "EIO=4&transport=polling";
    const cookies = client.cookies;
    const hs = await fetch(`${server.baseUrl}/socket.io/?${qs}`, {
      headers: { cookie: cookies, origin },
    });
    const hsText = await hs.text();
    assert.ok(hsText.startsWith("0"), `handshake inesperado: ${hsText.slice(0, 80)}`);
    const sid = (JSON.parse(hsText.slice(1)) as { sid: string }).sid;
    const post = await fetch(`${server.baseUrl}/socket.io/?${qs}&sid=${sid}`, {
      method: "POST",
      headers: { cookie: cookies, origin, "content-type": "text/plain;charset=UTF-8" },
      body: `40{"csrfToken":"${client.csrf}"}`,
    });
    const pollAgain = async (): Promise<string> => {
      const pollRes = await fetch(`${server.baseUrl}/socket.io/?${qs}&sid=${sid}`, {
        headers: { cookie: cookies, origin },
        signal: AbortSignal.timeout(10000),
      });
      return pollRes.text();
    };
    const poll = await pollAgain();
    return { sid, postStatus: post.status, poll, pollAgain };
  }

  async function socketSend(conn: SocketConn, client: TestClient, packet: string): Promise<void> {
    const qs = "EIO=4&transport=polling";
    await fetch(`${server.baseUrl}/socket.io/?${qs}&sid=${conn.sid}`, {
      method: "POST",
      headers: { cookie: client.cookies, origin: "http://app.test:5173", "content-type": "text/plain;charset=UTF-8" },
      body: packet,
    });
  }

  it("sockets: rechaza sin sesión, con CSRF inválido y Origin ajeno", async () => {
    await cleanSlate();
    const noSession = new TestClient(server.baseUrl);
    await noSession.session();
    const r1 = await socketConnect(noSession, "http://app.test:5173");
    assert.ok(r1.poll.includes("44"), `esperaba rechazo 44, poll=${r1.poll.slice(0, 120)}`);

    const badCsrf = new TestClient(server.baseUrl);
    await badCsrf.login("admin", "X-contraseña-admin-100");
    badCsrf.csrf = "manipulado";
    const r2 = await socketConnect(badCsrf, "http://app.test:5173");
    assert.ok(r2.poll.includes("44"), `esperaba rechazo CSRF, poll=${r2.poll.slice(0, 120)}`);

    const evil = new TestClient(server.baseUrl);
    await evil.login("admin", "X-contraseña-admin-100");
    const r3 = await socketConnect(evil, "http://evil.test");
    assert.ok(r3.poll.includes("44") || r3.postStatus === 400, `esperaba rechazo Origin, poll=${r3.poll.slice(0, 120)}`);
    assert.equal(server.hub.onlineCount(), 0);
  });

  it("sockets: conecta, presencia y typing entre los dos usuarios", async () => {
    await cleanSlate();
    const a = await socketConnect(admin, "http://app.test:5173");
    assert.ok(a.poll.includes("40"), `esperaba 40, poll=${a.poll.slice(0, 120)}`);
    const m = await socketConnect(member, "http://app.test:5173");
    assert.ok(m.poll.includes("40"), `esperaba 40, poll=${m.poll.slice(0, 120)}`);
    assert.equal(server.hub.onlineCount(), 2);

    // typing:set del admin debe llegar al miembro por el cable.
    // El POST se procesa de forma asíncrona (revalida la sesión en DB);
    // el primer GET puede devolver sólo la presencia ya encolada, así que
    // se repite la lectura hasta ver el evento o agotar el plazo.
    await socketSend(a, admin, '42["typing:set",{"isTyping":true}]');
    let memberPoll = '';
    {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        memberPoll += await m.pollAgain();
        if (memberPoll.includes('typing:updated') && memberPoll.includes(server.users.adminId)) break;
      }
    }
    assert.ok(
      memberPoll.includes("typing:updated"),
      `el miembro no recibió typing: ${memberPoll.slice(0, 200)}`,
    );
    assert.ok(memberPoll.includes(server.users.adminId));
  });

  it("sockets: cambiar contraseña cierra conexiones y revoca", async () => {
    await cleanSlate();
    const conn = await socketConnect(admin, "http://app.test:5173");
    assert.ok(conn.poll.includes("40"));
    assert.equal(server.hub.onlineCount(), 1);

    const oldState = admin.snapshotState();
    await changePassword(admin, "X-contraseña-admin-100", "Y-contraseña-admin-101");

    // Espera activa al cierre (el servidor desconecta de inmediato).
    const deadline = Date.now() + 3000;
    while (server.hub.onlineCount() !== 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(server.hub.onlineCount(), 0);

    // La sesión vieja ya no conecta (mismo jar/cookies anteriores al cambio).
    const stale = new TestClient(server.baseUrl);
    stale.restoreState(oldState);
    const r = await socketConnect(stale, "http://app.test:5173");
    assert.ok(r.poll.includes("44"), `sesión revocada debería fallar: ${r.poll.slice(0, 120)}`);
    await changePassword(admin, "Y-contraseña-admin-101", "X-contraseña-admin-100");
  });
});

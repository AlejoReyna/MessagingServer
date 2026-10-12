import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestServer, TestClient, type TestServer } from "./helpers.js";
import { generateVapidKeys } from "../../src/push.js";

const P256DH = `B${"A".repeat(86)}`;
const AUTH = "A".repeat(22);
const ENDPOINT_A = "https://push.example.com/dispositivo-a";
const ENDPOINT_B = "https://push.example.com/dispositivo-b";

describe("API push (contrato v5, PostgreSQL real)", () => {
  let server: TestServer;
  let admin: TestClient;
  let member: TestClient;

  before(async () => {
    server = await startTestServer();
    admin = new TestClient(server.baseUrl);
    member = new TestClient(server.baseUrl);
  });

  after(async () => {
    await server.close();
  });

  async function cleanSlate(): Promise<{ version: number }> {
    const fresh = await server.reset();
    server.users = fresh;
    server.hub.disconnectAll();
    admin = new TestClient(server.baseUrl);
    member = new TestClient(server.baseUrl);
    await admin.login("admin", server.users.adminPassword);
    await member.login("member", server.users.memberPassword);
    // Sin cambio de contraseña: el guard de push usa requireAuth, que exige
    // resolver mustChangePassword; el login con PIN no aplica aquí, así que
    // se cambia la contraseña como en el resto de suites.
    for (const [client, current, next] of [
      [admin, server.users.adminPassword, "X-contraseña-push-admin-1"],
      [member, server.users.memberPassword, "X-contraseña-push-member-2"],
    ] as const) {
      const res = await client.request("POST", "/api/auth/change-password", {
        body: { currentPassword: current, newPassword: next },
      });
      assert.equal(res.status, 200);
      client.csrf = (res.json as { csrfToken: string }).csrfToken;
    }
    const conv = await admin.request("GET", "/api/conversation", { csrf: false });
    assert.equal(conv.status, 200);
    // Push deshabilitado por defecto en el servidor de pruebas.
    server.config.push = { enabled: false, publicKey: "", privateKey: "", subject: "" };
    return { version: (conv.json as { conversation: { version: number } }).conversation.version };
  }

  function enablePush(): void {
    const keys = generateVapidKeys();
    server.config.push = {
      enabled: true,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: "mailto:test@example.com",
    };
  }

  it("vapid-key pública indica enabled=false sin sesión", async () => {
    await cleanSlate();
    const res = await admin.request("GET", "/api/push/vapid-key", { csrf: false });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { publicKey: null, enabled: false });
  });

  it("suscribir exige sesión y push activo", async () => {
    await cleanSlate();
    const anon = new TestClient(server.baseUrl);
    await anon.session();
    const noAuth = await anon.request("POST", "/api/push/subscriptions", {
      body: { subscription: { endpoint: ENDPOINT_A, keys: { p256dh: P256DH, auth: AUTH } } },
    });
    assert.equal(noAuth.status, 401);
    const disabled = await admin.request("POST", "/api/push/subscriptions", {
      body: { subscription: { endpoint: ENDPOINT_A, keys: { p256dh: P256DH, auth: AUTH } } },
    });
    assert.equal(disabled.status, 503);
  });

  it("suscribir, reasignar endpoint entre cuentas y borrar sólo propia", async () => {
    await cleanSlate();
    enablePush();
    const sub = { endpoint: ENDPOINT_A, keys: { p256dh: P256DH, auth: AUTH } };
    const created = await member.request("POST", "/api/push/subscriptions", { body: { subscription: sub } });
    assert.equal(created.status, 201);
    assert.deepEqual(created.json, { saved: true });

    // Claves inválidas (longitud real) → 400 aunque el contrato pase el formato.
    const bad = await member.request("POST", "/api/push/subscriptions", {
      body: { subscription: { endpoint: ENDPOINT_B, keys: { p256dh: "A".repeat(87), auth: AUTH } } },
    });
    assert.equal(bad.status, 400);

    // El mismo navegador en otra cuenta se reasigna, no se duplica.
    const reassigned = await admin.request("POST", "/api/push/subscriptions", { body: { subscription: sub } });
    assert.equal(reassigned.status, 201);
    const rows = await server.db.pushSubscription.findMany({ where: { endpoint: ENDPOINT_A } });
    assert.equal(rows.length, 1);

    // Borrar la ajena no la toca (idempotente 204); la propia sí.
    const foreignDelete = await member.request("DELETE", "/api/push/subscriptions", { body: { endpoint: ENDPOINT_A } });
    assert.equal(foreignDelete.status, 204);
    assert.equal((await server.db.pushSubscription.count({ where: { endpoint: ENDPOINT_A } })), 1);
    const ownDelete = await admin.request("DELETE", "/api/push/subscriptions", { body: { endpoint: ENDPOINT_A } });
    assert.equal(ownDelete.status, 204);
    assert.equal((await server.db.pushSubscription.count({ where: { endpoint: ENDPOINT_A } })), 0);
  });

  it("enviar mensaje dispara push vacío a la otra cuenta y poda caducadas", async () => {
    const { version } = await cleanSlate();
    enablePush();
    const sub = { endpoint: ENDPOINT_B, keys: { p256dh: P256DH, auth: AUTH } };
    const saved = await member.request("POST", "/api/push/subscriptions", { body: { subscription: sub } });
    assert.equal(saved.status, 201);

    // El disparo real usa fetch al push service; aquí se verifica el efecto
    // vía notifyPushNewMessage con transporte inyectado (sin red externa).
    const { notifyPushNewMessage } = await import("../../src/push.js");
    const sent: string[] = [];
    const outcome = await notifyPushNewMessage({
      config: server.config,
      db: server.db,
      senderId: server.users.adminId,
      fetchFn: async (url) => {
        sent.push(url);
        return { status: 201 };
      },
    });
    assert.equal(outcome.sent, 1);
    assert.deepEqual(sent, [ENDPOINT_B]);

    // 410 caduca la suscripción sin tumbar el resto.
    const pruned = await notifyPushNewMessage({
      config: server.config,
      db: server.db,
      senderId: server.users.adminId,
      fetchFn: async () => ({ status: 410 }),
    });
    assert.equal(pruned.pruned, 1);
    assert.equal((await server.db.pushSubscription.count({ where: { endpoint: ENDPOINT_B } })), 0);

    // El envío HTTP del mensaje sigue 201 aunque el push esté activo.
    const key = randomUUID();
    const sent2 = await admin.request("POST", "/api/messages", {
      body: { clientMessageId: key, body: "hola con push", conversationVersion: version },
    });
    assert.equal(sent2.status, 201);
  });
});

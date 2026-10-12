import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, TestClient, type TestServer } from "./helpers.js";
import { hashPassword } from "../../src/auth/password.js";

/**
 * Acceso con PIN v2 contra PostgreSQL real.
 * El secreto de alta se inyecta por configuración de prueba (nunca en el repo).
 */
describe("API acceso con PIN (contrato v2)", () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
    server.config.guestSetupSecret = "respuesta-secreta-de-prueba";
    // PIN del admin aprovisionado (vía seed/archivo en producción).
    await server.db.user.update({
      where: { id: server.users.adminId },
      data: { pinHash: await hashPassword("1234"), mustChangePassword: false },
    });
  });

  after(async () => {
    await server.close();
  });

  it("pin-status indica alta pendiente del invitado", async () => {
    const anon = new TestClient(server.baseUrl);
    const res = await anon.request("GET", "/api/auth/pin-status", { csrf: false });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { memberPinSet: false });
  });

  it("alta con respuesta errónea se rechaza sin crear PIN", async () => {
    const anon = new TestClient(server.baseUrl);
    await anon.session();
    const res = await anon.request("POST", "/api/auth/pin-setup", {
      body: { answer: "respuesta equivocada", pin: "5678" },
    });
    assert.equal(res.status, 401);
    const status = await anon.request("GET", "/api/auth/pin-status", { csrf: false });
    assert.deepEqual(status.json, { memberPinSet: false });
  });

  it("alta válida crea el PIN, abre sesión de invitado y bloquea re-alta", async () => {
    const anon = new TestClient(server.baseUrl);
    await anon.session();
    const res = await anon.request("POST", "/api/auth/pin-setup", {
      body: { answer: "  RESPUESTA-secreta-DE-prueba ", pin: "5678" },
    });
    assert.equal(res.status, 201);
    const body = res.json as { user: { username: string; mustChangePassword: boolean }; csrfToken: string };
    assert.equal(body.user.username, "member");
    assert.equal(body.user.mustChangePassword, false);
    anon.csrf = body.csrfToken;
    // La sesión sirve el historial (sin PASSWORD_CHANGE_REQUIRED).
    const conv = await anon.request("GET", "/api/conversation", { csrf: false });
    assert.equal(conv.status, 200);
    const status = await anon.request("GET", "/api/auth/pin-status", { csrf: false });
    assert.deepEqual(status.json, { memberPinSet: true });
    // Segunda alta imposible aunque se conozca la respuesta.
    const twice = await anon.request("POST", "/api/auth/pin-setup", {
      body: { answer: "respuesta-secreta-de-prueba", pin: "0000" },
    });
    assert.equal(twice.status, 409);
  });

  it("entrada con PIN abre la cuenta que corresponde", async () => {
    const guest = new TestClient(server.baseUrl);
    await guest.session();
    const inMember = await guest.request("POST", "/api/auth/pin-login", { body: { pin: "5678" } });
    assert.equal(inMember.status, 200);
    assert.equal((inMember.json as { user: { username: string } }).user.username, "member");

    const boss = new TestClient(server.baseUrl);
    await boss.session();
    const inAdmin = await boss.request("POST", "/api/auth/pin-login", { body: { pin: "1234" } });
    assert.equal(inAdmin.status, 200);
    assert.equal((inAdmin.json as { user: { username: string } }).user.username, "admin");
  });

  it("PIN erróneo es genérico y el login con contraseña del invitado queda cerrado", async () => {
    const c = new TestClient(server.baseUrl);
    await c.session();
    const bad = await c.request("POST", "/api/auth/pin-login", { body: { pin: "9999" } });
    assert.equal(bad.status, 401);
    // La cuenta de invitado con PIN ya no acepta contraseña.
    const legacy = await c.login("member", server.users.memberPassword);
    assert.equal(legacy.status, 403);
    assert.equal((legacy.json as { error: { code: string } }).error.code, "PIN_REQUIRED");
  });

  it("cambio de PIN exige el actual y deja entrar con el nuevo", async () => {
    const c = new TestClient(server.baseUrl);
    await c.session();
    const login = await c.request("POST", "/api/auth/pin-login", { body: { pin: "5678" } });
    assert.equal(login.status, 200);
    c.csrf = (login.json as { csrfToken: string }).csrfToken;
    const wrong = await c.request("POST", "/api/auth/change-pin", {
      body: { currentPin: "0000", newPin: "4321" },
    });
    assert.equal(wrong.status, 401);
    const changed = await c.request("POST", "/api/auth/change-pin", {
      body: { currentPin: "5678", newPin: "4321" },
    });
    assert.equal(changed.status, 200);
    const retry = new TestClient(server.baseUrl);
    await retry.session();
    const back = await retry.request("POST", "/api/auth/pin-login", { body: { pin: "4321" } });
    assert.equal(back.status, 200);
    retry.csrf = (back.json as { csrfToken: string }).csrfToken;
    const old = await retry.request("POST", "/api/auth/pin-login", { body: { pin: "5678" } });
    assert.equal(old.status, 401);
  });

  it("barrido de PIN termina en bloqueo temporal", async () => {
    // Contadores limpios: el bloqueo debe deberse sólo a este barrido.
    await server.db.user.updateMany({
      data: { pinFailedAttempts: 0, pinLockedUntil: null },
    });
    const c = new TestClient(server.baseUrl);
    await c.session();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await c.request("POST", "/api/auth/pin-login", { body: { pin: "9999" } });
      last = res.status;
      if (res.status === 403) break;
      assert.equal(res.status, 401);
    }
    assert.equal(last, 403);
    const again = await c.request("POST", "/api/auth/pin-login", { body: { pin: "9999" } });
    assert.equal(again.status, 403);
    assert.equal((again.json as { error: { code: string } }).error.code, "PIN_LOCKED");
  });
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startTestServer, TestClient, type TestServer } from "./helpers.js";
import { buildApp } from "../../src/http/app.js";

describe("API auth, sesión y perfil (PostgreSQL real)", () => {
  let server: TestServer;
  let admin: TestClient;
  let member: TestClient;
  let anon: TestClient;

  before(async () => {
    server = await startTestServer();
    admin = new TestClient(server.baseUrl);
    member = new TestClient(server.baseUrl);
    anon = new TestClient(server.baseUrl);
    // Cuentas recién provisionadas exigen cambio de contraseña.
    await admin.login("admin", server.users.adminPassword);
    await changePassword(admin, server.users.adminPassword, "Nueva-contraseña-admin-001");
    await member.login("member", server.users.memberPassword);
    await changePassword(member, server.users.memberPassword, "Nueva-contraseña-member-002");
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

  it("health y ready responden ok provisionado", async () => {
    const health = await anon.request("GET", "/api/health", { csrf: false });
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { status: "ok" });
    const ready = await anon.request("GET", "/api/ready", { csrf: false });
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.json, { status: "ok" });
  });

  it("sesión anónima devuelve user null y csrf", async () => {
    const fresh = new TestClient(server.baseUrl);
    const body = await fresh.session();
    assert.equal(body.user, null);
    assert.ok(body.csrfToken.length >= 16);
  });

  it("producción: cookie CSRF Secure/HttpOnly y respuestas sin caché", async () => {
    const app = await buildApp({ config: { ...server.config, isProd: true, env: "production", appOrigin: "https://chat.example.com" }, db: server.db });
    try {
      const res = await app.inject({ method: "GET", url: "/api/auth/session" });
      assert.equal(res.statusCode, 200);
      const cookies = [res.headers["set-cookie"]].flat().filter((value): value is string => typeof value === "string");
      const csrf = cookies.find((value) => value.startsWith("pc_csrf="));
      assert.ok(csrf);
      assert.match(csrf, /; Secure/i);
      assert.match(csrf, /; HttpOnly/i);
      assert.match(csrf, /; SameSite=Lax/i);
      assert.equal(res.headers["cache-control"], "no-store");
    } finally { await app.close(); }
  });

  it("login con credenciales erróneas es genérico", async () => {
    const c = new TestClient(server.baseUrl);
    const badPass = await c.login("admin", "contraseña-incorrecta-000");
    assert.equal(badPass.status, 401);
    assert.equal((badPass.json as { error: { code: string } }).error.code, "INVALID_CREDENTIALS");
    const unknown = await c.login("nadie", "contraseña-incorrecta-000");
    assert.equal(unknown.status, 401);
    assert.equal((unknown.json as { error: { code: string } }).error.code, "INVALID_CREDENTIALS");
  });

  it("login normaliza el usuario a minúsculas", async () => {
    const c = new TestClient(server.baseUrl);
    const res = await c.login("ADMIN", "Nueva-contraseña-admin-001");
    assert.equal(res.status, 200);
  });

  it("mutación sin CSRF se rechaza", async () => {
    const c = new TestClient(server.baseUrl);
    await c.login("admin", "Nueva-contraseña-admin-001");
    const saved = c.csrf;
    c.csrf = "manipulado";
    const res = await c.request("POST", "/api/messages", {
      body: { clientMessageId: randomUUID(), body: "hola", conversationVersion: 1 },
    });
    assert.equal(res.status, 403);
    assert.equal((res.json as { error: { code: string } }).error.code, "CSRF_INVALID");
    c.csrf = saved;
  });

  it("primera contraseña exige cambio y bloquea el resto", async () => {
    await server.reset();
    const c = new TestClient(server.baseUrl);
    const login = await c.login("admin", server.users.adminPassword);
    assert.equal(login.status, 200);
    assert.equal((login.json as { user: { mustChangePassword: boolean } }).user.mustChangePassword, true);
    const conv = await c.request("GET", "/api/conversation", { csrf: false });
    assert.equal(conv.status, 403);
    assert.equal((conv.json as { error: { code: string } }).error.code, "PASSWORD_CHANGE_REQUIRED");
    // Cambio con actual errónea.
    const wrong = await c.request("POST", "/api/auth/change-password", {
      body: { currentPassword: "no-es-esta-00000000", newPassword: "Otra-contraseña-nueva-003" },
    });
    assert.equal(wrong.status, 401);
    // Cambio válido.
    await changePassword(c, server.users.adminPassword, "Otra-contraseña-nueva-003");
    const conv2 = await c.request("GET", "/api/conversation", { csrf: false });
    assert.equal(conv2.status, 200);
    // Restaura estado para el resto del archivo.
    const fresh = await server.reset();
    server.users = fresh;
    await admin.login("admin", server.users.adminPassword);
    await changePassword(admin, server.users.adminPassword, "Nueva-contraseña-admin-001");
    await member.login("member", server.users.memberPassword);
    await changePassword(member, server.users.memberPassword, "Nueva-contraseña-member-002");
  });

  it("cambiar contraseña revoca sesiones anteriores", async () => {
    const first = new TestClient(server.baseUrl);
    await first.login("member", "Nueva-contraseña-member-002");
    const me1 = await first.request("GET", "/api/conversation", { csrf: false });
    assert.equal(me1.status, 200);
    await changePassword(member, "Nueva-contraseña-member-002", "Rotada-contraseña-member-004");
    const me1After = await first.request("GET", "/api/conversation", { csrf: false });
    assert.equal(me1After.status, 401);
    // Vuelve al estado conocido.
    await member.login("member", "Rotada-contraseña-member-004");
    await changePassword(member, "Rotada-contraseña-member-004", "Nueva-contraseña-member-002");
  });

  it("logout es idempotente y cierra sesión", async () => {
    const c = new TestClient(server.baseUrl);
    await c.login("admin", "Nueva-contraseña-admin-001");
    const out1 = await c.request("POST", "/api/auth/logout", { body: {} });
    assert.equal(out1.status, 204);
    const me = await c.request("GET", "/api/conversation", { csrf: false });
    assert.equal(me.status, 401);
    // El logout rota el CSRF: el cliente lo refresca antes de reintentar.
    await c.session();
    const out2 = await c.request("POST", "/api/auth/logout", { body: {} });
    assert.equal(out2.status, 204);
  });

  it("miembro no puede borrar mensajes ajenos, vaciar ni cambiar roles", async () => {
    const created = await admin.request("POST", "/api/messages", {
      body: { clientMessageId: randomUUID(), body: "Mensaje del administrador", conversationVersion: 1 },
    });
    assert.equal(created.status, 201);
    const id = (created.json as { message: { id: string } }).message.id;
    const del = await member.request("DELETE", `/api/messages/${id}`, {
      body: { conversationVersion: 1 },
    });
    assert.equal(del.status, 403);
    assert.equal((del.json as { error: { code: string } }).error.code, "FORBIDDEN");

    const clear = await member.request("DELETE", "/api/conversation/messages", {
      body: { conversationVersion: 1 },
    });
    assert.equal(clear.status, 403);

    const role = await member.request("PATCH", "/api/users/me", { body: { role: "admin" } });
    assert.equal(role.status, 400);
    const me = await member.request("GET", "/api/auth/session", { csrf: false });
    assert.equal((me.json as { user: { role: string } }).user.role, "member");
  });

  it("anónimo no accede a recursos privados", async () => {
    const c = new TestClient(server.baseUrl);
    await c.session();
    for (const [method, path] of [
      ["GET", "/api/conversation"],
      ["GET", "/api/messages"],
      ["PATCH", "/api/users/me"],
    ] as const) {
      const res = await c.request(method, path, { body: method === "PATCH" ? { displayName: "X" } : undefined });
      // Sin sesión: 401 aunque el CSRF anónimo sea válido.
      assert.equal(res.status, 401);
    }
  });

  it("perfil: editar nombre y duplicado rechazado", async () => {
    const upd = await admin.request("PATCH", "/api/users/me", { body: { displayName: "Ada Renovada" } });
    assert.equal(upd.status, 200);
    assert.equal((upd.json as { user: { displayName: string } }).user.displayName, "Ada Renovada");

    const dup = await admin.request("PATCH", "/api/users/me", { body: { username: "member" } });
    assert.equal(dup.status, 409);
    assert.equal((dup.json as { error: { code: string } }).error.code, "USERNAME_TAKEN");

    const bad = await admin.request("PATCH", "/api/users/me", { body: { username: "con espacios!" } });
    assert.equal(bad.status, 400);
  });

  it("avatar: subir, servir privado y rechazos", async () => {
    const PNG_1PX = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const boundary = `----test${Date.now()}`;
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      PNG_1PX,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await admin.request("POST", "/api/users/me/avatar", {
      rawBody: multipartBody,
      contentType: `multipart/form-data; boundary=${boundary}`,
    });
    assert.equal(up.status, 200);
    const avatarUrl = (up.json as { user: { avatarUrl: string | null } }).user.avatarUrl;
    assert.ok(avatarUrl?.startsWith("/api/users/"));

    const anon2 = new TestClient(server.baseUrl);
    await anon2.session();
    const anonGet = await anon2.request("GET", avatarUrl!.split("?")[0]!, { csrf: false });
    assert.equal(anonGet.status, 401);

    const authed = await admin.request("GET", avatarUrl!.split("?")[0]!, { csrf: false });
    assert.equal(authed.status, 200);

    // SVG rechazado aunque declare PNG.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");
    const badBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      svg,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const bad = await admin.request("POST", "/api/users/me/avatar", {
      rawBody: badBody,
      contentType: `multipart/form-data; boundary=${boundary}`,
    });
    assert.equal(bad.status, 400);
    assert.equal((bad.json as { error: { code: string } }).error.code, "UPLOAD_INVALID");

    // Sobretamaño.
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(6 * 1024 * 1024)]);
    const bigBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      big,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const bigRes = await admin.request("POST", "/api/users/me/avatar", {
      rawBody: bigBody,
      contentType: `multipart/form-data; boundary=${boundary}`,
    });
    assert.equal(bigRes.status, 400);

    const del = await admin.request("DELETE", "/api/users/me/avatar", { body: {} });
    assert.equal(del.status, 200);
    assert.equal((del.json as { user: { avatarUrl: string | null } }).user.avatarUrl, null);
  });
});

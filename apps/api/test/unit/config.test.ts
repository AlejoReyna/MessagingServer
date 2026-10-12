import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/config.js";

test("configuración inválida nunca cae silenciosamente a desarrollo", () => {
  assert.throws(() => loadConfig({ APP_ENV: "producction" }), /APP_ENV/);
  assert.throws(() => loadConfig({ APP_ORIGIN: "https://chat.example.com/path" }), /APP_ORIGIN/);
  assert.throws(() => loadConfig({ APP_ORIGIN: "https://usuario:clave@chat.example.com" }), /APP_ORIGIN/);
  assert.throws(() => loadConfig({ PORT: "3000texto" }), /PORT/);
});

test("configuración usa el entorno recibido y rechaza secretos inexistentes", () => {
  const url = "postgresql://test@127.0.0.1/private_chat_test";
  assert.equal(loadConfig({ APP_ENV: "test", DATABASE_URL: url }).databaseUrl, url);
  assert.throws(() => loadConfig({ APP_ENV: "test", DATABASE_PASSWORD_FILE: "/secreto-de-prueba-inexistente" }), /DATABASE_PASSWORD_FILE/);
  assert.throws(() => loadConfig({ APP_ENV: "production", APP_ORIGIN: "https://chat.example.com" }), /COOKIE_SECRET_FILE/);
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSessionCookie, signSessionCookie } from "../../src/auth/session.js";
import { sha256Hex, safeEqual } from "../../src/lib/crypto.js";

const SECRET = "cookie-secret-de-prueba-largo-1234567890";

describe("cookies de sesión", () => {
  it("firma y recupera el token", () => {
    const signed = signSessionCookie(SECRET, "token-opaco");
    assert.equal(parseSessionCookie(SECRET, signed), "token-opaco");
  });

  it("rechaza firma manipulada", () => {
    const signed = signSessionCookie(SECRET, "token-opaco");
    assert.equal(parseSessionCookie(SECRET, `${signed}x`), null);
    assert.equal(parseSessionCookie("otro-secreto-largo-0000000000000000", signed), null);
  });

  it("rechaza valores ausentes o malformados", () => {
    assert.equal(parseSessionCookie(SECRET, undefined), null);
    assert.equal(parseSessionCookie(SECRET, ""), null);
    assert.equal(parseSessionCookie(SECRET, "sinfirma"), null);
  });
});

describe("primitivas cripto", () => {
  it("sha256 es determinista y no revela el token", () => {
    const a = sha256Hex("abc");
    assert.equal(a, sha256Hex("abc"));
    assert.ok(!a.includes("abc"));
  });

  it("safeEqual distingue sin filtrar longitud útil", () => {
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abd"), false);
    assert.equal(safeEqual("abc", "abcd"), false);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { issueCsrf, verifyCsrf } from "../../src/auth/csrf.js";

const SECRET = "secreto-de-prueba-suficientemente-largo-123456";

describe("CSRF sin estado", () => {
  it("emite un par cookie/token que se verifica", () => {
    const issued = issueCsrf(SECRET);
    assert.ok(issued.cookieValue.length > 0);
    assert.ok(issued.token.length >= 16);
    assert.equal(verifyCsrf(SECRET, issued.cookieValue, issued.token), true);
  });

  it("rechaza token manipulado", () => {
    const issued = issueCsrf(SECRET);
    assert.equal(verifyCsrf(SECRET, issued.cookieValue, `${issued.token}x`), false);
  });

  it("rechaza cookie manipulada", () => {
    const issued = issueCsrf(SECRET);
    assert.equal(verifyCsrf(SECRET, `${issued.cookieValue}x`, issued.token), false);
  });

  it("rechaza secreto distinto", () => {
    const issued = issueCsrf(SECRET);
    assert.equal(verifyCsrf("otro-secreto-diferente-00000000000000000", issued.cookieValue, issued.token), false);
  });

  it("rechaza valores ausentes o malformados", () => {
    assert.equal(verifyCsrf(SECRET, undefined, "token"), false);
    assert.equal(verifyCsrf(SECRET, "a.b.c", undefined), false);
    assert.equal(verifyCsrf(SECRET, "sin-puntos", "token"), false);
    assert.equal(verifyCsrf(SECRET, "", ""), false);
  });

  it("rotar invalida el par anterior", () => {
    const first = issueCsrf(SECRET);
    const second = issueCsrf(SECRET);
    assert.notEqual(first.token, second.token);
    assert.equal(verifyCsrf(SECRET, first.cookieValue, second.token), false);
    assert.equal(verifyCsrf(SECRET, second.cookieValue, second.token), true);
  });
});

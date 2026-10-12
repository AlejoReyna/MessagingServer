import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryRateLimiter } from "../../src/lib/rate-limit.js";

describe("MemoryRateLimiter", () => {
  it("permite hasta el máximo dentro de la ventana", () => {
    const limiter = new MemoryRateLimiter({ maxAttempts: 3, windowMs: 1000 });
    assert.equal(limiter.take("k", 0), true);
    assert.equal(limiter.take("k", 1), true);
    assert.equal(limiter.take("k", 2), true);
    assert.equal(limiter.take("k", 3), false);
  });

  it("reabre la ventana tras expirar", () => {
    const limiter = new MemoryRateLimiter({ maxAttempts: 1, windowMs: 100 });
    assert.equal(limiter.take("k", 0), true);
    assert.equal(limiter.take("k", 50), false);
    assert.equal(limiter.take("k", 101), true);
  });

  it("aísla claves y permite reinicio", () => {
    const limiter = new MemoryRateLimiter({ maxAttempts: 1, windowMs: 1000 });
    assert.equal(limiter.take("a", 0), true);
    assert.equal(limiter.take("b", 0), true);
    limiter.reset("a");
    assert.equal(limiter.take("a", 0), true);
  });
});

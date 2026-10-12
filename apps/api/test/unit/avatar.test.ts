import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectImageFormat, processAvatarImage } from "../../src/avatar.js";
import { errorBody, ERRORS } from "../../src/http/errors.js";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG_MIN = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");

describe("avatares", () => {
  it("detecta PNG/JPEG por bytes mágicos", () => {
    assert.equal(detectImageFormat(PNG_1PX), "png");
    assert.equal(detectImageFormat(JPEG_MIN), "jpeg");
  });

  it("rechaza SVG y basura", () => {
    assert.equal(detectImageFormat(SVG), null);
    assert.equal(detectImageFormat(Buffer.from([1, 2, 3, 4])), null);
    assert.equal(detectImageFormat(Buffer.alloc(0)), null);
  });

  it("reexporta PNG a PNG válido", async () => {
    const out = await processAvatarImage(PNG_1PX, "png");
    assert.equal(detectImageFormat(out), "png");
  });

  it("falla con imagen corrupta", async () => {
    await assert.rejects(() => processAvatarImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]), "png"));
  });
});

describe("errores uniformes", () => {
  it("formato { error: { code, message } } en español", () => {
    const body = errorBody(ERRORS.conversationChanged());
    assert.equal(body.error.code, "CONVERSATION_CHANGED");
    assert.ok(body.error.message.length > 0);
    assert.ok(!("stack" in body));
  });
});

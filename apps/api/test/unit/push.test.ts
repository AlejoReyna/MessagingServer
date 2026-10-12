import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.js";
import {
  buildVapidHeaders,
  derToRawSignature,
  generateVapidKeys,
  pushAudienceFor,
  sendEmptyPush,
  subscriptionIdFor,
} from "../../src/push.js";

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("par VAPID válido: pública 65 bytes 0x04, privada 32 bytes", () => {
  const keys = generateVapidKeys();
  const pub = Buffer.from(keys.publicKey.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const priv = Buffer.from(keys.privateKey.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  assert.equal(pub.length, 65);
  assert.equal(pub[0], 0x04);
  assert.equal(priv.length, 32);
});

test("cabeceras VAPID firman un JWT ES256 verificable con la pública", () => {
  const keys = generateVapidKeys();
  const audience = "https://web.push.apple.com";
  const { authorization, cryptoKey } = buildVapidHeaders({
    ...keys,
    subject: "mailto:test@example.com",
    audience,
    nowMs: 1760000000000,
  });
  assert.match(authorization, /^vapid t=[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+, k=[A-Za-z0-9-_]+$/);
  assert.match(cryptoKey, /^p256ecdsa=[A-Za-z0-9-_]+$/);
  const token = authorization.slice("vapid t=".length).split(", k=")[0]!;
  const [header, payload, signature] = token.split(".");
  const pubBytes = Buffer.from(keys.publicKey.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: base64urlEncode(pubBytes.subarray(1, 33)),
    y: base64urlEncode(pubBytes.subarray(33, 65)),
  };
  // Node verifica ECDSA en DER: re-codificar el raw R||S del JWS a DER.
  const raw = Buffer.from(signature!, "base64url");
  assert.equal(raw.length, 64);
  const strip = (part: Buffer): Buffer => {
    let i = 0;
    while (i < part.length - 1 && part[i] === 0) i++;
    let out = part.subarray(i);
    if ((out[0]! & 0x80) !== 0) out = Buffer.concat([Buffer.from([0]), out]);
    return Buffer.from(out);
  };
  const r = strip(raw.subarray(0, 32));
  const s = strip(raw.subarray(32, 64));
  const der = Buffer.concat([
    Buffer.from([0x30, 2 + r.length + 2 + s.length, 0x02, r.length]),
    r,
    Buffer.from([0x02, s.length]),
    s,
  ]);
  const verifier = createVerify("sha256");
  verifier.update(`${header}.${payload}`);
  assert.equal(verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), der), true);
  const body = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as { aud: string; sub: string; exp: number };
  assert.equal(body.aud, audience);
  assert.equal(body.sub, "mailto:test@example.com");
});

test("DER a raw: firma de 64 bytes alineada", () => {
  const keys = generateVapidKeys();
  const { authorization } = buildVapidHeaders({ ...keys, subject: "mailto:a@b.com", audience: "https://push.example.com" });
  const sig = authorization.split(".")[2]!.split(",")[0]!;
  assert.equal(Buffer.from(sig, "base64url").length, 64);
  void derToRawSignature;
});

test("push vacío: envía TTL/urgencia/autorización sin payload y detecta caducadas", async () => {
  const keys = generateVapidKeys();
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const subscription = {
    endpoint: "https://push.example.com/abc",
    p256dh: "B".repeat(0) + "A".repeat(87),
    auth: "A".repeat(22),
  };
  const ok = await sendEmptyPush({
    subscription,
    config: { push: { enabled: true, publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:t@example.com" } },
    fetchFn: async (url, init) => {
      seen.push({ url, headers: init.headers });
      assert.equal(init.method, "POST");
      return { status: 201 };
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.gone, false);
  assert.equal(seen[0]!.headers["Urgency"], "high");
  assert.match(seen[0]!.headers["Authorization"]!, /^vapid t=/);
  assert.match(seen[0]!.headers["Crypto-Key"]!, /^p256ecdsa=/);

  const gone = await sendEmptyPush({
    subscription,
    config: { push: { enabled: true, publicKey: keys.publicKey, privateKey: keys.privateKey, subject: "mailto:t@example.com" } },
    fetchFn: async () => ({ status: 410 }),
  });
  assert.equal(gone.gone, true);
  assert.equal(gone.ok, false);
});

test("audiencia push exige https e id estable por endpoint", () => {
  assert.equal(pushAudienceFor("https://web.push.apple.com/p/123"), "https://web.push.apple.com");
  assert.throws(() => pushAudienceFor("http://push.example.com/x"), /no válido/);
  assert.match(subscriptionIdFor("https://push.example.com/a"), /^[a-f0-9]{64}$/);
  assert.equal(subscriptionIdFor("https://push.example.com/a"), subscriptionIdFor("https://push.example.com/a"));
});

test("config push: deshabilitado por defecto, exige claves y asunto", () => {
  const off = loadConfig({ APP_ENV: "test", DATABASE_URL: "postgresql://t@127.0.0.1/x" });
  assert.equal(off.push.enabled, false);
  const keys = generateVapidKeys();
  const dir = mkdtempSync(join(tmpdir(), "pc-push-"));
  const privFile = join(dir, "vapid_private_key");
  writeFileSync(privFile, `${keys.privateKey}\n`, { mode: 0o600 });
  const on = loadConfig({
    APP_ENV: "test",
    DATABASE_URL: "postgresql://t@127.0.0.1/x",
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY_FILE: privFile,
    VAPID_SUBJECT: "mailto:test@example.com",
  });
  assert.equal(on.push.enabled, true);
  assert.throws(() => loadConfig({
    APP_ENV: "test",
    DATABASE_URL: "postgresql://t@127.0.0.1/x",
    VAPID_PUBLIC_KEY: "corta",
    VAPID_PRIVATE_KEY_FILE: privFile,
    VAPID_SUBJECT: "mailto:test@example.com",
  }), /VAPID_PUBLIC_KEY/);
  assert.throws(() => loadConfig({
    APP_ENV: "test",
    DATABASE_URL: "postgresql://t@127.0.0.1/x",
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY_FILE: privFile,
    VAPID_SUBJECT: "no-valido",
  }), /VAPID_SUBJECT/);
});

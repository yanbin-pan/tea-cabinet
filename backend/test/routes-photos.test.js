import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPair, SignJWT, exportJWK } from "jose";

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "tea-routes-photos-"));
process.env.DATA_DIR = DATA_DIR;
process.env.ACCESS_TEAM_DOMAIN = "example.cloudflareaccess.com";
process.env.ACCESS_AUD = "test-audience-tag";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };

// The server exposes a seam so tests can supply a local key set instead of
// fetching Cloudflare's. Nothing else about the verification path changes.
process.env.ACCESS_TEST_JWKS = JSON.stringify({ keys: [jwk] });

const { app } = await import("../server.js");

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const EMAIL = "photos-reader@example.com";

async function tokenFor(email) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://example.cloudflareaccess.com")
    .setAudience("test-audience-tag")
    .setIssuedAt().setExpirationTime("5m")
    .sign(privateKey);
}

async function as(email, url, init = {}) {
  const headers = { ...(init.headers || {}), "Cf-Access-Jwt-Assertion": await tokenFor(email) };
  return fetch(`${base}${url}`, { ...init, headers });
}

test("POST /api/photos stores bytes and GET returns them unchanged", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const post = await as(EMAIL, "/api/photos", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: bytes,
  });
  assert.equal(post.status, 200);
  const { id } = await post.json();
  assert.match(id, /^[0-9a-f]{32}$/);

  const get = await as(EMAIL, `/api/photos/${id}`);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "image/jpeg");
  assert.match(get.headers.get("cache-control"), /immutable/);
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
});

test("GET /api/photos with an unknown id is 404, not 500", async () => {
  const res = await as(EMAIL, `/api/photos/${"0".repeat(32)}`);
  assert.equal(res.status, 404);
});

test("GET /api/photos rejects a malformed id", async () => {
  const res = await as(EMAIL, "/api/photos/not-a-valid-id");
  assert.equal(res.status, 404);
});

test("POST /api/photos with an empty body is 400", async () => {
  const res = await as(EMAIL, "/api/photos", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: Buffer.alloc(0),
  });
  assert.equal(res.status, 400);
});

test("POST /api/photos refuses a non-image content type", async () => {
  const res = await as(EMAIL, "/api/photos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: Buffer.from("{}"),
  });
  assert.equal(res.status, 415);
});

test("POST /api/photos over the 8MB per-photo limit is 413", async () => {
  // Bigger than the 8MB limit savePhoto enforces, but under the 10mb body
  // parser limit, so this exercises the TOO_LARGE -> 413 translation rather
  // than express.raw()'s own limit.
  const bytes = Buffer.alloc(9 * 1024 * 1024, 0xff);
  const res = await as(EMAIL, "/api/photos", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: bytes,
  });
  assert.equal(res.status, 413);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPair, SignJWT, exportJWK } from "jose";

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "tea-isolation-"));
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

test("an unauthenticated request gets 401", async () => {
  assert.equal((await fetch(`${base}/api/collection`)).status, 401);
  assert.equal((await fetch(`${base}/api/photos/${"0".repeat(32)}`)).status, 401);
});

test("/api/health stays open for probes", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("two people keep separate collections", async () => {
  await as("alice@example.com", "/api/collection", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teas: [{ id: "a1", englishName: "Alice's Longjing" }] }),
  });

  const bobBefore = await (await as("bob@example.com", "/api/collection")).json();
  assert.deepEqual(bobBefore.teas, [], "Bob must not see Alice's teas");

  await as("bob@example.com", "/api/collection", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teas: [{ id: "b1", englishName: "Bob's Puerh" }] }),
  });

  const alice = await (await as("alice@example.com", "/api/collection")).json();
  assert.equal(alice.teas.length, 1);
  assert.equal(alice.teas[0].englishName, "Alice's Longjing", "Bob's write must not touch Alice's cabinet");
});

test("one person cannot read another's photo even knowing its id", async () => {
  const post = await as("alice@example.com", "/api/photos", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: Buffer.from("alice-private-photo"),
  });
  const { id } = await post.json();

  assert.equal((await as("alice@example.com", `/api/photos/${id}`)).status, 200);
  assert.equal(
    (await as("bob@example.com", `/api/photos/${id}`)).status, 404,
    "a photo id from another cabinet must not resolve"
  );
});

test("each cabinet is a directory of its own", async () => {
  const users = await fs.readdir(path.join(DATA_DIR, "users"));
  assert.equal(users.length, 2);
  for (const dir of users) assert.match(dir, /^[0-9a-f]{64}$/);
});

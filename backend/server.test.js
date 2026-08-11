import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The server reads its config at import time, so point DATA_DIR at a throwaway
// directory *before* importing it. No API key -> /api/scan must self-disable.
const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "tea-cabinet-test-"));
process.env.DATA_DIR = DATA_DIR;
delete process.env.ANTHROPIC_API_KEY;

const { app, ensureStore } = await import("./server.js");
const { readCollection, writeCollection } = await import("./lib/store.js");

const DATA_FILE = path.join(DATA_DIR, "collection.json");

// Start the app on an ephemeral port once, and share it across the route tests.
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

async function clearStore() {
  await fs.rm(DATA_FILE, { force: true });
}

test("readCollection returns [] when the file is absent", async () => {
  await clearStore();
  assert.deepEqual(await readCollection(DATA_DIR), []);
});

test("ensureStore creates the data dir", async () => {
  await clearStore();
  await ensureStore();
  const stat = await fs.stat(DATA_DIR);
  assert.ok(stat.isDirectory());
});

test("readCollection tolerates a bare array on disk", async () => {
  await clearStore();
  await fs.writeFile(DATA_FILE, JSON.stringify([{ id: "t-9", englishName: "Bare" }]), "utf8");
  assert.deepEqual(await readCollection(DATA_DIR), [{ id: "t-9", englishName: "Bare" }]);
});

test("readCollection returns [] for corrupt JSON rather than throwing", async () => {
  await clearStore();
  await fs.writeFile(DATA_FILE, "{not json", "utf8");
  assert.deepEqual(await readCollection(DATA_DIR), []);
});

test("GET /api/health returns {ok:true}", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("GET /api/collection is empty initially; PUT then GET reflects the new list", async () => {
  await clearStore();
  await ensureStore();

  let res = await fetch(`${base}/api/collection`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { teas: [] });

  const teas = [{ id: "t-4", englishName: "Da Hong Pao", chineseName: "大红袍", type: "Oolong" }];
  res = await fetch(`${base}/api/collection`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teas }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, count: 1 });

  res = await fetch(`${base}/api/collection`);
  assert.deepEqual(await res.json(), { teas });
});

test("PUT /api/collection accepts a bare array", async () => {
  await clearStore();
  const teas = [{ id: "t-5", englishName: "Keemun" }];
  const res = await fetch(`${base}/api/collection`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(teas),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await readCollection(DATA_DIR), teas);
});

test("PUT /api/collection rejects a non-array payload with 400", async () => {
  const res = await fetch(`${base}/api/collection`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ teas: "nope" }),
  });
  assert.equal(res.status, 400);
});

test("POST /api/scan returns 503 when no ANTHROPIC_API_KEY is set", async () => {
  const res = await fetch(`${base}/api/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mediaType: "image/jpeg", b64: "AAAA", system: "test" }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, "Label scanning isn't configured on the server.");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "tea-routes-photos-"));
process.env.DATA_DIR = DATA_DIR;

const { app } = await import("../server.js");

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test("POST /api/photos stores bytes and GET returns them unchanged", async () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const post = await fetch(`${base}/api/photos`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: bytes,
  });
  assert.equal(post.status, 200);
  const { id } = await post.json();
  assert.match(id, /^[0-9a-f]{32}$/);

  const get = await fetch(`${base}/api/photos/${id}`);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "image/jpeg");
  assert.match(get.headers.get("cache-control"), /immutable/);
  assert.deepEqual(Buffer.from(await get.arrayBuffer()), bytes);
});

test("GET /api/photos with an unknown id is 404, not 500", async () => {
  const res = await fetch(`${base}/api/photos/${"0".repeat(32)}`);
  assert.equal(res.status, 404);
});

test("GET /api/photos rejects a malformed id", async () => {
  const res = await fetch(`${base}/api/photos/not-a-valid-id`);
  assert.equal(res.status, 404);
});

test("POST /api/photos with an empty body is 400", async () => {
  const res = await fetch(`${base}/api/photos`, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: Buffer.alloc(0),
  });
  assert.equal(res.status, 400);
});

test("POST /api/photos refuses a non-image content type", async () => {
  const res = await fetch(`${base}/api/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: Buffer.from("{}"),
  });
  assert.equal(res.status, 415);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "tea-routes-sweep-"));
process.env.DATA_DIR = DATA_DIR;

const { app } = await import("../server.js");
const { savePhoto, readPhoto } = await import("../lib/photos.js");

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function age(dir, id, ms) {
  const file = path.join(dir, "photos", `${id}.jpg`);
  const when = new Date(Date.now() - ms);
  await fs.utimes(file, when, when);
}

test("saving a collection removes old photos nothing refers to", async () => {
  const kept = await savePhoto(DATA_DIR, Buffer.from("kept"));
  const orphan = await savePhoto(DATA_DIR, Buffer.from("orphan"));
  await age(DATA_DIR, kept, 48 * 60 * 60 * 1000);
  await age(DATA_DIR, orphan, 48 * 60 * 60 * 1000);

  const res = await fetch(`${base}/api/collection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teas: [{ id: "t1", englishName: "Keeper", photo: kept }] }),
  });
  assert.equal(res.status, 200);

  assert.notEqual(await readPhoto(DATA_DIR, kept), null, "a referenced photo survives");
  assert.equal(await readPhoto(DATA_DIR, orphan), null, "an old orphan is reclaimed");
});

test("a freshly uploaded photo is never swept, even unreferenced", async () => {
  const justUploaded = await savePhoto(DATA_DIR, Buffer.from("in flight"));

  const res = await fetch(`${base}/api/collection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teas: [] }),
  });
  assert.equal(res.status, 200);

  assert.notEqual(
    await readPhoto(DATA_DIR, justUploaded), null,
    "a photo whose tea has not been saved yet must survive"
  );
});

// This does NOT exercise the route's sweep catch branch: sweepOrphans is
// defensive internally (see photos.test.js) and never throws for the inputs
// the route ever passes it, so there is no failure here to be isolated from.
// This test only pins down that a save whose sweep has nothing to reclaim
// still returns a normal ok response.
test("a save with nothing for the sweep to reclaim still returns ok", async () => {
  const res = await fetch(`${base}/api/collection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teas: [{ id: "t2", englishName: "No photo", photo: null }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

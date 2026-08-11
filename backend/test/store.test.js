import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCollection, writeCollection } from "../lib/store.js";

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "tea-store-"));
}

test("readCollection returns [] when the file is absent", async () => {
  assert.deepEqual(await readCollection(await tmpDir()), []);
});

test("writeCollection then readCollection round-trips", async () => {
  const dir = await tmpDir();
  await writeCollection(dir, [{ id: "a", englishName: "Longjing" }]);
  const teas = await readCollection(dir);
  assert.equal(teas.length, 1);
  assert.equal(teas[0].englishName, "Longjing");
});

test("writeCollection stores metadata alongside the teas", async () => {
  const dir = await tmpDir();
  await writeCollection(dir, [], { email: "someone@example.com" });
  const raw = JSON.parse(await fs.readFile(path.join(dir, "collection.json"), "utf8"));
  assert.equal(raw.email, "someone@example.com");
  assert.equal(raw.app, "The Tea Cabinet");
  assert.ok(Array.isArray(raw.teas));
});

test("readCollection tolerates a bare array on disk", async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "collection.json"), JSON.stringify([{ id: "x" }]), "utf8");
  assert.equal((await readCollection(dir)).length, 1);
});

test("readCollection returns [] for corrupt JSON rather than throwing", async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "collection.json"), "{ not json", "utf8");
  assert.deepEqual(await readCollection(dir), []);
});

// The bug this guards: both API replicas share one NFS directory. With a fixed
// temp filename, one write's rename can land on another's half-written file.
test("concurrent writes leave one valid file and no temp files behind", async () => {
  const dir = await tmpDir();
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      writeCollection(dir, [{ id: `t${i}`, englishName: `Tea ${i}` }])
    )
  );
  const teas = await readCollection(dir);
  assert.equal(teas.length, 1, "the file must be a complete, parseable collection");

  const leftovers = (await fs.readdir(dir)).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, [], "no temp file may survive a write");
});

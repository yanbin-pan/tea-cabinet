import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateLegacy } from "../lib/migrate.js";
import { userKey, userDir } from "../lib/paths.js";

async function legacyDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tea-migrate-"));
  await fs.writeFile(path.join(dir, "collection.json"), JSON.stringify({ teas: [{ id: "old" }] }), "utf8");
  await fs.mkdir(path.join(dir, "photos"), { recursive: true });
  await fs.writeFile(path.join(dir, "photos", `${"a".repeat(32)}.jpg`), Buffer.from("bytes"));
  return dir;
}

test("moves a legacy collection and its photos into the owner's cabinet", async () => {
  const dir = await legacyDir();
  assert.equal(await migrateLegacy(dir, "owner@example.com"), true);

  const owner = userDir(dir, userKey("owner@example.com"));
  const moved = JSON.parse(await fs.readFile(path.join(owner, "collection.json"), "utf8"));
  assert.equal(moved.teas[0].id, "old");
  assert.ok(await fs.stat(path.join(owner, "photos", `${"a".repeat(32)}.jpg`)));

  await assert.rejects(() => fs.stat(path.join(dir, "collection.json")), "the legacy file is moved, not copied");
});

test("is idempotent — a second run does nothing", async () => {
  const dir = await legacyDir();
  assert.equal(await migrateLegacy(dir, "owner@example.com"), true);
  assert.equal(await migrateLegacy(dir, "owner@example.com"), false);
});

test("does nothing when there is no legacy collection", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tea-migrate-empty-"));
  assert.equal(await migrateLegacy(dir, "owner@example.com"), false);
});

test("never overwrites an existing cabinet", async () => {
  const dir = await legacyDir();
  const owner = userDir(dir, userKey("owner@example.com"));
  await fs.mkdir(owner, { recursive: true });
  await fs.writeFile(path.join(owner, "collection.json"), JSON.stringify({ teas: [{ id: "current" }] }), "utf8");

  assert.equal(await migrateLegacy(dir, "owner@example.com"), false);
  const kept = JSON.parse(await fs.readFile(path.join(owner, "collection.json"), "utf8"));
  assert.equal(kept.teas[0].id, "current", "existing data wins over legacy data");
});

test("does nothing without an owner address", async () => {
  const dir = await legacyDir();
  assert.equal(await migrateLegacy(dir, ""), false);
});

test("never clobbers a destination populated between the check and the move", async () => {
  const dir = await legacyDir();
  const owner = userDir(dir, userKey("owner@example.com"));
  await fs.mkdir(owner, { recursive: true });
  await fs.writeFile(path.join(owner, "collection.json"), JSON.stringify({ teas: [{ id: "freshly-written" }] }), "utf8");

  assert.equal(await migrateLegacy(dir, "owner@example.com"), false);

  const kept = JSON.parse(await fs.readFile(path.join(owner, "collection.json"), "utf8"));
  assert.equal(kept.teas[0].id, "freshly-written", "the owner's real data survives untouched");
});

test("resumes after a crash that left photos moved but collection.json not yet moved", async () => {
  const dir = await legacyDir();
  const owner = userDir(dir, userKey("owner@example.com"));
  await fs.mkdir(owner, { recursive: true });

  // Simulate a prior run that crashed after moving photos but before moving
  // collection.json: photos are already in the owner's cabinet, and the
  // legacy collection.json is still sitting at the top level.
  await fs.rename(path.join(dir, "photos"), path.join(owner, "photos"));

  assert.equal(await migrateLegacy(dir, "owner@example.com"), true);

  const moved = JSON.parse(await fs.readFile(path.join(owner, "collection.json"), "utf8"));
  assert.equal(moved.teas[0].id, "old");
  assert.ok(await fs.stat(path.join(owner, "photos", `${"a".repeat(32)}.jpg`)));
  await assert.rejects(() => fs.stat(path.join(dir, "collection.json")), "the legacy collection is moved, not left behind");
});

// Not in the brief's test list, but the two-replica scenario is a specific
// hazard called out for this task: two processes may call migrateLegacy at
// the same instant against the same shared directory. This drives two
// concurrent, interleaved calls (via Promise.all, same process) at the exact
// exists()-check/rename race window and asserts neither throws, exactly one
// reports having moved the data, and nothing is lost or duplicated. It
// exercises the same-process interleaving the implementation is built to
// survive; it does not reproduce true cross-process NFS rename semantics.
test("two replicas racing on the same legacy data do not crash, lose, or duplicate anything", async () => {
  const dir = await legacyDir();

  const results = await Promise.all([
    migrateLegacy(dir, "owner@example.com"),
    migrateLegacy(dir, "owner@example.com"),
  ]);
  assert.deepEqual(results.sort(), [false, true], "exactly one caller should report having moved the data");

  const owner = userDir(dir, userKey("owner@example.com"));
  const moved = JSON.parse(await fs.readFile(path.join(owner, "collection.json"), "utf8"));
  assert.equal(moved.teas[0].id, "old");
  assert.ok(await fs.stat(path.join(owner, "photos", `${"a".repeat(32)}.jpg`)));
  await assert.rejects(() => fs.stat(path.join(dir, "collection.json")));
});

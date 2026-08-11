import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  savePhoto, readPhoto, sweepOrphans, isValidPhotoId, MAX_PHOTO_BYTES,
} from "../lib/photos.js";

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "tea-photos-"));
}

test("savePhoto returns an id that readPhoto resolves to the same bytes", async () => {
  const dir = await tmpDir();
  const bytes = Buffer.from("pretend-jpeg-bytes");
  const id = await savePhoto(dir, bytes);
  assert.ok(isValidPhotoId(id));
  assert.deepEqual(await readPhoto(dir, id), bytes);
});

test("ids are unique across saves", async () => {
  const dir = await tmpDir();
  const a = await savePhoto(dir, Buffer.from("a"));
  const b = await savePhoto(dir, Buffer.from("b"));
  assert.notEqual(a, b);
});

test("readPhoto returns null for an unknown id", async () => {
  assert.equal(await readPhoto(await tmpDir(), "0".repeat(32)), null);
});

// Path traversal: an id is the only user-controlled part of a photo path, so it
// must be rejected rather than escaped.
test("readPhoto refuses ids that are not 32 hex characters", async () => {
  const dir = await tmpDir();
  for (const bad of ["../../etc/passwd", "..", "abc", "", "/etc/passwd", "a".repeat(33)]) {
    assert.equal(await readPhoto(dir, bad), null, `must reject ${JSON.stringify(bad)}`);
    assert.equal(isValidPhotoId(bad), false);
  }
});

test("savePhoto rejects an empty body", async () => {
  const dir = await tmpDir();
  await assert.rejects(() => savePhoto(dir, Buffer.alloc(0)));
});

test("savePhoto rejects anything over the size limit", async () => {
  const dir = await tmpDir();
  await assert.rejects(
    () => savePhoto(dir, Buffer.alloc(MAX_PHOTO_BYTES + 1)),
    (e) => e.code === "TOO_LARGE"
  );
});

test("sweepOrphans keeps referenced photos and removes old unreferenced ones", async () => {
  const dir = await tmpDir();
  const kept = await savePhoto(dir, Buffer.from("kept"));
  const orphan = await savePhoto(dir, Buffer.from("orphan"));

  // Both files are new, so a sweep "now" must remove neither.
  assert.equal(await sweepOrphans(dir, [kept]), 0);
  assert.notEqual(await readPhoto(dir, orphan), null);

  // Pretend a day has passed.
  const removed = await sweepOrphans(dir, [kept], { now: Date.now() + 25 * 60 * 60 * 1000 });
  assert.equal(removed, 1);
  assert.equal(await readPhoto(dir, orphan), null);
  assert.notEqual(await readPhoto(dir, kept), null, "referenced photos are never swept");
});

test("sweepOrphans on a directory with no photos is a no-op", async () => {
  assert.equal(await sweepOrphans(await tmpDir(), []), 0);
});

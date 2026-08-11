import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// An id is the only user-controlled component of a photo path. Constraining it
// to fixed-length hex means traversal sequences cannot survive validation, so
// no escaping is needed anywhere downstream.
const ID_PATTERN = /^[0-9a-f]{32}$/;

export function isValidPhotoId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

function photosDir(dir) {
  return path.join(dir, "photos");
}

export async function savePhoto(dir, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error("A photo must have a body.");
  }
  if (bytes.length > MAX_PHOTO_BYTES) {
    const e = new Error("Photo exceeds the size limit.");
    e.code = "TOO_LARGE";
    throw e;
  }

  const dest = photosDir(dir);
  await fs.mkdir(dest, { recursive: true });

  const id = crypto.randomBytes(16).toString("hex");
  // Same reasoning as the collection: write then rename, so a reader never sees
  // a partial file. The leading dot keeps in-flight writes out of the sweep.
  const tmp = path.join(dest, `.${id}.tmp`);
  try {
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, path.join(dest, `${id}.jpg`));
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return id;
}

export async function readPhoto(dir, id) {
  if (!isValidPhotoId(id)) return null;
  try {
    return await fs.readFile(path.join(photosDir(dir), `${id}.jpg`));
  } catch (e) {
    return null;
  }
}

export async function sweepOrphans(dir, referencedIds, options = {}) {
  const { minAgeMs = TWENTY_FOUR_HOURS_MS, now = Date.now() } = options;
  const dest = photosDir(dir);

  let names;
  try {
    names = await fs.readdir(dest);
  } catch (e) {
    return 0;
  }

  const keep = new Set(referencedIds);
  let removed = 0;

  for (const name of names) {
    if (!name.endsWith(".jpg")) continue;
    const id = name.slice(0, -".jpg".length);
    if (keep.has(id)) continue;

    const file = path.join(dest, name);
    try {
      const stat = await fs.stat(file);
      // The age guard is load-bearing: a photo uploaded seconds ago, whose tea
      // has not been saved yet, is unreferenced but must not be deleted.
      if (now - stat.mtimeMs < minAgeMs) continue;
      await fs.rm(file, { force: true });
      removed++;
    } catch (e) {
      // A file that vanished under us is already in the desired state.
    }
  }

  return removed;
}

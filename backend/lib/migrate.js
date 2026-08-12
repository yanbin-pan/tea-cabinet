import fs from "node:fs/promises";
import path from "node:path";
import { userKey, userDir } from "./paths.js";

async function exists(p) {
  try { await fs.stat(p); return true; } catch (e) { return false; }
}

// One-time move of the pre-multi-tenancy layout into the owner's cabinet.
// Returns true only when it actually moved something, so a restart is a no-op.
//
// The backend runs two replicas against a shared (NFS) data directory, so two
// processes can call this at the same instant. Both may pass the exists()
// checks below before either has moved anything (a classic TOCTOU race).
//
// Photos move first, collection.json second. That order matters: the photos
// step self-guards with exists(legacyPhotos), so if a process crashes between
// the two moves, the next run finds the photos already gone (silent no-op)
// and goes on to move collection.json. Moving collection.json first would
// instead strand photos.json — the next run would short-circuit on the
// now-present owner collection and never move the photos, permanently
// orphaning every photo the migrated collection refers to.
//
// The collection.json move is never allowed to overwrite an existing owner
// cabinet, and an exists() check alone can't guarantee that — the other
// replica can populate the owner's cabinet between our check and our move.
// fs.rename would silently clobber the destination in that window. Instead
// we use fs.link, which is atomic and fails with EEXIST if the destination
// already exists, then fs.rm the legacy file to complete the "move". Both
// paths are under dataDir, so link is valid (no cross-device concern).
export async function migrateLegacy(dataDir, ownerEmail) {
  if (!ownerEmail) return false;

  const legacyCollection = path.join(dataDir, "collection.json");
  if (!(await exists(legacyCollection))) return false;

  const owner = userDir(dataDir, userKey(ownerEmail));
  const ownerCollection = path.join(owner, "collection.json");
  // Cheap fast path only — it avoids the work below in the common case, but
  // it does NOT enforce the never-overwrite invariant. That's fs.link's job,
  // below, which closes the TOCTOU window this check can't.
  if (await exists(ownerCollection)) return false;

  await fs.mkdir(owner, { recursive: true });

  const legacyPhotos = path.join(dataDir, "photos");
  const ownerPhotos = path.join(owner, "photos");
  if (await exists(legacyPhotos)) {
    try {
      await fs.rename(legacyPhotos, ownerPhotos);
    } catch (e) {
      if (e.code === "ENOENT" && (await exists(ownerPhotos))) {
        // Another replica already moved the photos out from under us. Fall
        // through — we still need to try the collection.json move below.
      } else {
        throw e;
      }
    }
  }

  try {
    await fs.link(legacyCollection, ownerCollection);
    await fs.rm(legacyCollection, { force: true });
  } catch (e) {
    if (e.code === "EEXIST") {
      // Another replica already populated the owner's cabinet between our
      // exists() check and this link. Leave the legacy file alone for a
      // human to look at, and don't report a migration that didn't happen.
      return false;
    }
    throw e;
  }

  return true;
}

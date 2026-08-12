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
// checks below before either has moved anything (a classic TOCTOU race) —
// what actually decides a single winner is fs.rename, which POSIX guarantees
// is atomic. The loser's rename fails with ENOENT because by the time it
// runs, the source file is already gone. That specific failure is treated as
// "a concurrent replica already did this," not an error, so the loser backs
// off cleanly instead of crashing.
export async function migrateLegacy(dataDir, ownerEmail) {
  if (!ownerEmail) return false;

  const legacyCollection = path.join(dataDir, "collection.json");
  if (!(await exists(legacyCollection))) return false;

  const owner = userDir(dataDir, userKey(ownerEmail));
  const ownerCollection = path.join(owner, "collection.json");
  // Never clobber a live cabinet. If both exist, the current one is the truth
  // and the legacy file is left alone for a human to look at.
  if (await exists(ownerCollection)) return false;

  await fs.mkdir(owner, { recursive: true });

  try {
    await fs.rename(legacyCollection, ownerCollection);
  } catch (e) {
    if (e.code === "ENOENT" && (await exists(ownerCollection))) {
      // Another replica won the race between our exists() check and this
      // rename: it already moved the file and populated the owner's cabinet.
      return false;
    }
    throw e;
  }

  const legacyPhotos = path.join(dataDir, "photos");
  if (await exists(legacyPhotos)) {
    await fs.rename(legacyPhotos, path.join(owner, "photos"));
  }

  return true;
}

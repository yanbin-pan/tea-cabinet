import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const FILENAME = "collection.json";

export function collectionPath(dir) {
  return path.join(dir, FILENAME);
}

export async function readCollection(dir) {
  try {
    const raw = await fs.readFile(collectionPath(dir), "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.teas)) return data.teas;
    return [];
  } catch (e) {
    // A missing or corrupt file reads as an empty collection rather than
    // throwing: the caller cannot do anything useful with the distinction, and
    // an exception here would take down a read for every user.
    return [];
  }
}

export async function writeCollection(dir, teas, meta = {}) {
  await fs.mkdir(dir, { recursive: true });
  const file = collectionPath(dir);

  // Unique per write. Two replicas share this directory over NFS, so a fixed
  // temp name lets one writer's rename publish another writer's partial file.
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;

  const payload = { app: "The Tea Cabinet", version: 2, ...meta, teas };
  try {
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    // rename is atomic on the NFS server, so readers see the old file or the
    // new one, never a partial write.
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

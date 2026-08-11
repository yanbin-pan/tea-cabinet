# Multi-tenancy and Durable Photo Storage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silent data loss by moving photos out of the collection document, then give each family member a private cabinet keyed to a verified identity.

**Architecture:** Photos become individually addressed files served by their own endpoints, leaving the collection as a few KB of metadata — so no save can approach an HTTP body limit. Identity is delegated to Cloudflare Access; the API verifies the signed assertion (never the email header) and fails closed. Storage helpers take a base directory as an argument, so Phase 1 passes the data root and Phase 2 passes a per-user directory with no rewrite.

**Tech Stack:** Node 20 (ES modules), Express 4, `node:test`, `jose` for JWT verification, React 18 + Vite 5, Vitest for the new frontend tests.

**Spec:** [`docs/superpowers/specs/2026-08-11-multi-tenancy-design.md`](../specs/2026-08-11-multi-tenancy-design.md)

## Global Constraints

- Node `>=20`, ES modules (`"type": "module"`) in both packages.
- Backend tests run under `node --test` and **must not touch the network**.
- Images must build for `linux/arm64`.
- Per-photo limit **8MB**; photo route body limit **10MB**; collection route body limit **5MB**.
- Orphan sweep deletes only unreferenced photos **older than 24 hours**.
- `userKey` is `sha256(lowercased, trimmed email)` as hex. No user-supplied string ever reaches a filesystem path.
- JWT verification checks signature via `kid`, `iss`, `aud` and expiry. Missing or invalid token → `401` with no body.
- No Anthropic credential may appear in `frontend/` — CI enforces this.
- Existing `localStorage` key is `cha:collection:v2`. Do not change it.
- Every `*.sops.yaml` stays encrypted; CI enforces this.

## Phases

**Phase 1 (Tasks 1–6) fixes the data loss and is shippable on its own.** It leaves the app single-tenant.
**Phase 2 (Tasks 7–12) adds identity and private cabinets.**

---

# Phase 1 — Durable storage and honest errors

### Task 1: Extract the store, and make writes collision-proof

**Files:**
- Create: `backend/lib/store.js`
- Create: `backend/test/store.test.js`
- Modify: `backend/server.js` (remove `readCollection`/`writeCollection`, import them)
- Modify: `backend/server.test.js` (import from the new module)

**Interfaces:**
- Consumes: nothing.
- Produces: `readCollection(dir) → Promise<Array>`, `writeCollection(dir, teas, meta?) → Promise<void>`. `dir` is the directory holding `collection.json`. Later tasks pass a per-user directory here.

- [ ] **Step 1: Write the failing test**

Create `backend/test/store.test.js`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && node --test test/store.test.js`
Expected: FAIL — `Cannot find module '../lib/store.js'`

- [ ] **Step 3: Write the implementation**

Create `backend/lib/store.js`:

```js
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
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd backend && node --test test/store.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Point `server.js` at the module**

In `backend/server.js`, delete the local `readCollection` and `writeCollection` definitions and the `DATA_FILE` / `TMP_FILE` constants, then add near the other imports:

```js
import { readCollection, writeCollection } from "./lib/store.js";
```

Replace the two route bodies that used them so they pass `DATA_DIR`:

```js
app.get("/api/collection", async (req, res) => {
  try {
    res.json({ teas: await readCollection(DATA_DIR) });
  } catch (e) {
    res.status(500).json({ error: "Could not read the collection." });
  }
});

app.put("/api/collection", async (req, res) => {
  const body = req.body;
  const teas = Array.isArray(body) ? body : body && body.teas;
  if (!Array.isArray(teas)) {
    res.status(400).json({ error: "Expected { teas: [...] } or an array." });
    return;
  }
  try {
    await writeCollection(DATA_DIR, teas);
    res.json({ ok: true, count: teas.length });
  } catch (e) {
    res.status(500).json({ error: "Could not save the collection." });
  }
});
```

Update `ensureStore` to use the module:

```js
export async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}
```

In `backend/server.test.js`, change the import line to pull the store helpers from their new home:

```js
const { app, ensureStore } = await import("./server.js");
const { readCollection, writeCollection } = await import("./lib/store.js");
```

and update every call in that file to pass `DATA_DIR` as the first argument (e.g. `await writeCollection(DATA_DIR, [...])`). Delete the two tests that assert on `.tmp` handling and the `{app,version,teas}` on-disk shape — `test/store.test.js` now owns them.

- [ ] **Step 6: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: PASS, no failures.

- [ ] **Step 7: Commit**

```bash
git add backend/lib/store.js backend/test/store.test.js backend/server.js backend/server.test.js
git commit -m "Give every collection write its own temp file

Both replicas share one NFS directory, and a fixed temp name lets one
writer's rename publish another writer's partially written file. The
store also moves to its own module and takes the directory as an
argument, which is what per-user paths will pass later."
```

---

### Task 2: Photo storage module

**Files:**
- Create: `backend/lib/photos.js`
- Create: `backend/test/photos.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `savePhoto(dir, buffer) → Promise<string id>`, `readPhoto(dir, id) → Promise<Buffer|null>`, `sweepOrphans(dir, referencedIds, opts?) → Promise<number>`, `isValidPhotoId(id) → boolean`, `MAX_PHOTO_BYTES` constant. Photos live in `<dir>/photos/<id>.jpg`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/photos.test.js`:

```js
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
  await assert.rejects(() => savePhoto(await tmpDir(), Buffer.alloc(0)));
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && node --test test/photos.test.js`
Expected: FAIL — `Cannot find module '../lib/photos.js'`

- [ ] **Step 3: Write the implementation**

Create `backend/lib/photos.js`:

```js
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
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd backend && node --test test/photos.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/lib/photos.js backend/test/photos.test.js
git commit -m "Store photos as individual files rather than inline base64

Photos are what pushed the collection document past the body limit.
Addressed by a random 32-hex id, validated by pattern so traversal
cannot survive, and swept when unreferenced — but only after 24 hours,
so a photo whose tea has not been saved yet is never deleted."
```

---

### Task 3: Photo HTTP routes

**Files:**
- Modify: `backend/server.js`
- Create: `backend/test/routes-photos.test.js`

**Interfaces:**
- Consumes: `savePhoto`, `readPhoto`, `MAX_PHOTO_BYTES` from Task 2.
- Produces: `POST /api/photos` (raw `image/*` body → `{ id }`), `GET /api/photos/:id` (bytes, or `404`).

- [ ] **Step 1: Write the failing test**

Create `backend/test/routes-photos.test.js`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && node --test test/routes-photos.test.js`
Expected: FAIL — `POST /api/photos` returns 404, so the first assertion fails.

- [ ] **Step 3: Write the implementation**

In `backend/server.js`, add to the imports:

```js
import { savePhoto, readPhoto } from "./lib/photos.js";
```

The size limit is enforced inside `savePhoto`, which throws `TOO_LARGE`; the
route translates that to a `413`. Do not import `MAX_PHOTO_BYTES` here — the
route never needs the value, and an unused import is dead weight.

Change the JSON body limit from `15mb` to `5mb` — the document holds only metadata now:

```js
app.use(express.json({ limit: "5mb" }));
```

Add the photo routes above the `/api/scan` route:

```js
// Raw bytes, not base64: encoding a photo into JSON inflates it by a third,
// which is how the collection document outgrew its limit in the first place.
const photoBody = express.raw({ type: "image/*", limit: "10mb" });

app.post("/api/photos", photoBody, async (req, res) => {
  if (!Buffer.isBuffer(req.body)) {
    res.status(415).json({ error: "Send image bytes with an image/* content type." });
    return;
  }
  if (req.body.length === 0) {
    res.status(400).json({ error: "A photo must have a body." });
    return;
  }
  try {
    const id = await savePhoto(DATA_DIR, req.body);
    res.json({ id });
  } catch (e) {
    if (e.code === "TOO_LARGE") {
      res.status(413).json({ error: "That photo is too large." });
      return;
    }
    res.status(500).json({ error: "Could not store that photo." });
  }
});

app.get("/api/photos/:id", async (req, res) => {
  const bytes = await readPhoto(DATA_DIR, req.params.id);
  if (!bytes) {
    res.status(404).json({ error: "No such photo." });
    return;
  }
  res.set("Content-Type", "image/jpeg");
  // Ids are random and a photo's bytes never change, so this can be cached hard.
  res.set("Cache-Control", "private, max-age=31536000, immutable");
  res.send(bytes);
});
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd backend && node --test test/routes-photos.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the whole suite**

Run: `cd backend && npm test`
Expected: PASS. If a pre-existing test asserted the 15mb limit, update it to 5mb.

- [ ] **Step 6: Commit**

```bash
git add backend/server.js backend/test/routes-photos.test.js
git commit -m "Serve photos from their own endpoints

Bytes are posted raw rather than base64 so nothing pays the 33% encoding
tax, and the collection limit drops to 5mb now that the document carries
metadata only."
```

---

### Task 4: Sweep orphaned photos on save

**Files:**
- Modify: `backend/server.js` (the `PUT /api/collection` handler)
- Create: `backend/test/routes-sweep.test.js`

**Interfaces:**
- Consumes: `sweepOrphans` from Task 2.
- Produces: no new surface — saving a collection now also reclaims unreferenced photos.

- [ ] **Step 1: Write the failing test**

Create `backend/test/routes-sweep.test.js`:

```js
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

test("a failed sweep does not fail the save", async () => {
  const res = await fetch(`${base}/api/collection`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teas: [{ id: "t2", englishName: "No photo", photo: null }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && node --test test/routes-sweep.test.js`
Expected: FAIL — the orphan still exists, because nothing sweeps yet.

- [ ] **Step 3: Write the implementation**

In `backend/server.js`, add `sweepOrphans` to the photos import:

```js
import { savePhoto, readPhoto, sweepOrphans } from "./lib/photos.js";
```

Replace the `PUT /api/collection` handler body:

```js
app.put("/api/collection", async (req, res) => {
  const body = req.body;
  const teas = Array.isArray(body) ? body : body && body.teas;
  if (!Array.isArray(teas)) {
    res.status(400).json({ error: "Expected { teas: [...] } or an array." });
    return;
  }
  try {
    await writeCollection(DATA_DIR, teas);
  } catch (e) {
    res.status(500).json({ error: "Could not save the collection." });
    return;
  }

  // Reclaim photos nothing points at any more. Deliberately after the write and
  // deliberately not awaited into the response path: a failed sweep wastes disk,
  // but a failed save loses data, and the client must not be told the save
  // failed because cleanup did.
  try {
    const referenced = teas.map((t) => t && t.photo).filter((p) => typeof p === "string");
    await sweepOrphans(DATA_DIR, referenced);
  } catch (e) {
    // Intentionally ignored; the next save will try again.
  }

  res.json({ ok: true, count: teas.length });
});
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd backend && node --test test/routes-sweep.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/server.js backend/test/routes-sweep.test.js
git commit -m "Reclaim photos nothing refers to when a collection is saved

Sweeping runs after the write and cannot fail the save: losing a photo
costs disk, losing a save costs data."
```

---

### Task 5: A frontend API client that reports failures

**Files:**
- Create: `frontend/src/api.js`
- Create: `frontend/src/api.test.js`
- Modify: `frontend/package.json` (add `vitest`, a `test` script)
- Create: `frontend/vitest.config.js`

**Interfaces:**
- Consumes: the routes from Tasks 3 and 4.
- Produces: `ApiError` (with `.status`, `.kind`), `loadCollection(opts?) → {teas, source}`, `saveCollection(teas, opts?)`, `uploadPhoto(blob, opts?) → id`, `photoUrl(id) → string`, `isPhotoId(v) → boolean`. All accept `{ fetchImpl }` for testing.

- [ ] **Step 1: Add the test runner**

In `frontend/package.json`, add to `devDependencies`:

```json
"vitest": "^2.1.8"
```

and to `scripts`:

```json
"test": "vitest run"
```

Create `frontend/vitest.config.js`:

```js
import { defineConfig } from "vitest/config";

// `node` rather than jsdom: api.js talks to the network and to localStorage,
// both of which the tests stub. Pulling in a DOM would be weight for nothing.
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.js"] },
});
```

Run: `cd frontend && npm install`

- [ ] **Step 2: Write the failing test**

Create `frontend/src/api.test.js`:

```js
import { describe, test, expect, beforeEach } from "vitest";
import { ApiError, loadCollection, saveCollection, uploadPhoto, photoUrl, isPhotoId } from "./api.js";

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

beforeEach(() => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
});

describe("saveCollection", () => {
  // The bug: fetch does not reject on 413, so the old code treated a rejected
  // save as success and reported "Import complete" over lost data.
  test("throws on 413 instead of resolving", async () => {
    const fetchImpl = async () => response(413, {});
    await expect(saveCollection([{ id: "a" }], { fetchImpl })).rejects.toBeInstanceOf(ApiError);
  });

  test("throws on 401, 429 and 500", async () => {
    for (const status of [401, 429, 500]) {
      const fetchImpl = async () => response(status, {});
      await expect(saveCollection([], { fetchImpl })).rejects.toMatchObject({ status });
    }
  });

  test("throws when the network is unreachable", async () => {
    const fetchImpl = async () => { throw new TypeError("Failed to fetch"); };
    await expect(saveCollection([], { fetchImpl })).rejects.toMatchObject({ kind: "network" });
  });

  test("resolves and mirrors locally only when the server accepted it", async () => {
    const fetchImpl = async () => response(200, { ok: true, count: 1 });
    await saveCollection([{ id: "a" }], { fetchImpl });
    expect(localStorage.getItem("cha:collection:v2")).toContain('"a"');
  });

  test("does not mirror a rejected save", async () => {
    const fetchImpl = async () => response(413, {});
    await expect(saveCollection([{ id: "a" }], { fetchImpl })).rejects.toThrow();
    expect(localStorage.getItem("cha:collection:v2")).toBe(null);
  });
});

describe("loadCollection", () => {
  test("returns the server's teas and marks the source", async () => {
    const fetchImpl = async () => response(200, { teas: [{ id: "a" }] });
    const out = await loadCollection({ fetchImpl });
    expect(out.teas).toHaveLength(1);
    expect(out.source).toBe("server");
  });

  // An empty server and an unreachable server used to be indistinguishable.
  test("an empty server is 'server', not a fallback", async () => {
    const fetchImpl = async () => response(200, { teas: [] });
    const out = await loadCollection({ fetchImpl });
    expect(out.source).toBe("server");
    expect(out.teas).toEqual([]);
  });

  test("falls back to the local mirror when unreachable", async () => {
    localStorage.setItem("cha:collection:v2", JSON.stringify([{ id: "cached" }]));
    const fetchImpl = async () => { throw new TypeError("Failed to fetch"); };
    const out = await loadCollection({ fetchImpl });
    expect(out.source).toBe("cache");
    expect(out.teas[0].id).toBe("cached");
  });

  test("reports unavailable when unreachable with no mirror", async () => {
    const fetchImpl = async () => { throw new TypeError("Failed to fetch"); };
    const out = await loadCollection({ fetchImpl });
    expect(out.source).toBe("unavailable");
    expect(out.teas).toEqual([]);
  });

  test("throws on 401 rather than pretending the cabinet is empty", async () => {
    const fetchImpl = async () => response(401, {});
    await expect(loadCollection({ fetchImpl })).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("uploadPhoto", () => {
  test("returns the id the server assigned", async () => {
    const fetchImpl = async () => response(200, { id: "a".repeat(32) });
    expect(await uploadPhoto(new Blob(["x"]), { fetchImpl })).toBe("a".repeat(32));
  });

  test("throws a specific message when the photo is too large", async () => {
    const fetchImpl = async () => response(413, {});
    await expect(uploadPhoto(new Blob(["x"]), { fetchImpl })).rejects.toThrow(/too large/i);
  });
});

describe("helpers", () => {
  test("isPhotoId accepts ids and rejects data URLs", () => {
    expect(isPhotoId("a".repeat(32))).toBe(true);
    expect(isPhotoId("data:image/jpeg;base64,AAAA")).toBe(false);
    expect(isPhotoId(null)).toBe(false);
  });

  test("photoUrl builds the endpoint path", () => {
    expect(photoUrl("b".repeat(32))).toBe(`/api/photos/${"b".repeat(32)}`);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd frontend && npm test`
Expected: FAIL — cannot resolve `./api.js`.

- [ ] **Step 4: Write the implementation**

Create `frontend/src/api.js`:

```js
// Every conversation with the server lives here. The rule this module exists to
// enforce: a write either succeeds or throws. Nothing is swallowed, because a
// silently discarded failure is what let imports vanish on refresh.

const API_BASE = import.meta.env?.VITE_API_BASE || "";
const STORAGE_KEY = "cha:collection:v2";
const PHOTO_ID = /^[0-9a-f]{32}$/;

export class ApiError extends Error {
  constructor(message, { status = 0, kind = "http" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
  }
}

function explain(status) {
  if (status === 401) return "Your session has expired. Reload the page to sign in again.";
  if (status === 413) return "That is too large to save.";
  if (status === 429) return "Too many requests just now — wait a moment and try again.";
  if (status >= 500) return "The server could not store that. Nothing was saved.";
  return `The server refused that request (HTTP ${status}).`;
}

export function isPhotoId(value) {
  return typeof value === "string" && PHOTO_ID.test(value);
}

export function photoUrl(id) {
  return `${API_BASE}/api/photos/${id}`;
}

function mirror(teas) {
  // Written only after the server has accepted the data. Mirroring first is what
  // made the local copy disagree with the server after a rejected save.
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(teas));
  } catch (e) {
    // Quota or a disabled store: the mirror is a convenience, never the truth.
  }
}

function readMirror() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

export async function saveCollection(teas, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/api/collection`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teas }),
    });
  } catch (e) {
    throw new ApiError("Could not reach the server. Your change is not saved.", { kind: "network" });
  }
  // fetch resolves for 4xx and 5xx. Checking res.ok is the whole fix.
  if (!res.ok) {
    throw new ApiError(explain(res.status), { status: res.status, kind: res.status === 401 ? "auth" : "http" });
  }
  mirror(teas);
  return res.json().catch(() => ({}));
}

export async function loadCollection({ fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/api/collection`);
  } catch (e) {
    const cached = readMirror();
    return { teas: cached || [], source: cached ? "cache" : "unavailable" };
  }
  if (res.status === 401) {
    throw new ApiError(explain(401), { status: 401, kind: "auth" });
  }
  if (!res.ok) {
    throw new ApiError(explain(res.status), { status: res.status });
  }
  const data = await res.json();
  const teas = Array.isArray(data && data.teas) ? data.teas : [];
  mirror(teas);
  return { teas, source: "server" };
}

export async function uploadPhoto(blob, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(`${API_BASE}/api/photos`, {
      method: "POST",
      headers: { "Content-Type": blob.type || "image/jpeg" },
      body: blob,
    });
  } catch (e) {
    throw new ApiError("Could not upload that photo.", { kind: "network" });
  }
  if (!res.ok) {
    const message = res.status === 413 ? "That photo is too large." : explain(res.status);
    throw new ApiError(message, { status: res.status });
  }
  const data = await res.json();
  return data.id;
}

// Converts an inline data URL — the shape older exports use — into bytes, so an
// existing export can be imported without the caller knowing the difference.
export async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `cd frontend && npm test`
Expected: PASS, 14 tests.

- [ ] **Step 6: Confirm the production build still works**

Run: `cd frontend && npm run build`
Expected: builds with no errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api.js frontend/src/api.test.js frontend/package.json frontend/package-lock.json frontend/vitest.config.js
git commit -m "Make a failed save impossible to mistake for a success

fetch resolves for 413 and 500, and the old code only caught thrown
exceptions, so a rejected write looked identical to an accepted one.
Every call now checks res.ok and throws, and the local mirror is written
only after the server has accepted the data."
```

---

### Task 6: Wire the client to the new API

**Files:**
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Consumes: everything from Task 5.
- Produces: no new module surface. `App` gains a `saveState` of `"idle" | "saving" | "saved" | "error"`.

- [ ] **Step 1: Replace the module-level helpers**

In `frontend/src/App.jsx`, delete the `persist` and `hydrate` functions (lines 31–63) and the now-unused `STORAGE_KEY` constant, and add to the imports at the top:

```js
import { ApiError, loadCollection, saveCollection, uploadPhoto, photoUrl, isPhotoId, dataUrlToBlob } from "./api.js";
```

- [ ] **Step 2: Add save state and a single save path**

Inside `App`, after the existing `useState` calls, add:

```js
const [saveState, setSaveState] = useState("idle");
const [loadError, setLoadError] = useState(null);

// The one place a collection is written. Side effects must not live inside a
// setState updater: React double-invokes updaters under StrictMode, which was
// firing two PUTs per save.
const commit = useCallback(async (next) => {
  setSaveState("saving");
  try {
    await saveCollection(next);
    setSaveState("saved");
    return true;
  } catch (err) {
    setSaveState("error");
    showToast(err instanceof ApiError ? err.message : "Could not save your change.", "err");
    return false;
  }
}, [showToast]);
```

- [ ] **Step 3: Make the mutating callbacks pure, then commit**

Replace `save` (currently lines 97–107) with:

```js
const save = useCallback(async (draft) => {
  const isUpdate = Boolean(draft.id) && collection.some((t) => t.id === draft.id);
  const next = isUpdate
    ? collection.map((t) => (t.id === draft.id ? draft : t))
    : [{ ...draft, id: draft.id || uniqueId(), createdAt: draft.createdAt || Date.now() }, ...collection];

  setCollection(next);
  setEditing(null);
  if (await commit(next)) {
    showToast(isUpdate ? "Tea updated" : "Tea added to your collection");
  }
}, [collection, commit, showToast]);
```

Replace `remove` (currently lines 109–113) with:

```js
const remove = useCallback(async (id) => {
  const next = collection.filter((t) => t.id !== id);
  setCollection(next);
  setDetail(null);
  if (await commit(next)) showToast("Removed from collection");
}, [collection, commit, showToast]);
```

Apply the same shape to `dedupe` (line 184): compute `next` from `collection`, call `setCollection(next)`, then `await commit(next)`, and only show a success toast if `commit` returned true.

- [ ] **Step 4: Load with three distinct outcomes**

Replace the mount effect (currently lines 79–90) with:

```js
useEffect(() => {
  let alive = true;
  (async () => {
    try {
      const { teas, source } = await loadCollection();
      if (!alive) return;
      setCollection(teas.map((t) => ({ ...BLANK, ...t })));
      // "Unreachable" and "empty" are different facts and must not look alike.
      if (source === "cache") showToast("Offline — showing your last saved copy", "err");
      if (source === "unavailable") setLoadError("Could not reach the server.");
    } catch (err) {
      if (!alive) return;
      setLoadError(err instanceof ApiError ? err.message : "Could not load your collection.");
    } finally {
      if (alive) setReady(true);
    }
  })();
  return () => { alive = false; };
}, [showToast]);
```

- [ ] **Step 5: Upload the photo before saving the tea**

In the intake form's `onFile` handler (around line 314), replace `set("photo", dataUrl)` with an upload, keeping the data URL only for the scan call and the on-screen preview:

```js
const dataUrl = await normalizeImage(raw);
setPreview(dataUrl);
try {
  const blob = await dataUrlToBlob(dataUrl);
  const id = await uploadPhoto(blob);
  set("photo", id);
} catch (err) {
  setScanError(err instanceof ApiError ? err.message : "Could not upload that photo.");
  return;
}
await runScan(dataUrl);
```

Add `const [preview, setPreview] = useState(null);` alongside the form's other state.

Everywhere a photo is rendered — lines 264, 359 and 409 — resolve the source through a helper. Add near the top of the file:

```js
// A record's photo is an id after this change and a data URL in older exports,
// so both must render while any un-migrated data exists.
function srcFor(photo) {
  if (!photo) return null;
  return isPhotoId(photo) ? photoUrl(photo) : photo;
}
```

and use `srcFor(tea.photo)` / `preview || srcFor(form.photo)` in the `img` tags.

- [ ] **Step 6: Import photos one at a time**

Replace `importJson` (lines 147–182) with:

```js
const importJson = useCallback(async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;

  let incoming;
  try {
    const data = JSON.parse(await file.text());
    incoming = Array.isArray(data) ? data : data.teas;
    if (!Array.isArray(incoming)) throw new Error("bad shape");
  } catch (err) {
    showToast("Couldn't read that file — expected a Tea Cabinet export", "err");
    return;
  }

  setSaveState("saving");
  const byId = new Map(collection.map((t) => [t.id, t]));
  let added = 0, updated = 0, failedPhotos = 0;

  for (const raw of incoming) {
    if (!raw || (!raw.englishName && !raw.chineseName)) continue;
    const rec = { ...BLANK, ...raw };

    // An older export carries the photo inline. Upload it as its own small
    // request, so a large import is many small writes and never one huge one.
    if (rec.photo && !isPhotoId(rec.photo)) {
      try {
        rec.photo = await uploadPhoto(await dataUrlToBlob(rec.photo));
      } catch (err) {
        rec.photo = null;
        failedPhotos++;
      }
    }

    if (rec.id && byId.has(rec.id)) {
      rec.createdAt = rec.createdAt || byId.get(rec.id).createdAt || Date.now();
      byId.set(rec.id, rec);
      updated++;
    } else {
      if (!rec.id) rec.id = uniqueId();
      if (!rec.createdAt) rec.createdAt = Date.now();
      byId.set(rec.id, rec);
      added++;
    }
  }

  const next = Array.from(byId.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  setCollection(next);

  // Success is claimed only once the server has confirmed the write.
  if (await commit(next)) {
    const parts = [];
    if (added) parts.push(`${added} added`);
    if (updated) parts.push(`${updated} updated`);
    if (failedPhotos) parts.push(`${failedPhotos} photo${failedPhotos === 1 ? "" : "s"} skipped`);
    showToast(`Import complete — ${parts.length ? parts.join(", ") : "no teas found"}`);
  }
}, [collection, commit, showToast]);
```

- [ ] **Step 7: Show the save state**

In the header, beside the Import and Export buttons (around line 220), add:

```jsx
{saveState === "saving" && <span style={S.saveHint}><Loader2 size={13} className="spin" /> Saving…</span>}
{saveState === "saved" && <span style={S.saveHint}><Check size={13} /> Saved</span>}
{saveState === "error" && <span style={{ ...S.saveHint, color: "#B3261E" }}><AlertCircle size={13} /> Not saved</span>}
```

Add to the `S` style object:

```js
saveHint: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "#6B6152" },
```

If `loadError` is set, render it above the grid instead of the empty-cabinet message so an unreachable server never looks like an empty collection.

- [ ] **Step 8: Verify**

Run: `cd frontend && npm test && npm run build`
Expected: all tests PASS and the build succeeds.

Then run both services and confirm by hand that a save shows "Saved", and that stopping the backend and saving shows "Not saved" with an error toast:

```bash
cd backend && npm run dev
cd frontend && npm run dev
```

- [ ] **Step 9: Commit**

```bash
git add frontend/src/App.jsx
git commit -m "Route every write through one save path that reports its outcome

Saving moves out of the setState updaters, which StrictMode was
double-invoking into two PUTs per change. Photos upload individually
before the tea is saved, so an import is many small requests rather than
one that can exceed a body limit, and 'Import complete' now appears only
after the server confirms the write."
```

---

**Phase 1 is complete and shippable here.** Merging to `main` fixes the data loss. Phase 2 can follow at any time.

---

# Phase 2 — Private cabinets

### Task 7: Verify Cloudflare Access tokens

**Files:**
- Create: `backend/lib/auth.js`
- Create: `backend/test/auth.test.js`
- Modify: `backend/package.json` (add `jose`)

**Interfaces:**
- Consumes: nothing.
- Produces: `accessConfig(env) → {issuer, audience, jwksUrl}`, `createVerifier({issuer, audience, jwks}) → (token) => Promise<string email>`, `requireAccess(verify) → express middleware` setting `req.userEmail`.

- [ ] **Step 1: Add the dependency**

Run: `cd backend && npm install jose@^5.9.6`

`jose` is chosen because `createRemoteJWKSet` already does key caching, `kid` matching and rotation-on-miss, which the spec requires and which is easy to get subtly wrong by hand.

- [ ] **Step 2: Write the failing test**

Create `backend/test/auth.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from "jose";
import { accessConfig, createVerifier, requireAccess } from "../lib/auth.js";

const ISSUER = "https://example.cloudflareaccess.com";
const AUDIENCE = "test-audience-tag";

// A local key pair keeps these tests entirely offline.
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
const jwks = createLocalJWKSet({ keys: [jwk] });
const verify = createVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks });

function token(claims = {}, { issuer = ISSUER, audience = AUDIENCE, expiry = "5m" } = {}) {
  return new SignJWT({ email: "person@example.com", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiry)
    .sign(privateKey);
}

test("a correctly signed token yields the email, lowercased", async () => {
  assert.equal(await verify(await token({ email: "Person@Example.COM" })), "person@example.com");
});

test("a token from a different issuer is rejected", async () => {
  await assert.rejects(() => verify(await token({}, { issuer: "https://evil.cloudflareaccess.com" })));
});

test("a token for a different audience is rejected", async () => {
  await assert.rejects(() => verify(await token({}, { audience: "someone-elses-app" })));
});

test("an expired token is rejected", async () => {
  await assert.rejects(() => verify(await token({}, { expiry: "-1m" })));
});

test("a token signed by an unknown key is rejected", async () => {
  const other = await generateKeyPair("RS256");
  const forged = await new SignJWT({ email: "person@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime("5m")
    .sign(other.privateKey);
  await assert.rejects(() => verify(forged));
});

test("a malformed token is rejected", async () => {
  await assert.rejects(() => verify("not.a.token"));
});

test("a valid token carrying no email is rejected", async () => {
  const t = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime("5m")
    .sign(privateKey);
  await assert.rejects(() => verify(t));
});

test("accessConfig refuses to build without both variables", () => {
  assert.throws(() => accessConfig({}));
  assert.throws(() => accessConfig({ ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com" }));
  assert.throws(() => accessConfig({ ACCESS_AUD: "tag" }));

  const cfg = accessConfig({ ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com", ACCESS_AUD: "tag" });
  assert.equal(cfg.issuer, ISSUER);
  assert.equal(cfg.audience, "tag");
  assert.equal(cfg.jwksUrl, `${ISSUER}/cdn-cgi/access/certs`);
});

test("requireAccess rejects a request with no token", async () => {
  const mw = requireAccess(verify);
  let status = 0;
  await mw(
    { get: () => undefined },
    { status(c) { status = c; return this; }, end() {} },
    () => assert.fail("next must not be called")
  );
  assert.equal(status, 401);
});

// The email header is attacker-controlled inside the cluster; only the signed
// assertion may establish identity.
test("requireAccess ignores the email header entirely", async () => {
  const mw = requireAccess(verify);
  let status = 0;
  await mw(
    { get: (h) => (h.toLowerCase() === "cf-access-authenticated-user-email" ? "admin@example.com" : undefined) },
    { status(c) { status = c; return this; }, end() {} },
    () => assert.fail("next must not be called")
  );
  assert.equal(status, 401);
});

test("requireAccess attaches the verified email and continues", async () => {
  const mw = requireAccess(verify);
  const t = await token();
  const req = { get: (h) => (h.toLowerCase() === "cf-access-jwt-assertion" ? t : undefined) };
  let called = false;
  await mw(req, { status() { return this; }, end() {} }, () => { called = true; });
  assert.ok(called);
  assert.equal(req.userEmail, "person@example.com");
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd backend && node --test test/auth.test.js`
Expected: FAIL — `Cannot find module '../lib/auth.js'`

- [ ] **Step 4: Write the implementation**

Create `backend/lib/auth.js`:

```js
import { createRemoteJWKSet, jwtVerify } from "jose";

// Cloudflare Access sends two headers. Only one of them is evidence.
const TOKEN_HEADER = "Cf-Access-Jwt-Assertion";

export function accessConfig(env = process.env) {
  const team = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  if (!team || !audience) {
    throw new Error(
      "ACCESS_TEAM_DOMAIN and ACCESS_AUD must both be set. Refusing to start: " +
      "without them no request can be authenticated and every user would be denied."
    );
  }
  const issuer = `https://${team}`;
  return { issuer, audience, jwksUrl: `${issuer}/cdn-cgi/access/certs` };
}

export function remoteJwks(jwksUrl) {
  // Handles caching, kid matching and refetching on an unknown kid, which is
  // what makes Cloudflare's key rotation a non-event here.
  return createRemoteJWKSet(new URL(jwksUrl));
}

export function createVerifier({ issuer, audience, jwks }) {
  return async function verify(token) {
    // jwtVerify checks the signature against the kid-matched key, and the
    // issuer, audience and expiry claims. Skipping issuer would accept a
    // correctly signed token minted for a different Access team.
    const { payload } = await jwtVerify(token, jwks, { issuer, audience });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email) throw new Error("The token carries no email claim.");
    return email;
  };
}

export function requireAccess(verify) {
  return async function accessMiddleware(req, res, next) {
    const token = req.get(TOKEN_HEADER);
    if (!token) {
      // Fail closed. No body: an unauthenticated caller learns nothing.
      res.status(401).end();
      return;
    }
    try {
      req.userEmail = await verify(token);
      next();
    } catch (e) {
      res.status(401).end();
    }
  };
}
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `cd backend && node --test test/auth.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/lib/auth.js backend/test/auth.test.js backend/package.json backend/package-lock.json
git commit -m "Verify the Access assertion rather than trusting a header

The email header is attacker-controlled by anything that can reach the
API directly; the signed assertion is not. Issuer is validated as well as
audience and expiry, because a correctly signed token minted for another
Access team would otherwise be accepted."
```

---

### Task 8: Per-user paths

**Files:**
- Create: `backend/lib/paths.js`
- Create: `backend/test/paths.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `userKey(email) → string` (64 hex chars), `userDir(dataDir, key) → string`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/paths.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { userKey, userDir } from "../lib/paths.js";

test("userKey is a stable 64-character hex digest", () => {
  const k = userKey("person@example.com");
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(k, userKey("person@example.com"));
});

test("userKey ignores case and surrounding whitespace", () => {
  assert.equal(userKey("Person@Example.COM"), userKey("  person@example.com  "));
});

test("different addresses get different keys", () => {
  assert.notEqual(userKey("a@example.com"), userKey("b@example.com"));
});

// The point of hashing: no user-supplied character reaches a path.
test("an address containing traversal characters cannot escape the data dir", () => {
  const dir = userDir("/data", userKey("../../etc/passwd@example.com"));
  assert.ok(dir.startsWith(path.join("/data", "users") + path.sep));
  assert.ok(!dir.includes(".."));
});

test("userKey rejects anything that is not an address", () => {
  for (const bad of ["", null, undefined, 42, "no-at-sign"]) {
    assert.throws(() => userKey(bad), `must reject ${JSON.stringify(bad)}`);
  }
});

test("userDir nests under users/", () => {
  const k = userKey("person@example.com");
  assert.equal(userDir("/data", k), path.join("/data", "users", k));
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && node --test test/paths.test.js`
Expected: FAIL — `Cannot find module '../lib/paths.js'`

- [ ] **Step 3: Write the implementation**

Create `backend/lib/paths.js`:

```js
import crypto from "node:crypto";
import path from "node:path";

// The directory name is a hash of the address, never the address itself. That
// removes path traversal and character-escaping concerns by construction: no
// byte the user controls is ever part of a filesystem path.
export function userKey(email) {
  if (typeof email !== "string" || !email.includes("@")) {
    throw new Error("userKey requires an email address.");
  }
  const normalised = email.trim().toLowerCase();
  if (!normalised) throw new Error("userKey requires an email address.");
  return crypto.createHash("sha256").update(normalised).digest("hex");
}

export function userDir(dataDir, key) {
  return path.join(dataDir, "users", key);
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd backend && node --test test/paths.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/lib/paths.js backend/test/paths.test.js
git commit -m "Derive each cabinet's directory from a hash of the address

Hashing is not for secrecy here — it is so that no user-supplied byte
ever becomes part of a filesystem path."
```

---

### Task 9: Serve every route from the caller's own cabinet

**Files:**
- Modify: `backend/server.js`
- Create: `backend/test/isolation.test.js`

**Interfaces:**
- Consumes: Tasks 7 and 8.
- Produces: all `/api/*` routes except `/api/health` require a verified token and operate on `userDir(DATA_DIR, userKey(req.userEmail))`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/isolation.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKeyPair, SignJWT, exportJWK } from "jose";

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "tea-isolation-"));
process.env.DATA_DIR = DATA_DIR;
process.env.ACCESS_TEAM_DOMAIN = "example.cloudflareaccess.com";
process.env.ACCESS_AUD = "test-audience-tag";

const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };

// The server exposes a seam so tests can supply a local key set instead of
// fetching Cloudflare's. Nothing else about the verification path changes.
process.env.ACCESS_TEST_JWKS = JSON.stringify({ keys: [jwk] });

const { app } = await import("../server.js");

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

async function tokenFor(email) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://example.cloudflareaccess.com")
    .setAudience("test-audience-tag")
    .setIssuedAt().setExpirationTime("5m")
    .sign(privateKey);
}

async function as(email, url, init = {}) {
  const headers = { ...(init.headers || {}), "Cf-Access-Jwt-Assertion": await tokenFor(email) };
  return fetch(`${base}${url}`, { ...init, headers });
}

test("an unauthenticated request gets 401", async () => {
  assert.equal((await fetch(`${base}/api/collection`)).status, 401);
  assert.equal((await fetch(`${base}/api/photos/${"0".repeat(32)}`)).status, 401);
});

test("/api/health stays open for probes", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("two people keep separate collections", async () => {
  await as("alice@example.com", "/api/collection", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teas: [{ id: "a1", englishName: "Alice's Longjing" }] }),
  });

  const bobBefore = await (await as("bob@example.com", "/api/collection")).json();
  assert.deepEqual(bobBefore.teas, [], "Bob must not see Alice's teas");

  await as("bob@example.com", "/api/collection", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teas: [{ id: "b1", englishName: "Bob's Puerh" }] }),
  });

  const alice = await (await as("alice@example.com", "/api/collection")).json();
  assert.equal(alice.teas.length, 1);
  assert.equal(alice.teas[0].englishName, "Alice's Longjing", "Bob's write must not touch Alice's cabinet");
});

test("one person cannot read another's photo even knowing its id", async () => {
  const post = await as("alice@example.com", "/api/photos", {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: Buffer.from("alice-private-photo"),
  });
  const { id } = await post.json();

  assert.equal((await as("alice@example.com", `/api/photos/${id}`)).status, 200);
  assert.equal(
    (await as("bob@example.com", `/api/photos/${id}`)).status, 404,
    "a photo id from another cabinet must not resolve"
  );
});

test("each cabinet is a directory of its own", async () => {
  const users = await fs.readdir(path.join(DATA_DIR, "users"));
  assert.equal(users.length, 2);
  for (const dir of users) assert.match(dir, /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && node --test test/isolation.test.js`
Expected: FAIL — the unauthenticated request returns 200 rather than 401.

- [ ] **Step 3: Write the implementation**

In `backend/server.js`, add the imports:

```js
import { createLocalJWKSet } from "jose";
import { accessConfig, createVerifier, remoteJwks, requireAccess } from "./lib/auth.js";
import { userKey, userDir } from "./lib/paths.js";
```

Build the verifier once, near the other module-level constants:

```js
const access = accessConfig();
// ACCESS_TEST_JWKS lets the test suite supply a local key set. It is the only
// concession to testability here, and it changes nothing about how a token is
// checked — signature, issuer, audience and expiry are validated identically.
const jwks = process.env.ACCESS_TEST_JWKS
  ? createLocalJWKSet(JSON.parse(process.env.ACCESS_TEST_JWKS))
  : remoteJwks(access.jwksUrl);

const verify = createVerifier({ issuer: access.issuer, audience: access.audience, jwks });
```

Add a helper and mount the middleware. `/api/health` is registered **before** it, so the kubelet probe needs no token:

```js
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Everything past this line requires a verified identity.
app.use("/api", requireAccess(verify));

function cabinetOf(req) {
  return userDir(DATA_DIR, userKey(req.userEmail));
}
```

Replace `DATA_DIR` with `cabinetOf(req)` in all four data routes — `GET /api/collection`, `PUT /api/collection`, `POST /api/photos` and `GET /api/photos/:id`. For example:

```js
app.get("/api/collection", async (req, res) => {
  try {
    res.json({ teas: await readCollection(cabinetOf(req)) });
  } catch (e) {
    res.status(500).json({ error: "Could not read the collection." });
  }
});
```

In `PUT /api/collection`, record the address so a file is legible on disk, and sweep within the caller's own directory:

```js
const dir = cabinetOf(req);
await writeCollection(dir, teas, { email: req.userEmail });
// ...
await sweepOrphans(dir, referenced);
```

Because `GET /api/photos/:id` resolves under `cabinetOf(req)`, an id from another cabinet simply does not exist there and falls through to the existing 404 — no extra ownership check is needed.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd backend && node --test test/isolation.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Fix the older suites**

`server.test.js`, `routes-photos.test.js` and `routes-sweep.test.js` now hit `401`. Give each the same JWKS seam and an `as(email, ...)` helper as above, and route their requests through it.

Run: `cd backend && npm test`
Expected: PASS across every file.

- [ ] **Step 6: Commit**

```bash
git add backend/server.js backend/test/isolation.test.js backend/server.test.js backend/test/routes-photos.test.js backend/test/routes-sweep.test.js
git commit -m "Give every person their own cabinet

All data routes now resolve under a directory derived from the verified
identity, so isolation is a property of the path rather than a check
someone can forget to write. Health stays open for the kubelet probe."
```

---

### Task 10: Migrate the existing single-tenant cabinet

**Files:**
- Create: `backend/lib/migrate.js`
- Create: `backend/test/migrate.test.js`
- Modify: `backend/server.js` (call it from `ensureStore`)

**Interfaces:**
- Consumes: Task 8.
- Produces: `migrateLegacy(dataDir, ownerEmail) → Promise<boolean>` — moves a pre-Phase-2 `collection.json` and `photos/` into the owner's cabinet, once.

- [ ] **Step 1: Write the failing test**

Create `backend/test/migrate.test.js`:

```js
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd backend && node --test test/migrate.test.js`
Expected: FAIL — `Cannot find module '../lib/migrate.js'`

- [ ] **Step 3: Write the implementation**

Create `backend/lib/migrate.js`:

```js
import fs from "node:fs/promises";
import path from "node:path";
import { userKey, userDir } from "./paths.js";

async function exists(p) {
  try { await fs.stat(p); return true; } catch (e) { return false; }
}

// One-time move of the pre-multi-tenancy layout into the owner's cabinet.
// Returns true only when it actually moved something, so a restart is a no-op.
export async function migrateLegacy(dataDir, ownerEmail) {
  if (!ownerEmail) return false;

  const legacyCollection = path.join(dataDir, "collection.json");
  if (!(await exists(legacyCollection))) return false;

  const owner = userDir(dataDir, userKey(ownerEmail));
  // Never clobber a live cabinet. If both exist, the current one is the truth
  // and the legacy file is left alone for a human to look at.
  if (await exists(path.join(owner, "collection.json"))) return false;

  await fs.mkdir(owner, { recursive: true });
  await fs.rename(legacyCollection, path.join(owner, "collection.json"));

  const legacyPhotos = path.join(dataDir, "photos");
  if (await exists(legacyPhotos)) {
    await fs.rename(legacyPhotos, path.join(owner, "photos"));
  }

  return true;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd backend && node --test test/migrate.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Call it at startup**

In `backend/server.js`, import it and extend `ensureStore`:

```js
import { migrateLegacy } from "./lib/migrate.js";

export async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const moved = await migrateLegacy(DATA_DIR, process.env.OWNER_EMAIL || "");
  if (moved) console.log("Migrated the legacy collection into the owner's cabinet.");
}
```

- [ ] **Step 6: Verify the whole suite**

Run: `cd backend && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/lib/migrate.js backend/test/migrate.test.js backend/server.js
git commit -m "Move any pre-existing collection into the owner's cabinet

Runs once at startup and refuses to overwrite a cabinet that already has
data, so an unexpected restart cannot replace live data with stale."
```

---

### Task 11: Show who is signed in, and handle expiry

**Files:**
- Modify: `frontend/src/api.js`
- Modify: `frontend/src/api.test.js`
- Modify: `frontend/src/App.jsx`

**Interfaces:**
- Consumes: Task 9.
- Produces: `loadCollection` additionally returns `email`; `App` renders it and shows a reload prompt on `401`.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/api.test.js`, inside the `loadCollection` describe block:

```js
test("returns the signed-in address when the server supplies one", async () => {
  const fetchImpl = async () => response(200, { teas: [], email: "person@example.com" });
  const out = await loadCollection({ fetchImpl });
  expect(out.email).toBe("person@example.com");
});

test("email is null when the server does not supply one", async () => {
  const fetchImpl = async () => response(200, { teas: [] });
  expect((await loadCollection({ fetchImpl })).email).toBe(null);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd frontend && npm test`
Expected: FAIL — `out.email` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `frontend/src/api.js`, change the tail of `loadCollection`:

```js
const data = await res.json();
const teas = Array.isArray(data && data.teas) ? data.teas : [];
mirror(teas);
return { teas, source: "server", email: typeof data.email === "string" ? data.email : null };
```

and return `email: null` from the two unreachable branches:

```js
const cached = readMirror();
return { teas: cached || [], source: cached ? "cache" : "unavailable", email: null };
```

In `backend/server.js`, include the address in the collection response so the UI can show it:

```js
res.json({ teas: await readCollection(cabinetOf(req)), email: req.userEmail });
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd frontend && npm test`
Expected: PASS.

- [ ] **Step 5: Surface it in the UI**

In `App.jsx`, add `const [email, setEmail] = useState(null);` and set it in the mount effect from the `loadCollection` result. Render it in the header:

```jsx
{email && <span style={S.whoami}>{email}</span>}
```

with:

```js
whoami: { fontSize: 12, color: "#6B6152", marginLeft: "auto" },
```

An Access session outlives most visits but not all, so make expiry recoverable rather than mysterious — in `commit`, special-case it:

```js
} catch (err) {
  setSaveState("error");
  const authExpired = err instanceof ApiError && err.kind === "auth";
  showToast(
    authExpired ? "Your session expired — reload the page to sign in again." : (err.message || "Could not save your change."),
    "err"
  );
  return false;
}
```

- [ ] **Step 6: Verify**

Run: `cd frontend && npm test && npm run build`
Expected: PASS and a successful build.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api.js frontend/src/api.test.js frontend/src/App.jsx backend/server.js
git commit -m "Show whose cabinet is open, and make an expired session recoverable

A shared family link makes 'which account am I in' a real question, and
an expired Access session otherwise presents as an unexplained failure
to save."
```

---

### Task 12: Deploy it

**Files:**
- Modify: `k8s/30-backend.yaml` (env vars)
- Modify: `k8s/10-pvc.yaml` (5Gi)
- Modify: `k8s/50-ingress.yaml` (drop the basic-auth middleware)
- Modify: `k8s/60-basic-auth.yaml` (remove the basicAuth Middleware)
- Modify: `k8s/kustomization.yaml` (drop the secret)
- Delete: `k8s/70-basic-auth-secret.sops.yaml`
- Modify: `.github/workflows/verify.yaml` (update the middleware assertion)
- **Private infrastructure repo:** `terraform/cloudflare/access.tf`, `docs/apps/tea-cabinet.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the running deployment.

- [ ] **Step 1: Add the Access application (private repo)**

In `terraform/cloudflare/access.tf`, add an application and policy for the app's hostname listing the family addresses, following the existing `admin` application as the pattern. Then:

```bash
cd terraform/cloudflare && terraform apply
```

Record the application's **audience tag** from the output — Task 12 Step 2 needs it. It is an identifier, not a secret.

- [ ] **Step 2: Configure the backend**

In `k8s/30-backend.yaml`, add to the container `env`:

```yaml
            - name: ACCESS_TEAM_DOMAIN
              value: <your-team>.cloudflareaccess.com
            - name: ACCESS_AUD
              value: <the audience tag from step 1>
            - name: OWNER_EMAIL
              value: <the address whose cabinet inherits any existing data>
```

- [ ] **Step 3: Raise the volume request**

In `k8s/10-pvc.yaml`, change `storage: 1Gi` to `storage: 5Gi`, and note in the comment that this documents intent rather than enforcing a quota — the NFS provisioner applies none.

- [ ] **Step 4: Remove basic auth**

Delete `k8s/70-basic-auth-secret.sops.yaml`, remove the `tea-basic-auth` Middleware from `k8s/60-basic-auth.yaml` (keep `tea-rate-limit`), remove that file from `resources:` in `k8s/kustomization.yaml`, and reduce the ingress annotation to the rate limiter alone:

```yaml
    traefik.ingress.kubernetes.io/router.middlewares: tea-cabinet-tea-rate-limit@kubernetescrd
```

- [ ] **Step 5: Update the CI assertion**

In `.github/workflows/verify.yaml`, replace the middleware-chain assertion with:

```bash
          grep -q 'router.middlewares: tea-cabinet-tea-rate-limit@kubernetescrd' /tmp/rendered.yaml \
            || fail "The rate-limit middleware is missing from the ingress."

          # Identity now comes from the verified Access assertion, so the API
          # must be configured for it or every request would be denied.
          grep -q 'ACCESS_TEAM_DOMAIN' /tmp/rendered.yaml \
            || fail "ACCESS_TEAM_DOMAIN is not set on the backend."
          grep -q 'ACCESS_AUD' /tmp/rendered.yaml \
            || fail "ACCESS_AUD is not set on the backend."
```

- [ ] **Step 6: Verify the render before pushing**

```bash
kubectl kustomize k8s > /tmp/rendered.yaml
grep -c 'tea-basic-auth' /tmp/rendered.yaml   # expect 0
grep 'ACCESS_' /tmp/rendered.yaml
```

- [ ] **Step 7: Commit and deploy**

```bash
git add k8s .github/workflows/verify.yaml
git commit -m "Move access control from a shared password to per-person identity

Basic auth was one credential for one person; a family needs one
identity each. The API verifies the Access assertion itself and fails
closed, so this is stricter than what it replaces despite the ingress
carrying one middleware fewer."
git push
```

- [ ] **Step 8: Verify in production**

```bash
flux reconcile kustomization tea-cabinet --with-source
kubectl -n tea-cabinet rollout status deploy/backend deploy/frontend

# No Access session: Cloudflare intercepts before the app is reached.
curl -sS -o /dev/null -w '%{http_code}\n' https://<host>/api/collection    # expect 302

# Inside the cluster, past Cloudflare, the API still refuses an unsigned request.
kubectl -n tea-cabinet run probe --rm -i --restart=Never --image=curlimages/curl -- \
  curl -sS -o /dev/null -w '%{http_code}\n' http://backend:8080/api/collection   # expect 401
```

That second check is the one that matters: it proves the API is not merely hiding behind the proxy.

- [ ] **Step 9: Update the private runbook**

Revise `docs/apps/tea-cabinet.md` in the infrastructure repo: replace the basic-auth and password-rotation sections with how to add or remove a family member (edit `access.tf`, `terraform apply`), and note that `ACCESS_AUD` changes if the Access application is recreated.

---

## Self-Review

**Spec coverage.** Identity → Tasks 7, 9. Storage layout → Tasks 1, 2, 8. Photo endpoints → Task 3. Orphan cleanup with the 24h guard → Tasks 2, 4. Atomic writes → Task 1. Client error surfacing → Tasks 5, 6. `hydrate` failure modes → Tasks 5, 6. Import via individual photo uploads → Task 6. Migration → Task 10. Testing → every task. Deployment → Task 12. Fail-closed behaviour → Tasks 7, 9, and verified in 12 Step 8.

**Known gaps, deliberate.** No per-user scan cap — the spec records this as an accepted risk. The rate limiter is unchanged. `MAX_PHOTO_BYTES` is exported by `lib/photos.js` for its own tests; `server.js` does not import it, because the route translates the module's `TOO_LARGE` error into a `413` and never needs the number.

**Deliberate empty catch blocks.** Three exist, each with a comment giving the reason: a corrupt collection reads as empty rather than throwing for every user; a failed orphan sweep must not fail the save that preceded it; a `localStorage` quota error must not break a save the server already accepted. These are decisions, not oversights — but a reviewer is right to challenge any of them, and the challenge should be adjudicated rather than pre-empted.

**Type consistency.** `readCollection(dir)` / `writeCollection(dir, teas, meta)` take the directory first throughout. `savePhoto(dir, buffer)`, `readPhoto(dir, id)`, `sweepOrphans(dir, ids, opts)` likewise. `userKey(email)` → hex string feeds `userDir(dataDir, key)`. `loadCollection` returns `{teas, source, email}` in every branch after Task 11. `ApiError.kind` is one of `"network" | "http" | "auth"`.

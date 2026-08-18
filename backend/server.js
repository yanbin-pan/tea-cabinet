import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { createLocalJWKSet } from "jose";
import { readCollection, writeCollection } from "./lib/store.js";
import { savePhoto, readPhoto, sweepOrphans } from "./lib/photos.js";
import { accessConfig, createVerifier, remoteJwks, requireAccess, testJwksOverride } from "./lib/auth.js";
import { userKey, userDir } from "./lib/paths.js";
import { createScanLimiter } from "./lib/scanlimit.js";
import { SCAN_SYSTEM, DEFAULT_MAX_IMAGE_BYTES, validateScanRequest, callerKey } from "./lib/scan.js";

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || "./data";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SCAN_DAILY_PER_CALLER = positiveInt(process.env.SCAN_DAILY_PER_CALLER, 25);
const SCAN_DAILY_TOTAL = positiveInt(process.env.SCAN_DAILY_TOTAL, 250);
const SCAN_MAX_IMAGE_BYTES = positiveInt(process.env.SCAN_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES);

// PUBLIC_MODE turns this into a label reader with no cabinet: /api/scan is served to
// anonymous callers, and the routes that touch stored data are NOT MOUNTED AT ALL.
//
// Not mounted, rather than mounted-and-gated, on purpose. A public instance holds no
// collections and no photos, so the safe failure when this flag is set by mistake is a
// 404 on every data route — loud, and incapable of serving one person's cabinet to
// another. Leaving those routes registered behind a disabled gate would make the same
// mistake a data leak instead of an outage.
//
// It must be set deliberately. An unset or unrecognised value leaves the private
// behaviour intact, where accessConfig() still refuses to start without Access
// configured — the fail-closed property that flag does not weaken.
const PUBLIC_MODE = /^(1|true|yes)$/i.test((process.env.PUBLIC_MODE || "").trim());

let verify = null;
if (!PUBLIC_MODE) {
  const access = accessConfig();
  // ACCESS_TEST_JWKS lets the test suite supply a local key set. It is the only
  // concession to testability here, and it changes nothing about how a token is
  // checked — signature, issuer, audience and expiry are validated identically.
  // testJwksOverride (lib/auth.js) is what makes this impossible in production:
  // it refuses to hand the override back once NODE_ENV is "production", no
  // matter what ACCESS_TEST_JWKS contains.
  const testJwks = testJwksOverride();
  const jwks = testJwks ? createLocalJWKSet(JSON.parse(testJwks)) : remoteJwks(access.jwksUrl);
  verify = createVerifier({ issuer: access.issuer, audience: access.audience, jwks });
}

const scanLimiter = createScanLimiter({
  perCaller: SCAN_DAILY_PER_CALLER,
  perDay: SCAN_DAILY_TOTAL,
});

export const app = express();
// Photos are stored separately now, so the collection document holds metadata only.
app.use(express.json({ limit: "5mb" }));
// No cors() here: the SPA is served same-origin (VITE_API_BASE is unset, so
// the frontend only ever calls relative /api/... paths), so there is no
// cross-origin caller to allow in the first place. Adding it back would only
// widen who can call these authenticated routes from a browser.

// Deliberately does not migrate anything. Moving the pre-multi-tenancy layout
// into a per-user cabinet is a one-off operator step performed with the
// deployment scaled to zero, not something a starting replica does.
//
// It was written as an automatic startup migration first. With two replicas
// sharing one NFS directory, and one of them possibly serving writes while the
// other migrates, every version of it failed review: fixing the rename race
// exposed a destination-overwrite window, and fixing that left photos stranded
// in a live cabinet where the orphan sweep would later delete them. That is a
// lot of unverifiable concurrency risk for an operation performed exactly once.
export async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

function cabinetOf(req) {
  return userDir(DATA_DIR, userKey(req.userEmail));
}

async function getCollection(req, res) {
  try {
    res.json({ teas: await readCollection(cabinetOf(req)), email: req.userEmail });
  } catch (e) {
    console.error(`GET /api/collection failed for ${req.userEmail}:`, e);
    res.status(500).json({ error: "Could not read the collection." });
  }
}

async function putCollection(req, res) {
  const body = req.body;
  const teas = Array.isArray(body) ? body : body && body.teas;
  if (!Array.isArray(teas)) {
    res.status(400).json({ error: "Expected { teas: [...] } or an array." });
    return;
  }
  let dir;
  try {
    dir = cabinetOf(req);
    await writeCollection(dir, teas, { email: req.userEmail });
  } catch (e) {
    console.error(`PUT /api/collection failed for ${req.userEmail}:`, e);
    res.status(500).json({ error: "Could not save the collection." });
    return;
  }

  // Reclaim photos nothing points at any more. Deliberately after the write and
  // deliberately not awaited into the response path: a failed sweep wastes disk,
  // but a failed save loses data, and the client must not be told the save
  // failed because cleanup did.
  //
  // Investigated whether this catch is actually reachable: sweepOrphans
  // (lib/photos.js) swallows its own fs.readdir failure (missing dir, or a
  // non-directory occupying the photos path) and returns 0, and it swallows
  // per-file fs.stat/fs.rm failures inside its loop too. `referenced` here is
  // always a real array from map/filter, so the one remaining synchronous
  // throw point (`new Set(referencedIds)` on a non-iterable) can't fire from
  // this call site either. So this catch is defense-in-depth, not the primary
  // guarantee — as far as this route ever calls it, sweepOrphans cannot
  // throw. See backend/test/photos.test.js for the tests that pin that down.
  try {
    const referenced = teas.map((t) => t && t.photo).filter((p) => typeof p === "string");
    await sweepOrphans(dir, referenced);
  } catch (e) {
    // Intentionally ignored; the next save will try again. Logged so a swept-
    // photo failure leaves a trace instead of vanishing entirely.
    console.error(`sweepOrphans failed for ${req.userEmail}:`, e);
  }

  res.json({ ok: true, count: teas.length });
}

// Raw bytes, not base64: encoding a photo into JSON inflates it by a third,
// which is how the collection document outgrew its limit in the first place.
const photoBody = express.raw({ type: "image/*", limit: "10mb" });

async function postPhoto(req, res) {
  if (!Buffer.isBuffer(req.body)) {
    res.status(415).json({ error: "Send image bytes with an image/* content type." });
    return;
  }
  if (req.body.length === 0) {
    res.status(400).json({ error: "A photo must have a body." });
    return;
  }
  try {
    const id = await savePhoto(cabinetOf(req), req.body);
    res.json({ id });
  } catch (e) {
    if (e.code === "TOO_LARGE") {
      res.status(413).json({ error: "That photo is too large." });
      return;
    }
    console.error(`POST /api/photos failed for ${req.userEmail}:`, e);
    res.status(500).json({ error: "Could not store that photo." });
  }
}

async function getPhoto(req, res) {
  try {
    const bytes = await readPhoto(cabinetOf(req), req.params.id);
    if (!bytes) {
      res.status(404).json({ error: "No such photo." });
      return;
    }
    res.set("Content-Type", "image/jpeg");
    // Ids are random and a photo's bytes never change, so this can be cached hard.
    res.set("Cache-Control", "private, max-age=31536000, immutable");
    res.send(bytes);
  } catch (e) {
    console.error(`GET /api/photos/${req.params.id} failed for ${req.userEmail}:`, e);
    res.status(500).json({ error: "Could not read that photo." });
  }
}

// An upstream failure is never forwarded verbatim. Two reasons, and the first is a
// bug this replaced: the old code answered with `upstream.status`, so a rejected
// API key came back as a 401 and the frontend — which reads 401 as "your Access
// session expired" — told the user to sign in again over a server misconfiguration
// they could do nothing about. The second is that the upstream body was returned as
// `detail`, handing every caller the provider's error text.
//
// The mapping also decides whether the client retries. The frontend retries 429 and
// 5xx and gives up on everything else, so anything deterministic must land outside
// that range or it burns three quota units learning the same answer three times.
function upstreamFailure(status) {
  // A credential the provider refused is a configuration fault, and 503 is what the
  // client already understands as "scanning isn't available — type it in by hand".
  if (status === 401 || status === 403) return { status: 503, error: "Label scanning isn't configured on the server." };
  // The provider's own rate limit. Genuinely worth retrying.
  if (status === 429) return { status: 429, error: "The label reader is busy. Try again shortly." };
  if (status >= 500) return { status: 502, error: "The label reader is unavailable right now." };
  // A 4xx we caused — a malformed request, or an image the provider would not accept.
  // Deterministic, so it must not look retryable.
  return { status: 422, error: "That image could not be read. Try a clearer photo." };
}

async function postScan(req, res) {
  if (!ANTHROPIC_API_KEY) {
    res.status(503).json({ error: "Label scanning isn't configured on the server." });
    return;
  }

  const check = validateScanRequest(req.body, { maxImageBytes: SCAN_MAX_IMAGE_BYTES });
  if (!check.ok) {
    res.status(check.status).json({ error: check.error });
    return;
  }
  const { mediaType, b64 } = check;

  // Reserved before the upstream call, not after. Counting on the way out would let
  // every request that arrives while the first is in flight read the same count and
  // pass, which is exactly the shape of traffic a limiter is for.
  const key = callerKey(req);
  const lease = scanLimiter.take(key);
  if (!lease.ok) {
    res.set("Retry-After", String(lease.retryAfterSeconds));
    res.status(429).json({
      error:
        lease.scope === "global"
          ? "This instance has used its label-reading budget for today. It resets at midnight UTC."
          : "You have used your label reads for today. They reset at midnight UTC.",
      scope: lease.scope,
    });
    return;
  }

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1000,
        // Fixed, and from this server. See lib/scan.js for why the client is no
        // longer allowed to supply it.
        system: SCAN_SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
              { type: "text", text: "Read this tea packet and return the JSON described." },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    // Nothing was answered, so nothing was billed: give the reservation back.
    scanLimiter.refund(key);
    res.status(502).json({ error: "Could not reach the label reader." });
    return;
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    scanLimiter.refund(key);
    // Logged rather than returned. An operator needs the provider's reason; a caller
    // has no use for it and should not be handed it.
    console.error(`POST /api/scan upstream ${upstream.status}:`, detail.slice(0, 500));
    const mapped = upstreamFailure(upstream.status);
    res.status(mapped.status).json({ error: mapped.error });
    return;
  }

  try {
    const data = await upstream.json();
    const text = (data && Array.isArray(data.content) ? data.content : [])
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    res.json({ text });
  } catch (e) {
    // Deliberately NOT refunded. The provider answered, so the call was billed —
    // failing to parse what came back is our problem, not a free retry.
    console.error("POST /api/scan could not parse a successful upstream response:", e);
    res.status(502).json({ error: "Could not reach the label reader." });
  }
}

if (PUBLIC_MODE) {
  // Anonymous, and quota'd by address rather than identity — see callerKey in lib/scan.js.
  app.post("/api/scan", postScan);
  // Everything else under /api is gone rather than guarded. Registered last so the
  // scan route above still matches first.
  app.use("/api", (req, res) => {
    res.status(404).json({ error: "This instance stores nothing — only label scanning is available." });
  });
} else {
  // Everything past this line requires a verified identity.
  app.use("/api", requireAccess(verify));

  app.get("/api/collection", getCollection);
  app.put("/api/collection", putCollection);
  app.post("/api/photos", photoBody, postPhoto);
  app.get("/api/photos/:id", getPhoto);
  app.post("/api/scan", postScan);
}

// Only bind the port when run directly, so the tests can import `app`.
const isDirectRun = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isDirectRun) {
  await ensureStore();
  app.listen(PORT, () => {
    console.log(`Tea Cabinet API listening on :${PORT} (data: ${DATA_DIR})`);
    if (PUBLIC_MODE) {
      console.log("PUBLIC_MODE: anonymous /api/scan only — collection and photo routes are not mounted.");
    }
    console.log(`Scan quota: ${SCAN_DAILY_PER_CALLER}/caller/day, ${SCAN_DAILY_TOTAL}/day total (per replica).`);
  });
}

export default app;

// Every conversation with the server lives here. The rule this module exists to
// enforce: a write either succeeds or throws. Nothing is swallowed, because a
// silently discarded failure is what let imports vanish on refresh.

const API_BASE = import.meta.env?.VITE_API_BASE || "";
const STORAGE_KEY = "cha:collection:v2";
const PHOTO_ID = /^[0-9a-f]{32}$/;

// Local-only builds have no cabinet on the server: the collection and its photos live
// in this browser and nowhere else. Set VITE_LOCAL_ONLY=1 at build time to produce one.
//
// This is what a public instance is for — someone can try the app without an account,
// and the operator stores none of their data. The one route such a build still calls
// is /api/scan, which needs a server because it holds the API key.
//
// A build-time flag rather than a runtime probe, matching how VITE_API_BASE already
// works here. It also means the mode cannot change under a running page: which store
// is the truth is decided once, at build, instead of being inferred from whether a
// request happened to fail.
export const LOCAL_ONLY = /^(1|true|yes)$/i.test(String(import.meta.env?.VITE_LOCAL_ONLY || "").trim());

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

// A 2xx response with a body that fails to parse as JSON is still a failure —
// it should surface as an ApiError like every other failure mode, not as a
// raw SyntaxError that callers branching on err.kind/err.status don't expect.
async function parseJson(res) {
  try {
    return await res.json();
  } catch (e) {
    throw new ApiError("The server sent back something unreadable.", { status: res.status, kind: "parse" });
  }
}

export function isPhotoId(value) {
  return typeof value === "string" && PHOTO_ID.test(value);
}

export function photoUrl(id) {
  return `${API_BASE}/api/photos/${id}`;
}

// The single write to browser storage, and it throws. Both callers below need the
// same bytes written; they differ only in whether a failure matters, so the decision
// to swallow belongs at the call site rather than in here.
function writeLocal(teas) {
  const store = globalThis.localStorage;
  if (!store) {
    throw new ApiError("This browser has no storage available, so nothing can be saved here.", { kind: "storage" });
  }
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(teas));
  } catch (e) {
    // Overwhelmingly a quota error, and in a local-only build that is data loss the
    // user must hear about. Photos are what fill the quota, so say so.
    throw new ApiError(
      "This browser is out of storage space. Export your collection now, then remove a few photos.",
      { kind: "quota" }
    );
  }
}

function mirror(teas) {
  // Written only after the server has accepted the data. Mirroring first is what
  // made the local copy disagree with the server after a rejected save.
  try {
    writeLocal(teas);
  } catch (e) {
    // Quota or a disabled store: the mirror is a convenience, never the truth.
    // In a local-only build it IS the truth, which is why saveCollection calls
    // writeLocal directly and lets this same failure through.
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
  if (LOCAL_ONLY) {
    // Throws on failure, exactly as the network path does. The rule this module
    // exists to enforce does not get an exemption for being local: a save that did
    // not happen must not return as though it did.
    writeLocal(teas);
    return { ok: true, count: teas.length };
  }

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
  if (LOCAL_ONLY) {
    // "local" is its own source, distinct from "cache". Both read the same key, but
    // "cache" means the server exists and could not be reached — a degraded state the
    // UI warns about — while "local" is simply where the data lives.
    return { teas: readMirror() || [], source: "local", email: null };
  }

  let res;
  try {
    res = await fetchImpl(`${API_BASE}/api/collection`);
  } catch (e) {
    const cached = readMirror();
    return { teas: cached || [], source: cached ? "cache" : "unavailable", email: null };
  }
  if (res.status === 401) {
    throw new ApiError(explain(401), { status: 401, kind: "auth" });
  }
  if (!res.ok) {
    throw new ApiError(explain(res.status), { status: res.status });
  }
  const data = await parseJson(res);
  const teas = Array.isArray(data && data.teas) ? data.teas : [];
  // An empty server response is authoritative for what to show, but it must
  // not be allowed to clobber a non-empty local mirror: a migration that
  // hasn't run yet, ran against the wrong directory, or an old pod still
  // serving mid-rollout can all legitimately return {teas: []} while the
  // user's real data is untouched on the server. Only overwrite the mirror
  // when the server actually gave us something, or when there is nothing
  // worth protecting.
  if (teas.length > 0) {
    mirror(teas);
  } else {
    const existing = readMirror();
    if (!existing || existing.length === 0) {
      mirror(teas);
    }
  }
  return { teas, source: "server", email: typeof data.email === "string" ? data.email : null };
}

export async function uploadPhoto(blob, { fetchImpl = fetch } = {}) {
  if (LOCAL_ONLY) {
    // There is no photo store to upload to. Callers keep the image inline on the
    // record instead; this guard exists so a missed branch fails loudly here rather
    // than posting to a route that answers 404 with an unrelated explanation.
    throw new ApiError("This build stores photos in the browser, not on a server.", { kind: "local" });
  }

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
  const data = await parseJson(res);
  return data.id;
}

// Converts an inline data URL — the shape older exports use — into bytes, so an
// existing export can be imported without the caller knowing the difference.
export async function dataUrlToBlob(dataUrl, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(dataUrl);
  return res.blob();
}

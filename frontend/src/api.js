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

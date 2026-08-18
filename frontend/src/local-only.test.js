import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// LOCAL_ONLY is read once, at module load, from a build-time variable. Getting a
// module that has seen a different value means resetting the registry and importing
// again — a plain `import` at the top of the file would freeze one mode for the whole
// suite, which is exactly the pair of behaviours worth testing against each other.
async function loadApi(localOnly) {
  vi.resetModules();
  vi.stubEnv("VITE_LOCAL_ONLY", localOnly ? "1" : "");
  return import("./api.js");
}

let store;
let setItem;

beforeEach(() => {
  store = new Map();
  setItem = (k, v) => store.set(k, String(v));
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => setItem(k, v),
    removeItem: (k) => store.delete(k),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// Nothing in a local-only build may reach the network for collection data. A fetch
// that is called at all is the failure, whatever it returns.
function forbiddenFetch() {
  return async () => {
    throw new Error("a local-only build must not call the server for collection data");
  };
}

describe("local-only builds", () => {
  test("the flag is on", async () => {
    const { LOCAL_ONLY } = await loadApi(true);
    expect(LOCAL_ONLY).toBe(true);
  });

  test("a collection round-trips through browser storage with no server", async () => {
    const { saveCollection, loadCollection } = await loadApi(true);
    const teas = [{ id: "t-1", englishName: "Long Jing" }];

    await saveCollection(teas, { fetchImpl: forbiddenFetch() });
    const loaded = await loadCollection({ fetchImpl: forbiddenFetch() });

    expect(loaded.teas).toEqual(teas);
    expect(loaded.email).toBeNull();
  });

  // "local" and "cache" both read the same key, but they mean different things: one is
  // where the data lives, the other is a server the app could not reach. The UI warns
  // about the second and must not warn about the first.
  test("the source is reported as local, not as a stale cache", async () => {
    const { loadCollection } = await loadApi(true);
    const loaded = await loadCollection({ fetchImpl: forbiddenFetch() });
    expect(loaded.source).toBe("local");
    expect(loaded.teas).toEqual([]);
  });

  // The rule the api module exists to enforce, applied to the local store: a save that
  // did not happen must not return as though it did. In a server build a failed mirror
  // write is a lost convenience; here it is lost data.
  test("a save that storage rejects throws instead of reporting success", async () => {
    const { saveCollection, ApiError } = await loadApi(true);
    setItem = () => {
      const e = new Error("QuotaExceededError");
      e.name = "QuotaExceededError";
      throw e;
    };

    const failed = saveCollection([{ id: "t-1" }], { fetchImpl: forbiddenFetch() });
    await expect(failed).rejects.toBeInstanceOf(ApiError);
    await expect(failed).rejects.toMatchObject({ kind: "quota" });
    // The user is told to export, because that is the only action that saves the data.
    await expect(failed).rejects.toThrow(/export/i);
  });

  test("a browser with no storage at all fails loudly rather than silently", async () => {
    const { saveCollection, ApiError } = await loadApi(true);
    globalThis.localStorage = undefined;

    await expect(saveCollection([{ id: "t-1" }], { fetchImpl: forbiddenFetch() })).rejects.toBeInstanceOf(ApiError);
  });

  test("there is no photo store to upload to", async () => {
    const { uploadPhoto, ApiError } = await loadApi(true);
    await expect(uploadPhoto(new Blob(["x"]), { fetchImpl: forbiddenFetch() })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("server builds are unchanged", () => {
  test("the flag is off by default", async () => {
    const { LOCAL_ONLY } = await loadApi(false);
    expect(LOCAL_ONLY).toBe(false);
  });

  test("a save still goes to the server", async () => {
    const { saveCollection } = await loadApi(false);
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, count: 1 }) };
    };

    await saveCollection([{ id: "t-1" }], { fetchImpl });
    expect(calls).toEqual([{ url: "/api/collection", method: "PUT" }]);
  });

  // The mirror is a convenience behind the server's authority, so a storage failure
  // must NOT fail the save — the opposite of the local-only case above.
  test("a storage failure does not fail a save the server accepted", async () => {
    const { saveCollection } = await loadApi(false);
    setItem = () => { throw new Error("QuotaExceededError"); };
    const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) });

    await expect(saveCollection([{ id: "t-1" }], { fetchImpl })).resolves.toBeDefined();
  });
});

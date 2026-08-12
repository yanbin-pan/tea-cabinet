import { describe, test, expect, beforeEach } from "vitest";
import { ApiError, loadCollection, saveCollection, uploadPhoto, dataUrlToBlob, photoUrl, isPhotoId } from "./api.js";

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  };
}

// A 2xx response whose body is not valid JSON — res.json() rejects with a
// SyntaxError, same as the real fetch implementation would.
function malformedJsonResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => {
      throw new SyntaxError("Unexpected token in JSON");
    },
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

  // A 2xx response with an unparsable body must still surface as an ApiError,
  // not a raw SyntaxError, so callers branching on err.kind/err.status hold.
  test("throws an ApiError, not a raw SyntaxError, on a malformed 2xx body", async () => {
    const fetchImpl = async () => malformedJsonResponse(200);
    await expect(loadCollection({ fetchImpl })).rejects.toBeInstanceOf(ApiError);
  });

  test("returns the signed-in address when the server supplies one", async () => {
    const fetchImpl = async () => response(200, { teas: [], email: "person@example.com" });
    const out = await loadCollection({ fetchImpl });
    expect(out.email).toBe("person@example.com");
  });

  test("email is null when the server does not supply one", async () => {
    const fetchImpl = async () => response(200, { teas: [] });
    expect((await loadCollection({ fetchImpl })).email).toBe(null);
  });

  // A legitimately empty server response (unmigrated data, wrong directory,
  // an old pod mid-rollout) must not destroy the last local backup.
  test("an empty server response leaves an existing non-empty mirror intact", async () => {
    localStorage.setItem("cha:collection:v2", JSON.stringify([{ id: "precious" }]));
    const fetchImpl = async () => response(200, { teas: [] });
    const out = await loadCollection({ fetchImpl });
    expect(out.source).toBe("server");
    expect(out.teas).toEqual([]);
    expect(JSON.parse(localStorage.getItem("cha:collection:v2"))).toEqual([{ id: "precious" }]);
  });

  test("a non-empty server response still overwrites the mirror", async () => {
    localStorage.setItem("cha:collection:v2", JSON.stringify([{ id: "stale" }]));
    const fetchImpl = async () => response(200, { teas: [{ id: "fresh" }] });
    await loadCollection({ fetchImpl });
    expect(JSON.parse(localStorage.getItem("cha:collection:v2"))).toEqual([{ id: "fresh" }]);
  });

  test("an empty server response with an absent mirror is fine", async () => {
    const fetchImpl = async () => response(200, { teas: [] });
    await loadCollection({ fetchImpl });
    expect(JSON.parse(localStorage.getItem("cha:collection:v2"))).toEqual([]);
  });

  test("an empty server response with an already-empty mirror is fine", async () => {
    localStorage.setItem("cha:collection:v2", JSON.stringify([]));
    const fetchImpl = async () => response(200, { teas: [] });
    await loadCollection({ fetchImpl });
    expect(JSON.parse(localStorage.getItem("cha:collection:v2"))).toEqual([]);
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

  test("throws an ApiError, not a raw SyntaxError, on a malformed 2xx body", async () => {
    const fetchImpl = async () => malformedJsonResponse(200);
    await expect(uploadPhoto(new Blob(["x"]), { fetchImpl })).rejects.toBeInstanceOf(ApiError);
  });
});

describe("dataUrlToBlob", () => {
  // Node 20's fetch genuinely supports data: URLs, so this exercises the real
  // default path (no injected fetchImpl) end to end.
  test("converts a real data URL into a Blob with the right bytes", async () => {
    const dataUrl = "data:text/plain;base64," + Buffer.from("hello").toString("base64");
    const blob = await dataUrlToBlob(dataUrl);
    expect(blob.size).toBe(5);
    expect(await blob.text()).toBe("hello");
  });

  test("uses an injected fetchImpl instead of the bare global fetch", async () => {
    let calledWith;
    const fakeBlob = new Blob(["stub"]);
    const fetchImpl = async (url) => {
      calledWith = url;
      return { blob: async () => fakeBlob };
    };
    const blob = await dataUrlToBlob("data:text/plain;base64,AAAA", { fetchImpl });
    expect(calledWith).toBe("data:text/plain;base64,AAAA");
    expect(blob).toBe(fakeBlob);
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

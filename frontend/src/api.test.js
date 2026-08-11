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

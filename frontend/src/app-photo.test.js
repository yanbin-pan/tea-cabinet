import { describe, test, expect } from "vitest";
import { srcFor } from "./App.jsx";

// Records written after the photo-storage change hold a 32-hex id; records that
// came from an older export still hold an inline data URL. Both have to render,
// so srcFor is the one place that decides which of the two a value is.
describe("srcFor", () => {
  test("turns a photo id into the endpoint that serves it", () => {
    const id = "a".repeat(32);
    expect(srcFor(id)).toBe(`/api/photos/${id}`);
  });

  test("passes an inline data URL through untouched", () => {
    const dataUrl = "data:image/jpeg;base64,AAAA";
    expect(srcFor(dataUrl)).toBe(dataUrl);
  });

  test("returns null for a record with no photo", () => {
    expect(srcFor(null)).toBe(null);
    expect(srcFor("")).toBe(null);
    expect(srcFor(undefined)).toBe(null);
  });

  // A near-miss must not be mistaken for an id and turned into a broken URL.
  test("treats anything that is not a 32-hex id as a literal source", () => {
    expect(srcFor("a".repeat(31))).toBe("a".repeat(31));
    expect(srcFor("z".repeat(32))).toBe("z".repeat(32));
  });
});

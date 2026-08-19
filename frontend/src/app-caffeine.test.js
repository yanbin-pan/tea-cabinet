import { describe, test, expect } from "vitest";
import { caffeineLevelOf } from "./App.jsx";

// Caffeine is stored as free text, so the filter can only be as good as the
// bucket a record is sorted into. These are the readings that have to hold.
describe("caffeineLevelOf", () => {
  test("reads an approximate single figure", () => {
    expect(caffeineLevelOf({ caffeine: "~15 mg" })).toBe("Low");
    expect(caffeineLevelOf({ caffeine: "30 mg" })).toBe("Medium");
    expect(caffeineLevelOf({ caffeine: "80 mg" })).toBe("High");
  });

  test("uses the midpoint of a range", () => {
    expect(caffeineLevelOf({ caffeine: "30–45 mg" })).toBe("Medium");
    expect(caffeineLevelOf({ caffeine: "10-20 mg" })).toBe("Low");
    expect(caffeineLevelOf({ caffeine: "60-100 mg" })).toBe("High");
  });

  test("treats caffeine-free wording as none, not as unlisted", () => {
    expect(caffeineLevelOf({ caffeine: "Caffeine-free" })).toBe("None");
    expect(caffeineLevelOf({ caffeine: "none" })).toBe("None");
    expect(caffeineLevelOf({ caffeine: "no caffeine" })).toBe("None");
    expect(caffeineLevelOf({ caffeine: "0 mg" })).toBe("None");
  });

  // A tea nobody has measured must not be filed under "Low" — that would let a
  // strong tea slip into a search for the gentlest thing in the cabinet.
  test("files a record with nothing usable under Unlisted", () => {
    expect(caffeineLevelOf({ caffeine: "" })).toBe("Unlisted");
    expect(caffeineLevelOf({ caffeine: "   " })).toBe("Unlisted");
    expect(caffeineLevelOf({ caffeine: "moderate" })).toBe("Unlisted");
    expect(caffeineLevelOf({})).toBe("Unlisted");
    expect(caffeineLevelOf(null)).toBe("Unlisted");
  });

  // The boundaries the chip labels promise.
  test("sorts on the bucket edges as labelled", () => {
    expect(caffeineLevelOf({ caffeine: "25 mg" })).toBe("Low");
    expect(caffeineLevelOf({ caffeine: "26 mg" })).toBe("Medium");
    expect(caffeineLevelOf({ caffeine: "50 mg" })).toBe("Medium");
    expect(caffeineLevelOf({ caffeine: "51 mg" })).toBe("High");
  });
});

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

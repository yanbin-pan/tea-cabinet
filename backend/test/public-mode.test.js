import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "tea-public-"));
process.env.DATA_DIR = DATA_DIR;
process.env.PUBLIC_MODE = "1";
process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
process.env.SCAN_DAILY_PER_CALLER = "2";
process.env.SCAN_DAILY_TOTAL = "100";

// ACCESS_TEAM_DOMAIN and ACCESS_AUD are deliberately NOT set. accessConfig() refuses
// to start without them, so importing the app at all is the assertion that a public
// instance does not need Cloudflare Access configured — and, read the other way, that
// the fail-closed check is skipped only on this path.
delete process.env.ACCESS_TEAM_DOMAIN;
delete process.env.ACCESS_AUD;

const realFetch = globalThis.fetch;
let upstreamCalls = 0;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.anthropic.com/")) {
    upstreamCalls++;
    return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }] }), { status: 200 });
  }
  return realFetch(url, init);
};

const { app } = await import("../server.js");

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((r) => server.close(r));
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

// Distinct addresses per test, since the limiter's counters live for the whole file.
function scanFrom(ip) {
  return fetch(`${base}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cf-Connecting-Ip": ip },
    body: JSON.stringify({ mediaType: "image/jpeg", b64: "A".repeat(200) }),
  });
}

test("anyone can scan a label, with no identity at all", async () => {
  const res = await scanFrom("203.0.113.1");
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls, 1);
});

// The property that makes this mode safe to expose: there is no stored data to reach,
// because the routes that would reach it were never registered. 404, not 401 — the
// difference between "this does not exist here" and "this exists and you may not have it".
test("the routes that touch stored data do not exist", async () => {
  const cases = [
    ["GET", "/api/collection"],
    ["PUT", "/api/collection"],
    ["POST", "/api/photos"],
    ["GET", `/api/photos/${"0".repeat(32)}`],
  ];
  for (const [method, url] of cases) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : "{}",
    });
    assert.equal(res.status, 404, `${method} ${url}`);
  }
});

test("health still answers, so the container probes keep working", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

// With no identity to count against, the quota keys on the edge's address header. If
// that were read from the wrong place — req.ip, or the tail of X-Forwarded-For — every
// visitor would arrive as the same internal pod address and share one allowance.
test("anonymous callers are counted per address, not all together", async () => {
  assert.equal((await scanFrom("203.0.113.10")).status, 200);
  assert.equal((await scanFrom("203.0.113.10")).status, 200);

  const denied = await scanFrom("203.0.113.10");
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).scope, "caller");

  assert.equal((await scanFrom("203.0.113.11")).status, 200, "a different visitor has their own allowance");
});

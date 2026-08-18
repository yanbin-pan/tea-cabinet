import test from "node:test";
import assert from "node:assert/strict";
import { createScanLimiter, startOfNextUtcDay } from "../lib/scanlimit.js";

// Noon UTC, so a test can move the clock a few hours in either direction without
// accidentally crossing the day boundary it is not testing.
const NOON = Date.UTC(2026, 0, 15, 12, 0, 0);
const NEXT_MIDNIGHT = Date.UTC(2026, 0, 16, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

// A clock the test drives. The limiter's windows are a day long; waiting for one is
// not an option, so the seam is the only way this behaviour is testable at all.
function clock(start = NOON) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("the window boundary is the next UTC midnight", () => {
  assert.equal(startOfNextUtcDay(NOON), NEXT_MIDNIGHT);
  // One millisecond before midnight still belongs to the day that is ending.
  assert.equal(startOfNextUtcDay(NEXT_MIDNIGHT - 1), NEXT_MIDNIGHT);
  // Exactly midnight is the start of the new day, so its boundary is the day after.
  assert.equal(startOfNextUtcDay(NEXT_MIDNIGHT), NEXT_MIDNIGHT + 24 * HOUR);
});

test("a caller gets exactly perCaller scans, then is refused", () => {
  const c = clock();
  const limiter = createScanLimiter({ perCaller: 3, perDay: 100, now: c.now });

  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.take("ip:1.2.3.4").ok, true, `scan ${i + 1} should be allowed`);
  }

  const denied = limiter.take("ip:1.2.3.4");
  assert.equal(denied.ok, false);
  assert.equal(denied.scope, "caller");
  // Half a day left, so the reset is hours away — and never zero, which would invite
  // an immediate retry that cannot succeed.
  assert.equal(denied.retryAfterSeconds, 12 * 60 * 60);
});

test("one caller's exhaustion does not affect another", () => {
  const c = clock();
  const limiter = createScanLimiter({ perCaller: 2, perDay: 100, now: c.now });

  limiter.take("ip:1.1.1.1");
  limiter.take("ip:1.1.1.1");
  assert.equal(limiter.take("ip:1.1.1.1").ok, false);
  assert.equal(limiter.take("ip:2.2.2.2").ok, true);
});

// The point of the global counter: per-caller limits key on something the caller
// chooses, so a caller with many addresses walks straight past them. This is the limit
// that actually bounds the bill.
test("the global ceiling stops a caller who cycles addresses", () => {
  const c = clock();
  const limiter = createScanLimiter({ perCaller: 2, perDay: 5, now: c.now });

  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.take(`ip:10.0.0.${i}`).ok, true);
  }

  const denied = limiter.take("ip:10.0.0.99");
  assert.equal(denied.ok, false);
  assert.equal(denied.scope, "global");
});

test("both counters reset at midnight", () => {
  const c = clock();
  const limiter = createScanLimiter({ perCaller: 1, perDay: 1, now: c.now });

  assert.equal(limiter.take("ip:1.2.3.4").ok, true);
  assert.equal(limiter.take("ip:1.2.3.4").ok, false);

  c.advance(12 * HOUR); // now exactly midnight
  assert.equal(limiter.take("ip:1.2.3.4").ok, true, "a new day gives the caller a fresh allowance");
  assert.equal(limiter.stats().globalCount, 1, "and the global counter started over too");
});

test("a refund returns the reservation to both counters", () => {
  const c = clock();
  const limiter = createScanLimiter({ perCaller: 2, perDay: 2, now: c.now });

  limiter.take("ip:1.2.3.4");
  limiter.take("ip:1.2.3.4");
  assert.equal(limiter.take("ip:1.2.3.4").ok, false);

  limiter.refund("ip:1.2.3.4");
  assert.equal(limiter.stats().globalCount, 1);
  assert.equal(limiter.take("ip:1.2.3.4").ok, true, "the refunded scan is available again");
});

// A request that started yesterday and failed after midnight must not hand today's
// counter a free unit — that would let a caller bank credit across the boundary.
test("a refund after the window rolled over credits nothing", () => {
  const c = clock();
  const limiter = createScanLimiter({ perCaller: 1, perDay: 10, now: c.now });

  assert.equal(limiter.take("ip:1.2.3.4").ok, true);

  c.advance(12 * HOUR); // midnight: yesterday's counters are gone
  limiter.refund("ip:1.2.3.4");

  assert.equal(limiter.take("ip:1.2.3.4").ok, true, "today's single allowance");
  assert.equal(limiter.take("ip:1.2.3.4").ok, false, "and no second one from the stale refund");
});

test("refunding more than was taken cannot drive a counter negative", () => {
  const c = clock();
  const limiter = createScanLimiter({ perCaller: 1, perDay: 1, now: c.now });

  limiter.take("ip:1.2.3.4");
  limiter.refund("ip:1.2.3.4");
  limiter.refund("ip:1.2.3.4");
  limiter.refund("ip:1.2.3.4");

  assert.equal(limiter.stats().globalCount, 0);
  assert.equal(limiter.take("ip:1.2.3.4").ok, true);
  assert.equal(limiter.take("ip:1.2.3.4").ok, false, "still exactly one scan a day");
});

// The tracked-caller cap exists so a flood of one-request addresses cannot grow the
// map without bound. The behaviour that matters is what it does NOT do: evicting an
// existing counter would let an abuser clear their own record by flooding.
test("past the tracked-caller cap, known callers keep their counts", () => {
  const c = clock();
  const limiter = createScanLimiter({ perCaller: 1, perDay: 1e9, now: c.now });

  limiter.take("ip:known");
  assert.equal(limiter.take("ip:known").ok, false, "used its one scan");

  // 10,000 is MAX_TRACKED_CALLERS; go past it so the cap is certainly in force.
  for (let i = 0; i < 10050; i++) limiter.take(`ip:flood-${i}`);

  assert.equal(limiter.take("ip:known").ok, false, "the flood did not reset the known caller");
});

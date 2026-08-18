// Spend control for /api/scan — the one route that costs real money per call.
//
// The ingress already rate-limits requests per source address (k8s/60-rate-limits.yaml),
// but a request-rate limit is not a spend limit: 60/min sustained is ~86,000 scans a
// day from a single address, and the limit resets forever. What protects the bill is a
// *quota* — a fixed number of scans per day — so this module counts scans rather than
// requests per second.
//
// Two counters, and both must pass:
//
//   per-caller  the routine case. One person, or one address, cannot spend the whole
//               day's budget.
//   global      the backstop. Per-caller counting keys on something the caller
//               supplies (an address), so a caller with many addresses defeats it by
//               definition. The global ceiling is the number that actually bounds the
//               invoice, and it is the only one that does.
//
// IN-MEMORY, AND PER REPLICA. Counters live in the process, so with N replicas the
// real ceiling is N x the configured one. That is a deliberate trade: the alternative
// is a shared counter on the NFS volume, and read-modify-write from two replicas over
// NFS loses increments precisely when it matters — under the concurrent load an
// abuser generates. An over-count by a known integer factor beats an under-count by
// an unknown one, so size SCAN_DAILY_TOTAL at the per-replica share of the budget and
// treat the deployment's replica count as part of the configuration.

// A day, aligned to UTC midnight rather than to first use. A caller who hits the cap
// learns "resets at midnight UTC", which is a fact they can act on; a rolling window
// anchored on their first request of the day is not.
const DAY_MS = 24 * 60 * 60 * 1000;

// Ceiling on how many distinct callers are tracked at once. Every unseen key costs a
// map entry, so a caller cycling addresses can grow this without bound — the sweep
// below only reclaims *expired* entries, and entries minted this second are not
// expired. Past the cap, new callers are refused against the global counter, which is
// the limit that protects the budget anyway. Roughly 100 bytes an entry, so this is
// single-digit megabytes at worst.
const MAX_TRACKED_CALLERS = 10000;

// Sweeping expired entries on every call would make each scan O(callers). Once a
// minute keeps the map from accumulating yesterday's keys without putting a scan on
// the hook for the cleanup.
const SWEEP_INTERVAL_MS = 60 * 1000;

export function startOfNextUtcDay(now) {
  return Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
}

/**
 * @param {object} options
 * @param {number} options.perCaller  scans allowed per caller per UTC day
 * @param {number} options.perDay     scans allowed across all callers per UTC day
 * @param {() => number} [options.now] clock seam, so tests can cross midnight without waiting
 */
export function createScanLimiter({ perCaller, perDay, now = Date.now }) {
  const callers = new Map();
  let global = { count: 0, resetAt: 0 };
  let lastSweep = 0;

  function sweep(t) {
    if (t - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = t;
    for (const [key, entry] of callers) {
      if (entry.resetAt <= t) callers.delete(key);
    }
  }

  function windowFor(entry, t) {
    // A counter whose window has passed is indistinguishable from one that never
    // existed, so both take the same path.
    if (!entry || entry.resetAt <= t) return { count: 0, resetAt: startOfNextUtcDay(t) };
    return entry;
  }

  function denial(scope, resetAt, t) {
    return {
      ok: false,
      scope,
      // Rounded up: a Retry-After of 0 invites an immediate retry that cannot succeed.
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - t) / 1000)),
      resetAt,
    };
  }

  return {
    /**
     * Reserve one scan for `key`. Counts *before* the upstream call, not after: two
     * requests arriving together must not both read the pre-increment count and both
     * be allowed through. Call `refund` if the scan turns out not to have cost
     * anything.
     */
    take(key) {
      const t = now();
      sweep(t);

      global = windowFor(global, t);
      // Checked first, and never bypassed by the caller-cap path below: this is the
      // limit that bounds the bill.
      if (global.count >= perDay) return denial("global", global.resetAt, t);

      let entry = callers.get(key);
      if (!entry && callers.size >= MAX_TRACKED_CALLERS) {
        // Too many distinct callers to track individually. Rather than evict a
        // legitimate caller's count (which would hand an abuser a way to *clear* the
        // per-caller counter — flood the map, evict the entry, start again at zero),
        // refuse the unknown caller and let the global ceiling do the work. Reported
        // as "global" because that is the limit being leaned on.
        return denial("global", global.resetAt, t);
      }

      entry = windowFor(entry, t);
      if (entry.count >= perCaller) return denial("caller", entry.resetAt, t);

      entry.count++;
      global.count++;
      callers.set(key, entry);
      return { ok: true, remaining: perCaller - entry.count, resetAt: entry.resetAt };
    },

    /**
     * Give back a reservation the caller never got value from — an upstream failure
     * that produced no answer and therefore no bill. Silently ignores a refund for a
     * window that has since rolled over, which would otherwise credit today's counter
     * for yesterday's request.
     */
    refund(key, at = now()) {
      const entry = callers.get(key);
      if (entry && entry.resetAt > at && entry.count > 0) entry.count--;
      if (global.resetAt > at && global.count > 0) global.count--;
    },

    // Reporting seam for tests and for a future /api/health detail line.
    stats() {
      const t = now();
      const g = windowFor(global, t);
      return { globalCount: g.count, trackedCallers: callers.size, resetAt: g.resetAt };
    },
  };
}

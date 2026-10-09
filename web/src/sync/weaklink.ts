// Weak-link FE-vantage sampler (send-net-resilience slice 4c, debate-2 Q5).
//
// PURPOSE: count the browser-side weak-link events that NO server-side probe
// can see — fetch failures by class and transport-level stream drops — so a
// future ConnStatus / reconnect-policy threshold tuning pass has a BASELINE
// from the user's actual vantage. The daemon's /vh/diag/latency (yamux
// slow-writes, ws-write stalls, tunnel lifecycle) is PROXY evidence for link
// quality; it measures the worker↔controller legs, not what the operator's
// browser experienced.
//
// BINDING RULE — FE-VANTAGE BASELINE GATES THRESHOLD TUNING:
// any future tuning of connection-health thresholds (STALE_MS,
// CONTENT_STALE_MS, ConnStatus grades, backoff caps) must be justified
// against FE-vantage counters (this module + the recovery-reasons counters
// below), NOT against daemon-only metrics alone. Daemon-side probes may
// INFORM, never gate, threshold changes. Recorded here and in the slice-4c
// report; enforce at review.
//
// WHAT IS COUNTED (and where the sibling signals live):
//   - fetch failures by class: network / abort / http_5xx — counted here via
//     a pass-through wrapper around globalThis.fetch installed once from
//     startSync (installFetchSampler). 4xx answers are deliberately NOT
//     counted: a definitive non-2xx is a server answer, not a weak-link
//     event.
//   - transport stream drops (EventSource gave up → CLOSED): counted here via
//     recordStreamDrop, hooked at the tree (tree-transport.ts onerror CLOSED
//     branch) and session (session-stream.ts onerror CLOSED branch) streams.
//   - SSE-gap detections: ALREADY counted by recovery-reasons.ts as
//     "seq-gap" / "tree-seq-gap" (same window.__vhSyncDiag() snapshot).
//   - watchdog stales: ALREADY counted by recovery-reasons.ts as
//     "tree-transport-stale" / "tree-idle-stale" /
//     "session-transport-stale" / "idle-content-stale".
// The consolidated weak-link view is therefore ONE console call:
// window.__vhSyncDiag() → { recovery, snapshotBytes, weakLink }.
//
// CONTRACT (mirrors recovery-reasons.ts exactly):
//  - Counting is ALWAYS on but near-free: plain field increments, no
//    allocation on the counting path, no timers, no reactive signals, no
//    console output, NO behavior change of any kind.
//  - INSTRUMENTATION ONLY: nothing here is delivery/retry authority. No
//    threshold in this file wires to any behavior; every label/semantic in
//    the snapshot is an ASSUMPTION pending baseline data — do not "tune"
//    anything from a single tab's numbers without a real-world sample.
//  - The export surface is the EXISTING debug getter (window.__vhSyncDiag,
//    recovery-reasons.ts) — no new global health system.
//  - The fetch wrapper is an exact pass-through: same arguments, same
//    resolution/rejection values, same ordering. It only observes.

/** Failure classes for the FE fetch sampler. Fixed vocabulary.
 *  network  — the request rejected without an abort (TypeError et al. —
 *             DNS/TCP/TLS/proxy unreachable from the browser).
 *  abort    — rejected as an AbortError (client AbortController: bound
 *             timeouts like REPLY_TIMEOUT_MS / CREATE_SESSION_TIMEOUT_MS /
 *             the fork guard's FORK_TIMEOUT_MS). Outcome-unknown class.
 *  http_5xx — resolved with status >= 500 (proxy 502 / upstream 5xx — the
 *             response may not describe whether the effect applied). */
export type FetchFailureClass = "network" | "abort" | "http_5xx";
const FETCH_FAILURE_CLASSES: readonly FetchFailureClass[] = ["network", "abort", "http_5xx"];

/** Which SSE transport dropped to CLOSED (the browser gave up; a manual
 *  backoff reconnect follows). Tree = Stream 1, session = Stream 2. */
export type WeakLinkStream = "tree" | "session";

export interface WeakLinkSnapshot {
  /** Total fetches observed by the wrapper (the denominator for failure
   *  rates — a failure count alone cannot distinguish "flaky link" from
   *  "chatty app on a healthy link"). */
  fetches: number;
  /** Fetch failures by class (see FetchFailureClass). */
  fetchFailures: Record<FetchFailureClass, number>;
  /** Transport-level stream drops per stream. Watchdog/forced reconnects
   *  are counted separately in recovery-reasons.ts recovery counters. */
  streamDrops: Record<WeakLinkStream, number>;
  /** Wall-clock ms when this snapshot was taken. */
  generatedAt: number;
}

// --- counters (module-singleton, near-free increments) -----------------------
const fetchFailures: Record<FetchFailureClass, number> = { network: 0, abort: 0, http_5xx: 0 };
const streamDrops: Record<WeakLinkStream, number> = { tree: 0, session: 0 };
let fetches = 0;

/** Count one completed fetch (any outcome). Internal to the wrapper. */
function noteFetch(): void {
  fetches++;
}

/** Count one fetch failure by class. Exported for the wrapper; also usable
 *  directly by call sites that bypass globalThis.fetch (none today — the
 *  wrapper covers everything). */
export function recordFetchFailure(cls: FetchFailureClass): void {
  fetchFailures[cls]++;
}

/** Classify a fetch rejection into a FetchFailureClass. Pure. */
export function classifyFetchError(e: unknown): FetchFailureClass {
  // AbortError is a DOMException whose .name carries the class — works for
  // DOMException and duck-typed lookalikes without importing DOMException
  // (keeps the module usable in non-DOM test environments).
  const name = (e as { name?: unknown } | null | undefined)?.name;
  return name === "AbortError" ? "abort" : "network";
}

/** Count one transport-level stream drop (EventSource CLOSED detection). */
export function recordStreamDrop(stream: WeakLinkStream): void {
  streamDrops[stream]++;
}

/** Read a frozen copy of the sampler state. Allocates — call from the console
 *  (via __vhSyncDiag) or tests, not from app code on a hot path. */
export function readWeakLink(): WeakLinkSnapshot {
  return {
    fetches,
    fetchFailures: { network: fetchFailures.network, abort: fetchFailures.abort, http_5xx: fetchFailures.http_5xx },
    streamDrops: { tree: streamDrops.tree, session: streamDrops.session },
    generatedAt: Date.now(),
  };
}

// installFetchSampler wraps globalThis.fetch (the identifier every bare
// `fetch(...)` call in the SPA resolves to) with a pass-through counting
// wrapper. Idempotent (the __vhFetchSampled latch), installed once from
// startSync. A test that stubs fetch AFTER install replaces the wrapper and
// simply stops counting — counting is never load-bearing for behavior.
export function installFetchSampler(): void {
  const g = globalThis as { fetch?: typeof fetch; __vhFetchSampled?: boolean };
  if (g.__vhFetchSampled || typeof g.fetch !== "function") return;
  g.__vhFetchSampled = true;
  const orig = g.fetch;
  const sampled = (...args: Parameters<typeof fetch>): Promise<Response> => {
    // Count on SETTLEMENT so an eternally-pending fetch (a hung socket) does
    // not inflate the denominator — those surface as the caller's abort
    // (bounded actions) or stream drops instead.
    return orig(...args).then(
      (res) => {
        noteFetch();
        if (res.status >= 500) recordFetchFailure("http_5xx");
        return res;
      },
      (e) => {
        noteFetch();
        recordFetchFailure(classifyFetchError(e));
        throw e;
      },
    );
  };
  g.fetch = sampled as typeof fetch;
}

/** Test-only: reset all counters AND the install latch. Assumes the wrapper
 *  is no longer installed on globalThis.fetch (tests restore the original
 *  via vi.unstubAllGlobals before the next install) — otherwise a fresh
 *  install would wrap the old wrapper and double-count. */
export function _resetWeakLinkForTest(): void {
  fetches = 0;
  for (const c of FETCH_FAILURE_CLASSES) fetchFailures[c] = 0;
  streamDrops.tree = 0;
  streamDrops.session = 0;
  delete (globalThis as { __vhFetchSampled?: boolean }).__vhFetchSampled;
}

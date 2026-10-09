// Slice 1 (webperf build1): stable reason codes for every forced reconnect /
// re-snapshot path + a tiny dev-visible counter surface (`window.__vhSyncDiag`).
//
// WHY: the idle 9-pane heat/traffic study showed content-stale watchdogs
// reconnecting idle sessions AND trees every ~130s per pane, but the existing
// signals (log.warn + default-OFF diaglog ring) could not answer "how many,
// for which reason, carrying how many snapshot bytes" from a live tab. This
// module makes every force path COUNTABLE by a stable reason code so
// before/after slicing (slice 2 pause, slice 3 idle-aware state machine) is
// measurable from the browser console alone.
//
// CONTRACT (mirrors the diaglog.ts posture):
//  - Counting is ALWAYS on but near-free: one Map lookup + number add per
//    event. No allocation on the steady-state path (the stat object is cached
//    per reason), no timers, no reactive signals, NO console output.
//  - The dev surface is a plain getter installed once on window.__vhSyncDiag
//    (installSyncDiagGlobal, wired from startSync). Zero cost until invoked;
//    invoking it allocates one frozen snapshot copy.
//  - No polling loop of its own; no new diag UI.
//
// Reason codes are STABLE strings — operator evidence packs and dashboards may
// grep them. Do not rename; extend only.
//
// SLICE 4C NOTE (weak-link baseline): the SSE-gap detections live HERE
// ("seq-gap" / "tree-seq-gap") and the watchdog stales live HERE (the four
// *-stale codes) — together with weaklink.ts's fetch-failure and stream-drop
// counters (surfaced as the `weakLink` section of this same snapshot below)
// they form the FE-VANTAGE weak-link baseline. BINDING: future threshold
// tuning gates on these FE-vantage counters, never on daemon-only proxy
// metrics (see weaklink.ts's header for the full rule).
import { log } from "../lib/log";
import { readWeakLink, type WeakLinkSnapshot } from "./weaklink";

// The full closed vocabulary of recovery reasons. Each maps 1:1 to an existing
// distinct force path (they already exist as distinct causes — kept distinct):
//  - idle-content-stale     health.ts watchdog, Stream2 content-stall (pings
//                           flow, zero content) — the idle-pane churn driver.
//  - session-transport-stale health.ts watchdog, Stream2 transport stall.
//  - tree-idle-stale        health.ts watchdog, Stream1 content-stall (the
//                           idle tree re-snapshot driver; the SR60 server
//                           backstop is fictitious when idle).
//  - tree-transport-stale   health.ts watchdog, Stream1 transport stall.
//  - busy-reconcile         stream.ts reconcileBusy force (busy-scope release).
//  - tail-incomplete        reconcile.ts tail-incomplete-on-idle force.
//  - seq-gap                session-stream.ts checkSesOrdinalGap force.
//  - tree-seq-gap           tree-transport.ts checkTreeOrdinalGap force.
//  - offset-mismatch        session-stream.ts flushAppends part.append offset
//                           mismatch → cursorless re-snapshot.
//  - tree-overlap-capture   tree-transport.ts overlapping tree.snapshot →
//                           connect(true) resync.
//  - visibility-pause       slice 2: pane hidden → streams suspended.
//  - visibility-resume      slice 2: pane revealed → streams resumed from
//                           cursors.
//  - idle-content-stale-skipped slice 3: the Stream2 content-stale watchdog
//                           tripped on an IDLE (not sessionWorking) session and
//                           the force was SKIPPED — silence is expected for a
//                           terminal-idle session. Counted PER SKIPPED TICK
//                           (a rate meter: ticks where today's code would have
//                           forced a cursorless full snapshot but slice 3 did
//                           not), so an all-idle soak shows this climbing while
//                           `idle-content-stale` freezes at 0.
//  - tree-idle-stale-skipped slice 3: the Stream1 tree content-stale watchdog
//                           tripped with NO activity anywhere in the project
//                           (anySessionActive() false) and the force was
//                           SKIPPED. Per-skipped-tick, same rate-meter contract.
//  - busy-edge-rearm        slice 3: an idle→busy edge on the selected session
//                           proactively re-opened Stream2 through the retry
//                           seam (cursor-preserving ring replay) because the
//                           stream was closed or its content clock was aged —
//                           the prompt-to-idle-dead-stream attach fix. Counted
//                           once per acted-on edge.
//  - sentinel-probe-issued  slice 5 (webperf/F7): a content-stale boundary
//                           fired a POST /vh/stream/probe and armed
//                           SENTINEL_TIMEOUT. Rate meter (≈1 per
//                           CONTENT_STALE_MS per idle pane).
//  - sentinel-alive         slice 5: the probe nonce came back as a no-id
//                           vh.liveness frame on an open stream — liveness
//                           PROVEN end-to-end; the stale clock was refreshed
//                           and NO recovery ran. The proven-alive
//                           distinguisher for the idle soak (vs the legacy
//                           assumed-alive skip counters above).
//  - sentinel-timeout       slice 5: SENTINEL_TIMEOUT elapsed with no frame —
//                           the worker pipeline is presumed dead; the
//                           cursor-PRESERVING recovery ran (openSessionES
//                           seam / tree connect(), never an IMMEDIATE
//                           cursorless force). If the resumed Stream2 then
//                           stays silent past
//                           SES_RESUME_SILENT_FALLBACK_MS, the slice-5b fix
//                           follows up with ONE cursorless snapshot
//                           confirmation (counted separately below).
//  - sentinel-legacy-fallback slice 5: the probe POST answered 404/405 (old
//                           worker, no route) — capability memo'd unavailable
//                           for the session lifetime and the legacy
//                           heuristic (idle-skip / active-force) ran exactly
//                           as pre-slice-5.
//  - resume-silent-fallback slice 5b fix: a cursor-preserving recovery reopen
//                           (watchdog CLOSED branch / sentinel timeout)
//                           delivered NO snapshot and NO message events
//                           within SES_RESUME_SILENT_FALLBACK_MS — the ring
//                           replay was provably continuous but everything in
//                           range was interest-filtered, so the repair can
//                           never be confirmed on that connection. ONE
//                           cursorless reopen follows so the server's
//                           fresh-snapshot branch confirms the repair
//                           (clears refreshing[id]; MERGE re-seeds). Counted
//                           once per silent resume; any delivered content
//                           cancels it (never fires on a served replay).
export const RECOVERY_REASONS = [
  "idle-content-stale",
  "session-transport-stale",
  "tree-idle-stale",
  "tree-transport-stale",
  "busy-reconcile",
  "tail-incomplete",
  "seq-gap",
  "tree-seq-gap",
  "offset-mismatch",
  "tree-overlap-capture",
  "visibility-pause",
  "visibility-resume",
  "idle-content-stale-skipped",
  "tree-idle-stale-skipped",
  "busy-edge-rearm",
  "sentinel-probe-issued",
  "sentinel-alive",
  "sentinel-timeout",
  "sentinel-legacy-fallback",
  "resume-silent-fallback",
] as const;
export type RecoveryReason = (typeof RECOVERY_REASONS)[number];

/**
 * Pure classification of a dual-clock watchdog stall into a stable reason
 * code. Mirrors the existing log.reason derivation in health.ts
 * (`contentStale && !transportStale ? "content-stall" : "transport-stall"`)
 * so the counter never disagrees with the log line. Returns null when NEITHER
 * clock tripped (no recovery — do not count).
 *
 * transport-stall dominates when BOTH trip: a socket whose pings stopped is
 * the stronger claim (content age is then a consequence, not an independent
 * signal).
 */
export function classifyStall(
  stream: "tree" | "session",
  contentStall: boolean,
  transportStall: boolean,
): RecoveryReason | null {
  if (!contentStall && !transportStall) return null;
  const contentOnly = contentStall && !transportStall;
  if (stream === "tree") return contentOnly ? "tree-idle-stale" : "tree-transport-stale";
  return contentOnly ? "idle-content-stale" : "session-transport-stale";
}

// --- counters ---------------------------------------------------------------
interface ReasonStat {
  count: number;
  lastTs: number;
}
const stats = new Map<RecoveryReason, ReasonStat>();
const snapBytes: Record<"tree" | "session", number> = { tree: 0, session: 0 };

/**
 * Count one recovery event by stable reason. Near-free (Map hit + increment,
 * no allocation after the first occurrence of a reason). Safe to call on any
 * force path; NOT a log — no console output by default.
 */
export function countRecovery(reason: RecoveryReason): void {
  const s = stats.get(reason);
  if (s) {
    s.count++;
    s.lastTs = Date.now();
  } else {
    stats.set(reason, { count: 1, lastTs: Date.now() });
  }
}

/**
 * Accumulate snapshot wire bytes RECEIVED by the client (per stream). Counts
 * the SSE `data:` payload length — exact for gzip64/base64 payloads (ASCII),
 * a close lower bound for raw JSON. Called from the tree (snapshot +
 * tree.snapshot) and session (snapshot) listeners at frame arrival.
 */
export function countSnapshotBytes(stream: "tree" | "session", bytes: number): void {
  if (bytes > 0) snapBytes[stream] += bytes;
}

export interface SyncDiagSnapshot {
  /** Per-reason recovery counters (only reasons that fired at least once). */
  recovery: Partial<Record<RecoveryReason, { count: number; lastTs: number }>>;
  /** Cumulative snapshot payload bytes received, per stream, since load. */
  snapshotBytes: { tree: number; session: number };
  /** Weak-link FE-vantage counters (slice 4c): fetch failures by class +
   *  transport stream drops. SSE-gap/watchdog-stale signals stay in
   *  `recovery` above — one snapshot, one console call. */
  weakLink: WeakLinkSnapshot;
  /** Wall-clock ms when this snapshot was taken. */
  generatedAt: number;
}

/**
 * Read a frozen copy of the counters. Allocates — call from the console
 * (`__vhSyncDiag()`), not from app code on a hot path.
 */
export function readSyncDiag(): SyncDiagSnapshot {
  const recovery: SyncDiagSnapshot["recovery"] = {};
  for (const [k, v] of stats) recovery[k] = { count: v.count, lastTs: v.lastTs };
  return {
    recovery,
    snapshotBytes: { tree: snapBytes.tree, session: snapBytes.session },
    weakLink: readWeakLink(),
    generatedAt: Date.now(),
  };
}

/**
 * Install the dev-visible console surface: `window.__vhSyncDiag` → this
 * getter. Idempotent; wired once from startSync. Zero-cost until invoked.
 */
export function installSyncDiagGlobal(): void {
  if (typeof window === "undefined") return;
  const w = window as { __vhSyncDiag?: () => SyncDiagSnapshot };
  if (w.__vhSyncDiag) return;
  w.__vhSyncDiag = readSyncDiag;
  log.debug("sync", "diag surface installed: window.__vhSyncDiag()");
}

/** Test-only: reset all counters + bytes (isolates per-test assertions). */
export function _resetRecoveryCountersForTest(): void {
  stats.clear();
  snapBytes.tree = 0;
  snapBytes.session = 0;
}

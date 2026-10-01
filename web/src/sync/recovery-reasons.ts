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
import { log } from "../lib/log";

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

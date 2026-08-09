// Stream health: the watchdog + reconnect decision functions, extracted from
// ./stream per the invariant audit §6e. Owns the coarse health tick signal
// (healthNow), isStale (the global connection-status indicator), watchdogTick
// (the dual-clock dead-but-OPEN detector that drives forced fresh-snapshot
// reconnects), maybeReconnect (foreground/online recovery entry), resyncTree
// (the on-focus + periodic drift self-heal), and their tunables
// (STALE_MS is imported — it is shared with ./stream's periodicResyncShouldRun;
// CONTENT_STALE_MS / TREE_RESYNC_MIN_GAP_MS live here).
//
// connect() lives in ./tree-transport — it is the Stream 1 (tree) lifecycle
// owner and is deeply coupled to the tree EventSource + the C4 coherent barrier.
// This module only DECIDES when to (re)connect and delegates the actual
// reconnect to connect() (Stream 1) / openSessionStream() (Stream 2).
//
// Cross-module seams (deliberate, minimal — read-only peeks, never mutation):
//   From ./tree-transport: connect(fresh?), isTreeClosed(), getTreeLastSeen(),
//                          getTreeContentSeen().
//   From ./periodic-resync: markAuthoritativeRecovery().
//   From ./stream:  STALE_MS.
//   From ./session-stream: openSessionStream(id, force?), getSesId(),
//                          isSessionClosed(), getSessionLastSeen(),
//                          getSessionContentSeen().
// Each stream's transport + clock STATE stays with its lifecycle owner; this
// module evaluates both clocks independently and re-requests an authoritative
// snapshot when either ages out.
//
// Top-level side effect: createSignal(0) (self-contained — no cross-module read
// at eval time). The stream ↔ health import cycle is TDZ-safe: every cross-
// module read happens inside watchdogTick / maybeReconnect / resyncTree bodies
// at runtime.
import { createSignal } from "solid-js";
import { log } from "../lib/log";
import { state, setState, projectDir } from "./store";
import { connect, isTreeClosed, getTreeLastSeen, getTreeContentSeen } from "./tree-transport";
import { markAuthoritativeRecovery } from "./periodic-resync";
import { STALE_MS } from "./stream";
import {
  openSessionStream,
  getSesId,
  isSessionClosed,
  getSessionLastSeen,
  getSessionContentSeen,
} from "./session-stream";
import { captureDiagEntry } from "./diaglog";

// Content-stall threshold (product policy). Transport staleness (STALE_MS)
// catches a stream whose pings STOP. CONTENT_STALE_MS catches a stream whose
// pings KEEP FLOWING but which delivers no content (the ping-mask gap). 120s
// is deliberately conservative: during active reasoning, tokens stream as
// message.part.delta (content flows continuously), so a genuine content gap
// this long is abnormal; but tool execution / between-turn gaps can legitimately
// silence content for tens of seconds, and a too-aggressive threshold would
// tear down and re-establish a healthy connection during normal deep-reasoning
// silences (a false reconnect costs a refresh flash + a re-snapshot round-trip).
// 120s ≈ 8 missed 15s ping windows of zero content. This value also keeps the
// existing Gate-C idle-stability test green as-is (its ~106s content-silence
// window stays under the threshold → no churn). Tunable: lower toward 90s if
// real-world signal shows 120s feels too slow; do NOT go below ~60s (legitimate
// tool-execution gaps) or deep-reasoning silences false-reconnect.
export const CONTENT_STALE_MS = 120_000;

// --- Feature 1: staleness (S1) ---------------------------------------------
// healthNow is a coarse tick (bumped by the watchdog) so staleness re-evaluates
// over wall-clock time even with no store writes. isStale reads the
// NON-reactive module `treeLastSeen` (plain var → no per-event subscription), so
// consumers of isStale only re-run on healthNow / state.status changes, not on
// every SSE byte. This keeps the stale indicator off the per-token hot path.
const [healthNow, setHealthNow] = createSignal(0);
// tickHealth advances the coarse health tick WITHOUT touching the watchdog's
// reconnect logic. Called on a faster cadence than the 10s watchdog (see
// startSync) so a stale-but-open socket surfaces the stale indicator BEFORE the
// watchdog reconnects it — otherwise isStale() could never render (the
// watchdog flips status to "reconnecting" in the same tick it detects staleness).
export function tickHealth() {
  setHealthNow((n) => n + 1);
}
export function isStale(): boolean {
  healthNow(); // subscribe to the coarse tick
  // Reads the TREE clock only: the status dot represents GLOBAL connection
  // health. A dead-but-OPEN Stream2 (selected-session messages) does NOT flip
  // the global status to stale/disconnected — it surfaces via the per-session
  // `refreshing[id]` dot and is healed by the Stream2 watchdog branch below.
  return state.status === "live" && getTreeLastSeen() > 0 && Date.now() - getTreeLastSeen() > STALE_MS;
}

// Force a reconnect when a stream has gone silent past the heartbeat window
// (a dead-but-OPEN EventSource won't surface as an error) or was closed. Each
// stream is evaluated against its OWN liveness clock — the original bug was a
// single shared `lastSeen` that Stream1's 15s server ping kept fresh forever,
// so a dead-but-OPEN Stream2 could never age out while the tree was healthy.
// Runs while the tab is visible.
export function watchdogTick() {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  // No project selected: never (re)connect the cwd bridge. The watchdog just
  // advances the stale-health tick (cheap, harmless) and stands down otherwise.
  if (!projectDir()) {
    setHealthNow((n) => n + 1);
    return;
  }
  // Feature 1: re-evaluate staleness over wall-clock time (no store write on
  // a silent-but-open socket). Coarse tick only — safe on the per-frame budget.
  setHealthNow((n) => n + 1);
  // --- Stream 1 (tree) liveness: drives the GLOBAL connection status. ---
  if (isTreeClosed()) {
    connect();
  } else {
    // Two independent stall signals, EITHER trips a forced reconnect (connect()
    // tears down the old EventSource — treeGen++, es.close() — and rebuilds,
    // re-seeding BOTH clocks at construction via markTreeSeen so there is no
    // tight loop). The Stream1 mirror of Lane C's Stream2 dual-clock watchdog
    // branch — only the TRIGGER set grows; the recovery path is unchanged.
    //
    // Transport stall (original path): pings STOPPED → treeLastSeen ages past
    // STALE_MS. Catches a fully-dead socket. Drives the global "reconnecting"
    // status (the status dot follows the tree).
    //
    // Content stall (Stream1 mirror of Lane C): transport ALIVE (pings flow,
    // treeLastSeen fresh) but ZERO content delivered → treeContentSeen ages
    // past CONTENT_STALE_MS. Catches the ping-mask gap on the tree — a socket
    // that stays OPEN and keeps acknowledging pings but never delivers
    // snapshot/tree.op/session.*/etc. The operator-visible symptom is a
    // completed subsession sticking "running" until reload (the stuck-running-
    // node gap). The conservative CONTENT_STALE_MS keeps legitimate silences
    // from churning the connection: tree content + the SR60 ≤60s backstop flow
    // well under the window during normal operation. The recovery path is the
    // SAME connect() the transport-stall path uses — the server emits a fresh
    // tree.snapshot on connect (cursored or not), and the C4 coherent barrier
    // reconciles. No connect(true) special-case is needed: unlike Stream2's
    // openSessionStream(id, true), the tree's connect() has no "already-open"
    // guard to bypass, so a plain connect() always rebuilds.
    const transportStale = !!(getTreeLastSeen() && Date.now() - getTreeLastSeen() > STALE_MS);
    const contentStale = !!(getTreeContentSeen() && Date.now() - getTreeContentSeen() > CONTENT_STALE_MS);
    if (transportStale || contentStale) {
      log.warn("sync", "tree stream stale → forcing reconnect", {
        silentMs: getTreeLastSeen() ? Date.now() - getTreeLastSeen() : 0,
        contentSilentMs: getTreeContentSeen() ? Date.now() - getTreeContentSeen() : 0,
        reason: contentStale && !transportStale ? "content-stall" : "transport-stall",
      });
      // StallEntry: capture the watchdog's pre-recovery state. Today this path
      // had NO diag — the operator could only observe the symptom (stuck
      // running node) with no record of the watchdog firing.
      captureDiagEntry({
        kind: "stall",
        ts: Date.now(),
        trigger: "content-stale-watchdog",
        stream: "tree",
        treeLastSeenAge: getTreeLastSeen() ? Date.now() - getTreeLastSeen() : undefined,
        treeContentSeenAge: getTreeContentSeen() ? Date.now() - getTreeContentSeen() : undefined,
      });
      setState("status", "reconnecting");
      connect();
    }
  }
  // --- Stream 2 (selected-session messages) liveness: INDEPENDENT clock. ---
  // A dead-but-OPEN Stream2 must be detected even while Stream1's 15s server
  // pings keep the tree healthy (the original masking bug). A stale/closed
  // Stream2 is reconnected via the existing forced fresh-snapshot path
  // (openSessionStream(id, true)): it bypasses the healthy/open early return,
  // closes the old EventSource, bumps sesGen (invalidating the stale
  // connection's listeners), and constructs a cursorless one starting with an
  // authoritative snapshot. A not-yet-open / just-(re)connected Stream2 has
  // sessionLastSeen seeded to "now" by open() → not stale → gets a fresh
  // deadline (no tight construction/close loop). Reconnecting ONLY Stream2
  // does NOT flip global status to disconnected (that follows the tree above).
  const sesId = getSesId();
  if (sesId) {
    if (isSessionClosed()) {
      openSessionStream(sesId);
    } else {
      // Two independent stall signals, EITHER trips the forced fresh-snapshot
      // reconnect (openSessionStream(id, true) → cursorless → authoritative
      // snapshot → applySessionSnapshot MERGE). The recovery path is the same
      // one the original dead-but-OPEN fix established; only the TRIGGER set
      // grows.
      //
      // Transport stall (original path): pings STOPPED → sessionLastSeen ages
      // past STALE_MS. Catches a fully-dead socket.
      //
      // Content stall (Lane C): transport ALIVE (pings flow, sessionLastSeen
      // fresh) but ZERO content delivered → sessionContentSeen ages past
      // CONTENT_STALE_MS. Catches the ping-mask gap (operator's "frozen
      // transcript, reload helps"): a socket that stays OPEN and keeps
      // acknowledging pings but never delivers snapshot/message/part. The
      // conservative CONTENT_STALE_MS keeps legitimate deep-reasoning /
      // tool-execution silences (which stream part deltas well under the
      // window) from churning the connection.
      const transportStale = !!(getSessionLastSeen() && Date.now() - getSessionLastSeen() > STALE_MS);
      const contentStale = !!(getSessionContentSeen() && Date.now() - getSessionContentSeen() > CONTENT_STALE_MS);
      if (transportStale || contentStale) {
        log.warn("sync", "session stream stale → forcing reconnect", {
          id: sesId,
          silentMs: getSessionLastSeen() ? Date.now() - getSessionLastSeen() : 0,
          contentSilentMs: getSessionContentSeen() ? Date.now() - getSessionContentSeen() : 0,
          reason: contentStale && !transportStale ? "content-stall" : "transport-stall",
        });
        // StallEntry: capture the watchdog's pre-recovery state.
        captureDiagEntry({
          kind: "stall",
          ts: Date.now(),
          trigger: "content-stale-watchdog",
          stream: "session",
          sessionId: sesId,
          sessionLastSeenAge: getSessionLastSeen() ? Date.now() - getSessionLastSeen() : undefined,
          sessionContentSeenAge: getSessionContentSeen() ? Date.now() - getSessionContentSeen() : undefined,
        });
        openSessionStream(sesId, true);
      }
    }
  }
}

export function maybeReconnect() {
  // No project selected: no stream to reconnect (and connect() would no-op
  // anyway, but avoid even the readyState read / status churn).
  if (!projectDir()) return;
  if (isTreeClosed()) connect();
  else watchdogTick();
}

// === Issue 2 / Q6: on-focus + conditional periodic tree resync (drift self-heal)
// ===
//
// The O1 collapsed-frontier optimization removed the frequent full
// re-projections that used to CONTINUOUSLY self-heal client/daemon state, so a
// long-lived stream now accumulates drift until the next restart/reconnect. Two
// bounded recovery triggers request ONE fresh snapshot via connect(true) (the
// existing full-rebuild reconcile path) so applySnapshot wholesale-replaces the
// detail layer and the tree.* frames re-seed the flat map; the open session
// stays exempt. This is the existing snapshot reconcile path — reused, not a
// new primitive.
//
// Triggers:
//   1. On-focus (visibilitychange → visible): immediate, heals drift a
//      backgrounded tab accumulated while iOS suspended its socket. Throttled
//      by TREE_RESYNC_MIN_GAP_MS so a focus burst can't reconnect repeatedly.
//   2. Periodic (Q6): a LOW-frequency (~10min + jitter) catch-all for a
//      CONTINUOUSLY-FOREGROUNDED tab whose live stream silently missed an event
//      (an emitter gap the on-focus trigger never sees because the tab never
//      backgrounded). This is NOT the old unconditional 90s cadence — it runs
//      ONLY when every precondition in periodicResyncShouldRun() holds, and
//      resets after any successful authoritative recovery. See the Q6 block
//      below for the full contract.
//
// Cost ≈ 88 KB compressed per resync; at the ~10min cadence that is ≈0.5 MB/hr
// through the at-rest tunnel (vs the old 90s cadence's ~3.5 MB/hr).
//
// Tunables:
//   TREE_RESYNC_MIN_GAP_MS           — dedup window shared by the on-focus +
//                                      periodic triggers (a periodic tick right
//                                      after an on-focus can't reconnect twice).
//   TREE_RESYNC_PERIODIC_INTERVAL_MS — base cadence for the periodic trigger.
//   TREE_RESYNC_PERIODIC_JITTER_MS   — ±jitter applied at each (re)scheduling,
//                                      so a fleet of tabs doesn't synchronized-burst.
export const TREE_RESYNC_MIN_GAP_MS = 30_000;
let lastTreeResync = 0;
export function resyncTree() {
  // No project selected → nothing to resync (connect(true) would no-op anyway).
  if (!projectDir()) return;
  // Let the watchdog own recovery of a closed/stale stream; a resync here would
  // only race it (maybeReconnect already reconnects a CLOSED tree). The value
  // of a resync is healing a HEALTHY-but-drifted tree, which is exactly the
  // closed-but-stale-by-sweep / missed-event case the optimization created.
  if (isTreeClosed()) return;
  const now = Date.now();
  if (now - lastTreeResync < TREE_RESYNC_MIN_GAP_MS) return;
  lastTreeResync = now;
  // A focus/periodic resync IS an equivalent recovery event — stamp the
  // boundary so the periodic "no recovery in the previous interval" gate
  // suppresses a redundant tick, and reschedule the periodic timer (push the
  // next periodic tick out by a full interval).
  markAuthoritativeRecovery();
  connect(true);
}

// Test-only accessor — resets the resync throttle gate so a test can exercise
// resyncTree() without waiting TREE_RESYNC_MIN_GAP_MS. Prefixed _ and suffixed
// ForTest so a grep keeps it visually distinct from runtime API.
export function _resetResyncGateForTest(): void {
  lastTreeResync = 0;
}

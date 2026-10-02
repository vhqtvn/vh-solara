// web/src/sync/liveness.ts — the end-to-end liveness SENTINEL (webperf
// slice 5 / F7 residual).
//
// WHY: liveness was INFERRED. The 15s SSE ping proves only that the worker's
// per-connection handler goroutine + socket are alive — NOT that the worker's
// ingest pipeline (opencode /event → aggregator → store emit fanout) still
// works. The watchdog's content-stale branches therefore had to GUESS: the
// idle path skips recovery (assumed-alive) and the active path forces a
// reconnect (assumed-dead). This module replaces both guesses with a PROVEN
// fact: it POSTs /vh/stream/probe?nonce=<random> (slice 4) and waits for the
// nonce to come back as a no-id `vh.liveness` SSE frame on one of the pane's
// open streams. Receipt proves the FULL worker store → subscribe channel →
// SSE handler → yamux tunnel → controller → browser path end-to-end.
//
// OWNERSHIP: this module owns ONLY the wire state — the pending nonce, the
// capability memo, and the SENTINEL_TIMEOUT timer. It imports nothing from
// the stream lifecycle modules (no cycle: health/session-stream/
// tree-transport import THIS; this imports store/recovery-reasons/log only).
// The DECISIONS (which clock to refresh, which recovery to run) stay with the
// caller via the SentinelHandlers callbacks, so each stream's lifecycle owner
// keeps its own recovery path.
//
// Broadcast note: the worker emits vh.liveness via state.Store.EmitTransient,
// which reaches EVERY live subscriber of the project store (tree stream AND
// message-filtered session streams — Interest is a message-class flood
// filter and transients bypass it). Both streams register a
// noteLivenessFrame listener; whichever receives the frame FIRST resolves
// the pending probe ("whichever-first" correlation — the proof is about the
// WORKER pipeline, not one socket; an individually-dead socket stops
// delivering its pings too and converges via the transport-stale branch).
//
// Version skew: a 404/405 on the probe POST means an OLD worker (no route).
// The capability is memoized unavailable for the page/session lifetime (a
// PWA reload re-probes — skew is transient) and the caller's onLegacy runs
// today's exact heuristic (idle-skip / active-force). No retries.

import { projectDir } from "./store";
import { countRecovery } from "./recovery-reasons";
import { log } from "../lib/log";

// SENTINEL_TIMEOUT_MS — how long the watchdog waits for the nonce to come
// back before declaring the pipeline dead and recovering. Budget: the
// observed controller-tunnel RTT is ~110–120 ms; a probe round-trip is one
// POST response + one SSE frame already in flight on an OPEN stream, so the
// healthy case resolves in well under 1 s even with yamux window
// backpressure, JS event-loop queuing on a busy tab, and a slow mobile CPU.
// 12 s is ~2 orders of magnitude of headroom over that budget — generous
// enough to never false-positive on jitter, while staying an order of
// magnitude BELOW CONTENT_STALE_MS (120 s) so total detection time
// (CONTENT_STALE_MS + SENTINEL_TIMEOUT_MS ≈ 132 s) stays within the
// watchdog's existing recovery envelope (~130 s).
export const SENTINEL_TIMEOUT_MS = 12_000;

export type SentinelStream = "tree" | "session";

// SentinelHandlers — the caller-owned decisions, invoked at most once per
// issued probe (settle() clears the pending state first, so a late frame or
// a straggling timer cannot double-fire).
export interface SentinelHandlers {
  /** The nonce came back on an open stream: pipeline PROVEN alive. Refresh
   *  the stale clock; do NOT recover. */
  onProven(): void;
  /** SENTINEL_TIMEOUT elapsed with no frame: pipeline presumed dead. Run the
   *  cursor-PRESERVING recovery. */
  onTimeout(): void;
  /** Probe answered 404/405 (old worker): legacy heuristic, exactly today's
   *  behavior for the boundary that issued the probe. */
  onLegacy(): void;
}

// capabilityUnavailable — memo once a probe answers 404/405: the worker has
// no /vh/stream/probe route, so every future boundary goes straight to the
// legacy heuristic with zero extra round-trips. Page-lifetime memo (module
// state); a reload re-probes.
let capabilityUnavailable = false;

// Pending-probe state. ONE probe in flight at a time per pane: the watchdog
// evaluates both streams each tick, but a single proof covers the worker
// pipeline for whichever boundary issued it; the other stream's boundary
// (still stale) probes on a following tick — bounded delay, no burst.
// (The issuing stream is NOT tracked as state: no decision reads it — the
// handlers close over their own stream, and correlation is nonce-only.)
let pendingNonce: string | null = null;
let pendingTimer: number | undefined;
let pendingHandlers: SentinelHandlers | null = null;

/** Whether the sentinel is usable (probe route known present on this worker). */
export function livenessCapabilityAvailable(): boolean {
  return !capabilityUnavailable;
}

// genNonce — client-generated correlation token. Prefer crypto.randomUUID
// (browser + Node/jsdom vitest both provide it on globalThis.crypto); fall
// back to Math.random+Date.now for exotic runtimes. Uniqueness per pane is
// all that is required (the nonce scopes the broadcast to THIS probe).
function genNonce(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

// settle clears the pending probe (timer + state) exactly once. Callers
// capture the handlers BEFORE settling so the callback runs on settled state.
function settle(): void {
  clearTimeout(pendingTimer);
  pendingTimer = undefined;
  pendingNonce = null;
  pendingHandlers = null;
}

/**
 * Issue one liveness probe for the given stream's content-stale boundary.
 * Returns false when the sentinel cannot take the decision — capability
 * unavailable (404 memo'd) or a probe already in flight (this tick stands
 * down; the pending probe's resolution covers the worker-pipeline question).
 * Otherwise returns true and owns the decision until proof/timeout/legacy.
 */
export function issueLivenessProbe(stream: SentinelStream, handlers: SentinelHandlers): boolean {
  if (capabilityUnavailable) return false;
  if (pendingNonce !== null) return false; // one in flight — its outcome covers this boundary's turn
  const nonce = genNonce();
  pendingNonce = nonce;
  pendingHandlers = handlers;
  countRecovery("sentinel-probe-issued");
  log.debug("sync", "liveness sentinel probe issued", { stream, nonce });
  pendingTimer = window.setTimeout(() => {
    if (pendingNonce !== nonce) return; // already settled (race-safe no-op)
    const h = pendingHandlers;
    settle();
    countRecovery("sentinel-timeout");
    log.warn("sync", "liveness sentinel TIMEOUT → cursor-preserving recovery", { stream, nonce });
    h?.onTimeout();
  }, SENTINEL_TIMEOUT_MS);
  fetch(
    `/vh/stream/probe?nonce=${encodeURIComponent(nonce)}&dir=${encodeURIComponent(projectDir())}`,
    { method: "POST" },
  )
    .then((res) => {
      if (pendingNonce !== nonce) return; // already settled by the frame
      if (res.status === 404 || res.status === 405) {
        // Old worker: no probe route. Memo unavailable for the page
        // lifetime, then run the caller's legacy heuristic. The reason code
        // is counted + logged here (single site).
        capabilityUnavailable = true;
        const h = pendingHandlers;
        settle();
        countRecovery("sentinel-legacy-fallback");
        log.info("sync", "liveness probe 404/405 — old worker, sentinel disabled for session lifetime (sentinel-legacy-fallback)", {
          stream,
          status: res.status,
        });
        h?.onLegacy();
        return;
      }
      // Other statuses (200 answered but frame lost, 5xx, …): leave the
      // timer armed — the vh.liveness frame is the authority, and the
      // timeout bounds the wait either way.
    })
    .catch(() => {
      // Transport-level fetch failure (worker unreachable): keep the timer
      // armed. If the tunnel is down the SSE pings stop too and the
      // transport-stale branch handles it; otherwise the timeout decides.
    });
  return true;
}

/**
 * Feed one observed `vh.liveness` SSE frame (the raw data payload) into the
 * correlation matcher. Registered by BOTH stream lifecycle owners
 * (tree-transport + session-stream); whichever receives the broadcast first
 * calls this. A frame with no pending probe, a foreign nonce, or an
 * unparseable payload is ignored (a stray late echo must never refresh a
 * clock the probe is not currently measuring).
 */
export function noteLivenessFrame(data: string): void {
  if (pendingNonce === null) return;
  let nonce = "";
  try {
    nonce = String((JSON.parse(data) as any)?.nonce ?? "");
  } catch {
    return; // malformed frame — keep waiting (timeout bounds)
  }
  if (!nonce || nonce !== pendingNonce) return;
  const h = pendingHandlers;
  settle();
  countRecovery("sentinel-alive");
  log.debug("sync", "liveness sentinel PROVEN alive — clock refreshed, no recovery", { nonce });
  h?.onProven();
}

// --- test-only ---------------------------------------------------------------

/** Reset ALL sentinel state (pending probe, capability memo). Test isolation. */
export function _resetSentinelForTest(): void {
  settle();
  capabilityUnavailable = false;
}

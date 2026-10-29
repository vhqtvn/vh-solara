// Slice B (send-net-resilience) — the shared graded ConnStatus reduction.
// BINDING CONTRACT: researches/decisions/2026-10-10-send-convergence-cascade-
// and-connstatus.md (debate-1 Q5 + debate-3 A6).
//
// ── BINDING POLICY (debate-1 Q5 — never violate) ────────────────────────────
// Grades/thresholds/ConnStatus are OBSERVATIONAL ONLY: never retry, delivery,
// or redelivery authority. All auto-redelivery authority stays exactly where
// slices 1-5 put it (C1/C2/C3 certified classes; C4 never auto-POST; exact-ID
// GET sole delivery authority). navigator.onLine and the daemon tunnel signal
// are STATUS INPUTS, not send triggers. This module therefore owns ZERO
// side effects beyond its own signal updates — it never calls connect(),
// fetchQueue, or any reconcile surface.
//
// ── Inputs (debate-3 A6 precedence) ─────────────────────────────────────────
//   1. daemon tunnel-down (fresh "disconnected")  → reconnecting  (dominates)
//   2. navigator.offline                          → offline       (dominates)
//   3. client observations (store status)         → browser reachability
//   4. live requires: store "live" AND no pending cascade convergence AND a
//      non-down tunnel reading ("unknown" does NOT block live — honest
//      degradation for local-server / fixture topologies with no provider).
//
// "unknown ≠ down" is the external/controller-topology honesty rule: absence
// of the X-VH-Tunnel-State header (local-server, fixture server, or a stale
// observation past TUNNEL_FRESH_MS) says NOTHING about the tunnel.
//
// ── Tuning-consumer rule ────────────────────────────────────────────────────
// Every threshold below ships ASSUMPTION-labeled. The 4c FE-vantage baseline
// (window.__vhSyncDiag, recovery-reasons.ts + weaklink.ts) is the ONLY
// legitimate tuning consumer — never daemon-only proxy metrics.
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { state } from "./store";
import { isStale } from "./health";
import { isUpdating } from "./reconcile";
import { STALE_MS } from "./stream";
import { readWeakLink } from "./weaklink";
import { cascadeRecoveryPending, subscribeCascadeState } from "./cascade";
import { noteConnGradeTransition } from "./diaglog";

// The graded connection status. "offline" = the BROWSER has no network
// (navigator.offline); "reconnecting" = any hard-down observation (tunnel
// down, socket reconnecting, or post-reconnect convergence outstanding);
// "degraded" = live but with weak positive evidence (tree stale past the
// tuned STALE_MS, or a recent FE-vantage fetch-failure spike); "live" =
// connected and converged.
export type ConnGrade = "live" | "degraded" | "reconnecting" | "offline";

// The daemon tunnel state as observed from response headers.
// "unknown" = no fresh observation (absence ≠ down — see header).
export type TunnelSignal = "connected" | "disconnected" | "unknown";

export interface ConnStatusModel {
  grade: ConnGrade;
  // Vocabulary facet for consumers that still speak the 3-state socket
  // language: the store's hard-socket phase when grade is "reconnecting".
  phase: "connecting" | "reconnecting" | null;
  // Evidence facets (mirrored for consumers + tips).
  stale: boolean;
  syncing: boolean;
  tunnel: TunnelSignal;
  reasons: string[];
}

export interface ConnStatusInput {
  status: "connecting" | "live" | "reconnecting";
  navigatorOnline: boolean;
  tunnel: TunnelSignal;
  cascadePending: boolean;
  stale: boolean;
  syncing: boolean;
  fetchFailureSpike: boolean;
}

/**
 * The ONE precedence reduction (pure — unit-tested directly). Order:
 * tunnel-down → reconnecting; navigator-offline → offline; hard socket
 * phases → reconnecting (phase preserved); live blocked while a cascade
 * pass still awaits convergence (debate-3 A6: live requires a successful
 * post-reconnect convergence); degraded = live-eligible with weak positive
 * evidence; else live.
 */
export function reduceConnStatus(i: ConnStatusInput): ConnStatusModel {
  // (1) Daemon tunnel-down dominates (debate-3 A6). Structurally rare vs
  // offline: with the browser offline no fresh headers can arrive, so the
  // tunnel reading decays to "unknown" and rule (2) governs.
  if (i.tunnel === "disconnected") {
    return { grade: "reconnecting", phase: "reconnecting", stale: i.stale, syncing: i.syncing, tunnel: "disconnected", reasons: ["tunnel-down"] };
  }
  // (2) Browser offline dominates everything else.
  if (!i.navigatorOnline) {
    return { grade: "offline", phase: null, stale: i.stale, syncing: i.syncing, tunnel: i.tunnel, reasons: ["navigator-offline"] };
  }
  // (3) Client hard-socket observations govern browser reachability.
  if (i.status === "reconnecting" || i.status === "connecting") {
    return { grade: "reconnecting", phase: i.status, stale: i.stale, syncing: false, tunnel: i.tunnel, reasons: [`socket-${i.status}`] };
  }
  // (4) Live requires the store live AND no pending convergence pass.
  if (i.status === "live") {
    if (i.cascadePending) {
      return { grade: "reconnecting", phase: "reconnecting", stale: i.stale, syncing: false, tunnel: i.tunnel, reasons: ["convergence-pending"] };
    }
    if (i.stale) {
      return { grade: "degraded", phase: null, stale: true, syncing: i.syncing, tunnel: i.tunnel, reasons: ["tree-stale"] };
    }
    if (i.fetchFailureSpike) {
      return { grade: "degraded", phase: null, stale: false, syncing: i.syncing, tunnel: i.tunnel, reasons: ["fetch-failure-spike"] };
    }
    return { grade: "live", phase: null, stale: false, syncing: i.syncing, tunnel: i.tunnel, reasons: [] };
  }
  // Unreachable with the closed status vocabulary; fail honest.
  return { grade: "reconnecting", phase: "reconnecting", stale: i.stale, syncing: false, tunnel: i.tunnel, reasons: ["unknown-status"] };
}

// ── Thresholds (ASSUMPTION-labeled; see the tuning-consumer rule) ───────────
// TUNNEL_FRESH_MS — how long an observed X-VH-Tunnel-State header stays
// authoritative before the reading decays back to "unknown". ASSUMPTION 30s:
// generous vs the queue's ~5s poll + focus refreshes (the header rides every
// /vh/* response), so a healthy topology refreshes it constantly; when the
// worker is truly unreachable, client observations (stream drop) dominate
// long before the decay lands. Tune ONLY from the 4c FE-vantage baseline
// (__vhSyncDiag weakLink + recovery counters), never daemon-only metrics.
export const TUNNEL_FRESH_MS = 30_000;
// DEGRADED_FETCH_FAILURES / DEGRADED_FETCH_WINDOW_MS — the FE-vantage
// fetch-failure spike that (alongside tree-stale) justifies the "degraded"
// grade. ASSUMPTION ≥2 failures within a 30s trailing window (evaluated on
// the ~5s health tick — weaklink keeps CUMULATIVE counters only, so the
// window is a between-evaluations diff). Counts network + http_5xx ONLY:
// the "abort" class is client-initiated (bounded action timeouts, unmount
// cancellations) and outcome-unknown — counting it would false-positive the
// degraded grade on ordinary deliberate aborts. These feed a purely
// observational grade; tune ONLY from the 4c FE-vantage baseline
// (__vhSyncDiag).
export const DEGRADED_FETCH_FAILURES = 2;
export const DEGRADED_FETCH_WINDOW_MS = 30_000;

// ── Reactive input wiring ───────────────────────────────────────────────────
const [navigatorOnline, setNavigatorOnline] = createSignal(true);
const [tunnelObserved, setTunnelObserved] = createSignal<{ state: "connected" | "disconnected"; at: number } | null>(null);
const [cascadePending, setCascadePending] = createSignal(false);

// Fetch-failure spike window (cumulative-counter diff; see threshold notes).
let ffWindowStart = 0;
let ffWindowBase = 0;
function fetchFailureTotal(): number {
  const f = readWeakLink().fetchFailures;
  // network + http_5xx only — see the threshold note above for the abort
  // exclusion rationale.
  return f.network + f.http_5xx;
}
function fetchFailureSpike(): boolean {
  const now = Date.now();
  if (now - ffWindowStart > DEGRADED_FETCH_WINDOW_MS) {
    ffWindowStart = now;
    ffWindowBase = fetchFailureTotal();
  }
  return fetchFailureTotal() - ffWindowBase >= DEGRADED_FETCH_FAILURES;
}

// The reactive model. Subscribes the coarse health tick (via isStale) so
// time-based decays (tunnel freshness, the failure window) re-evaluate on
// the ~5s tick even with no store writes — the same pattern as isStale.
const connMemo = createMemo((): ConnStatusModel => {
  isStale(); // subscribe healthNow (the coarse tick)
  const obs = tunnelObserved();
  const tunnel: TunnelSignal = !obs || Date.now() - obs.at > TUNNEL_FRESH_MS ? "unknown" : obs.state;
  return reduceConnStatus({
    status: state.status,
    navigatorOnline: navigatorOnline(),
    tunnel,
    cascadePending: cascadePending(),
    stale: isStale(),
    syncing: isUpdating() && state.status === "live",
    fetchFailureSpike: fetchFailureSpike(),
  });
});

/** The graded connection model (reactive). */
export function connModel(): ConnStatusModel {
  return connMemo();
}

// The grade alone, deduped by string equality — effect-key consumers
// (ConnectionToast / RestartOverlay) depend on this so a model re-evaluation
// that lands on the SAME grade (the ~5s health tick re-runs the memo, which
// returns a fresh object) does NOT re-fire their transitions/debounces.
const gradeMemo = createMemo((): ConnGrade => connMemo().grade);

/** The grade alone (string-deduped — use as an effect key). */
export function connGrade(): ConnGrade {
  return gradeMemo();
}

// ── Tunnel header sampler ───────────────────────────────────────────────────
// Mirrors weaklink.ts's installFetchSampler posture: a pass-through fetch
// wrapper (own idempotence latch), reading X-VH-Tunnel-State off /vh/*
// responses. EventSource cannot read response headers — the fetch path (the
// queue's ~5s poll, focus refreshes, sends) is the intended carrier; when
// the tunnel is down those fetches stop arriving, the observation ages out
// (TUNNEL_FRESH_MS), and the reading degrades honestly to "unknown" while
// client observations take over. Instrumentation ONLY.
export function installTunnelSampler(): void {
  const g = globalThis as unknown as { __vhTunnelSampled?: boolean };
  if (g.__vhTunnelSampled) return;
  g.__vhTunnelSampled = true;
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    orig(input, init).then((res: Response) => {
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/vh/")) {
          const v = res.headers.get("X-VH-Tunnel-State");
          if (v === "connected" || v === "disconnected") {
            setTunnelObserved({ state: v, at: Date.now() });
          }
        }
      } catch {
        // Never let observation affect the response.
      }
      return res;
    });
}

// ── Initialization (idempotent; wired from startSync) ───────────────────────
let connStatusInited = false;

// Grade-transition diag stamps (capture-2, 2026-10-29): the prior grade for
// the transition observer below. Tracked CONTINUOUSLY (even while diag
// capture is off) so enabling capture mid-flight still stamps the next
// genuine transition with a truthful from-grade.
let gradeDiagPrev: ConnGrade | null = null;

export function initConnStatus(): void {
  if (connStatusInited) return;
  connStatusInited = true;
  if (typeof navigator !== "undefined") {
    setNavigatorOnline(navigator.onLine);
    window.addEventListener("online", () => setNavigatorOnline(true));
    window.addEventListener("offline", () => setNavigatorOnline(false));
  }
  setCascadePending(cascadeRecoveryPending());
  subscribeCascadeState(setCascadePending);
  // The transition observer: record every genuine connstatus grade
  // transition into the diag ring with the landing grade's reasons, so a
  // capture can read exactly when/why the ConnectionToast cleared RELATIVE
  // to the stream-open applied@ stamps (already in the same ring). App-
  // lifetime root (never disposed — the same posture as startSync's own
  // createRoot effects). Cost: one string compare per model re-evaluation
  // (connMemo re-runs on the ~5s health tick + input writes — it returns a
  // fresh object each time, so this effect re-runs with it); the ring write
  // itself is default-off gated inside noteConnGradeTransition. The first
  // evaluation records the BASELINE only (not a transition — nothing is
  // stamped). OBSERVATIONAL ONLY (the module's binding policy: this owns
  // zero side effects beyond its own signals + this diag write).
  createRoot(() => {
    createEffect(() => {
      const m = connMemo();
      const prev = gradeDiagPrev;
      gradeDiagPrev = m.grade;
      if (prev === null || prev === m.grade) return;
      noteConnGradeTransition(prev, m.grade, m.reasons);
    });
  });
}

// ── Consumer mappings (one table per surface vocabulary) ────────────────────
// Sidebar StatusMark state (the indState ladder, now derived from the grade).
// "offline" is a NEW state class (same custom-prop palette as reconnecting —
// the visual vocabulary is preserved; the tip/aria carry the distinction).
export function statusMarkState(m: ConnStatusModel): string {
  if (m.grade === "offline") return "offline";
  if (m.grade === "reconnecting") return m.phase ?? "reconnecting";
  if (m.grade === "degraded") return "stale";
  return m.syncing ? "syncing" : "live";
}

// Sidebar StatusMark tip (grade-honest wording).
export function statusMarkTip(m: ConnStatusModel): string {
  if (m.grade === "offline") return "Status: offline — no network connection";
  if (m.grade === "reconnecting") {
    return m.phase === "connecting" ? "Status: connecting…" : "Status: reconnecting…";
  }
  if (m.grade === "degraded") {
    if (m.stale) return `Status: stale — no data for over ${Math.round(STALE_MS / 1000)}s`;
    return "Status: degraded — recent network errors";
  }
  if (m.syncing) return "Status: syncing…";
  return "Status: connected";
}

// SessionRail dot state (RailConn vocabulary + "offline").
export function railConnFromModel(m: ConnStatusModel): "live" | "syncing" | "stale" | "connecting" | "reconnecting" | "offline" {
  if (m.grade === "offline") return "offline";
  if (m.grade === "reconnecting") return m.phase ?? "reconnecting";
  if (m.grade === "degraded") return "stale";
  return m.syncing ? "syncing" : "live";
}

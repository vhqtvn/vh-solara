import { createSignal } from "solid-js";
import type {
  HostOps,
  LivenessState,
  PaneVm,
  PaneToHost,
  Survival,
  SurvivalBaseline,
} from "./types";

// Module-level singleton store. Signals created at module scope are fine in
// SolidJS: components that read them inside a tracking scope re-render on
// change. (Effects need a root — those live in the adapter component.)

const [panes, setPanes] = createSignal<PaneVm[]>([]);
const [focusedId, setFocusedId] = createSignal<string | null>(null);
const [trayIds, setTrayIds] = createSignal<string[]>([]);
const [isMaximized, setIsMaximized] = createSignal<boolean>(false);
const [connected, setConnected] = createSignal<boolean>(false);

export { panes, focusedId, trayIds, isMaximized, connected };

// ---- host imperative ops registry (set by DockviewHost, read by the shell) ----
// The shell (App, Tabstrip) calls layout ops through this typed HostOps surface
// instead of window.__host, so the shell never depends on the DEV-only test
// bridge. DockviewHost registers the same mutable `ops` object the
// HostController fills (installOps, onMount); the shell reads it with optional
// chaining — user clicks always land post-mount, so the methods are populated by
// then. This is the established shell⇄dockview sharing pattern (it mirrors the
// state mutators below): it is NOT DEV-gated and it is NOT the test bridge.
let hostOpsRef: HostOps | null = null;
export function setHostOps(ops: HostOps): void {
  hostOpsRef = ops;
}
export function hostOps(): HostOps | null {
  return hostOpsRef;
}

// ---- per-pane survival + document-liveness tracking -----------------------
// See docs/heartbeat-protocol.md for the full contract. In brief:
//   - survivalMap[paneId]   = last ACCEPTED heartbeat's Survival identity
//   - baselineMap[paneId]   = first-observed identity (survival-gate reference)
//   - configuredOrigin[id]  = the pane's server origin (from params.url); the
//                             host rejects heartbeats whose event.origin differs
//                             (constraint #3 — origin-only is insufficient)
//   - pendingLoad[id]       = set on iframe load; the first post-load heartbeat
//                             is accepted as the new identity (constraint #4),
//                             and must echo the issued challenge nonce
//                             (expectedNonce[id]) when one is outstanding
//   - expectedNonce[id]     = the challenge nonce issued by sendHandshake for
//                             the current pending load; verified on the first
//                             post-load heartbeat (constraint #4 — the host
//                             knows the expected value before accepting it)
//   - reloadDetectedAt[id]  = when a reload (identity change) was last observed;
//                             the "reloaded" indicator state shows for a window
//                             after this, then reverts to "document alive"
//
// The `connected` signal above is a GLOBAL "any heartbeat ever accepted" flag —
// it is INTERNAL (the DEV test bridge + a few specs wait on it for readiness).
// The user-visible indicator uses livenessFor() (Q1-C states), never `connected`.

/** Liveness thresholds (see docs/heartbeat-protocol.md §6). */
const STALE_MS = 3000; // ≈12 missed beats at 4 Hz → "no recent signal"
const RELOAD_SHOW_MS = 4000; // "reloaded" display window before reverting to alive
const CLOCK_TICK_MS = 500; // ≈2 Hz re-evaluation

const survivalMap = new Map<string, Survival>();
const baselineMap = new Map<string, SurvivalBaseline>();
const configuredOrigin = new Map<string, string>();
const pendingLoad = new Map<string, boolean>();
const reloadDetectedAt = new Map<string, number>();
// expectedNonce[id] = the challenge nonce the host issued for the pane's current
// pending load (constraint #4). Set in sendHandshake; verified in routeMessage:
// while pendingLoad is true, the first post-load heartbeat MUST echo this value
// or it is rejected as stale (identity NOT established). Always set for real
// panes (the renderer issues a handshake on every load); undefined only for the
// DEV scratch-pane surface when no handshake has been issued yet.
const expectedNonce = new Map<string, string>();
// contentWindow → paneId, so the single message listener can route heartbeats.
const sourceMap = new WeakMap<Window, string>();

// Monotonic-ish clock tick (≈2 Hz) so staleness + the reloaded window expire
// reactively. Read inside livenessFor() to make the SolidJS tracking re-evaluate.
const [nowTick, setNowTick] = createSignal<number>(Date.now());
if (typeof window !== "undefined") {
  window.setInterval(() => setNowTick(Date.now()), CLOCK_TICK_MS);
}

export function survivalFor(id: string): Survival | undefined {
  return survivalMap.get(id);
}
export function baselineFor(id: string): SurvivalBaseline | undefined {
  return baselineMap.get(id);
}
export function resetBaseline(id: string): void {
  // Force a fresh baseline from the current heartbeat (used after a known
  // reload, e.g. a negative control, so the NEXT assertion compares against
  // the post-reload identity).
  const s = survivalMap.get(id);
  if (s) baselineMap.set(id, { mountTs: s.mountTs, nonce: s.nonce, connId: s.connId });
  else baselineMap.delete(id);
}

/** Bind a pane's configured server origin (constraint #3 origin check). */
export function bindPaneOrigin(id: string, origin: string): void {
  configuredOrigin.set(id, origin);
}
export function configuredOriginFor(id: string): string | undefined {
  return configuredOrigin.get(id);
}

/** The challenge nonce the host issued for the pane's current pending load. */
export function expectedNonceFor(id: string): string | undefined {
  return expectedNonce.get(id);
}

// ---- [DEV/TEST] scratch protocol pane --------------------------------------
// A self-contained mini-pane for deterministic protocol-logic e2e (origin/
// window/nonce rejection) WITHOUT a real heartbeating iframe. The scratch pane
// binds a sentinel source object + configured origin + a pending load; tests
// probe it via routeMessage(sentinel, origin, payload). It is NOT a Dockview
// panel (no iframe, no real heartbeat stream), so probes have full control over
// timing/nonce/origin. Cleaned up via unregisterPane(id). Used only by the
// DEV-only window.__host bridge (see hostController.installTestBridge).
const scratchSentinels = new Map<string, object>();
export function bindScratchSource(id: string, origin: string): object {
  bindPaneOrigin(id, origin);
  noteIframeLoad(id);
  const sentinel: object = {};
  scratchSentinels.set(id, sentinel);
  sourceMap.set(sentinel as Window, id);
  return sentinel;
}
export function scratchSource(id: string): object | undefined {
  return scratchSentinels.get(id);
}

/**
 * Mark that the pane's iframe just (re)loaded. Sets the pending-load flag so the
 * NEXT accepted heartbeat establishes a fresh identity for this document
 * (constraint #4). Called by the renderer on the iframe `load` event and by the
 * `naiveReload` negative-control hook (which bypasses the renderer's listener).
 */
export function noteIframeLoad(id: string): void {
  pendingLoad.set(id, true);
}

/**
 * Issue the document-liveness handshake (constraint #2 + #4) to a pane's bound
 * content window. Carries a fresh challenge nonce the SPA echoes back; targeted
 * to the pane's configured origin (never '*'). Used by the renderer on iframe
 * load and by the `naiveReload` negative-control hook. The issued nonce is
 * remembered (expectedNonce) so routeMessage can verify the first post-load
 * heartbeat against it. No-op if the pane has no configured origin yet.
 */
export function sendHandshake(id: string): void {
  const origin = configuredOrigin.get(id);
  if (!origin) return;
  // Generate + remember the challenge for this load (constraint #4: the host
  // knows the expected value before accepting a heartbeat). Stored whenever a
  // handshake is issued; the first post-load heartbeat must echo it.
  const nonce = genNonce();
  expectedNonce.set(id, nonce);
  const cw = lookupContentWindow(id);
  if (cw) cw.postMessage({ type: "vh-host-handshake", nonce }, origin);
}

/** Fresh challenge nonce (crypto.randomUUID with a Math.random fallback). */
export function genNonce(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && "randomUUID" in c) return c.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Compute the Q1-C document-liveness state for a pane. Reads `nowTick` so the
 * result is reactive (staleness + the reloaded window expire without another
 * heartbeat arriving). This is document/SPA liveness ONLY — never SSE/realtime.
 */
export function livenessFor(id: string): LivenessState {
  void nowTick(); // track the clock so staleness re-evaluates
  const s = survivalMap.get(id);
  if (!s) return "no-signal";
  if (Date.now() - s.lastSeen > STALE_MS) return "no-signal";
  const reloadedAt = reloadDetectedAt.get(id);
  if (reloadedAt !== undefined && Date.now() - reloadedAt < RELOAD_SHOW_MS) {
    return "reloaded";
  }
  return "alive";
}

export function unregisterPane(id: string): void {
  survivalMap.delete(id);
  baselineMap.delete(id);
  configuredOrigin.delete(id);
  pendingLoad.delete(id);
  reloadDetectedAt.delete(id);
  expectedNonce.delete(id);
  setPanes((list) => list.filter((p) => p.id !== id));
  setTrayIds((list) => list.filter((t) => t !== id));
  setFocusedId((cur) => (cur === id ? null : cur));
}

// ---- shell view-model mutators (called by the controller from dockview) ----

export function upsertPaneVm(vm: PaneVm): void {
  setPanes((list) => {
    const i = list.findIndex((p) => p.id === vm.id);
    if (i === -1) return [...list, vm];
    const copy = list.slice();
    copy[i] = vm;
    return copy;
  });
}

export function setFocused(id: string | null): void {
  setFocusedId(id);
}

export function setTray(ids: string[]): void {
  setTrayIds(ids);
}

export function addTray(id: string): void {
  setTrayIds((list) => (list.includes(id) ? list : [...list, id]));
}

export function removeTray(id: string): void {
  setTrayIds((list) => list.filter((t) => t !== id));
}

export function setMaximized(v: boolean): void {
  setIsMaximized(v);
}

// ---- central message router (ONE listener for all panes) ------------------

export type RouteReason =
  | "ignored-non-pane-to-host"
  | "rejected:unknown-source" // wrong window (constraint #3)
  | "rejected:origin-mismatch" // wrong origin (constraint #3)
  | "rejected:stale-nonce" // wrong/stale nonce: foreign while pendingLoad, or stale w/o a load (constraint #4)
  | "accepted:first-after-load" // established new identity
  | "accepted:reload" // established new identity AND identity changed (reload)
  | "accepted:stable" // identity unchanged
  | "accepted:non-heartbeat"; // title/route (source-bound display only)

export interface RouteResult {
  routed: boolean; // matched a known pane (source-bound)
  paneId: string | null;
  accepted: boolean;
  reason: RouteReason;
}

/**
 * Route + apply one inbound message. Extracted from onMessage so the DEV test
 * bridge can synthesize messages (origin/window/nonce tests) through the SAME
 * path the real listener uses. `src` is the MessageEvent.source window; for a
 * synthetic probe the caller may pass the bound contentWindow of a pane.
 *
 * Heartbeats are accepted only when source+origin bind to a pane (constraint
 * #3) AND the nonce is fresh per the load lifecycle (constraint #4). title/
 * route messages are accepted on source-binding alone (display-only, no
 * liveness semantics — see docs/heartbeat-protocol.md §5).
 */
export function routeMessage(
  src: Window | null,
  origin: string,
  data: unknown,
): RouteResult {
  if (!data || typeof data !== "object") return { routed: false, paneId: null, accepted: false, reason: "ignored-non-pane-to-host" };
  const d = data as Partial<PaneToHost>;
  if (typeof d.type !== "string") {
    return { routed: false, paneId: null, accepted: false, reason: "ignored-non-pane-to-host" };
  }

  const paneId = src ? (sourceMap.get(src) ?? null) : null;
  if (!paneId) {
    return { routed: false, paneId: null, accepted: false, reason: "rejected:unknown-source" };
  }

  switch (d.type) {
    case "heartbeat": {
      // Validate the minimal payload shape (constraint #5). A malformed/spoofed
      // heartbeat is ignored entirely rather than polluting state with
      // undefined identity fields.
      if (
        typeof d.mountTs !== "number" ||
        typeof d.nonce !== "string" ||
        typeof d.uptime !== "number"
      ) {
        return { routed: false, paneId: null, accepted: false, reason: "ignored-non-pane-to-host" };
      }
      // Constraint #3: origin must match the pane's configured server origin.
      const expected = configuredOrigin.get(paneId);
      if (expected !== undefined && origin !== expected) {
        return { routed: true, paneId, accepted: false, reason: "rejected:origin-mismatch" };
      }
      const mountTs = d.mountTs;
      const nonce = d.nonce;
      const uptime = d.uptime;
      const prev = survivalMap.get(paneId);

      // Constraint #4: nonce freshness via the load lifecycle.
      if (pendingLoad.get(paneId)) {
        // While a load is pending, the first heartbeat must echo the challenge
        // nonce the host issued for THIS load (sendHandshake stored it in
        // expectedNonce). A foreign nonce is REJECTED as stale — identity is
        // NOT established and pendingLoad stays set (treated like a wrong-
        // origin/wrong-window rejection). When no challenge was issued (DEV
        // scratch surface only), there is nothing to verify against, so the
        // first post-load heartbeat is accepted as before.
        const issued = expectedNonce.get(paneId);
        if (issued !== undefined && nonce !== issued) {
          return { routed: true, paneId, accepted: false, reason: "rejected:stale-nonce" };
        }
        // First heartbeat after a (re)load — establishes this document's
        // identity. If a previous identity existed and differs, this is a reload.
        pendingLoad.set(paneId, false);
        const isReload =
          !!prev && (prev.mountTs !== mountTs || prev.nonce !== nonce);
        applyAccepted(paneId, d, mountTs, nonce, uptime);
        if (isReload) reloadDetectedAt.set(paneId, Date.now());
        setConnected(true);
        return {
          routed: true,
          paneId,
          accepted: true,
          reason: isReload ? "accepted:reload" : "accepted:first-after-load",
        };
      }
      // No pending load: the heartbeat must carry the established identity's
      // nonce, else it's stale (a previous document's heartbeat or a spoof).
      if (prev && prev.nonce === nonce) {
        applyAccepted(paneId, d, mountTs, nonce, uptime);
        setConnected(true);
        return { routed: true, paneId, accepted: true, reason: "accepted:stable" };
      }
      return { routed: true, paneId, accepted: false, reason: "rejected:stale-nonce" };
    }
    case "title": {
      setPanes((list) =>
        list.map((p) => (p.id === paneId ? { ...p, title: d.title! } : p)),
      );
      return { routed: true, paneId, accepted: true, reason: "accepted:non-heartbeat" };
    }
    case "route": {
      // route changes are accepted but not surfaced beyond the title for Phase 1
      return { routed: true, paneId, accepted: true, reason: "accepted:non-heartbeat" };
    }
    default:
      return { routed: false, paneId: null, accepted: false, reason: "ignored-non-pane-to-host" };
  }
}

/** Store an accepted heartbeat's Survival (connId/src optional — mock stand-in). */
function applyAccepted(
  paneId: string,
  d: Partial<PaneToHost>,
  mountTs: number,
  nonce: string,
  uptime: number,
): void {
  if (d.type !== "heartbeat") return;
  const s: Survival = {
    mountTs,
    nonce,
    uptime,
    connId: d.connId ?? null,
    src: d.src ?? "",
    lastSeen: Date.now(),
  };
  survivalMap.set(paneId, s);
  if (!baselineMap.has(paneId)) {
    baselineMap.set(paneId, { mountTs: s.mountTs, nonce: s.nonce, connId: s.connId });
  }
}

function onMessage(ev: MessageEvent): void {
  routeMessage(ev.source as Window | null, ev.origin, ev.data);
}

if (typeof window !== "undefined") {
  window.addEventListener("message", onMessage);
}

// id → contentWindow reverse map (populated by the controller, used for
// host→pane focus/blur + handshake delivery). Kept here next to the forward map.
const cwById = new Map<string, Window>();
export function bindContentWindow(id: string, cw: Window): void {
  cwById.set(id, cw);
  sourceMap.set(cw, id);
}
export function lookupContentWindow(id: string): Window | null {
  return cwById.get(id) ?? null;
}
export function unbindContentWindow(id: string): void {
  cwById.delete(id);
}

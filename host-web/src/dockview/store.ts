import { createSignal } from "solid-js";
import type { DockviewApi } from "dockview-core";
import type {
  Attention,
  Activity,
  HostOps,
  LivenessState,
  PaneStatus,
  PaneVm,
  PaneToHost,
  Survival,
  SurvivalBaseline,
} from "./types";
import {
  hadSavedStateAtInit,
  loadWorkspaceSet,
  scheduleSave,
  setSerializeAllFn,
} from "./layoutPersistence";

// Module-level singleton store. Signals created at module scope are fine in
// SolidJS: components that read them inside a tracking scope re-render on
// change. (Effects need a root — those live in the adapter component.)

// ============================================================================
// MULTI-WORKSPACE MODEL
//
// The host shell models N workspaces, each its own isolated Dockview layout
// tree of server panes. Switching workspaces is CSS-visibility-only (see
// App.tsx's overlay stack) — every iframe stays permanently mounted in its own
// host, so a switch NEVER reloads any iframe (the load-bearing survival
// guarantee; proven by the workspace-switch survival gate).
//
// Per-workspace DockviewApis are registered here as each host mounts. The
// per-workspace HostOps facet is registered too, and hostOps() resolves the
// ACTIVE workspace's facet at call time so shell ops route to the active
// workspace's live tree.
//
// DISPLAY PROJECTION: the panes/focusedId/trayIds/isMaximized signals reflect
// ONLY the active workspace (the shell renders the active workspace's chrome).
// Background-workspace writes are guarded out at the mutator level; on a
// workspace switch the newly-active host re-syncs these signals from its api.
// Survival/liveness state (survivalMap etc.) is GLOBAL, keyed by paneId (pane
// ids are unique across the whole app), so it is NOT workspace-scoped — a
// background workspace's panes keep heartbeating and their identity survives.
// ============================================================================

export interface Workspace {
  id: string;
  name: string;
}

let wsSeq = 0;
/** Stable workspace id generator (unique within a session + across reloads when
 *  combined with the persisted set). */
function nextWsId(): string {
  wsSeq += 1;
  return `ws-${wsSeq}`;
}

/** Build the initial workspace set. When a valid v2 blob exists, restore the
 *  persisted set (+ active id); otherwise create a single default workspace
 *  whose id is the seed target for fleet/mock panes. */
function initWorkspaces(): {
  list: Workspace[];
  activeId: string;
  seedId: string | null;
} {
  const saved = loadWorkspaceSet();
  if (saved) {
    // Restore: workspace ids/names from the blob; advance the counter past any
    // numeric suffix so a runtime addWorkspace does not collide.
    for (const w of saved.workspaces) {
      const m = /^ws-(\d+)$/.exec(w.id);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n > wsSeq) wsSeq = n;
      }
    }
    return {
      list: saved.workspaces.map((w) => ({ id: w.id, name: w.name })),
      activeId: saved.activeWorkspaceId,
      seedId: null, // blob present → each workspace cold-restores its own layout
    };
  }
  // No blob (first load): one default workspace; it seeds the fleet/mock fleet.
  const id = nextWsId();
  return { list: [{ id, name: "Workspace 1" }], activeId: id, seedId: id };
}

const initial = initWorkspaces();
const [workspaces, setWorkspaces] = createSignal<Workspace[]>(initial.list);
const [activeWorkspaceId, setActiveWorkspaceIdSignal] = createSignal<string>(
  initial.activeId,
);
/** The workspace that should seed the fleet/mock fleet on cold init (the default
 *  workspace when there was no blob; null otherwise). Runtime-added workspaces
 *  are never seed targets — they start empty (the empty-workspace affordance). */
const seedWorkspaceId: string | null = hadSavedStateAtInit() ? null : initial.seedId;

export { workspaces, activeWorkspaceId };

/** True iff this workspace should seed the fleet/mock fleet at cold init. Only
 *  the default workspace when there was no saved blob; false for every other
 *  workspace (restored-from-blob or runtime-added). */
export function shouldSeedWorkspace(wsId: string): boolean {
  return seedWorkspaceId !== null && wsId === seedWorkspaceId;
}

/** Register the serializer the debounced persistence writer calls, sourced from
 *  the live workspace list + the per-workspace DockviewApi registry. Registered
 *  once at module load so scheduleSave() always has a current snapshot. */
setSerializeAllFn(() => {
  const list = workspaces();
  return {
    activeWorkspaceId: activeWorkspaceId(),
    workspaces: list.map((ws) => ({
      id: ws.id,
      name: ws.name,
      layout: workspaceApis.get(ws.id)?.toJSON() ?? null,
    })),
  };
});

// ---- workspace add / close / activate --------------------------------------

/** Per-workspace "became active" re-sync callback (registered by each host's
 *  controller so the display signals re-project from the now-active api on a
 *  switch). Keyed by workspace id. */
const workspaceSyncCbs = new Map<string, () => void>();
export function registerWorkspaceSync(wsId: string, cb: () => void): void {
  workspaceSyncCbs.set(wsId, cb);
}
export function unregisterWorkspaceSync(wsId: string): void {
  workspaceSyncCbs.delete(wsId);
}

/**
 * Switch the active workspace. CSS-visibility-only (App.tsx's overlay stack
 * toggles classes); this does NOT touch any DockviewApi, dispose any host, or
 * reload any iframe. After setting the signal, the newly-active workspace's
 * sync callback re-projects the display signals (panes/focus/tray/maximize)
 * from its api. If that host has not mounted yet (a freshly-created workspace),
 * its onMount will sync itself when it becomes active.
 */
export function setActiveWorkspace(id: string): void {
  if (id === activeWorkspaceId()) return;
  if (!workspaces().some((w) => w.id === id)) return; // unknown ws — no-op
  setActiveWorkspaceIdSignal(id);
  scheduleSave(); // remember the active workspace for the next reload
  workspaceSyncCbs.get(id)?.();
}

/**
 * Create + activate a new (empty) workspace. The new host mounts empty — no seed
 * (only the default workspace on a first-ever load seeds the fleet). Returns the
 * new workspace id. Triggers a debounced save so the workspace set persists.
 */
export function addWorkspace(name?: string): string {
  const id = nextWsId();
  const ws: Workspace = {
    id,
    name: name?.trim() || `Workspace ${workspaces().length + 1}`,
  };
  setWorkspaces((list) => [...list, ws]);
  setActiveWorkspaceIdSignal(id);
  scheduleSave();
  return id;
}

/**
 * Close (destroy) a workspace. Removing it from the workspaces signal makes
 * SolidJS <For> unmount that workspace's DockviewHost, whose onCleanup calls
 * api.dispose() (the SINGLE dispose — do NOT dispose here too, or Dockview
 * double-disposes). Disposing DOES reload that workspace's iframes — acceptable
 * because the workspace is being DESTROYED, not switched (switching is CSS-only
 * and never reloads). Refuses to close the last remaining workspace so the shell
 * never has zero. Returns true when closed.
 */
export function closeWorkspace(id: string): boolean {
  const list = workspaces();
  if (list.length <= 1) return false; // never zero workspaces
  if (!list.some((w) => w.id === id)) return false;
  setWorkspaces((l) => l.filter((w) => w.id !== id));
  // If we closed the active workspace, activate a remaining one (its host's
  // onCleanup + the active-switch sync handle display teardown). The destroyed
  // workspace's host unmounts via the <For> signal change → onCleanup disposes.
  if (activeWorkspaceId() === id) {
    const remaining = workspaces();
    if (remaining.length > 0) {
      setActiveWorkspaceIdSignal(remaining[0].id);
      workspaceSyncCbs.get(remaining[0].id)?.();
    }
  }
  scheduleSave();
  return true;
}

/** Rename a workspace (idempotent no-op when the name is unchanged).
 *
 *  NOTE: not currently wired to any UI/bridge caller. If/when wired, it MUST
 *  preserve the Workspace object's referential identity (App.tsx's <For> overlay
 *  stack keys hosts by reference — a spread-new-object rename would unmount +
 *  remount that workspace's host → cold fromJSON → EVERY iframe in it reloads,
 *  regressing the load-bearing survival guarantee). Use a Solid store/produce or
 *  a separate reactive name signal keyed by id, NOT a spread. */
export function renameWorkspace(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  setWorkspaces((list) =>
    list.map((w) => (w.id === id ? { ...w, name: trimmed } : w)),
  );
  scheduleSave();
}

// ============================================================================
// PER-WORKSPACE DOCKVIEW API + OPS REGISTRY
// ============================================================================

const workspaceApis = new Map<string, DockviewApi>();
export function registerWorkspaceApi(wsId: string, api: DockviewApi): void {
  workspaceApis.set(wsId, api);
}
export function unregisterWorkspaceApi(wsId: string): void {
  workspaceApis.delete(wsId);
}
export function workspaceApiFor(wsId: string): DockviewApi | undefined {
  return workspaceApis.get(wsId);
}

/** The per-workspace HostOps facet, registered by each controller. hostOps()
 *  resolves the ACTIVE workspace's facet so shell ops route to the active tree. */
const workspaceOpsByWs = new Map<string, HostOps>();
export function registerWorkspaceOps(wsId: string, ops: HostOps): void {
  workspaceOpsByWs.set(wsId, ops);
}
export function unregisterWorkspaceOps(wsId: string): void {
  workspaceOpsByWs.delete(wsId);
}

// ---- legacy single-facet accessor (kept for the shell's hostOps() reads) ----
// The shell (App, Tabstrip, AddServer) calls hostOps() and optional-chains the
// method it needs. With multi-workspace, hostOps() resolves the ACTIVE
// workspace's facet at call time, so a click always lands in the active tree.
let hostOpsRef: HostOps | null = null;
export function setHostOps(ops: HostOps): void {
  hostOpsRef = ops;
}
export function hostOps(): HostOps | null {
  const ws = activeWorkspaceId();
  if (ws) {
    const ops = workspaceOpsByWs.get(ws);
    if (ops) return ops;
  }
  // Fall back to the legacy single facet (the first host to mount registers it
  // before the workspace map is populated) so nothing breaks during the brief
  // cold-init window. User clicks always land post-mount.
  return hostOpsRef;
}

// ============================================================================
// DISPLAY PROJECTION (active workspace only)
//
// panes / focusedId / trayIds / isMaximized reflect the ACTIVE workspace. Writes
// are guarded by the writer's workspace id (background writes are dropped); the
// active host's sync callback re-derives them from its api on a switch.
// ============================================================================

const [panes, setPanes] = createSignal<PaneVm[]>([]);
const [focusedId, setFocusedId] = createSignal<string | null>(null);
const [trayIds, setTrayIds] = createSignal<string[]>([]);
const [isMaximized, setIsMaximized] = createSignal<boolean>(false);
const [connected, setConnected] = createSignal<boolean>(false);
// P1: count of ACTIVE-workspace panes whose session needs operator input
// (needs_permission or needs_reply). Drives the workspace-aggregate badge.
// Recomputed on every status store and on every active-workspace pane-list
// change (setPanesVm). P1 scope: active-workspace aggregate only (background
// workspaces' panes are not in the display projection); the per-pane header
// indicator carries the load-bearing signal regardless of workspace.
const [needsYouCount, setNeedsYouCount] = createSignal<number>(0);

export { panes, focusedId, trayIds, isMaximized, connected, needsYouCount };

/** Recompute the active-workspace needs-you aggregate from the current pane
 *  view-model. Called after a status store and after setPanesVm. Cheap: a small
 *  linear scan over the active panes. */
function recomputeNeedsYou(): void {
  let n = 0;
  for (const p of panes()) {
    const st = statusByPane.get(p.id);
    if (st && (st.attention === "needs_permission" || st.attention === "needs_reply")) n++;
  }
  setNeedsYouCount(n);
}

/** Clear the display projection (used by a host on unmount / dispose so a
 *  destroyed workspace's panes do not linger in the active view). */
export function clearDisplayFor(wsId: string): void {
  if (wsId !== activeWorkspaceId()) return;
  setPanes([]);
  setFocusedId(null);
  setTrayIds([]);
  setIsMaximized(false);
}

// ---- per-pane survival + document-liveness tracking -----------------------
// See docs/heartbeat-protocol.md for the full contract. This state is GLOBAL
// (keyed by paneId; pane ids are unique across the whole app), NOT workspace-
// scoped, so a background workspace's panes keep heartbeating and their identity
// survives a workspace switch unchanged. In brief:
//   - survivalMap[paneId]   = last ACCEPTED heartbeat's Survival identity
//   - baselineMap[paneId]   = first-observed identity (survival-gate reference)
//   - configuredOrigin[id]  = the pane's server origin (from params.url); the
//                             host rejects heartbeats whose event.origin differs
//                             (constraint #3 — origin-only is insufficient)
//   - pendingLoad[id]       = set on iframe load; the first post-load heartbeat
//                             is accepted as the new identity (constraint #4),
//                             and must echo the issued challenge nonce
//                             (expectedNonce[id]) when one is outstanding
//   - reloadDetectedAt[id]  = when a reload (identity change) was last observed;
//                             the "reloaded" indicator state shows for a window
//                             after this, then reverts to "document alive"
//   - titleFor(paneId)      = last reported pane title (survives a workspace
//                             switch because it is NOT active-workspace-scoped;
//                             syncPanes reads from it so a background pane's
//                             title update is not lost on the next switch)
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
const titleByPane = new Map<string, string>();
// P1 session-attention: last-reported status per pane (GLOBAL — survives
// workspace switches, like titleByPane). Keyed by paneId; the host NEVER trusts
// a sender-claimed server id (the pane is identified by its bound
// contentWindow, exactly like heartbeats/routes). See web/src/statusEmitter.ts.
const statusByPane = new Map<string, PaneStatus>();
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

/** The challenge nonce the host issued for a pane's current pending load. */
export function expectedNonceFor(id: string): string | undefined {
  return expectedNonce.get(id);
}

/** Last reported title for a pane (GLOBAL — survives workspace switches). */
export function titleFor(id: string): string | undefined {
  return titleByPane.get(id);
}
// P1: host-side length cap on ingested titles (defense-in-depth). Titles are
// OpenCode-authored plain session/project text (safe), but a cross-origin
// payload is capped at ingress so a pathological/malicious value can never
// blow up the header DOM or the persisted layout. ~120 chars matches typical
// session-title lengths with wide headroom.
const TITLE_CAP = 120;
function capTitle(t: string): string {
  return t.length > TITLE_CAP ? t.slice(0, TITLE_CAP) : t;
}
export function setTitleFor(id: string, title: string): void {
  titleByPane.set(id, capTitle(title));
}

/** Last reported session-attention status for a pane (GLOBAL — survives
 *  workspace switches). Source-bound to the pane's contentWindow; the host
 *  never trusts a sender-claimed id. */
export function statusFor(id: string): PaneStatus | undefined {
  return statusByPane.get(id);
}
/** Test/INTERNAL setter for a pane's status (capped title + stored globally).
 *  Recomputes the active-workspace needs-you aggregate and mirrors the status
 *  into the active projection's PaneVm so SolidJS shell components react. */
function setStatusFor(paneId: string, status: PaneStatus): void {
  // Cap the title ONCE at ingress (defense-in-depth) so both the status store
  // and the title store carry the capped value consistently.
  const capped: PaneStatus = { ...status, title: capTitle(status.title) };
  statusByPane.set(paneId, capped);
  if (capped.title) titleByPane.set(paneId, capped.title);
  setPanes((list) =>
    list.map((p) => (p.id === paneId ? { ...p, status: capped, title: capped.title || p.title } : p)),
  );
  recomputeNeedsYou();
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
  titleByPane.delete(id);
  statusByPane.delete(id);
  setPanes((list) => list.filter((p) => p.id !== id));
  setTrayIds((list) => list.filter((t) => t !== id));
  setFocusedId((cur) => (cur === id ? null : cur));
  recomputeNeedsYou();
}

// ---- shell view-model mutators (called by the controller from dockview) ----
// Each takes the writer's workspace id and is a no-op when that workspace is
// not active (the active host re-derives these from its api on a switch). This
// keeps the display projection purely active-workspace-scoped.

/** Replace the active-workspace pane projection with a full rebuild (used by
 *  a controller's syncPanes/syncAll so the display mirrors the active api exactly,
 *  including on a workspace switch). No-op when wsId is not active. */
export function setPanesVm(wsId: string, vms: PaneVm[]): void {
  if (wsId !== activeWorkspaceId()) return;
  setPanes(vms);
  // Re-derive the needs-you aggregate for the now-active pane set (status is
  // GLOBAL; a workspace switch must re-tally the visible panes' attention).
  recomputeNeedsYou();
}

export function setFocused(wsId: string, id: string | null): void {
  if (wsId !== activeWorkspaceId()) return;
  setFocusedId(id);
}

export function setTray(wsId: string, ids: string[]): void {
  if (wsId !== activeWorkspaceId()) return;
  setTrayIds(ids);
}

export function setMaximized(wsId: string, v: boolean): void {
  if (wsId !== activeWorkspaceId()) return;
  setIsMaximized(v);
}

// `connected` is set internally by routeMessage (any heartbeat ever accepted).
// It is INTERNAL — exported for read, never set from outside the store.

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
 * liveness semantics — see docs/heartbeat-protocol.md §5). Titles are stored
 * GLOBALLY (titleByPane) so they survive a workspace switch; the active-
 * workspace projection's setPanes is only touched when the pane belongs to the
 * active workspace.
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
      // Store the title GLOBALLY so it survives a workspace switch; then update
      // the active projection only if this pane is currently displayed.
      setTitleFor(paneId, d.title!);
      setPanes((list) =>
        list.map((p) => (p.id === paneId ? { ...p, title: d.title! } : p)),
      );
      return { routed: true, paneId, accepted: true, reason: "accepted:non-heartbeat" };
    }
    case "route": {
      // Capture the SPA's route change so it persists per-pane and restores on
      // reload. Source-bound (like title — display-only, no liveness semantics).
      // updateRoute updates panel params WITHOUT reloading the iframe (the
      // renderer has no update() → survival-safe); scheduleSave writes the URL
      // hash + localStorage mirror. The route is restored into the iframe src
      // at the NEXT cold creation (reload) so the SPA deep-links itself.
      if (typeof d.route === "string") {
        hostOps()?.updateRoute?.(paneId, d.route);
        scheduleSave();
      }
      return { routed: true, paneId, accepted: true, reason: "accepted:non-heartbeat" };
    }
    case "status": {
      // P1 session-attention. Source-bound (keyed by the pane's bound
      // contentWindow, NEVER a sender-claimed id). Validate the minimal payload
      // shape; a malformed/spoofed status is ignored entirely. The host NEVER
      // trusts a sender-claimed serverId: `dir`+`session` are the SPA's routing
      // vocabulary, and the SERVER is implied by the pane the message came from.
      //
      // TRUST TIER (stricter than title/route): status carries
      // `attention: needs_reply|needs_permission`, which drives operator
      // NEXT/attention routing — a forged needs-you is trust-destroying. So
      // status follows the HEARTBEAT trust tier (origin-checked), NOT the
      // title/route tier (source-binding-only, which is display-only with no
      // liveness/attention semantics). A bound WindowProxy survives a
      // cross-origin navigation, so a hijacked/navigated iframe could otherwise
      // inject a forged needs_permission/needs_reply; the origin check below
      // prevents that. Q1-C document-liveness stays driven by heartbeats only;
      // status is display/attention only.
      if (
        typeof d.dir !== "string" ||
        typeof d.session !== "string" ||
        typeof d.title !== "string" ||
        typeof d.attention !== "string" ||
        typeof d.activity !== "string"
      ) {
        return { routed: false, paneId: null, accepted: false, reason: "ignored-non-pane-to-host" };
      }
      // Constraint #3 (heartbeat trust tier): origin must match the pane's
      // configured server origin. Mirrors the heartbeat branch's check exactly.
      // A bound WindowProxy survives a cross-origin navigation; source-binding
      // alone is NOT sufficient for an attention-driving message. Rejected here
      // → status/title/needsYou are NOT mutated.
      const expected = configuredOrigin.get(paneId);
      if (expected !== undefined && origin !== expected) {
        return { routed: true, paneId, accepted: false, reason: "rejected:origin-mismatch" };
      }
      const attention = d.attention as Attention;
      const activity = d.activity as Activity;
      // Closed-set check: reject out-of-vocabulary values rather than storing
      // an arbitrary string (defense-in-depth against a spoofed/malformed post).
      if (
        attention !== "none" &&
        attention !== "needs_reply" &&
        attention !== "needs_permission"
      ) {
        return { routed: false, paneId: null, accepted: false, reason: "ignored-non-pane-to-host" };
      }
      if (
        activity !== "running" &&
        activity !== "idle" &&
        activity !== "done_unread" &&
        activity !== "error" &&
        activity !== "unknown"
      ) {
        return { routed: false, paneId: null, accepted: false, reason: "ignored-non-pane-to-host" };
      }
      setStatusFor(paneId, {
        dir: d.dir,
        session: d.session,
        title: d.title,
        attention,
        activity,
      });
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

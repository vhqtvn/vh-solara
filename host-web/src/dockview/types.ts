// Shared types for the vh-solara host SPA.
//
// Architecture A (locked): a pure-web host SPA embeds ONE cross-origin
// <iframe> per vh-solara server. Each pane is an iframe pointing at a server's
// web UI. Panes are tiled by Dockview with `renderer: 'always'` so the iframe
// element is never reparented/destroyed — only its geometry/visibility changes.

export type ViewKind = "chat" | "terminal" | "diff" | "sessions";

/**
 * Params carried by each Dockview panel; determine the iframe target + header.
 *
 * `url` is the FULL iframe src, set ONCE at pane creation and NEVER mutated
 * afterward — changing `src` reloads the iframe and breaks the survival
 * guarantee. In mock mode it points at the mock content page; in real-fleet
 * mode (VITE_SERVERS) it points at a real vh-solara server.
 *
 * `label` is the single display string for the pane header / tab / tray chip.
 * It folds the old `server` + `view` pair (mock label: "srv-A · chat") so the
 * shell view-model stays decoupled from how a pane target is described.
 */
export interface PaneParams {
  url: string;
  label: string;
  /**
   * The SPA route (a `?dir=...&session=...` query string) captured from the
   * embedded SPA's route emission, restored into the iframe src at CREATION
   * only so the SPA deep-links itself on reload. Non-authoritative: src is set
   * once from `url` (+ appended route) and never mutated afterward; runtime
   * route changes update this param via updateParameters WITHOUT touching src.
   */
  route?: string;
}

/** Shell view-model for a pane (mirrors the live Dockview panel). */
export interface PaneVm {
  id: string;
  label: string;
  title: string;
}

/** Survival identity/signal reported by each iframe's heartbeat. */
export interface Survival {
  mountTs: number;
  nonce: string;
  uptime: number;
  connId: number | null;
  src: string;
  /** host clock at the moment the last heartbeat was ingested */
  lastSeen: number;
}

/** First-observed baseline used by the survival gate to detect a reload. */
export interface SurvivalBaseline {
  mountTs: number;
  nonce: string;
  connId: number | null;
}

// ---- minimal postMessage contract (pane ⇄ host) ---------------------------
// Independent panes: no deep cross-tile DOM integration. Pane labels its own
// tab/header (title/route); host tells a pane when it gains/loses focus.

// Inbound pane→host message contract. The host router (`store.ts`) keys only on
// `type` + the per-variant payload it actually consumes (survival identity for
// heartbeat, title text for title, nothing for route). The Phase-1′a pane-model
// refactor retired the old `server`/`view` pair from this surface — a pane is
// now addressed by its `url`+`label` (PaneParams) and the host never routes
// inbound messages by server/view, so those fields were documented-but-dead.
export type PaneToHost =
  | {
      type: "heartbeat";
      mountTs: number;
      nonce: string;
      uptime: number;
      // connId + src are OPTIONAL: kept only for the mock content page stand-in
      // (the survival gate's WS negative control asserts on connId). The real
      // SPA omits both; the document-liveness indicator keys on mountTs + nonce
      // + uptime, never on connId. See docs/heartbeat-protocol.md §7.
      connId?: number | null;
      src?: string;
    }
  | { type: "title"; title: string }
  | { type: "route"; route?: string };

// Host → pane. `focus`/`blur` are the pre-existing host-focus routing. The
// `vh-host-handshake` is the document-liveness challenge (see
// docs/heartbeat-protocol.md §3.1): issued once per iframe load, carries a fresh
// nonce the SPA echoes back in its heartbeats.
export type HostToPane =
  | { type: "focus" }
  | { type: "blur" }
  | { type: "vh-host-handshake"; nonce: string };

// ---- document-liveness indicator (Q1-C) ------------------------------------
// The on-screen per-pane indicator state derived from heartbeats. This is
// document/SPA liveness ONLY — never realtime/SSE health. See
// docs/heartbeat-protocol.md §1 + §6.
export type LivenessState = "alive" | "reloaded" | "no-signal";

/** Human-visible label for a liveness state (Q1-C exact strings). */
export function livenessLabel(s: LivenessState): string {
  switch (s) {
    case "alive":
      return "document alive";
    case "reloaded":
      return "reloaded";
    case "no-signal":
      return "no recent signal";
  }
}

export const VIEW_KINDS: ViewKind[] = ["chat", "terminal", "diff", "sessions"];

// ---- host imperative ops (late-bound; filled in by the controller) --------
// The DockviewHost creates the dockview (which needs the component factory →
// needs ops) BEFORE the controller exists (the controller needs the dockview
// api). We break the cycle with a mutable ops object: the factory captures it
// and the renderer calls methods via optional chaining, so by the time a user
// clicks anything the controller has populated it.

export type SplitDir = "right" | "down";

export interface HostOps {
  split?(paneId: string, direction: SplitDir): string | null;
  swap?(a: string, b: string): void;
  closePane?(paneId: string): void;
  focusPane?(paneId: string): void;
  toggleZoom?(paneId: string): void;
  collapse?(paneId: string): void;
  restore?(paneId: string): void;
  /** Add a server to the runtime catalog + open a pane for it. The url is
   *  validated through isFleetEntry (http/https) — a javascript:/data:/opaque
   *  value is REJECTED (returns null, no pane, no catalog change) because it
   *  would execute same-origin against the host shell via the unsandboxed
   *  iframe.src. Returns the new pane id, or null on rejection. */
  addServer?(url: string, label: string): string | null;
  /** Remove a server (by url) from the runtime catalog + close its open panes.
   *  Returns true when applied; false when refused — specifically when closing
   *  that server's grid panes would empty the visible grid (refused so the grid
   *  never goes blank; survival-safe: no layout mutation when refused). */
  removeServer?(url: string): boolean;
  /**
   * Capture a route change reported by an embedded pane's SPA so it persists
   * across reload. Updates the panel params via `api.updateParameters` WITHOUT
   * reloading the iframe (the iframeRenderer has no `update()` → survival-safe),
   * then schedules a debounced save of the full state. The route is restored
   * into the iframe src at the NEXT cold creation (reload) so the SPA deep-links
   * itself; runtime route changes never touch src.
   */
  updateRoute?(paneId: string, route: string): void;
}

/** State pushed to a pane's header so it can reflect tray/zoom affordances. */
export interface PaneHeaderState {
  inTray: boolean;
  maximized: boolean;
  canCollapse: boolean;
}

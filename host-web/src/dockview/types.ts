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
      connId: number | null;
      src: string;
    }
  | { type: "title"; title: string }
  | { type: "route" };

export type HostToPane = { type: "focus" } | { type: "blur" };

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
}

/** State pushed to a pane's header so it can reflect tray/zoom affordances. */
export interface PaneHeaderState {
  inTray: boolean;
  maximized: boolean;
  canCollapse: boolean;
}

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
  /**
   * The pane's server URL (the iframe src). Carried in the view-model so the
   * shell can prefill the AddServer form with the currently-active pane's URL
   * (tabs=panes model, operator point #4). Read-only view-model copy; the
   * authoritative value lives in the panel params (never mutated after creation).
   */
  url: string;
  /**
   * P1 session-attention status for the pane's current `(dir, session)`, when
   * the embedded SPA has reported one via a `{type:"status"}` message. Absent
   * until the first status lands (the host renders no attention indicator and
   * treats activity as "unknown"). Carried in the view-model so SolidJS shell
   * components (the per-pane needs-you badge) react to status changes; the
   * imperative pane renderer reads the source-of-truth `statusFor(paneId)`.
   */
  status?: PaneStatus;
}

// ---- P1 session-attention (pane ⇄ host) ------------------------------------
// The embedded SPA derives its current `(dir, session)`'s attention/activity
// from its sync store and reports it via a `{type:"status"}` message that
// reuses the heartbeat/route security pattern (embed gate, inbound source-
// guard, captured-origin targeting). The host keys it by the pane's bound
// contentWindow (NEVER a sender-claimed id) and decorates the pane header +
// a workspace-aggregate badge. This is DISTINCT from Q1-C document-liveness
// (the heartbeat dot/label): attention is an operator-action signal, not a
// document-health signal. See web/src/statusEmitter.ts for the SPA side.

export type Attention = "none" | "needs_reply" | "needs_permission";
export type Activity = "running" | "idle" | "done_unread" | "error" | "unknown";

export interface PaneStatus {
  dir: string;
  session: string;
  title: string;
  attention: Attention;
  activity: Activity;
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
  | { type: "route"; route?: string }
  // P1 session-attention. dir + session are the SPA's declared non-sensitive
  // routing vocabulary (identical to the route message); title is OpenCode-
  // authored plain session/project text (no transcript/URL/content); attention
  // + activity are derived values. The host keys by the pane's bound
  // contentWindow and IGNORES any sender-claimed server id — same threat model
  // as route. See web/src/statusEmitter.ts.
  | {
      type: "status";
      dir: string;
      session: string;
      title: string;
      attention: Attention;
      activity: Activity;
    };

// Host → pane. `focus`/`blur` are the pre-existing host-focus routing. The
// `vh-host-handshake` is the document-liveness challenge (see
// docs/heartbeat-protocol.md §3.1): issued once per iframe load, carries a fresh
// nonce the SPA echoes back in its heartbeats. The `vh-host-select` is the P4
// reverse-nav command (see web/src/selectListener.ts): directs the embedded SPA
// to switch to a specific {dir, session} via a survival-safe SPA-INTERNAL route
// change (setSelectedId/switchProject) — the iframe src + element are NEVER
// touched. Origin-scoped to the pane's configured origin (never '*').
export type HostToPane =
  | { type: "focus" }
  | { type: "blur" }
  | { type: "vh-host-handshake"; nonce: string }
  | { type: "vh-host-select"; dir: string; session: string };

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

/**
 * Outcome of a deterministic add-server action (decision #3). The kind tells
 * the UI which outcome line to show; `paneId` is the pane that ended up
 * focused/opened (existing for "already-open", newly created otherwise);
 * `label` is the resolved display label (supplied or derived from the url
 * host). See HostOps.addServerWithOutcome. */
export interface AddServerOutcome {
  kind: "already-open" | "opened" | "added";
  paneId: string;
  label: string;
}

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
   *  iframe.src. Returns the new pane id, or null on rejection.
   *
   *  NOTE: this is the LEGACY always-add-and-open path retained for the test
   *  bridge (existing survival/layout/attention e2e call it for deterministic
   *  pane creation). The UI's AddServer popover uses addServerWithOutcome
   *  (deterministic-duplicate handling + an outcome the operator can see). */
  addServer?(url: string, label: string): string | null;
  /**
   * Deterministic add-server with an OUTCOME the operator can see (decision
   * #3). Three outcomes, all returning the resolved label + the pane id that
   * ended up focused/opened:
   *  - `"already-open"`: the active workspace already has a pane bound to this
   *    url → focus it (NO new pane, NO catalog change).
   *  - `"opened"`: the url is catalog-known but no pane is open for it → open
   *    one (NO catalog change).
   *  - `"added"`: the url is new → addRuntimeServer + open a pane.
   * Returns null on isFleetEntry rejection (no pane, no catalog change). The
   * popover stays open + shows the outcome line so the operator can tell what
   * happened (the core legibility fix). */
  addServerWithOutcome?(
    url: string,
    label: string,
  ): AddServerOutcome | null;
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
  /**
   * Direct a pane's embedded SPA to switch to a specific {dir, session} via a
   * survival-safe postMessage (SPA-INTERNAL route change; the iframe src +
   * element are NEVER touched — contrast with updateRoute which captures the
   * SPA's OUTBOUND route into params; select is the INBOUND reverse). Posts
   * {type:'vh-host-select',dir,session} to the pane's bound contentWindow
   * targeted at its configured origin (never '*'). No-op when the pane is not
   * found or its origin is unbound. The SPA echoes the route change back via
   * its existing {type:'route'} emission — that round-trip is the success
   * signal (no new reply message). See web/src/selectListener.ts. */
  selectTarget?(paneId: string, dir: string, session: string): void;
  /**
   * Rename a pane's LABEL inline (tabs=panes model). Updates the panel params
   * via `api.updateParameters({label})` WITHOUT reloading the iframe (same
   * survival-safe mechanism as updateRoute — the renderer has no update()).
   * Persists via scheduleSave (updateParameters does NOT fire onDidLayoutChange,
   * so the rename must explicitly schedule a debounced save). The iframe element
   * + src + renderer:'always' mount are ALL untouched. Mirrors the
   * renameWorkspace referential-identity-preserving pattern (mutate the label
   * field, don't spread-recreate the panel). Refuses an empty/whitespace label
   * (keeps the current label). */
  renamePane?(paneId: string, label: string): void;
}

/** State pushed to a pane's header so it can reflect tray/zoom affordances. */
export interface PaneHeaderState {
  inTray: boolean;
  maximized: boolean;
  canCollapse: boolean;
}

// ---- P4 attention-target registry (host state) -----------------------------
// The operator's unit of attention is a SESSION, not a workspace. The host
// keeps a registry of intentionally-visited AttentionTarget records and renders
// them as a flat tabstrip (replacing the workspace tabstrip). A target becomes
// a tab ONLY when the operator opens/selects it (Fork B — explicit-watch; no
// auto-enumeration of server sessions). See targetRegistry.ts.

/**
 * A single session the operator has intentionally visited. `serverId` is the
 * pane's bound server origin (configuredOriginFor), DERIVED from the pane/server
 * binding — NEVER sender-claimed (a status/route message carries dir+session but
 * no trustworthy server id; the server is implied by the pane the message came
 * from, exactly like the P1 status bridge). `dir`+`session` are the SPA's
 * declared non-sensitive routing vocabulary (same as PaneStatus).
 */
export interface AttentionTarget {
  serverId: string;
  dir: string;
  session: string;
}

/**
 * One row in the flat tabstrip. Deduped by exact (serverId,dir,session).
 *
 * `liveStatus` is the LAST-KNOWN PaneStatus for this target (metadata). It is
 * valid as CURRENT attention ONLY while a live pane is reporting this exact
 * target (targetRegistry.isLive(target)); once the pane navigates away the
 * record is no longer "live" and the tab MUST NOT claim current attention (no
 * needs-you badge) — it shows the last-known status dimmed/stale instead. This
 * is the honest-status invariant: never carry needs_reply/needs_permission to a
 * target no pane is currently reporting.
 *
 * PERSISTENCE: only {target, title, lastVisitedAt, pinned} are durable.
 * `liveStatus` is RUNTIME-ONLY (transient; stripped on save) — on a cold reload
 * no record is live until status messages re-arrive, so no stale needs-you can
 * survive a reload.
 */
export interface TabRecord {
  target: AttentionTarget;
  title: string;
  lastVisitedAt: number;
  pinned: boolean;
  /** LAST-KNOWN status (runtime-only; not persisted). Honest only while live. */
  liveStatus?: PaneStatus;
  /**
   * TITLE SOURCE-PRECEDENCE (decision #2). A tab starts as `"fallback"` (its
   * title is the server host, derived from the bound origin). The FIRST
   * non-empty session status title that arrives flips this to `"session"`
   * (PINNED) — once pinned, the title is NEVER replaced by a fallback or a
   * later status tick. This is what stops the "server label does nothing"
   * flicker the operator reported: the title was being overwritten on every
   * non-empty status tick. Persistence is optional + backward-compat (an
   * absent field on a cold-loaded v1 blob defaults to `"fallback"`).
   */
  titleSource?: "fallback" | "session";
}

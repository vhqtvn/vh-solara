import type { DockviewApi, IDockviewPanel } from "dockview-core";
import type { IframeRenderer } from "./iframeRenderer";
import type { AddServerOutcome, HostOps, SplitDir } from "./types";
import {
  isFleetEntry,
  isRealFleet,
  mockUrl,
  nextMockPane,
  nextPaneId,
} from "../state/mockData";
import {
  addRuntimeServer,
  removeRuntimeServer,
  runtimeServers,
} from "../state/serverList";
import { firstNeedsYouAtFor } from "./store";
import {
  visit as visitTarget,
  parseRouteTarget,
  activeTarget as activeRegistryTarget,
  records as targetRecords,
  liveKeys as liveKeysSet,
  dismiss as dismissTarget,
  pin as pinTarget,
  unpin as unpinTarget,
  _setRecordVisitedAtForTest,
} from "./targetRegistry";
import { next as attentionNext, nextTarget as attentionNextTarget } from "../attentionNext";
import {
  activeWorkspaceId,
  addWorkspace as storeAddWorkspace,
  baselineFor,
  bindContentWindow,
  bindScratchSource,
  closeWorkspace as storeCloseWorkspace,
  configuredOriginFor,
  connected,
  expectedNonceFor,
  focusedId,
  livenessFor,
  lookupContentWindow,
  needsYouCount,
  needsYouCountFor,
  noteIframeLoad,
  hostOps,
  renameWorkspace as storeRenameWorkspace,
  resetBaseline,
  routeMessage,
  scratchSource,
  sendHandshake,
  setActiveWorkspace as storeSetActiveWorkspace,
  setFocused,
  setMaximized,
  setPanesVm,
  setTray,
  statusFor,
  survivalFor,
  titleFor,
  unregisterPane,
  unregisterWorkspaceApi,
  unregisterWorkspaceOps,
  unregisterWorkspaceSync,
  workspaces as storeWorkspaces,
  workspaceApiFor,
} from "./store";

type Direction = "left" | "right" | "above" | "below";

// ============================================================================
// MULTI-WORKSPACE HOST CONTROLLER
//
// One HostController per workspace, owning that workspace's isolated DockviewApi.
// Each controller registers itself in the module-level `controllers` map; the
// DEV-only test bridge (a singleton installed once) resolves the ACTIVE
// workspace's controller at call time so bridge ops route to the active tree.
//
// Shell ops route through store.hostOps(), which returns the active workspace's
// HostOps facet — so a click always lands in the active workspace's live tree.
// Each controller's `this.api` is its OWN workspace's api, so when the active
// facet is invoked the op mutates the correct (active) tree. Switching
// workspaces is CSS-only (App.tsx) and never touches any api.
// ============================================================================

/** Module-level controller registry: workspaceId → controller. The DEV test
 *  bridge resolves the active controller through this map. */
const controllers = new Map<string, HostController>();

function activeController(): HostController | null {
  const ws = activeWorkspaceId();
  return ws ? (controllers.get(ws) ?? null) : null;
}

/** Find the controller that owns a given pane (by renderer), across ALL
 *  workspaces. Used by bridge methods that address a pane directly (getIframe,
 *  naiveReload) — the pane may live in any workspace, not just the active one. */
function controllerForPane(paneId: string): HostController | null {
  for (const c of controllers.values()) {
    if (c.renderers.has(paneId)) return c;
  }
  return null;
}

export class HostController implements HostOps {
  // `api` and `renderers` are read by the module-level bridge helpers
  // (activeController / controllerForPane) which resolve the active or owning
  // controller for a bridge call. They are NOT part of the public HostOps
  // surface; the shell uses hostOps() (the typed facet), never these fields.
  constructor(
    private readonly workspaceId: string,
    readonly api: DockviewApi,
    readonly renderers: Map<string, IframeRenderer>,
    private readonly ops: HostOps,
  ) {
    controllers.set(workspaceId, this);
    this.installOps();
    this.wireEvents();
    this.installTestBridge();
  }

  /** Re-project the display signals from this workspace's api. Called when this
   *  workspace becomes active (so panes/focus/tray/maximize reflect the now-
   *  visible tree) and on this host's cold mount when it is already active. */
  syncAll(): void {
    this.syncPanes();
    this.syncTray();
    const active = this.api.activePanel?.id ?? null;
    setFocused(this.workspaceId, active);
    setMaximized(this.workspaceId, this.api.hasMaximizedGroup());
    this.pushHeaderStates();
  }

  // ---- HostOps implementation (mutates the live tree of THIS workspace) ----

  split(paneId: string, direction: SplitDir): string | null {
    const panel = this.api.getPanel(paneId);
    if (!panel) return null;
    // Directional split: addPanel relative to the focused panel's group, in a
    // NEW group (never 'within' — we want a tiled split, not a tab). This does
    // NOT touch the existing iframe; addPanel only creates the new pane.
    const dir: Direction = direction === "right" ? "right" : "below";
    const params = this.newPaneParams(panel);
    if (!params) return null;
    const created = this.api.addPanel({
      id: params.id,
      component: "iframe",
      renderer: "always",
      params: { url: params.url, label: params.label },
      position: { referencePanel: panel, direction: dir },
    });
    created.api.setActive();
    return created.id;
  }

  swap(a: string, b: string): void {
    const pa = this.api.getPanel(a);
    const pb = this.api.getPanel(b);
    if (!pa || !pb || a === b) return;
    // Survival-safe exchange via panel.moveTo (never disposes a renderer).
    // Capture b's group up front: after a moves into it, a's original (now
    // empty) group is auto-removed by Dockview, so pa.group would already point
    // at the combined group by the second move.
    const gb = pb.group;
    // 1) dock a into b's group as a tab; a's iframe survives (moveTo repositions).
    pa.api.moveTo({ group: gb, position: "center" });
    // 2) split b back out to its own group on the right, leaving a alone in the
    //    combined group. b's iframe survives too. Net: a and b exchanged.
    pb.api.moveTo({ group: gb, position: "right" });
    pa.api.setActive();
    this.afterMutation();
  }

  closePane(paneId: string): void {
    const panel = this.api.getPanel(paneId);
    if (!panel) return;
    // removePanel disposes THIS pane's iframe (it's gone) — that's correct for
    // close. Survival matters for the REMAINING panes, which Dockview keeps
    // mounted. Single-child splits collapse automatically (empty group removed).
    this.api.removePanel(panel);
    this.afterMutation();
  }

  focusPane(paneId: string): void {
    const panel = this.api.getPanel(paneId);
    panel?.api.setActive();
  }

  toggleZoom(paneId: string): void {
    const panel = this.api.getPanel(paneId);
    if (!panel) return;
    // RULE #4: zoom = native maximizeGroup (survival-safe, proven). Toggling
    // exits the maximized group when this group is the maximized one.
    if (this.api.hasMaximizedGroup()) {
      this.api.exitMaximizedGroup();
    } else {
      this.api.maximizeGroup(panel);
    }
    this.afterMutation();
  }

  collapse(paneId: string): void {
    const panel = this.api.getPanel(paneId);
    if (!panel) return;
    // GUARD: can't collapse the last visible (grid) pane — the layout must keep
    // at least one pane on the grid so there's somewhere to restore into.
    if (this.gridPaneCount() <= 1) return;
    if (panel.group.api.location.type !== "grid") return;
    // RULE #1: collapse-to-tray = addFloatingGroup (park) + moveTo (restore).
    // NEVER removePanel to collapse — it reloads the iframe.
    const box = panel.group.api.boundingBox;
    this.api.addFloatingGroup(panel, {
      x: Math.max(20, (box?.left ?? 60) + 40),
      y: Math.max(60, (box?.top ?? 60) + 40),
      width: 360,
      height: 240,
    });
    this.afterMutation();
  }

  restore(paneId: string): void {
    const panel = this.api.getPanel(paneId);
    if (!panel) return;
    if (panel.group.api.location.type !== "floating") return;
    // Re-split into the grid next to any remaining grid group (survival-safe:
    // moveTo repositions the keep-mounted group back into the grid).
    const ref = this.api.groups.find(
      (g) => g.api.location.type === "grid" && g !== panel.group,
    );
    if (ref) {
      panel.api.moveTo({ group: ref, position: "right" });
    } else {
      // No grid group to anchor against. Reachable: closePane (unlike collapse)
      // has no count guard, so closing every grid pane while one is parked in
      // the tray leaves a floating pane with an empty grid. Create a fresh grid
      // group and dock the panel into it. Survival-safe: moveTo repositions the
      // always-mounted renderer; the now-empty floating group is auto-removed.
      const fresh = this.api.addGroup();
      panel.api.moveTo({ group: fresh, position: "center" });
    }
    panel.api.setActive();
    this.afterMutation();
  }

  // ---- runtime server management (catalog add/remove) ---------------------

  /**
   * Add a server to the runtime catalog AND open a new pane for it (in THIS
   * workspace).
   *
   * SECURITY: the url is validated through isFleetEntry (http/https). A
   * javascript:/data:/opaque/parse-failure value is REJECTED — returns null,
   * no pane opens, no catalog change — because the url lands on an UNSANDBOXED
   * iframe.src and a non-http(s) value would execute same-origin against the
   * host shell. This mirrors the F1 fleet-rejection guard.
   *
   * On a valid url: append {url,label} to the catalog (idempotent on url) and
   * addPanel a new pane with that {url,label} (split-right off the focused pane
   * when one exists, else absolute). The new pane's iframe src is set ONCE here
   * and never mutated (renderer:'always' keeps it mounted).
   */
  addServer(url: string, label: string): string | null {
    // Trim + derive a label from the url host when none supplied (UX nicety; the
    // isFleetEntry check below still owns the security boundary).
    const u = url.trim();
    const l = label.trim() || safeHost(u);
    if (!isFleetEntry({ url: u, label: l })) return null; // reject: not http/https
    addRuntimeServer(u, l); // idempotent on url (catalog side)
    const ref = this.api.activePanel ?? undefined;
    const created = this.api.addPanel({
      id: nextPaneId(),
      component: "iframe",
      renderer: "always",
      params: { url: u, label: l },
      position: ref ? { referencePanel: ref, direction: "right" } : undefined,
    });
    created.api.setActive();
    this.afterMutation();
    return created.id;
  }

  /**
   * Deterministic add-server with an OUTCOME the operator can see (decision
   * #3). This is the path the AddServer popover uses; it differs from the
   * legacy addServer (always add+open) by handling the three cases the operator
   * could not previously distinguish:
   *
   *  - matching pane ALREADY OPEN in the active workspace → focus it, NO new
   *    pane, NO catalog change → {kind:"already-open"}. (This is the fix for
   *    the "+ does nothing / opens a duplicate" confusion: a re-add of an
   *    already-open server now focuses the existing pane instead of silently
   *    stacking a duplicate.)
   *  - catalog-known (runtimeServers has the url) but no open pane → open one,
   *    NO catalog change → {kind:"opened"}.
   *  - new url → addRuntimeServer + open → {kind:"added"}.
   *
   * SECURITY: same isFleetEntry guard as addServer — a non-http(s) value is
   * rejected (null return, no pane, no catalog change). The url lands on an
   * unsandboxed iframe.src.
   *
   * NOTE: the already-open check is scoped to THIS workspace (the active one),
   * matching the popover's "Add a server" intent (the operator is looking at
   * the active workspace). A url open in a NON-active workspace is treated as
   * "opened" here (a new pane opens in the active workspace) — cross-workspace
   * focus is the tab-click path's job (selectTab), not the add-server path's.
   */
  addServerWithOutcome(url: string, label: string): AddServerOutcome | null {
    const u = url.trim();
    const l = label.trim() || safeHost(u);
    if (!isFleetEntry({ url: u, label: l })) return null; // reject: not http/https
    // (1) matching pane ALREADY OPEN in the active workspace → focus it.
    for (const panel of this.api.panels) {
      const pu = (panel.params as { url?: string } | undefined)?.url;
      if (pu === u) {
        panel.api.setActive();
        this.afterMutation();
        return { kind: "already-open", paneId: panel.id, label: l };
      }
    }
    // (2) catalog-known but no open pane → open one (no catalog change).
    // (3) new url → addRuntimeServer + open.
    const known = runtimeServers().some((e) => e.url === u);
    if (!known) addRuntimeServer(u, l);
    const ref = this.api.activePanel ?? undefined;
    const created = this.api.addPanel({
      id: nextPaneId(),
      component: "iframe",
      renderer: "always",
      params: { url: u, label: l },
      position: ref ? { referencePanel: ref, direction: "right" } : undefined,
    });
    created.api.setActive();
    this.afterMutation();
    return { kind: known ? "opened" : "added", paneId: created.id, label: l };
  }

  /**
   * Remove a server (by url) from the runtime catalog + close its open panes
   * (in THIS workspace). Returns true when applied; false when refused (closing
   * this server's grid panes would empty the visible grid — refused so the grid
   * never goes blank). Refusal is survival-safe: NO layout mutation happens.
   */
  removeServer(url: string): boolean {
    const u = url.trim();
    // Collect every panel whose pane url matches this server.
    const matching: IDockviewPanel[] = [];
    for (const p of this.api.panels) {
      const pu = (p.params as { url?: string } | undefined)?.url;
      if (pu === u) matching.push(p);
    }
    // Guard: would closing the matching GRID panes empty the visible grid?
    const matchingGrid = matching.filter(
      (p) => p.group.api.location.type === "grid",
    );
    if (matchingGrid.length > 0 && this.gridPaneCount() - matchingGrid.length <= 0) {
      return false; // refuse — never leave a blank grid
    }
    removeRuntimeServer(u); // catalog side (no-op if url not in catalog)
    for (const p of matching) this.api.removePanel(p);
    this.afterMutation();
    return true;
  }

  /**
   * Capture a route change reported by an embedded pane's SPA. Updates the
   * panel params via `api.updateParameters` WITHOUT reloading the iframe (the
   * renderer has no `update()` → survival-safe). The route is restored into
   * the iframe src at the NEXT cold creation (reload) so the SPA deep-links
   * itself; runtime route changes never touch src.
   *
   * P4: when the route carries a {dir,session} (the SPA's routing vocabulary),
   * upsert it as a visited AttentionTarget — Fork B's SPA-internal visit path.
   * The serverId is the pane's bound origin (NEVER sender-claimed). Dedupes
   * with the host-driven visit in selectTarget (a select round-trip lands here
   * too when the SPA echoes its new route). A route without dir+session (a
   * non-session view) does not mint a tab.
   */
  updateRoute(paneId: string, route: string): void {
    const panel = this.api.getPanel(paneId);
    if (!panel) return;
    panel.api.updateParameters({ ...(panel.params ?? {}), route });
    // P4 SPA-internal visit: parse the route for a session target.
    const parsed = parseRouteTarget(route);
    if (parsed) {
      const serverId = configuredOriginFor(paneId);
      if (serverId) {
        visitTarget(
          { serverId, dir: parsed.dir, session: parsed.session },
          titleFor(paneId),
        );
      }
    }
  }

  /**
   * Direct a pane's embedded SPA to switch to a specific {dir, session} via a
   * survival-safe postMessage (P4 reverse-nav enabler). The iframe src +
   * element are NEVER touched — this posts {type:'vh-host-select',dir,session}
   * to the pane's bound contentWindow targeted at its configured origin
   * (never '*'). The SPA performs an INTERNAL route change
   * (setSelectedId/switchProject); its existing route emission fires
   * {type:'route'} back, which updateRoute captures — the round-trip success
   * signal. No-op when the pane is not found or its origin is unbound.
   *
   * SURVIVAL-INVARIANT (load-bearing): unlike a route CAPTURE (updateRoute,
   * which only mutates params), a select DRIVES the SPA. But it does so purely
   * via postMessage — the iframe element, its src, and `renderer:'always'` are
   * untouched. Survival is unchanged (the SPA document is never reloaded).
   */
  selectTarget(paneId: string, dir: string, session: string): void {
    const cw = lookupContentWindow(paneId);
    const origin = configuredOriginFor(paneId);
    // No-op if the pane is not found (no bound contentWindow) or its origin is
    // unbound (never fall back to '*' — a broadcast select is both unsafe and
    // pointless, since the listening child would reject an untargeted post).
    if (!cw || !origin) return;
    cw.postMessage({ type: "vh-host-select", dir, session }, origin);
    // P4 host-driven visit (Fork B): the operator explicitly selected this
    // session → it becomes a tab. serverId is the pane's bound origin (NEVER
    // sender-claimed). Dedupes with the SPA-internal visit in updateRoute (the
    // SPA echoes its new route back, which lands there). Sets it as active.
    visitTarget({ serverId: origin, dir, session }, titleFor(paneId));
  }

  // ---- event wiring → store (display projection of THIS workspace) ---------

  private wireEvents(): void {
    this.api.onDidActivePanelChange((ev) => {
      const prev = focusedId();
      const next = ev.panel?.id ?? null;
      if (prev && prev !== next) {
        const r = this.renderers.get(prev);
        r?.setActive(false);
        r?.sendBlur();
      }
      if (next) {
        const r = this.renderers.get(next);
        r?.setActive(true);
        r?.sendFocus();
      }
      setFocused(this.workspaceId, next);
    });
    this.api.onDidMaximizedGroupChange(() => {
      setMaximized(this.workspaceId, this.api.hasMaximizedGroup());
      this.pushHeaderStates();
    });
    this.api.onDidAddPanel(() => this.syncPanes());
    this.api.onDidRemovePanel((p) => {
      unregisterPane(p.id);
      this.syncPanes();
    });
    this.api.onDidMovePanel(() => {
      this.syncPanes();
      this.afterMutation();
    });
    this.api.onDidLayoutChange(() => {
      this.syncTray();
      this.pushHeaderStates();
    });
  }

  /** Reconcile the shell view-model with the live Dockview panels of THIS
   *  workspace (full rebuild; titles read from the global titleFor map so they
   *  survive a workspace switch). No-op for the display signal when this
   *  workspace is not active (the store mutator guards on active). */
  private syncPanes(): void {
    const vms: { id: string; label: string; title: string }[] = [];
    for (const panel of this.api.panels) {
      const params = (panel.params ?? {}) as { url?: string; label?: string };
      const title = titleFor(panel.id) ?? params.label ?? "";
      vms.push({
        id: panel.id,
        label: params.label ?? "server",
        title,
      });
    }
    setPanesVm(this.workspaceId, vms);
  }

  private syncTray(): void {
    const tray: string[] = [];
    for (const g of this.api.groups) {
      if (g.api.location.type === "floating" && g.activePanel) {
        tray.push(g.activePanel.id);
      }
    }
    setTray(this.workspaceId, tray);
  }

  private afterMutation(): void {
    this.syncTray();
    this.pushHeaderStates();
  }

  private pushHeaderStates(): void {
    const gridCount = this.gridPaneCount();
    const maximized = this.api.hasMaximizedGroup();
    for (const [id, r] of this.renderers) {
      const panel = this.api.getPanel(id);
      if (!panel) continue;
      const inTray = panel.group.api.location.type === "floating";
      r.setHeaderState({
        inTray,
        maximized: maximized && panel.group === this.api.activeGroup,
        canCollapse: gridCount > 1,
      });
    }
  }

  /** Number of panes currently on the grid (not in the tray). Public so the
   *  DEV bridge can read it via the active controller. */
  gridPaneCount(): number {
    let n = 0;
    for (const g of this.api.groups) {
      if (g.api.location.type === "grid") n += g.activePanel ? 1 : g.panels.length;
    }
    return n;
  }

  /**
   * Build params for a NEW pane created by "+" / split (in THIS workspace).
   *
   * - REAL-fleet mode (runtime catalog OR VITE_SERVERS): clone the SOURCE/focused
   *   pane's {url,label} — splitting opens another view of the same server, not a
   *   new mock. The url is reused verbatim (a server view, not a different server).
   * - MOCK mode (default): cycle the next mock (server, view) and build its
   *   {url,label} (url → mock content page; label "srv-A · chat"-style).
   *
   * Mode is decided per-call via isRealFleet() (runtime-aware: true when the
   * operator has added servers OR VITE_SERVERS is set), so "+" clones in any
   * real-server session and cycles mock only on a fresh mock context.
   */
  private newPaneParams(source?: IDockviewPanel): {
    id: string;
    url: string;
    label: string;
  } | null {
    if (isRealFleet()) {
      const sp = (source?.params ?? {}) as { url?: string; label?: string };
      // GUARD (defensive): if the source pane has no usable url, refuse the
      // split rather than seed an empty iframe.src — an empty src self-embeds
      // the host. Statically unreachable today (seeded panes always carry a
      // url), but keeps the split safe under any future code path.
      if (!sp.url) return null;
      return {
        id: nextPaneId(),
        url: sp.url,
        label: sp.label ?? "server",
      };
    }
    const m = nextMockPane();
    return {
      id: nextPaneId(),
      url: mockUrl(m.server, m.view),
      label: `${m.server} · ${m.view}`,
    };
  }

  private installOps(): void {
    this.ops.split = (id, dir) => this.split(id, dir);
    this.ops.swap = (a, b) => this.swap(a, b);
    this.ops.closePane = (id) => this.closePane(id);
    this.ops.focusPane = (id) => this.focusPane(id);
    this.ops.toggleZoom = (id) => this.toggleZoom(id);
    this.ops.collapse = (id) => this.collapse(id);
    this.ops.restore = (id) => this.restore(id);
    this.ops.addServer = (url, label) => this.addServer(url, label);
    this.ops.addServerWithOutcome = (url, label) => this.addServerWithOutcome(url, label);
    this.ops.removeServer = (url) => this.removeServer(url);
    this.ops.updateRoute = (paneId, route) => this.updateRoute(paneId, route);
    this.ops.selectTarget = (paneId, dir, session) => this.selectTarget(paneId, dir, session);
  }

  /** Dispose this controller: unregister from the store + the controller map so
   *  a closed workspace's host fully tears down. Called by DockviewHost
   *  onCleanup (closing a workspace disposes its host — that DOES reload its
   *  iframes, which is acceptable since the workspace is being destroyed).
   *
   *  PANE CLEANUP: explicitly unregister every pane this controller owns BEFORE
   *  the api disposes. Dockview's api.dispose() does not reliably fire
   *  onDidRemovePanel for each panel, so without this the destroyed workspace's
   *  panes would leak in the GLOBAL maps (survivalMap, statusByPane,
   *  titleByPane, firstNeedsYouAt, etc.) as orphaned entries. (They cannot
   *  inflate a LIVE workspace's needs-you count — recomputeAggregates scopes its
   *  scan by workspaceApis, and the destroyed ws is already gone from there —
   *  but the stale global entries would linger and the survival store would
   *  report identities for panes that no longer exist.) unregisterPane is
   *  idempotent (safe for panes a prior removePanel already cleared). */
  dispose(): void {
    controllers.delete(this.workspaceId);
    for (const id of this.renderers.keys()) {
      unregisterPane(id);
    }
    unregisterWorkspaceApi(this.workspaceId);
    unregisterWorkspaceOps(this.workspaceId);
    unregisterWorkspaceSync(this.workspaceId);
  }

  // ---- test bridge (window.__host) ----------------------------------------
  // Drives ops programmatically (deterministic survival assertions) and exposes
  // the two NEGATIVE-CONTROL hooks that deliberately do the reload-causing
  // wrong thing, so the gate can prove it detects them.
  //
  // DEV-ONLY. The ENTIRE bridge — including the two INTENTIONAL destructive
  // negative-control hooks `naiveReload` and `jsonReswap` — is gated behind
  // `import.meta.env.DEV` so production builds never expose the test surface or
  // the destructive reload hooks. Vite statically replaces `import.meta.env.DEV`
  // with `false` in prod builds, making this whole body unreachable, so the
  // bridge object and both hook closures are dead-code-eliminated from the
  // bundle (verified: grep dist/ for __host / naiveReload / jsonReswap → 0).
  //
  // SINGLETON: with multiple workspaces there are multiple controllers, but the
  // bridge is installed ONCE (bridgeInstalled guard). Every method resolves the
  // ACTIVE workspace's controller at call time (so bridge ops route to the
  // active tree), except renderer-lookup methods (getIframe, naiveReload) which
  // search ALL controllers since the addressed pane may live in any workspace.
  //
  // DO NOT "helpfully" delete or expose `naiveReload` / `jsonReswap` in prod:
  // they are INTENTIONAL negative controls. The survival regression test
  // (tests/e2e/survival.spec.ts) drives each one and asserts it reloads the
  // iframe, which proves the survival gate is non-vacuous. They run only under
  // the Vite dev server (the e2e webServer uses `npm run dev:host`), where DEV
  // is true.

  private installTestBridge(): void {
    if (!import.meta.env.DEV) return;
    if (bridgeInstalled) return;
    bridgeInstalled = true;
    const bridge = {
      // ---- multi-workspace model (workspace switch/add/close/rename) ----
      workspaces: (): string[] =>
        Array.from(controllers.keys()),
      activeWorkspace: (): string | null => activeWorkspaceId(),
      setActiveWorkspace: (id: string): void => {
        storeSetActiveWorkspace(id);
      },
      addWorkspace: (name?: string): string => storeAddWorkspace(name),
      closeWorkspace: (id: string): boolean => storeCloseWorkspace(id),
      renameWorkspace: (id: string, name: string): void => storeRenameWorkspace(id, name),
      // The workspace name as currently stored (for asserting a rename landed +
      // round-tripped through persistence). Reads the live store.
      workspaceName: (id: string): string =>
        storeWorkspaces().find((w) => w.id === id)?.name ?? "",

      // ---- active-workspace-scoped reads/ops ----
      panes: (): string[] => activeController()?.api.panels.map((p) => p.id) ?? [],
      paneParams: (): Array<{ id: string; url: string; label: string; route?: string }> =>
        activeController()?.api.panels.map((p) => {
          const params = (p.params ?? {}) as { url?: string; label?: string; route?: string };
          return {
            id: p.id,
            url: params.url ?? "",
            label: params.label ?? "",
            route: params.route,
          };
        }) ?? [],
      // Read-only full-layout serialization of the ACTIVE workspace's api.
      serialize: (): unknown => activeController()?.api.toJSON() ?? {},
      focused: (): string | null => focusedId(),
      trayIds: (): string[] => {
        const c = activeController();
        if (!c) return [];
        return c.api.groups
          .filter((g) => g.api.location.type === "floating")
          .map((g) => g.activePanel?.id ?? "")
          .filter(Boolean);
      },
      gridPaneCount: (): number => activeController()?.gridPaneCount() ?? 0,
      isMaximized: (): boolean => activeController()?.api.hasMaximizedGroup() ?? false,
      groupBox: (id: string) =>
        activeController()?.api.getPanel(id)?.group.api.boundingBox ?? null,
      survival: (id: string) => survivalFor(id) ?? null,
      baseline: (id: string) => baselineFor(id) ?? null,
      expectedNonce: (id: string) => expectedNonceFor(id) ?? null,
      resetBaseline: (id: string) => resetBaseline(id),
      connected: () => connected(),
      // P1: active-workspace needs-you aggregate (drives the workspace badge).
      needsYou: () => needsYouCount(),
      // PER-WORKSPACE needs-you count (ALL workspaces, not just active). Drives
      // the per-tab badge so a background ws's needy sessions are surfaced.
      needsYouFor: (wsId: string): number => needsYouCountFor(wsId),
      // P3 NEXT hero button: inspect the ranking without acting + trigger the
      // action + read the host-latched firstNeedsYouAt tiebreak. These route
      // through attentionNext.ts (production logic) so the e2e drives the SAME
      // path the statusbar's NEXT button uses.
      nextTarget: (): { paneId: string; wsId: string; attention: string; firstNeedsYouAt: number } | null =>
        attentionNextTarget(),
      next: (): void => {
        attentionNext();
      },
      firstNeedsYouAt: (id: string): number | null => {
        const v = firstNeedsYouAtFor(id);
        return v === undefined ? null : v;
      },

      // ---- document-liveness protocol probes (heartbeat-protocol e2e) ------
      liveness: (id: string) => livenessFor(id),
      // P1 session-attention: last-reported status for a pane (source-bound).
      status: (id: string) => statusFor(id) ?? null,
      probeHeartbeat: (
        args: {
          sourcePaneId: string | null;
          origin: string;
          payload: unknown;
        },
      ) => {
        const cw = args.sourcePaneId
          ? (lookupContentWindow(args.sourcePaneId) ?? null)
          : null;
        const src: Window | null = cw ?? (args.sourcePaneId === null ? window : null);
        return routeMessage(src, args.origin, args.payload);
      },
      noteIframeLoad: (id: string) => noteIframeLoad(id),
      sendHandshake: (id: string) => sendHandshake(id),
      protocolScratch: (id: string, origin: string) => {
        bindScratchSource(id, origin);
      },
      protocolProbe: (args: {
        scratchId: string | null;
        origin: string;
        payload: unknown;
      }) => {
        const src = args.scratchId ? (scratchSource(args.scratchId) ?? null) : null;
        return routeMessage(src as Window | null, args.origin, args.payload);
      },
      protocolLiveness: (id: string) => livenessFor(id),
      protocolNoteLoad: (id: string) => noteIframeLoad(id),
      protocolDispose: (id: string) => unregisterPane(id),

      split: (id: string, dir: SplitDir) => activeController()?.split(id, dir) ?? null,
      swap: (a: string, b: string) => activeController()?.swap(a, b),
      closePane: (id: string) => activeController()?.closePane(id),
      focus: (id: string) => activeController()?.focusPane(id),
      maximize: (id: string) => {
        const c = activeController();
        if (!c) return;
        const p = c.api.getPanel(id);
        if (p && !c.api.hasMaximizedGroup()) c.api.maximizeGroup(p);
      },
      exitMaximized: () => {
        activeController()?.api.exitMaximizedGroup();
      },
      collapse: (id: string) => activeController()?.collapse(id),
      restore: (id: string) => activeController()?.restore(id),

      addServer: (url: string, label: string): string | null =>
        activeController()?.addServer(url, label) ?? null,
      removeServer: (url: string): boolean =>
        activeController()?.removeServer(url) ?? false,
      // P4 decision #3: deterministic add-server with an OUTCOME. Drives the
      // SAME production HostOps path the AddServer popover uses
      // (hostOps().addServerWithOutcome). Returns {kind,paneId,label} or null
      // on isFleetEntry rejection.
      addServerWithOutcome: (
        url: string,
        label: string,
      ): AddServerOutcome | null =>
        activeController()?.addServerWithOutcome(url, label) ?? null,

      // P4 reverse-nav: drive a select through the SAME production HostOps path
      // the shell's NEXT/jump-to-session UI will use (hostOps().selectTarget).
      // Routes through the active controller's facet; the method itself does a
      // global store lookup (lookupContentWindow/configuredOriginFor), so the
      // round-trip lands in the pane regardless of its workspace.
      selectTarget: (paneId: string, dir: string, session: string): void => {
        activeController()?.selectTarget(paneId, dir, session);
      },

      dockAsTab: (a: string, b: string): void => {
        const c = activeController();
        if (!c) return;
        const pa = c.api.getPanel(a);
        const pb = c.api.getPanel(b);
        if (!pa || !pb || a === b) return;
        pa.api.moveTo({ group: pb.group, position: "center" });
      },
      sameGroup: (a: string, b: string): boolean => {
        const c = activeController();
        if (!c) return false;
        const pa = c.api.getPanel(a);
        const pb = c.api.getPanel(b);
        return !!pa && !!pb && pa.group === pb.group;
      },

      // Renderer-lookup methods search ALL controllers (the addressed pane may
      // live in any workspace, not just the active one).
      getIframe: (id: string): HTMLIFrameElement | null =>
        controllerForPane(id)?.renderers.get(id)?.getIframe() ?? null,

      // ---- P4 attention-target registry (flat tabstrip) -------------------
      // Drives the registry programmatically for e2e (caps/age/visit/dedup/
      // honest-status assertions). These route through the SAME production
      // targetRegistry module the Tabstrip + selectTarget/updateRoute use.
      targets: (): Array<{
        serverId: string; dir: string; session: string;
        title: string; titleSource: "fallback" | "session";
        lastVisitedAt: number; pinned: boolean;
        live: boolean;
        liveStatus: { attention: string; activity: string; title: string } | null;
      }> => {
        const live = liveKeysSet();
        return targetRecords().map((r) => {
          const k = `${r.target.serverId}\u0000${r.target.dir}\u0000${r.target.session}`;
          return {
            serverId: r.target.serverId,
            dir: r.target.dir,
            session: r.target.session,
            title: r.title,
            titleSource: r.titleSource ?? "fallback",
            lastVisitedAt: r.lastVisitedAt,
            pinned: r.pinned,
            live: live.has(k),
            liveStatus: r.liveStatus
              ? {
                  attention: r.liveStatus.attention,
                  activity: r.liveStatus.activity,
                  title: r.liveStatus.title,
                }
              : null,
          };
        });
      },
      visitTarget: (
        serverId: string,
        dir: string,
        session: string,
        title?: string,
      ): void => {
        visitTarget({ serverId, dir, session }, title);
      },
      dismissTarget: (serverId: string, dir: string, session: string): void => {
        dismissTarget({ serverId, dir, session });
      },
      pinTarget: (serverId: string, dir: string, session: string): boolean =>
        pinTarget({ serverId, dir, session }),
      unpinTarget: (serverId: string, dir: string, session: string): void => {
        unpinTarget({ serverId, dir, session });
      },
      activeTarget: (): { serverId: string; dir: string; session: string } | null => {
        const at = activeRegistryTarget();
        return at ? { serverId: at.serverId, dir: at.dir, session: at.session } : null;
      },
      // Resolve the pane bound to a serverId (the Tabstrip's tab-click resolver).
      findPaneForServer: (serverId: string): string | null =>
        findPaneForServer(serverId),
      // P4 decision #7: resolve BOTH the pane AND its owning workspace for a
      // serverId (cross-workspace selection). Returns {workspaceId,paneId}|null.
      resolveTabTarget: (serverId: string): { workspaceId: string; paneId: string } | null =>
        findPaneAndWorkspaceForServer(serverId),
      // P4 decision #7: read the workspace id that owns a given pane (cross-ws e2e).
      workspaceOfPane: (paneId: string): string | null =>
        workspaceOfPane(paneId),
      // Drive a tab select through the SAME production path the Tabstrip uses
      // (findPaneForServer → hostOps().selectTarget → visit).
      selectTab: (serverId: string, dir: string, session: string): boolean =>
        selectTab({ serverId, dir, session }),
      // TEST-ONLY: backdate a record's lastVisitedAt so age-retirement (7-day
      // eviction) is exercisable in a fast e2e. Persists (cold-load retirement
      // test). DEV-only; absent in prod builds.
      _backdateTarget: (serverId: string, dir: string, session: string, daysAgo: number): void => {
        const DAY = 24 * 60 * 60 * 1000;
        _setRecordVisitedAtForTest(
          { serverId, dir, session },
          Date.now() - daysAgo * DAY,
        );
      },

      // NEGATIVE CONTROL (a): naive remove + re-add. This is the exact mistake
      // renderer:'always' exists to prevent. It RELOADS the iframe (new
      // element) → mountTs/nonce/connId all change. The gate asserts that.
      naiveReload: (id: string): void => {
        const c = controllerForPane(id);
        const r = c?.renderers.get(id);
        if (!c || !r) return;
        const old = r.getIframe();
        const body = r.getBody();
        old.remove();
        const fresh = document.createElement("iframe");
        fresh.className = "pane-iframe";
        fresh.src = old.src;
        body.appendChild(fresh);
        if (fresh.contentWindow) bindContentWindow(id, fresh.contentWindow);
        fresh.addEventListener("load", () => {
          if (fresh.contentWindow) bindContentWindow(id, fresh.contentWindow);
          noteIframeLoad(id);
          sendHandshake(id);
        });
      },

      // NEGATIVE CONTROL (b): wholesale toJSON → fromJSON re-swap on the ACTIVE
      // workspace. This disposes + recreates EVERY panel in that workspace →
      // all its iframes reload. The gate asserts a reload.
      jsonReswap: (): void => {
        const c = activeController();
        if (!c) return;
        const state = c.api.toJSON();
        // default reuseExistingPanels=false → full dispose + recreate.
        c.api.fromJSON(state as never);
      },
    };
    (window as unknown as { __host?: typeof bridge }).__host = bridge;
  }
}

/** Singleton guard: the bridge installs exactly once across all controllers. */
let bridgeInstalled = false;

/** Best-effort host:port extraction for a fallback label. Returns "" on a
 *  malformed url (the caller's isFleetEntry check rejects those anyway). */
function safeHost(url: string): string {
  try {
    const h = new URL(url).host;
    return h || url;
  } catch {
    return url;
  }
}

// ---- P4 target → pane resolution + tab-select (flat tabstrip) --------------
// The flat tabstrip renders AttentionTarget records; clicking a tab must drive
// a survival-safe selectTarget on the pane bound to that target's server. These
// helpers resolve a target's server pane + issue the select. They live here
// (not in targetRegistry.ts) because pane resolution needs the live Dockview
// apis + configuredOrigin map (store accessors), and the registry is kept pure
// (types-only import) to avoid an import cycle with store.ts.

/**
 * Find the pane id bound to a given serverId (origin), across ALL workspaces.
 * Prefers the currently-focused pane when its origin matches (so a tab click
 * for the focused server reuses it); otherwise returns the first matching pane
 * found by scanning each workspace's live api.panels. Returns null when no pane
 * is bound to that server (the tab cannot be selected — the Tabstrip renders it
 * disabled).
 *
 * AMBIGUITY NOTE (flagged reversible default): if MULTIPLE panes are bound to
 * the same server origin, this picks the focused one (when it matches) else the
 * first in workspace-then-panel iteration order. That is a deliberate reversible
 * default — the brief's ambiguity. A future per-DIR iframe pool (DELETED from
 * P4 scope) would change this resolution.
 */
/**
 * Find the pane id bound to a given serverId (origin), across ALL workspaces.
 * Prefers the currently-focused pane when its origin matches (so a tab click
 * for the focused server reuses it); otherwise returns the first matching pane
 * found by scanning each workspace's live api.panels. Returns null when no pane
 * is bound to that server (the tab cannot be selected — the Tabstrip renders it
 * aria-disabled + explanatory).
 *
 * AMBIGUITY NOTE (flagged reversible default): if MULTIPLE panes are bound to
 * the same server origin, this picks the focused one (when it matches) else the
 * first in workspace-then-panel iteration order. That is a deliberate reversible
 * default — the brief's ambiguity. A future per-DIR iframe pool (DELETED from
 * P4 scope) would change this resolution.
 *
 * Cross-workspace-aware callers should prefer findPaneAndWorkspaceForServer
 * (which also returns the owning workspace id so selectTab can activate it).
 */
export function findPaneForServer(serverId: string): string | null {
  return findPaneAndWorkspaceForServer(serverId)?.paneId ?? null;
}

/**
 * Resolve BOTH the pane and its owning workspace for a serverId (decision #7).
 * Used by selectTab to activate the owning workspace FIRST (CSS-only visibility,
 * survival-safe) before issuing selectTarget — this fixes the "click did
 * nothing" path when the matching pane is in a hidden (non-active) workspace:
 * previously selectTarget posted to the pane's contentWindow (which worked) but
 * the operator saw nothing change because the workspace stayed hidden. Now the
 * owning workspace is surfaced first so the operator sees the result.
 *
 * Returns null when no pane is bound to the server (unavailable-server state).
 */
export function findPaneAndWorkspaceForServer(
  serverId: string,
): { workspaceId: string; paneId: string } | null {
  // Prefer the focused pane when its origin matches (it lives in the active
  // workspace, so its owning workspace is activeWorkspaceId()).
  const focused = focusedId();
  if (focused && configuredOriginFor(focused) === serverId) {
    const ws = activeWorkspaceId();
    if (ws) return { workspaceId: ws, paneId: focused };
  }
  for (const ws of storeWorkspaces()) {
    const api = workspaceApiFor(ws.id);
    if (!api) continue;
    for (const panel of api.panels) {
      if (configuredOriginFor(panel.id) === serverId) {
        return { workspaceId: ws.id, paneId: panel.id };
      }
    }
  }
  return null;
}

/** Read the workspace id that owns a given pane (across all workspaces), or
 *  null when no live api has the pane. Used by the DEV bridge for the cross-
 *  workspace e2e. */
export function workspaceOfPane(paneId: string): string | null {
  for (const ws of storeWorkspaces()) {
    const api = workspaceApiFor(ws.id);
    if (!api) continue;
    if (api.panels.some((p) => p.id === paneId)) return ws.id;
  }
  return null;
}

/**
 * Select a target's tab (decision #7 cross-workspace path). Resolves the pane
 * bound to the target's server AND its owning workspace; if the owning workspace
 * is not active, activates it FIRST (CSS-only visibility switch — survival-safe,
 * no iframe reload), then issues the survival-safe selectTarget (SPA-internal
 * route change; the iframe src + element are NEVER touched). No-op (returns
 * false) when no pane is bound to that server (the Tabstrip renders the tab
 * aria-disabled + explanatory — unavailable-server state). On success, visit()
 * (called inside selectTarget) sets the target active.
 */
export function selectTab(target: AttentionTargetLike): boolean {
  const resolved = findPaneAndWorkspaceForServer(target.serverId);
  if (!resolved) return false; // unavailable-server: no pane bound → no-op
  // Cross-workspace: surface the owning workspace FIRST so the operator sees
  // the result (CSS-only visibility — survival-safe). No-op when already active.
  const active = activeWorkspaceId();
  if (active !== resolved.workspaceId) {
    storeSetActiveWorkspace(resolved.workspaceId);
  }
  hostOps()?.selectTarget?.(resolved.paneId, target.dir, target.session);
  return true;
}

/** Minimal structural shape selectTab accepts (avoids importing the type into
 *  this call site's consumers that already hold a {serverId,dir,session}). */
interface AttentionTargetLike {
  serverId: string;
  dir: string;
  session: string;
}

// Re-export the registry accessors the Tabstrip + bridge consume, so the shell
// imports everything tab-related from hostController (one import surface).
// (findPaneAndWorkspaceForServer + workspaceOfPane are already `export
// function` above, so they are NOT re-listed here.)
export {
  visitTarget,
  dismissTarget,
  pinTarget,
  unpinTarget,
  activeRegistryTarget,
  targetRecords,
  liveKeysSet,
};

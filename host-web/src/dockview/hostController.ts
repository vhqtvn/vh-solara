import type { DockviewApi, IDockviewPanel } from "dockview-core";
import type { IframeRenderer } from "./iframeRenderer";
import type { AddServerOutcome, FocusDir, HostOps, LayoutMode, OverlaySplitDir, PaneVm, SplitDir } from "./types";
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
import { scheduleSave } from "./layoutPersistence";
import {
  deleteNamedLayout,
  listNamedLayouts,
  loadNamedLayout,
  saveNamedLayout,
} from "./namedLayouts";
import { next as attentionNext, nextTarget as attentionNextTarget } from "../attentionNext";
import {
  activeWorkspaceId,
  addWorkspace as storeAddWorkspace,
  baselineFor,
  bindContentWindow,
  bindScratchSource,
  captureActiveLayout,
  closeOverlay,
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
  openOverlayFor,
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
  overlaySourcePaneId,
} from "./store";

type Direction = "left" | "right" | "above" | "below";

// Overlay Split/Swap cardinal dir (OverlaySplitDir) → the bounding-box focus dir
// (FocusDir) the nearest-neighbor lookup uses. above↔up, below↔down, left/right
// identity.
const OVERLAY_TO_FOCUS: Record<OverlaySplitDir, FocusDir> = {
  above: "up",
  right: "right",
  below: "down",
  left: "left",
};
// The OPPOSITE side a neighbor must split back out to after the source docks
// into its group center, so the two panes exchange relative ORDER. Map is keyed
// by the FocusDir the source moved FROM (the neighbor direction): a neighbor to
// the right gets ejected LEFT, etc. Values are dockview moveTo `position`
// vocabulary ("left"|"right"|"top"|"bottom"), NOT addPanel `direction`.
const OPPOSITE_SIDE: Record<FocusDir, "left" | "right" | "top" | "bottom"> = {
  right: "left",
  left: "right",
  down: "top",
  up: "bottom",
};

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
   * (tabs=panes model: routes are NO LONGER minted as session tabs. The
   * tabstrip shows panes directly. Route capture is purely for cold-restore
   * persistence — the SPA re-deep-links itself on reload.)
   */
  updateRoute(paneId: string, route: string): void {
    const panel = this.api.getPanel(paneId);
    if (!panel) return;
    panel.api.updateParameters({ ...(panel.params ?? {}), route });
  }

  /**
   * Direct a pane's embedded SPA to switch to a specific {dir, session} via a
   * survival-safe postMessage (reverse-nav). The iframe src + element are NEVER
   * touched — this posts {type:'vh-host-select',dir,session} to the pane's bound
   * contentWindow targeted at its configured origin (never '*'). The SPA
   * performs an INTERNAL route change (setSelectedId/switchProject); its
   * existing route emission fires {type:'route'} back, which updateRoute
   * captures — the round-trip success signal. No-op when the pane is not found
   * or its origin is unbound.
   *
   * (tabs=panes model: selectTarget is for navigating sessions WITHIN a window
   * via the SPA tree; it is NOT the tab identity anymore. Tabs ARE panes.)
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
  }

  /**
   * Direct a pane's embedded SPA to force its chat back onto the transcript
   * tail (jump-to-latest) via a survival-safe postMessage — mirrors
   * selectTarget's shape exactly. The iframe src + element are NEVER touched;
   * the SPA performs an INTERNAL scroll action (its own jumpToLatest path), so
   * survival is unchanged. The round-trip signal is the SPA's existing
   * {type:'status'} emission (the idempotence key now includes `following`),
   * captured by setStatusFor — the UI reflects the REPORTED state, never a
   * local echo. NOTE: the SPA dispatches only following=true (force-unfollow
   * is not durably expressible in its scroll machinery — read-first verdict;
   * see web/src/tailListener.ts); the host UI exposes indicator +
   * "Jump to latest" only. No-op when the pane is not found or its origin is
   * unbound (never '*').
   */
  setTail(paneId: string, following: boolean): void {
    const cw = lookupContentWindow(paneId);
    const origin = configuredOriginFor(paneId);
    if (!cw || !origin) return;
    cw.postMessage({ type: "vh-host-tail", following }, origin);
  }

  /**
   * Rename a pane's LABEL inline (tabs=panes model, operator point #2: "rename
   * mean rename the prefix"). Updates the panel params via
   * `api.updateParameters({label})` WITHOUT reloading the iframe (same
   * survival-safe mechanism as updateRoute — IframeRenderer has no update()
   * method → no-op on the component → iframe element + src + renderer:'always'
   * mount are ALL untouched). Persists via scheduleSave — belt-and-suspenders:
   * updateParameters DOES fire the buffered onDidLayoutChange (dockview wires
   * Event.any(onDidPanelTitleChange, onDidPanelParametersChange) into it — it
   * was the detonator in the FLIP baseline-freshness test), so the layout
   * saver hooked in DockviewHost already schedules a save; the explicit call
   * only makes it immediate. Mirrors the renameWorkspace
   * referential-identity-preserving pattern (mutate the label field, don't
   * spread-recreate the panel). Refuses an empty/whitespace label (keeps the
   * current label).
   */
  renamePane(paneId: string, label: string): void {
    const panel = this.api.getPanel(paneId);
    if (!panel) return;
    const trimmed = label.trim();
    if (!trimmed) return; // refuse empty rename (keep current label)
    panel.api.updateParameters({ ...(panel.params ?? {}), label: trimmed });
    this.syncPanes(); // rebuild PaneVm with the new label
    scheduleSave(); // persist now (the layout-event save is debounced anyway)
  }

  /**
   * Switch the focused pane's group into one of the four i3 container layout
   *  modes (Phase 1). LIVE-TREE (Gate 1 passed: orientation flip + header
   *  position flip both survival-safe — iframe identity unchanged).
   *
   *  - tabbed: group.api.setHeaderPosition('top') — native tab strip across the
   *    top (un-hidden by dockviewOverrides.css for ≥2 panels).
   *  - stacked: group.api.setHeaderPosition('left') — tab strip down the side.
   *  - split-h: break each panel (after the first) out of the group into its own
   *    group to the RIGHT (moveTo repositions the keep-mounted renderer).
   *  - split-v: break each panel out BELOW.
   *
   *  SURVIVAL: both setHeaderPosition and moveTo are proven survival-safe by the
   *  gate probe (identity unchanged). No cold reload. Single-panel groups are a
   *  no-op for split-h/split-v (nothing to break out) and set the header
   *  position for tabbed/stacked (visually inert until a second panel arrives).
   */
  setLayoutMode(paneId: string, mode: LayoutMode): void {
    const panel = this.api.getPanel(paneId);
    if (!panel) return;
    const group = panel.group;
    if (mode === "tabbed" || mode === "stacked") {
      const pos = mode === "tabbed" ? "top" : "left";
      try {
        group.api.setHeaderPosition(pos);
      } catch {
        // setHeaderPosition can throw on certain group states — swallow.
      }
      this.afterMutation();
      return;
    }
    // split-h / split-v: break a multi-panel group's panels out into separate
    // tiled groups. moveTo(position) relative to the SOURCE panel's group (NOT
    // group.panels[0] — the prior code anchored on the first panel, so invoking
    // the mode from a non-first tab anchored + activated the wrong pane). The
    // source is the pane the operator invoked the mode on (the source pane in
    // the overlay path; the legacy statusbar + keyboard paths were retired with
    // the statusbar). Every OTHER
    // panel breaks out into its own group relative to the source; the SOURCE
    // stays put + is re-activated. Position vocabulary is dockview's
    // 'left'|'right'|'top'|'bottom' (NOT the addPanel 'direction' vocabulary
    // 'right'|'below').
    const pos = mode === "split-h" ? "right" : "bottom";
    const panels = [...group.panels];
    if (panels.length > 1) {
      for (const p of panels) {
        if (p.id === panel.id) continue;
        p.api.moveTo({ group: panel.group, position: pos });
      }
      // The SOURCE remains active (was the focused/invoking pane), not
      // panels[0]. This is the split-target fix.
      panel.api.setActive();
    }
    this.afterMutation();
  }

  /**
   * Focus the spatially-nearest grid pane in the given cardinal direction
   *  (i3 Alt+Arrow). Bounding-box geometry: among all GRID panes whose center
   *  lies in the requested half-plane (and whose primary-axis offset dominates
   *  the cross-axis), pick the smallest primary-axis distance. Survival-safe
   *  (focusPane only — setActive; no iframe touched). No-op when no neighbor.
   */
  focusDirection(paneId: string, dir: FocusDir): void {
    const id = this.nearestPaneInDir(paneId, dir);
    if (id) this.focusPane(id);
  }

  /**
   * Swap the focused pane with the spatially-nearest grid pane in the given
   *  cardinal direction (i3 Alt+Shift+Arrow move). Survival-safe via
   *  exchangePanes (live-tree moveTo only; renderer:'always' keeps both iframes
   *  mounted). No-op when no neighbor OR either pane is not swap-eligible
   *  (tabbed/stacked/floating/maximized). NOTE: there is no keyboard binding
   *  wired to this anymore (the Alt+Shift shortcuts were retired with the
   *  statusbar); overlaySwap (Swap mode) is the live surface. Kept + corrected
   *  for API completeness + the DEV bridge moveDirection probe. */
  moveDirection(paneId: string, dir: FocusDir): void {
    const panel = this.api.getPanel(paneId);
    if (!panel || !this.isSwappablePanel(panel)) return;
    const neighborId = this.nearestPaneInDir(paneId, dir);
    if (!neighborId || neighborId === paneId) return;
    const neighbor = this.api.getPanel(neighborId);
    if (!neighbor || !this.isSwappablePanel(neighbor)) return;
    this.exchangePanes(panel, neighbor, dir);
  }

  // ---- layout overlay (gesture / DEV-bridge fallback) ----------------------

  /**
   * Open the layout overlay anchored to `paneId`'s group. Focuses the source
   * pane (so the focus indicator + subsequent split target it), then activates
   * the overlay state. Idempotent: a second open while already open re-anchors
   * (the store signal just swaps). No-op when the pane is not in THIS
   * workspace. The host-gesture router (double-Ctrl / triple-tap, forwarded by
   * the embedded SPA) and the DEV test bridge both route through this; there is
   * no longer a statusbar Layout button (the statusbar was removed in its
   * entirety).
   */
  openLayoutOverlay(paneId: string): void {
    const panel = this.api.getPanel(paneId);
    if (!panel) return;
    panel.api.setActive();
    openOverlayFor(this.workspaceId, paneId);
  }

  /** Close the layout overlay (clears the source anchor). */
  closeLayoutOverlay(): void {
    closeOverlay();
  }

  /**
   * Split the overlay's source pane in a cardinal direction (an overlay arrow).
   * Survival-safe: addPanel relative to the source panel; renderer:'always'
   * keeps the source iframe mounted. Dockview's addPanel `position.direction`
   * accepts the four cardinals relative to `referencePanel`. The new pane
   * becomes active (matching the existing split() behavior). Auto-closes the
   * overlay (a split is a terminal overlay action). Returns the new pane id.
   */
  overlaySplit(paneId: string, dir: OverlaySplitDir): string | null {
    const panel = this.api.getPanel(paneId);
    if (!panel) return null;
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
    // A split is a terminal overlay action — close the overlay so the operator
    // sees the result, not a stale anchor over a changed layout.
    closeOverlay();
    return created.id;
  }

  /**
   * Swap the overlay's source pane with its nearest neighbor in a cardinal
   *  direction (overlay arrow path, Swap mode). Survival-safe live-tree
   *  exchange via exchangePanes (dock source into neighbor's group center, then
   *  split neighbor back out to the opposite side); renderer:'always' keeps both
   *  iframes mounted (mountTs/nonce/connId unchanged — proven by the Slice-2
   *  characterization). Bounded to ordinary tiled single-panel grid groups (no
   *  tabbed/stacked/floating/maximized). Returns the swapped-with pane id on
   *  success, or null when not applicable. Auto-closes + source stays active. */
  overlaySwap(paneId: string, dir: OverlaySplitDir): string | null {
    const panel = this.api.getPanel(paneId);
    if (!panel || !this.isSwappablePanel(panel)) return null;
    const focusDir = OVERLAY_TO_FOCUS[dir];
    const neighborId = this.nearestPaneInDir(paneId, focusDir);
    if (!neighborId) return null;
    const neighbor = this.api.getPanel(neighborId);
    if (!neighbor || !this.isSwappablePanel(neighbor)) return null;
    this.exchangePanes(panel, neighbor, focusDir);
    // Source stays active (exchangePanes sets it). A swap is a terminal overlay
    // action — close so the operator sees the exchanged layout, not a stale
    // anchor.
    panel.api.setActive();
    closeOverlay();
    return neighborId;
  }

  /**
   * Read the swappable neighbor (if any) in each cardinal direction, for the
   * overlay's Swap-mode arrow-enable computation. A direction maps to null
   * when there is no neighbor OR the source/neighbor is not swap-eligible
   * (the overlay disables that arrow rather than silently no-op'ing). */
  overlaySwapTargets(paneId: string): Record<OverlaySplitDir, string | null> {
    const result: Record<OverlaySplitDir, string | null> = {
      above: null,
      right: null,
      below: null,
      left: null,
    };
    const panel = this.api.getPanel(paneId);
    if (!panel) return result;
    const sourceOk = this.isSwappablePanel(panel);
    for (const dir of ["above", "right", "below", "left"] as OverlaySplitDir[]) {
      const neighborId = this.nearestPaneInDir(paneId, OVERLAY_TO_FOCUS[dir]);
      if (!neighborId) continue;
      if (!sourceOk) continue;
      const neighbor = this.api.getPanel(neighborId);
      if (!neighbor || !this.isSwappablePanel(neighbor)) continue;
      result[dir] = neighborId;
    }
    return result;
  }

  // ---- named layouts (shell-level; routed through the ACTIVE facet) --------

  /**
   * Save the ACTIVE workspace's current layout under `name`. SHELL-LEVEL op:
   * hostOps() resolves the active workspace's facet, so by construction this
   * runs on the ACTIVE controller — captureActiveLayout() reads the active
   * workspace's api (this.api) and serializes it through the SAME fractional
   * transform the persistence writer uses. Read-only: toJSON never mutates
   * the tree, no iframe is touched. Same name = overwrite (savedAt refreshes;
   * see namedLayouts.ts). Returns true when written, false when the active
   * layout could not be captured (no active api) or the name is empty.
   */
  saveLayout(name: string): boolean {
    const layout = captureActiveLayout();
    if (!layout) return false;
    return saveNamedLayout(name, layout);
  }

  /**
   * Instantiate the named layout as a NEW workspace (cold mount). Reads the
   * saved blob, hands it to addWorkspace (which STAGES it for the fresh
   * workspace id so the new DockviewHost cold-restores it at mount through the
   * existing persistence pipeline — fromJSON exactly once, before any of the
   * new workspace's iframes exist), names the workspace after the save, and
   * activates it (addWorkspace's existing activation path; FLIP/normalize
   * effects compose exactly as on any workspace add). NEVER touches any live
   * workspace's tree — the only mutations are a new workspace record +
   * activation. Returns the new workspace id, or null when no layout is saved
   * under the name.
   */
  loadLayout(name: string): string | null {
    const entry = loadNamedLayout(name);
    if (!entry) return null;
    return storeAddWorkspace(name, entry.layout);
  }

  /** Spatial nearest-neighbor in a cardinal direction, by group bounding-box
   *  centers. Returns null when no grid pane lies in that direction. */
  private nearestPaneInDir(paneId: string, dir: FocusDir): string | null {
    const panel = this.api.getPanel(paneId);
    if (!panel) return null;
    const myBox = panel.group.api.boundingBox;
    if (!myBox) return null;
    const myCx = myBox.left + myBox.width / 2;
    const myCy = myBox.top + myBox.height / 2;
    let best: { id: string; dist: number } | null = null;
    for (const p of this.api.panels) {
      if (p.id === paneId) continue;
      if (p.group.api.location.type !== "grid") continue;
      const box = p.group.api.boundingBox;
      if (!box) continue;
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const dx = cx - myCx;
      const dy = cy - myCy;
      // Require the primary-axis offset to dominate the cross-axis (a pane
      // roughly in the requested half-plane, not diagonally off).
      let inDir = false;
      let primary = 0;
      if (dir === "left") {
        inDir = dx < 0 && Math.abs(dx) >= Math.abs(dy) * 0.5;
        primary = -dx;
      } else if (dir === "right") {
        inDir = dx > 0 && dx >= Math.abs(dy) * 0.5;
        primary = dx;
      } else if (dir === "up") {
        inDir = dy < 0 && Math.abs(dy) >= Math.abs(dx) * 0.5;
        primary = -dy;
      } else {
        inDir = dy > 0 && dy >= Math.abs(dx) * 0.5;
        primary = dy;
      }
      if (!inDir || primary <= 0) continue;
      if (!best || primary < best.dist) best = { id: p.id, dist: primary };
    }
    return best?.id ?? null;
  }

  /** Is `panel` eligible for a swap-with-direction exchange? Requires an
   *  ordinary tiled single-panel grid group: not in the tray (floating), not a
   *  tabbed/stacked multi-panel group (those need a break-out first), and no
   *  active maximization (maximized mode hides geometry — swapping there is
   *  ambiguous). Survival is not the concern here (moveTo never disposes); this
   *  bounds the exchange to the geometrically-meaningful case. */
  private isSwappablePanel(panel: IDockviewPanel): boolean {
    if (panel.group.api.location.type !== "grid") return false;
    if (panel.group.panels.length !== 1) return false;
    if (this.api.hasMaximizedGroup()) return false;
    return true;
  }

  /** Exchange two panes' relative ORDER via live-tree moveTo ops only
   *  (renderer:'always' keeps both iframes mounted; mountTs/nonce/connId
   *  unchanged). Algorithm (proven by the Slice-2 characterization probe):
   *  (1) dock the SOURCE into the NEIGHBOR's group center — source's old
   *  single-panel group is auto-removed by Dockview; (2) split the NEIGHBOR
   *  back out to the OPPOSITE side of the direction the source came from, so
   *  the neighbor now occupies the source's former side and the source is left
   *  where the neighbor was. Dockview re-proportions pane sizes on dock+split,
   *  so RELATIVE ORDER flips (left/right or top/bottom) but absolute pixels are
   *  not preserved — that is the intended "swap with neighbor" semantic. The
   *  caller MUST have validated both panels via isSwappablePanel. */
  private exchangePanes(
    source: IDockviewPanel,
    neighbor: IDockviewPanel,
    focusDir: FocusDir,
  ): void {
    const gb = neighbor.group;
    // 1) dock source into neighbor's group as a tab; source's iframe survives
    //    (moveTo repositions the keep-mounted renderer). source's old (now
    //    empty single-panel) group is auto-removed by Dockview.
    source.api.moveTo({ group: gb, position: "center" });
    // 2) split neighbor back out to the opposite side — neighbor leaves the
    //    combined group to occupy the source's former side, leaving source
    //    alone in the combined group at the neighbor's former side. Net: the
    //    two panes have exchanged relative ORDER. neighbor's iframe survives.
    neighbor.api.moveTo({ group: gb, position: OPPOSITE_SIDE[focusDir] });
    source.api.setActive();
    this.afterMutation();
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
   *  survive a workspace switch; status read from the global statusFor map so
   *  the per-pane needs-you badge survives a syncPanes rebuild). No-op for the
   *  display signal when this workspace is not active (the store mutator guards
   *  on active). */
  private syncPanes(): void {
    const vms: PaneVm[] = [];
    for (const panel of this.api.panels) {
      const params = (panel.params ?? {}) as { url?: string; label?: string };
      const title = titleFor(panel.id) ?? params.label ?? "";
      vms.push({
        id: panel.id,
        label: params.label ?? "server",
        title,
        url: params.url ?? "",
        status: statusFor(panel.id) ?? undefined,
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
    this.ops.setTail = (paneId, following) => this.setTail(paneId, following);
    this.ops.renamePane = (paneId, label) => this.renamePane(paneId, label);
    this.ops.setLayoutMode = (paneId, mode) => this.setLayoutMode(paneId, mode);
    this.ops.focusDirection = (paneId, dir) => this.focusDirection(paneId, dir);
    this.ops.moveDirection = (paneId, dir) => this.moveDirection(paneId, dir);
    this.ops.openLayoutOverlay = (paneId) => this.openLayoutOverlay(paneId);
    this.ops.closeLayoutOverlay = () => this.closeLayoutOverlay();
    this.ops.overlaySplit = (paneId, dir) => this.overlaySplit(paneId, dir);
    this.ops.overlaySwap = (paneId, dir) => this.overlaySwap(paneId, dir);
    this.ops.overlaySwapTargets = (paneId) => this.overlaySwapTargets(paneId);
    this.ops.saveLayout = (name) => this.saveLayout(name);
    this.ops.loadLayout = (name) => this.loadLayout(name);
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

      // ---- named layouts (drives the SAME production HostOps paths the
      // Settings → Layouts… manager uses; reads for assertions) ----
      // Save/load route through the ACTIVE controller's facet exactly like a
      // Settings click; list/delete read the namedLayouts store directly (pure
      // module — no live-tree involvement).
      saveLayout: (name: string): boolean =>
        activeController()?.saveLayout(name) ?? false,
      loadLayout: (name: string): string | null =>
        activeController()?.loadLayout(name) ?? null,
      namedLayouts: (): Array<{ name: string; savedAt: number }> =>
        listNamedLayouts(),
      deleteNamedLayout: (name: string): boolean => deleteNamedLayout(name),

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
      // path the tabstrip NEXT button uses.
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

      // Tail/follow control: drive a force-follow through the SAME production
      // HostOps path the layout overlay's Tail row uses (hostOps().setTail).
      // Routes through the active controller's facet; the method itself does a
      // global store lookup (lookupContentWindow/configuredOriginFor), so the
      // post lands in the pane regardless of its workspace. The SPA dispatches
      // only the true path (read-first verdict).
      setTail: (paneId: string, following: boolean): void => {
        activeController()?.setTail(paneId, following);
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

      // ---- i3 layout-mode probes (orientation + header position) ------------
      // Read the gridview root orientation ("HORIZONTAL" | "VERTICAL"). The root
      // orientation + tree depth jointly derive every branch's orientation
      // (dockview-core serializeBranchNode alternates orthogonal by depth). Used
      // by the gate probe + the persistence round-trip e2e. The CORRECT path is
      // the runtime Gridview at `api.component.gridview.orientation` (the
      // DockviewApi TS type does not expose it; `DockviewApi.orientation` does
      // not exist and `DockviewComponent.orientation` is getter-only — the old
      // bridge cast wrote that broken no-op path and silently did nothing).
      // Same proven, idempotent, survival-safe primitive viewportShape uses.
      rootOrientation: (): "HORIZONTAL" | "VERTICAL" => {
        const c = activeController();
        if (!c) return "HORIZONTAL";
        const gv = (
          c.api as unknown as {
            component?: { gridview?: { orientation?: string } };
          }
        ).component?.gridview;
        return ((gv?.orientation ?? "HORIZONTAL") as "HORIZONTAL" | "VERTICAL");
      },
      // Flip the gridview root orientation at runtime. The gridview setter
      // calls flipNode(root) which rebuilds the splitview tree in place
      // (survival-safe — proven by the viewport-shape gate; iframes keep their
      // identity) and guards on equality, so setting the current value is a
      // true no-op.
      setRootOrientation: (o: "HORIZONTAL" | "VERTICAL"): boolean => {
        const c = activeController();
        if (!c) return false;
        try {
          const gv = (
            c.api as unknown as {
              component?: { gridview?: { orientation: string } };
            }
          ).component?.gridview;
          if (!gv) return false;
          gv.orientation = o;
          return true;
        } catch {
          return false;
        }
      },
      // Read the focused pane's group identity + panel count + header position.
      // headerPosition drives the native tab strip placement ('top' = tabbed,
      // 'left'/'right' = stacked). Used by the mode-switch e2e.
      groupOf: (
        paneId: string,
      ): { groupId: string; panelCount: number; headerPosition: string } | null => {
        const c = activeController();
        if (!c) return null;
        const p = c.api.getPanel(paneId);
        if (!p) return null;
        const g = p.group;
        return {
          groupId: g.id,
          panelCount: g.panels.length,
          headerPosition: g.api.getHeaderPosition(),
        };
      },
      // Set the focused pane's group header position (tabbed/stacked mode-switch).
      setGroupHeaderPosition: (
        paneId: string,
        pos: "top" | "bottom" | "left" | "right",
      ): boolean => {
        const c = activeController();
        if (!c) return false;
        const p = c.api.getPanel(paneId);
        if (!p) return false;
        try {
          p.group.api.setHeaderPosition(pos);
          return true;
        } catch {
          return false;
        }
      },
      // Move a pane OUT of its group into a fresh group at the given direction
      // (split a tabbed group back into tiled panes). Survival-safe: moveTo
      // repositions the keep-mounted renderer. Position vocabulary is dockview's
      // 'left'|'right'|'top'|'bottom' (NOT addPanel's 'direction' vocab).
      breakOutGroup: (paneId: string, dir: "right" | "left" | "top" | "bottom"): boolean => {
        const c = activeController();
        if (!c) return false;
        const p = c.api.getPanel(paneId);
        if (!p) return false;
        try {
          p.api.moveTo({ group: p.group, position: dir });
          return true;
        } catch {
          return false;
        }
      },

      // Renderer-lookup methods search ALL controllers (the addressed pane may
      // live in any workspace, not just the active one).
      getIframe: (id: string): HTMLIFrameElement | null =>
        controllerForPane(id)?.renderers.get(id)?.getIframe() ?? null,

      // ---- tabs=panes model: rename + select (replaces P4 target bridge) ----
      // Rename a pane's label inline (survival-safe: updateParameters, no
      // iframe reload). Drives the SAME production HostOps path the Tabstrip's
      // inline edit uses (hostOps().renamePane).
      renamePane: (paneId: string, label: string): void => {
        activeController()?.renamePane(paneId, label);
      },

      // i3 layout-mode switch (Phase 1). Drives the SAME production HostOps path
      // the layout overlay + the DEV bridge use (hostOps().setLayoutMode); the
      // statusbar cluster + Alt-keyboard shortcuts that also invoked it were
      // retired with the statusbar.
      setLayoutMode: (paneId: string, mode: LayoutMode): void => {
        activeController()?.setLayoutMode(paneId, mode);
      },

      // i3 directional focus/move (Alt+Arrow / Alt+Shift+Arrow). Drives the SAME
      // production HostOps path the keyboard shortcuts use.
      focusDirection: (paneId: string, dir: FocusDir): void => {
        activeController()?.focusDirection(paneId, dir);
      },
      moveDirection: (paneId: string, dir: FocusDir): void => {
        activeController()?.moveDirection(paneId, dir);
      },

      // ---- layout overlay (gesture / DEV-bridge fallback) -------------------
      // Drive the overlay through the SAME production HostOps path the
      // host-gesture router uses (hostOps().openLayoutOverlay / closeLayoutOverlay
      // / overlaySplit / overlaySwap / overlaySwapTargets), plus read the overlay
      // source signal for assertions. The statusbar Layout button that used to
      // also open the overlay was removed with the statusbar; the overlay is
      // gesture + DEV-bridge triggered now. The host-gesture MESSAGE itself is
      // probed via the existing probeHeartbeat (it routes any payload through
      // the real routeMessage — the security e2e uses it).
      overlaySource: (): string | null => overlaySourcePaneId(),
      openLayoutOverlay: (paneId: string): void => {
        activeController()?.openLayoutOverlay(paneId);
      },
      closeLayoutOverlay: (): void => {
        activeController()?.closeLayoutOverlay();
      },
      overlaySplit: (paneId: string, dir: OverlaySplitDir): string | null =>
        activeController()?.overlaySplit(paneId, dir) ?? null,
      overlaySwap: (paneId: string, dir: OverlaySplitDir): string | null =>
        activeController()?.overlaySwap(paneId, dir) ?? null,
      overlaySwapTargets: (
        paneId: string,
      ): Record<OverlaySplitDir, string | null> =>
        activeController()?.overlaySwapTargets(paneId) ?? {
          above: null,
          right: null,
          below: null,
          left: null,
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

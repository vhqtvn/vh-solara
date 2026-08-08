import type { DockviewApi, IDockviewPanel } from "dockview-core";
import type { IframeRenderer } from "./iframeRenderer";
import type { HostOps, SplitDir } from "./types";
import { isRealFleet, mockUrl, nextMockPane, nextPaneId } from "../state/mockData";
import {
  baselineFor,
  bindContentWindow,
  connected,
  focusedId,
  panes,
  resetBaseline,
  setFocused,
  setMaximized,
  setTray,
  survivalFor,
  unregisterPane,
  upsertPaneVm,
} from "./store";

type Direction = "left" | "right" | "above" | "below";

/**
 * Imperative host controller. Owns the DockviewApi and implements every layout
 * op as a MUTATION OF THE LIVE TREE (rule #2): runtime actions never round-trip
 * through toJSON/fromJSON — that disposes + recreates panels and reloads the
 * cross-origin iframes. toJSON/fromJSON are reserved for cold persistence
 * (deferred) and for the negative-control test hook that PROVES such a reswap
 * reloads.
 */
export class HostController implements HostOps {
  constructor(
    private readonly api: DockviewApi,
    private readonly renderers: Map<string, IframeRenderer>,
    private readonly ops: HostOps,
  ) {
    this.installOps();
    this.wireEvents();
    this.installTestBridge();
  }

  // ---- HostOps implementation (mutates the live tree) ---------------------

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
      // NOTE: the prior `moveTo({ group: undefined })` silently no-opped —
      // panel.api.moveTo resolves a missing group to the panel's OWN (floating)
      // group, so the pane never left the tray (proven: a restore-into-empty-grid
      // e2e saw gridPaneCount stuck at 0 against the old code; green with this).
      const fresh = this.api.addGroup();
      panel.api.moveTo({ group: fresh, position: "center" });
    }
    panel.api.setActive();
    this.afterMutation();
  }

  // ---- event wiring → store ------------------------------------------------

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
      setFocused(next);
    });
    this.api.onDidMaximizedGroupChange(() => {
      setMaximized(this.api.hasMaximizedGroup());
      this.pushHeaderStates();
    });
    this.api.onDidAddPanel(() => this.syncPanes());
    this.api.onDidRemovePanel((p) => {
      unregisterPane(p.id);
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

  /** Reconcile the shell view-model with the live Dockview panels. */
  private syncPanes(): void {
    for (const panel of this.api.panels) {
      const params = (panel.params ?? {}) as { url?: string; label?: string };
      const existing = panes().find((p) => p.id === panel.id);
      upsertPaneVm({
        id: panel.id,
        label: params.label ?? existing?.label ?? "server",
        title: existing?.title ?? params.label ?? "",
      });
    }
    this.afterMutation();
  }

  private syncTray(): void {
    const tray: string[] = [];
    for (const g of this.api.groups) {
      if (g.api.location.type === "floating" && g.activePanel) {
        tray.push(g.activePanel.id);
      }
    }
    setTray(tray);
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

  private gridPaneCount(): number {
    let n = 0;
    for (const g of this.api.groups) {
      if (g.api.location.type === "grid") n += g.activePanel ? 1 : g.panels.length;
    }
    return n;
  }

  /**
   * Build params for a NEW pane created by "+" / split.
   *
   * - REAL-fleet mode (VITE_SERVERS): clone the SOURCE/focused pane's
   *   {url,label} — splitting opens another view of the same server, not a new
   *   mock. The url is reused verbatim (a server view, not a different server).
   * - MOCK mode (default): cycle the next mock (server, view) and build its
   *   {url,label} (url → mock content page; label "srv-A · chat"-style).
   *
   * Mode is decided once from the (static) VITE_SERVERS env via isRealFleet(),
   * so it stays stable for the whole session.
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
  // DO NOT "helpfully" delete or expose `naiveReload` / `jsonReswap` in prod:
  // they are INTENTIONAL negative controls. The survival regression test
  // (tests/e2e/survival.spec.ts) drives each one and asserts it reloads the
  // iframe, which proves the survival gate is non-vacuous (it actually detects a
  // reload). They run only under the Vite dev server (the e2e webServer uses
  // `npm run dev:host`), where DEV is true.

  private installTestBridge(): void {
    if (!import.meta.env.DEV) return;
    const bridge = {
      panes: (): string[] => this.api.panels.map((p) => p.id),
      // Read-only snapshot of every panel's {url,label} params — used by the
      // layout-persistence e2e to assert a restored layout round-trips with the
      // correct urls/labels (ids are opaque; params are the trusted content).
      paneParams: (): Array<{ id: string; url: string; label: string }> =>
        this.api.panels.map((p) => {
          const params = (p.params ?? {}) as { url?: string; label?: string };
          return {
            id: p.id,
            url: params.url ?? "",
            label: params.label ?? "",
          };
        }),
      // Read-only: serialize the whole layout (api.toJSON). The persistence e2e
      // captures a real, well-formed layout via this, poisons one url, writes it
      // back to localStorage, and asserts the cold restore rejects the poison.
      // (Distinct from the destructive jsonReswap negative control below, which
      // round-trips toJSON→fromJSON to PROVE such a reswap reloads iframes.)
      serialize: (): unknown => this.api.toJSON(),
      focused: (): string | null => focusedId(),
      trayIds: (): string[] => this.api.groups
        .filter((g) => g.api.location.type === "floating")
        .map((g) => g.activePanel?.id ?? "")
        .filter(Boolean),
      gridPaneCount: (): number => this.gridPaneCount(),
      isMaximized: (): boolean => this.api.hasMaximizedGroup(),
      groupBox: (id: string) => this.api.getPanel(id)?.group.api.boundingBox ?? null,
      survival: (id: string) => survivalFor(id) ?? null,
      baseline: (id: string) => baselineFor(id) ?? null,
      resetBaseline: (id: string) => resetBaseline(id),
      connected: () => connected(),

      split: (id: string, dir: SplitDir) => this.split(id, dir),
      swap: (a: string, b: string) => this.swap(a, b),
      closePane: (id: string) => this.closePane(id),
      focus: (id: string) => this.focusPane(id),
      maximize: (id: string) => {
        const p = this.api.getPanel(id);
        if (p && !this.api.hasMaximizedGroup()) this.api.maximizeGroup(p);
        this.afterMutation();
      },
      exitMaximized: () => {
        this.api.exitMaximizedGroup();
        this.afterMutation();
      },
      collapse: (id: string) => this.collapse(id),
      restore: (id: string) => this.restore(id),

      // Test ARRANGEMENT (not a shell op): dock panel `a` into panel `b`'s
      // group as a tab (position:'center'). No real shell op creates a tabbed
      // group — split() always opens a new group — so the same-group branch of
      // swap() is otherwise unreachable deterministically (only native tab DnD
      // gets there). Uses the SAME survival-safe primitive (panel.api.moveTo)
      // the real swap()'s first step uses, so it never disposes a renderer.
      dockAsTab: (a: string, b: string): void => {
        const pa = this.api.getPanel(a);
        const pb = this.api.getPanel(b);
        if (!pa || !pb || a === b) return;
        pa.api.moveTo({ group: pb.group, position: "center" });
        this.afterMutation();
      },
      // Read-only: are two panels currently in the SAME Dockview group?
      sameGroup: (a: string, b: string): boolean => {
        const pa = this.api.getPanel(a);
        const pb = this.api.getPanel(b);
        return !!pa && !!pb && pa.group === pb.group;
      },

      getIframe: (id: string): HTMLIFrameElement | null =>
        this.renderers.get(id)?.getIframe() ?? null,

      // NEGATIVE CONTROL (a): naive remove + re-add. This is the exact mistake
      // renderer:'always' exists to prevent. It RELOADS the iframe (new
      // element) → mountTs/nonce/connId all change. The gate asserts that.
      // The fresh contentWindow is bound so the gate can observe the reload
      // signal via the new heartbeat (the whole point is to PROVE the gate
      // detects this mistake).
      naiveReload: (id: string): void => {
        const r = this.renderers.get(id);
        if (!r) return;
        const old = r.getIframe();
        const body = r.getBody();
        old.remove();
        const fresh = document.createElement("iframe");
        fresh.className = "pane-iframe";
        fresh.src = old.src;
        body.appendChild(fresh);
        if (fresh.contentWindow) bindContentWindow(id, fresh.contentWindow);
      },

      // NEGATIVE CONTROL (b): wholesale toJSON → fromJSON re-swap. This
      // disposes + recreates EVERY panel (rule #2 violation when used as a
      // re-render step) → all iframes reload. The gate asserts a reload.
      jsonReswap: (): void => {
        const state = this.api.toJSON();
        // default reuseExistingPanels=false → full dispose + recreate.
        this.api.fromJSON(state as never);
      },
    };
    (window as unknown as { __host?: typeof bridge }).__host = bridge;
  }
}

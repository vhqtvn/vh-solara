import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import {
  activeWorkspaceId,
  closeWorkspace,
  needsYouCount,
  needsYouCountFor,
  renameWorkspace,
  reorderWorkspace,
  setActiveWorkspace,
  statusPairsFor,
  trayIds,
  workspaces,
  type Workspace,
} from "../dockview/store";
import { TABSTRIP_POPOVER_GROUP, usePopoverSurface } from "./popover";
import { next } from "../attentionNext";
import { AddMenu } from "./AddServer";
import { WorkspaceOverflow } from "./WorkspaceOverflow";
import { Layouts } from "./Layouts";
import { Settings } from "./Settings";
import {
  computeFits,
  rankByPriority,
  type PriorityCandidate,
} from "./priorityFit";
import s from "./Tabstrip.module.css";

/**
 * Top WORKSPACE tabstrip (i3 upper tabs = workspaces): brand + a
 * PRIORITY-FIT subset of workspace tabs + the "⋯" overflow affordance + the
 * single merged "+" AddMenu + the P3 NEXT hero button. Clicking a tab switches
 * the active workspace — a SURVIVAL-SAFE CSS-visibility-only switch
 * (App.tsx's overlay stack; no host is disposed, no iframe reloads).
 *
 * PRIORITY-FIT MEMBERSHIP (attention-selected visibility): the strip shows
 * the workspaces that FIT the measured width, chosen by attention priority —
 * active → needs-you → unread → running → prev-active (one-slot recency) →
 * remaining; ties by canonical index (priorityFit.ts, decisions D1/D4).
 *  - MEMBERSHIP ONLY: the rendered row stays in CANONICAL workspace order;
 *    priority never reshuffles visible tabs.
 *  - MEASUREMENT: a hidden aria-hidden measuring row (every workspace at
 *    natural width, live badges included) + a ResizeObserver on the tabs
 *    container. Plain px math — host-web has no UI zoom. (Reference pattern:
 *    web/src/components/TabBar.tsx — measurement concept only.)
 *  - FREEZE: visible membership/order is frozen during strip interaction —
 *    a pressed pointer, any open strip popover/menu (TABSTRIP_POPOVER_GROUP)
 *    or inline rename, and KEYBOARD focus in the strip. Badges, the overflow
 *    cue, and the hidden-workspace list keep updating LIVE while frozen; only
 *    membership holds still. Never auto-scrolls the strip on status change
 *    (the fitted row does not overflow; there is no scroll-into-view call
 *    anywhere).
 *  - SATURATION (honest, D4): whatever does not fit goes to the "⋯" overflow
 *    list (WorkspaceOverflow.tsx — searchable, live badges); the active
 *    workspace is ALWAYS visible (tier 0 outranks fit).
 *
 * P3 NEXT HERO BUTTON (moved here from the deleted bottom statusbar — operator
 * directive "no [FAB], just a button next to add server is enough"). It is the
 * attention-loop trigger: "which session needs me? → jump". It appears ONLY when
 * the active workspace has a needs-you pane (needsYouCount() > 0; ws-scoped
 * visibility — the locked choice), pulses to draw the eye, and on click calls
 * next() (attentionNext.ts — UNCHANGED): rank → cross-ws → restore-from-tray →
 * keyboard-rule → focus the highest-priority needy pane system-wide. next()
 * routes through store.hostOps().next (production-capable — NOT the DEV
 * bridge).
 *
 * PER-TAB AFFORDANCES:
 *  - CONTEXT MENU (right-click / long-press / F2): Rename, Close, Close
 *    others. The menu rides the SAME surface stack as AddMenu/Overflow/
 *    Layouts/Settings (popover.ts, mutually exclusive group): Esc closes
 *    topmost-only, a pointerdown outside the tab closes it, a pane tap closes
 *    it, a workspace switch closes it reactively. Last-workspace guard:
 *    Close + Close others are aria-disabled no-ops (the store refuses to
 *    empty the shell anyway). Deleting a workspace DESTROYS its panes
 *    (intentional; not a survival op).
 *  - RENAME: menu → Rename opens the inline edit. Commit on blur/Enter; cancel
 *    on Esc.
 *  - PER-TAB BADGE: needs-you count on EVERY tab (background ws's needy
 *    sessions are the ones the operator can't see). Rounded-rect number,
 *    GPU-cheap, distinct from Q1-C liveness. Badges are NEVER truncated.
 *
 * Layout ops within the active workspace go through the typed HostOps controller
 * surface (store.hostOps), not the DEV-only window.__host test bridge.
 */

/** Long-press threshold (ms) to open the tab context menu. Same value the old
 * direct-rename long-press used (RENAME_PRESS_MS=500): long enough that a tap
 * never triggers it, short enough to feel responsive on touch. */
const MENU_PRESS_MS = 500;
/** Pointer drift (px) that cancels an armed long-press — a touch that moves
 * (scroll intent) must never summon the menu. */
const MENU_PRESS_DRIFT_PX = 12;
/** Fixed .tabMenu width (px). Declared here so placeMenu's viewport clamp uses
 * the same number the CSS renders (keep in sync with .tabMenu in
 * Tabstrip.module.css). */
const MENU_WIDTH_PX = 176;

/** Gap between adjacent tabs (px) — keep in sync with `.tabs { gap }` in
 * Tabstrip.module.css (computeFits budgets it). */
const TAB_GAP_PX = 4;
/** Width reserved for the "⋯" overflow trigger whenever anything is hidden:
 * the 26px icon trigger + the cue badge at its widest + the strip's 8px flex
 * gap. Slightly conservative when the cue is absent — a deterministic,
 * fixed reserve beats a circular (cue depends on membership) measurement. */
const OVERFLOW_RESERVE_PX = 52;
/** A focusin arriving within this window after a pointerdown on the strip is
 * attributed to the POINTER (browsers focus the pressed control), not the
 * keyboard — pointer-attributed focus does not freeze membership. */
const POINTER_FOCUS_MS = 500;

/**
 * TAB-PAIRS display cap (REVERSIBLE DEFAULT). A count of 10 or more renders as
 * the fixed-width "9+" instead of its full integer, keeping every badge a tight
 * constant-width token even on a heavily-loaded dir. The SPA sends the TRUE
 * integer; the cap is host-side display formatting only (the badge's
 * data-count attribute always carries the true integer).
 */
function fmtCount(n: number): string {
  return n >= 10 ? "9+" : String(n);
}

/** A pair renders iff at least one of its counts is nonzero. */
function isNonzero(p: { running: number; unread: number }): boolean {
  return p.running > 0 || p.unread > 0;
}

/**
 * TAB-PAIRS human label (REVERSIBLE DEFAULT): the badge run's title/aria-label
 * in aggregate human words — "2 running, 3 unread" — never pair notation.
 */
function pairsLabel(pairs: { running: number; unread: number }[]): string {
  const running = pairs.reduce((n, p) => n + p.running, 0);
  const unread = pairs.reduce((n, p) => n + p.unread, 0);
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (unread > 0) parts.push(`${unread} unread`);
  return parts.join(", ");
}

/** The tab label content (name + live pair badges + needs-you pill) shared by
 *  the real tab and the hidden measuring tab — the SAME markup, so measured
 *  widths equal rendered widths. No interactivity here. `live` gates the
 *  e2e-facing data-testids/data-* mirrors so the aria-hidden measuring row
 *  never pollutes test selectors. */
function TabContent(props: { ws: Workspace; live?: boolean }) {
  const need = () => needsYouCountFor(props.ws.id);
  const pairs = () => statusPairsFor(props.ws.id);
  const showPairs = () => pairs().some((p) => p.running > 0 || p.unread > 0);
  const pairsText = () => pairs().map((p) => `(${fmtCount(p.running)}|${fmtCount(p.unread)})`).join("");
  const t = (id: string) => (props.live ? id : undefined);
  return (
    <>
      <span
        class={s.tabLabel}
        data-testid={t("ws-tab-label")}
        title={props.ws.name}
      >
        {props.ws.name}
      </span>
      <Show when={showPairs()}>
        <span
          class={s.tabPairs}
          data-testid={t("ws-tab-pairs")}
          data-workspace={props.live ? props.ws.id : undefined}
          data-pairs={pairsText()}
          role="img"
          aria-label={pairsLabel(pairs())}
          title={pairsLabel(pairs())}
        >
          <For each={pairs()}>
            {(p, i) => (
              <Show when={isNonzero(p)}>
                <span class={s.paneBadges} data-pane-index={i()}>
                  <Show when={p.running > 0}>
                    <span class={s.badgeRunning} data-kind="running" data-count={p.running} title={`${p.running} running`}>
                      {fmtCount(p.running)}
                    </span>
                  </Show>
                  <Show when={p.unread > 0}>
                    <span class={s.badgeUnread} data-kind="unread" data-count={p.unread} title={`${p.unread} unread`}>
                      {fmtCount(p.unread)}
                    </span>
                  </Show>
                </span>
              </Show>
            )}
          </For>
        </span>
      </Show>
      <Show when={need() > 0}>
        <span
          class={s.needBadge}
          data-testid={t("ws-needs-you")}
          data-workspace={props.live ? props.ws.id : undefined}
          title={`${need()} session${need() === 1 ? "" : "s"} need you`}
        >
          {need()}
        </span>
      </Show>
    </>
  );
}

export function Tabstrip() {
  // ---- measurement + membership state ---------------------------------------
  let stripEl: HTMLDivElement | undefined;
  let tabsEl: HTMLDivElement | undefined;
  let measureEl: HTMLDivElement | undefined;

  /** Tabs container clientWidth (px) — the stable available space (the flex
   *  container, NOT the content row, which sizes to content). */
  const [avail, setAvail] = createSignal(0);
  /** Natural tab widths by workspace id, measured off the hidden row. */
  const [widths, setWidths] = createSignal<Record<string, number>>({});
  /** Frozen predicate parts (see freeze memo below). */
  const [pressed, setPressed] = createSignal(0);
  const [openMenu, setOpenMenu] = createSignal(false);
  const [kbdFocus, setKbdFocus] = createSignal(false);
  /** One-slot recency (D1): the workspace active immediately before the
   *  current one. No timers, no grace window. */
  const [prevActiveId, setPrevActiveId] = createSignal<string | null>(null);
  /** The applied VISIBLE set. Initialized to all workspaces (the pre-measure
   *  render shows everything, like the web TabBar reference); corrected by
   *  the fit effect as soon as measurement lands. */
  const [visibleSet, setVisibleSet] = createSignal<Set<string>>(
    new Set(workspaces().map((w) => w.id)),
  );

  // Width-affecting inputs as one reactive key: the workspace set (ids +
  // names), every workspace's needs-you count and status pairs (badges change
  // tab width). Measuring re-runs whenever this key changes.
  const widthKey = createMemo(() =>
    workspaces()
      .map((ws) => `${ws.id}:${ws.name}:${needsYouCountFor(ws.id)}:${JSON.stringify(statusPairsFor(ws.id))}`)
      .join("|"),
  );

  // Measure every workspace tab at natural width off the hidden row. Runs
  // AFTER the DOM paints (queueMicrotask) so a badge/name change is reflected.
  const measure = () => {
    if (!measureEl) return;
    const next: Record<string, number> = {};
    for (const el of measureEl.children) {
      const id = (el as HTMLElement).dataset.workspace;
      if (id) next[id] = (el as HTMLElement).getBoundingClientRect().width;
    }
    setWidths(next);
  };
  createEffect(() => {
    void widthKey();
    queueMicrotask(measure);
  });

  // Available width: the flex container's clientWidth via ResizeObserver
  // (sibling chrome appearing/disappearing — brand @480px, NEXT button,
  // overflow trigger — resizes it), plus an initial read.
  onMount(() => {
    if (!tabsEl || !stripEl) return;
    const ro = new ResizeObserver(() => setAvail(tabsEl!.clientWidth));
    ro.observe(tabsEl);
    setAvail(tabsEl.clientWidth);
    onCleanup(() => ro.disconnect());

    // ---- FREEZE observation -------------------------------------------------
    // (a) OPEN MENUS / RENAME within the strip: every TABSTRIP_POPOVER_GROUP
    //     trigger (Settings gear, Layouts, AddMenu, the overflow trigger, the
    //     per-tab menu's aria-expanded tab) and the inline rename
    //     (data-editing) live INSIDE this strip subtree and reflects its open
    //     state in the DOM — so one MutationObserver watching those
    //     attributes covers the whole group without any cross-component
    //     wiring (popover.ts's registry is module-private by design).
    const recountOpen = () => {
      const n = stripEl!.querySelectorAll('[aria-expanded="true"], [data-editing="1"]').length;
      setOpenMenu(n > 0);
    };
    recountOpen();
    const mo = new MutationObserver(recountOpen);
    mo.observe(stripEl, {
      subtree: true,
      childList: true,
      attributeFilter: ["aria-expanded", "data-editing"],
    });
    onCleanup(() => mo.disconnect());

    // (b) KEYBOARD focus within the strip (arrowing through tabs, F2 flows).
    //     Pointer-attributed focus (a press focused a control) does NOT
    //     freeze — see POINTER_FOCUS_MS.
    const onFocusIn = () => {
      if (Date.now() - lastPointerAt < POINTER_FOCUS_MS) return;
      setKbdFocus(true);
    };
    const onFocusOut = () => {
      // focusout fires before the next focus target receives focus — read
      // activeElement a microtask later, when the transfer has settled.
      queueMicrotask(() => setKbdFocus(!!stripEl && stripEl.contains(document.activeElement)));
    };
    stripEl.addEventListener("focusin", onFocusIn);
    stripEl.addEventListener("focusout", onFocusOut);
    onCleanup(() => {
      stripEl?.removeEventListener("focusin", onFocusIn);
      stripEl?.removeEventListener("focusout", onFocusOut);
    });
  });

  // A pointer press anywhere on the strip freezes membership until release —
  // "no membership motion while touching the strip". The release listeners
  // live on window (a press that starts on the strip may release outside it).
  let lastPointerAt = 0;
  let releaseCleanup: (() => void) | undefined;
  const onStripPointerDown = () => {
    lastPointerAt = Date.now();
    if (pressed() > 0) return;
    setPressed(1);
    const release = () => {
      setPressed(0);
      releaseCleanup?.();
      releaseCleanup = undefined;
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    releaseCleanup = () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
    };
  };
  onCleanup(() => releaseCleanup?.());

  /** MEMBERSHIP FREEZE: while any strip interaction is in progress the
   *  applied visible set holds still (badges/queues keep updating). */
  const frozen = createMemo(() => pressed() > 0 || openMenu() || kbdFocus());

  // prev-active tracking (D1): remember the immediately-previous active
  // workspace. Updates even while frozen (the applied set re-derives on
  // unfreeze with the latest value).
  let lastActive: string | null = null;
  createEffect(() => {
    const cur = activeWorkspaceId();
    if (lastActive !== null && lastActive !== cur) setPrevActiveId(lastActive);
    lastActive = cur;
  });

  // THE FIT: rank by priority, then greedily fit widths to the available
  // space (priorityFit.ts). Gated by the freeze — while frozen the applied
  // set is untouched; unfreezing re-runs this effect with fresh inputs.
  createEffect(() => {
    void widthKey(); // width-affecting inputs (names + badges)
    void avail(); // container width
    const list = workspaces();
    const active = activeWorkspaceId();
    const prev = prevActiveId();
    if (frozen()) return;
    const candidates: PriorityCandidate[] = list.map((ws, index) => {
      const pairs = statusPairsFor(ws.id);
      return {
        id: ws.id,
        index,
        active: ws.id === active,
        prevActive: ws.id === prev,
        needsYou: needsYouCountFor(ws.id),
        running: pairs.reduce((n, p) => n + p.running, 0),
        unread: pairs.reduce((n, p) => n + p.unread, 0),
      };
    });
    const ranked = rankByPriority(candidates);
    const w = widths();
    const fit = computeFits(
      ranked.map((c) => ({ id: c.id, width: w[c.id] ?? 0 })),
      { available: avail(), gap: TAB_GAP_PX, overflowReserve: OVERFLOW_RESERVE_PX },
    );
    setVisibleSet(new Set(fit.visible));
  });

  // Visible workspaces in CANONICAL order (membership is priority-selected;
  // the rendered row NEVER reshuffles) + the complement for the overflow.
  const visibleWorkspaces = createMemo(() => workspaces().filter((ws) => visibleSet().has(ws.id)));
  const hiddenIds = createMemo(() => workspaces().filter((ws) => !visibleSet().has(ws.id)).map((ws) => ws.id));

  return (
    <div class={s.tabstrip} ref={stripEl} onPointerDown={onStripPointerDown}>
      <div class={s.brand}>
        <span class={s.brandMark}>◈</span>
        <span class={s.brandText}>VHSolara</span>
        <span class={s.brandSub}>host</span>
      </div>
      {/* a11y completion: the tabs container carries the tablist role the
          per-tab role="tab"/aria-selected semantics already imply. */}
      <div class={s.tabs} data-testid="ws-tabs" role="tablist" aria-label="Workspaces" ref={tabsEl}>
        <For each={visibleWorkspaces()}>
          {(ws) => <WorkspaceTab ws={ws} />}
        </For>
      </div>
      {/* Overflow affordance (only when something is hidden). Lives OUTSIDE
          the .tabs scroller so its popover escapes the overflow clip (the
          strip itself is overflow:visible). */}
      <Show when={hiddenIds().length > 0}>
        <WorkspaceOverflow hiddenIds={hiddenIds} />
      </Show>
      {/* The single merged "+" (D3): New workspace + Connect server… in one
          AddMenu popover (surface id "add-menu"). */}
      <AddMenu />
      {/* Saved-layouts popover (Layouts.tsx) — per-workspace ("this tab")
          layouts AND whole-session ("all tabs") master snapshots. Same
          tabstrip popover group as AddMenu + Settings (mutually exclusive). */}
      <Layouts />
      {/* Settings gear (host-chrome popover: Edit layout…, reload + auto-rotate
          toggle). Sits after Layouts in the right cluster; see Settings.tsx. */}
      <Settings />
      {/* P3 NEXT hero button (moved from the deleted bottom statusbar). The
          attention-loop trigger: visible only when the active workspace has a
          needs-you pane (needsYouCount() > 0), pulses to draw the eye, and on
          click calls next() which routes to the highest-priority needy pane
          system-wide. Production-capable (hostOps().next, NOT the DEV bridge).
          GPU-cheap: a slow opacity pulse ONLY; honored under
          prefers-reduced-motion. */}
      <Show when={needsYouCount() > 0}>
        <button
          type="button"
          class={s.nextBtn}
          data-testid="attention-next"
          aria-label="NEXT — needs attention"
          title="Focus the highest-priority session that needs you"
          onClick={() => next()}
        >
          NEXT
        </button>
        </Show>
      <Show when={trayIds().length > 0}>
        <span class={s.trayBadge} title="Collapsed panes (active workspace)">
          tray: {trayIds().length}
        </span>
      </Show>
      {/* HIDDEN MEASURING ROW (priority-fit): every workspace at natural
          width — same markup as a real tab (TabContent), laid out in a
          clipped, invisible, aria-hidden row. getBoundingClientRect on its
          children is the width source for computeFits. Position:absolute so
          it never contributes to the strip's flex layout. */}
      <div class={s.measureRow} aria-hidden="true" ref={measureEl}>
        <For each={workspaces()}>
          {(ws) => (
            <div class={s.tab} data-workspace={ws.id}>
              <TabContent ws={ws} />
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/** One workspace tab. Owns its local interaction state: the context menu
 *  (right-click / long-press / F2 → Rename | Close | Close others) and the
 *  inline rename the menu can open. */
function WorkspaceTab(props: { ws: Workspace }) {
  const active = () => activeWorkspaceId() === props.ws.id;
  // Last-workspace guard: Close + Close others render aria-disabled no-ops in
  // the menu (the store's closeWorkspace refuses to empty the shell anyway).
  const isLast = () => workspaces().length <= 1;

  // (The tab's live label content — name + TAB-PAIRS badges + the needs-you
  //  pill — is rendered by <TabContent ws live/> below, SHARED with the hidden
  //  measuring row so measured widths equal rendered widths.)

  // ---- tab context menu (right-click / long-press / F2) ---------------------
  // Registered on the shared surface stack (popover.ts) in the SAME group as
  // the other tabstrip popovers (mutually exclusive with AddMenu/Overflow/
  // Settings/Layouts): Escape closes topmost-only, a pointerdown outside this
  // tab closes it, a pane tap closes it via dismissAnchoredSurfaces. The
  // anchor is the TAB element: it contains both the trigger (the tab itself)
  // and the menu, so a pointerdown on a menu item never counts as an outside
  // click that would dismiss-before-activate. The menu is position:fixed — it
  // escapes the .tabs overflow clip.
  let tabEl: HTMLDivElement | undefined;
  const [menuPos, setMenuPos] = createSignal({ left: 0, top: 0 });
  // Fixed coords, computed on open: drop under the tab, clamped so a
  // right-edge tab (or a ~360px viewport) never pushes the menu offscreen.
  const placeMenu = () => {
    const r = tabEl?.getBoundingClientRect();
    if (!r) return;
    const vw = document.documentElement.clientWidth;
    setMenuPos({
      left: Math.max(4, Math.min(r.left, vw - MENU_WIDTH_PX - 8)),
      top: r.bottom + 2,
    });
  };
  const menu = usePopoverSurface({
    id: `ws-tab-menu:${props.ws.id}`,
    group: TABSTRIP_POPOVER_GROUP,
    anchor: () => tabEl,
    onOpen: placeMenu,
  });

  // Dismiss on workspace switch: a KEYBOARD switch (focus another tab, Enter)
  // moves no pointer, so the surface stack's outside-click pass never fires —
  // close reactively instead.
  createEffect(() => {
    activeWorkspaceId();
    if (untrack(menu.open)) menu.closePopover();
  });

  // Menu actions. Every item stops its click from reaching the tab's own
  // click handler. The menu closes FIRST for the destructive items; a
  // disabled (last-workspace) item is a FULL no-op.
  const menuRename = () => {
    menu.closePopover();
    beginEdit();
  };
  const menuClose = () => {
    if (isLast()) return;
    menu.closePopover();
    closeWorkspace(props.ws.id);
  };
  const menuCloseOthers = () => {
    if (isLast()) return;
    menu.closePopover();
    // Snapshot first: closeWorkspace splices the very array being iterated.
    for (const w of workspaces().slice()) {
      if (w.id !== props.ws.id) closeWorkspace(w.id);
    }
  };
  // Reorder boundary guards: Move left is a no-op on the first tab, Move right
  // on the last. The store's reorderWorkspace clamps too — the disabled render
  // is UX (aria-disabled + full no-op, the Close-last-workspace pattern), not
  // the safety net.
  const isLeftmost = () => workspaces()[0]?.id === props.ws.id;
  const isRightmost = () => {
    const list = workspaces();
    return list.length > 0 && list[list.length - 1]?.id === props.ws.id;
  };
  const menuMove = (dir: -1 | 1) => () => {
    // Boundary: a FULL no-op that keeps the menu open (the Close-last
    // workspace guard pattern).
    if ((dir === -1 && isLeftmost()) || (dir === 1 && isRightmost())) return;
    menu.closePopover();
    reorderWorkspace(props.ws.id, dir);
  };
  /** Wrap a menu action: swallow the click at the menu (see above), run it. */
  const onMenuItem = (run: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    run();
  };

  // ---- rename (menu → Rename → inline edit) ---------------------------------
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let inputEl: HTMLInputElement | undefined;

  const beginEdit = () => {
    clearPressTimer();
    setDraft(props.ws.name);
    setEditing(true);
    // Focus after the input mounts. queueMicrotask runs after SolidJS renders
    // the <Show> branch. select() highlights the current name so a replacement
    // is one keystroke (touch-friendly).
    queueMicrotask(() => {
      inputEl?.focus();
      inputEl?.select();
    });
  };
  const commitEdit = () => {
    if (!editing()) return;
    const name = draft().trim();
    setEditing(false);
    if (name && name !== props.ws.name) renameWorkspace(props.ws.id, name);
  };
  const cancelEdit = () => {
    setEditing(false);
  };

  // ---- long-press → menu (the old direct-rename gesture, retargeted) --------
  // pointerdown arms a timer; if MENU_PRESS_MS elapses while still pressed
  // (and unmoved), the menu opens. pointerup/leave/cancel clears an unfired
  // timer so a quick tap never triggers it; moving > MENU_PRESS_DRIFT_PX
  // (scroll intent) cancels it too.
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let pressX = 0;
  let pressY = 0;
  // Set when the long-press timer actually fires; consumed by the tab's click
  // handler so the release click never ALSO switches the workspace. Reset on
  // every pointerdown so an unconsumed flag can never swallow a later click.
  let suppressClick = false;
  const clearPressTimer = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = undefined;
    }
  };
  const onTabPointerDown = (e: PointerEvent) => {
    suppressClick = false;
    if (editing() || menu.open()) return;
    clearPressTimer();
    pressX = e.clientX;
    pressY = e.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = undefined;
      // If a contextmenu event already opened it (Android Chrome fires one on
      // long-press too), this is a duplicate — don't re-place or re-flag.
      if (menu.open()) return;
      suppressClick = true;
      menu.openPopover();
    }, MENU_PRESS_MS);
  };
  const onTabPointerMove = (e: PointerEvent) => {
    if (!pressTimer) return;
    if (Math.hypot(e.clientX - pressX, e.clientY - pressY) > MENU_PRESS_DRIFT_PX) {
      clearPressTimer();
    }
  };

  // Right-click (desktop) — and Android Chrome's native long-press — opens the
  // same menu. preventDefault suppresses the browser's own menu (and the
  // long-press text-selection callout). While RENAMING, let the native
  // input menu (cut/copy/paste) through untouched.
  const onTabContextMenu = (e: MouseEvent) => {
    if (editing()) return;
    e.preventDefault();
    if (!menu.open()) menu.openPopover();
  };

  onCleanup(clearPressTimer);

  return (
    <div
      ref={tabEl}
      classList={{
        [s.tab]: true,
        [s.tabActive]: active(),
      }}
      data-testid="ws-tab"
      data-workspace={props.ws.id}
      data-active={active() ? "1" : "0"}
      data-editing={editing() ? "1" : "0"}
      data-menu-open={menu.open() ? "1" : "0"}
      // a11y: role=tab + explicit keyboard/AT semantics (the tab hosts nested
      // interactive elements — the rename input + the context menu's items).
      // aria-haspopup/expanded advertise the context menu to AT.
      role="tab"
      tabindex={editing() ? -1 : 0}
      aria-selected={active() ? "true" : "false"}
      aria-label={props.ws.name}
      aria-haspopup="menu"
      aria-expanded={menu.open() ? "true" : "false"}
      // Clicking the tab switches the workspace — EXCEPT: the release click
      // after a fired long-press (menu just opened; consumed), while renaming,
      // and when this tab's own menu is open (tap-again = toggle it closed).
      onClick={() => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        if (editing()) return;
        if (menu.open()) {
          menu.closePopover();
          return;
        }
        setActiveWorkspace(props.ws.id);
      }}
      // Right-click / Menu key / Shift+F10 (the browser synthesizes a
      // contextmenu event for the last two on the focused element).
      onContextMenu={onTabContextMenu}
      // Long-press arms the menu timer (see onTabPointerDown).
      onPointerDown={onTabPointerDown}
      onPointerMove={onTabPointerMove}
      onPointerUp={clearPressTimer}
      onPointerLeave={clearPressTimer}
      onPointerCancel={clearPressTimer}
      onKeyDown={(e) => {
        if (editing()) return;
        // F2 = the standard rename key: it opens the menu that CONTAINS
        // Rename. The keyboard path to a menu ACTION is F2 → Tab (into the
        // items) → Enter; item activation keeps native button behavior.
        if (e.key === "F2") {
          e.preventDefault();
          menu.togglePopover();
          return;
        }
        // The context-menu keys (Menu key, Shift+F10). Browsers synthesize a
        // contextmenu event for these on the focused element — but not
        // uniformly (Firefox's dispatched Shift+F10 produces no contextmenu),
        // so handle the keys directly and let onTabContextMenu's open-guard
        // dedupe when the browser ALSO synthesizes the event.
        if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          if (!menu.open()) menu.openPopover();
          return;
        }
        if (menu.open()) {
          // Menu open: an Enter/Space on the TAB ITSELF must not fall through
          // to the workspace-switch branch (no preventDefault needed: the tab
          // div has no native Enter default, and an UNCONDITIONAL one would
          // swallow the keydowns that bubble here from the focused MENU ITEMS
          // (buttons are DOM children of this tab), killing their native
          // Enter/Space activation — found by commit-review).
          return;
        }
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setActiveWorkspace(props.ws.id);
        }
      }}
    >
      <Show when={editing()} fallback={<TabContent ws={props.ws} live />}>
        <input
          ref={inputEl}
          class={s.tabInput}
          data-testid="ws-rename-input"
          value={draft()}
          // Stop pointer events from re-entering the long-press arm while typing.
          onPointerDown={(e) => e.stopPropagation()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitEdit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
          maxlength={80}
        />
      </Show>

      {/* Tab CONTEXT MENU (right-click / long-press / F2). A child of the tab
          (the surface-stack anchor) but position:fixed — it escapes the .tabs
          overflow clip; coords are set in onOpen (placeMenu). role="menu" +
          menuitem mirror the Settings popover pattern. */}
      <Show when={menu.open()}>
        <div
          class={s.tabMenu}
          style={{ left: `${menuPos().left}px`, top: `${menuPos().top}px` }}
          role="menu"
          data-testid="ws-tab-menu"
          data-workspace={props.ws.id}
          aria-label={`Workspace menu: ${props.ws.name}`}
        >
          <button
            type="button"
            class={s.tabMenuItem}
            data-testid="ws-menu-rename"
            data-workspace={props.ws.id}
            role="menuitem"
            onClick={onMenuItem(menuRename)}
          >
            Rename
          </button>
          <button
            type="button"
            classList={{ [s.tabMenuItem]: true, [s.tabMenuItemDisabled]: isLeftmost() }}
            data-testid="ws-menu-move-left"
            data-workspace={props.ws.id}
            role="menuitem"
            aria-disabled={isLeftmost() ? "true" : undefined}
            title={isLeftmost() ? "Already the first workspace" : `Move "${props.ws.name}" left`}
            onClick={onMenuItem(menuMove(-1))}
          >
            Move left
          </button>
          <button
            type="button"
            classList={{ [s.tabMenuItem]: true, [s.tabMenuItemDisabled]: isRightmost() }}
            data-testid="ws-menu-move-right"
            data-workspace={props.ws.id}
            role="menuitem"
            aria-disabled={isRightmost() ? "true" : undefined}
            title={isRightmost() ? "Already the last workspace" : `Move "${props.ws.name}" right`}
            onClick={onMenuItem(menuMove(1))}
          >
            Move right
          </button>
          <button
            type="button"
            classList={{ [s.tabMenuItem]: true, [s.tabMenuItemDisabled]: isLast() }}
            data-testid="ws-menu-close"
            data-workspace={props.ws.id}
            role="menuitem"
            aria-disabled={isLast() ? "true" : undefined}
            title={isLast() ? "Can't close the last workspace" : `Close "${props.ws.name}"`}
            onClick={onMenuItem(menuClose)}
          >
            Close
          </button>
          <button
            type="button"
            classList={{ [s.tabMenuItem]: true, [s.tabMenuItemDisabled]: isLast() }}
            data-testid="ws-menu-close-others"
            data-workspace={props.ws.id}
            role="menuitem"
            aria-disabled={isLast() ? "true" : undefined}
            title={isLast() ? "Only one workspace" : `Close every workspace except "${props.ws.name}"`}
            onClick={onMenuItem(menuCloseOthers)}
          >
            Close others
          </button>
        </div>
      </Show>
    </div>
  );
}

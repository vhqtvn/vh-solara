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
 *  - CONTEXT MENU (right-click / long-press / F2): Rename, Move left/right,
 *    Close, Close others. The menu rides the SAME surface stack as
 *    AddMenu/Overflow/Layouts/Settings (popover.ts, mutually exclusive
 *    group): Esc closes topmost-only, a pointerdown outside the tab closes
 *    it, a pane tap closes it, a workspace switch closes it reactively.
 *    Last-workspace guard: Close + Close others are aria-disabled no-ops (the
 *    store refuses to empty the shell anyway). Deleting a workspace DESTROYS
 *    its panes (intentional; not a survival op).
 *  - DRAG-TO-REORDER (pointer gesture over the landed menu reorder): a
 *    pressed tab can be dragged along the strip to a new position. MOUSE: a
 *    >MENU_PRESS_DRIFT_PX move while pressed starts the drag IMMEDIATELY
 *    (desktop convention; the 500ms stationary hold still opens the menu
 *    while pressed, and right-click always does). TOUCH: a 500ms stationary
 *    hold ARMS the drag — movement after arming drags, a STATIONARY release
 *    opens the menu (the menu-open moment moved to release so a post-hold
 *    drag can never race an already-open menu); pre-hold movement past the
 *    threshold is scroll intent (no drag, no menu). The preview is
 *    transform-only (GPU rules: no layout writes, no mask-image, no
 *    backdrop-filter); the drop commits through the SAME identity-preserving
 *    reorderWorkspace the ⋮ menus use — hostLayerOrder is never touched, so
 *    no iframe ever reloads. Dragging from/to the ⋯ overflow rows is OUT of
 *    scope (the row menu owns hidden workspaces).
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
/** Pointer drift (px) with a DUAL role in the press gesture model: (a) before
 *  a touch long-press matures it cancels the menu arm (scroll intent — a
 *  moving touch must never summon the menu), and (b) it is the DRAG-START
 *  threshold — a mouse move past it while pressed starts a drag immediately,
 *  and a touch move past it after the 500ms hold armed the press starts the
 *  drag. Same 12px slop window for every role keeps the disambiguation
 *  coherent. */
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
    // lostpointercapture completes the terminal-event set: the browser can
    // release a captured pointer WITHOUT any pointerup/pointercancel (the
    // capture holder can be removed mid-press, capture retargeted, …). It
    // bubbles, so this single window-capture listener covers the tab's
    // setPointerCapture too. Without it a swallowed terminal release leaves
    // `pressed` stuck at 1 and the membership freeze hangs forever (the fit
    // effect is gated on frozen()). Idempotent with pointerup: release() is
    // a no-op once the listeners are gone (lostpointercapture fires AFTER
    // pointerup for a normal release, when these are already removed).
    window.addEventListener("lostpointercapture", release, true);
    releaseCleanup = () => {
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("lostpointercapture", release, true);
    };
  };
  onCleanup(() => releaseCleanup?.());

  /** MEMBERSHIP FREEZE: while any strip interaction is in progress the
   *  applied visible set holds still (badges/queues keep updating). */
  const frozen = createMemo(() => pressed() > 0 || openMenu() || kbdFocus());

  // ---- DRAG-TO-REORDER session (the gesture layer) ---------------------------
  // All drag state lives HERE (strip-level): the dragged tab follows the
  // pointer and SIBLING tabs translate to open the drop gap, so the preview
  // must coordinate every visible tab, not just the pressed one. The tab
  // component only decides WHEN a press becomes a drag (the pointer-type
  // aware arming model) and calls beginDrag(); from there this session owns
  // the gesture via window capture-phase listeners: pointerup commits,
  // pointercancel/lostpointercapture/Escape abort to the original order
  // (lostpointercapture = the browser ended the capture without a terminal
  // pointerup — treating it as abort keeps the session from wedging).
  // Nothing mutates the store until commit — abort is trivially clean.
  //
  // The membership freeze carries the whole drag: a drag holds the pointer
  // down (the `pressed` arm), so visible membership/order is frozen for the
  // gesture's duration and the start-captured geometry below stays valid.
  // (Badges still update live mid-drag and can change a tab's natural width;
  // the commit maps by ids through the frozen visible set, never by these
  // rects — at worst the preview is a few px stale, never wrong about order.)

  /** Immutable capture of the visible row's geometry at drag start. */
  interface DragSession {
    id: string;
    pointerId: number;
    /** Visible index of the dragged tab at start. */
    from: number;
    rects: Array<{ id: string; left: number; width: number; center: number }>;
    /** Union bounds of the visible row (drag clamping keeps the drop target
     *  reachable when the pointer leaves the row — the strip never
     *  auto-scrolls). */
    rowLeft: number;
    rowRight: number;
    /** Pointer clientX at drag start; dx is measured from here. */
    originX: number;
    /** The frozen visible set at start (the commit maps the drop through it —
     *  never a re-derivation that could race the unfreeze). */
    visible: Set<string>;
  }
  const [drag, setDrag] = createSignal<DragSession | null>(null);
  /** Follow offset of the dragged tab (px, clamped inside the row). */
  const [dragDx, setDragDx] = createSignal(0);
  /** Live insertion index among the OTHER visible tabs (the commit target). */
  const [dropIdx, setDropIdx] = createSignal(0);
  let dragCleanup: (() => void) | undefined;

  const endDragSession = () => {
    dragCleanup?.();
    dragCleanup = undefined;
    setDrag(null);
    setDragDx(0);
    setDropIdx(0);
  };
  onCleanup(() => dragCleanup?.());

  /** Per-tab preview: the dragged tab follows the pointer (dx), each sibling
   *  between the origin and the live drop slot translates by exactly one slot
   *  to open the gap. Transform-only — no layout writes mid-drag (GPU rules). */
  const previewFor = (id: string): { dx: number; dragging: boolean } => {
    const d = drag();
    if (!d) return { dx: 0, dragging: false };
    if (d.id === id) return { dx: dragDx(), dragging: true };
    const i = d.rects.findIndex((r) => r.id === id);
    if (i < 0) return { dx: 0, dragging: false };
    const k = dropIdx();
    const slot = (d.rects[d.from]?.width ?? 0) + TAB_GAP_PX;
    // Standard insertion-list shift: tabs in [k, from) move right by a slot,
    // tabs in (from, k] move left by one (their index-1 < k form).
    if (k <= i && i < d.from) return { dx: slot, dragging: false };
    if (i > d.from && i - 1 < k) return { dx: -slot, dragging: false };
    return { dx: 0, dragging: false };
  };

  /** Dragged-tab offset update + drop-index recompute from pointer x over the
   *  frozen row geometry: the insertion slot is where the dragged tab's CENTER
   *  falls among the other tabs' centers. The VISUAL offset is clamped inside
   *  the row (the preview never leaves the strip — GPU-cheap and the gap stays
   *  visible), but the DROP SLOT follows the RAW pointer position: a dragged
   *  tab wider than an edge sibling could otherwise never cross that
   *  sibling's center (its box clamps first) and the end slots would be
   *  unreachable. */
  const updateDrag = (clientX: number) => {
    const d = drag();
    if (!d) return;
    const me = d.rects[d.from];
    if (!me) return;
    const rawDx = clientX - d.originX;
    const dx = Math.max(
      d.rowLeft - me.left,
      Math.min(d.rowRight - me.width - me.left, rawDx),
    );
    setDragDx(dx);
    const center = me.center + rawDx;
    let k = 0;
    for (let i = 0; i < d.rects.length; i++) {
      if (i === d.from) continue;
      const r = d.rects[i];
      if (r && r.center < center) k++;
    }
    setDropIdx(k);
  };

  /** Commit the drop. The landed store API is DIRECTIONAL
   *  (reorderWorkspace(id, ±1) — one slot per call, identity-preserving,
   *  hostLayerOrder untouched), so a multi-slot drop is a SEQUENCE of one-slot
   *  moves. The move count comes from a local-id SIMULATION (never the
   *  store): walk the dragged id one canonical slot at a time until its
   *  position among the FROZEN-visible tabs equals the drop slot. A hidden
   *  workspace the dragged tab passes shifts one canonical slot as it is
   *  crossed (invisible on the strip; overflow rows follow the store order) —
   *  the visible drop position is exact. The whole commit is one synchronous
   *  batch; scheduleSave is debounced (450ms) so N calls flush once. */
  const commitDrag = () => {
    const d = drag();
    const k = dropIdx();
    if (!d) return;
    endDragSession(); // collapse the preview FIRST, then commit — one paint
    if (k === d.from) return; // dropped in place — nothing to do
    const arr = workspaces().map((w) => w.id);
    const visibleIndex = (a: string[]): number => {
      let c = 0;
      for (const x of a) {
        if (x === d.id) return c;
        if (d.visible.has(x)) c++;
      }
      return -1;
    };
    const dir: -1 | 1 = k > d.from ? 1 : -1;
    let moves = 0;
    while (moves <= arr.length) {
      if (visibleIndex(arr) === k) break;
      const i = arr.indexOf(d.id);
      const j = i + dir;
      if (j < 0 || j >= arr.length) break; // cannot happen for a valid k
      arr.splice(i, 1);
      arr.splice(j, 0, d.id);
      moves++;
    }
    for (let m = 0; m < moves; m++) reorderWorkspace(d.id, dir);
  };

  /** Begin a drag session for `ws` (called by the tab once its arming model
   *  says this press is a drag). `originX` is the PRESS x (the tab's grab
   *  offset is preserved from the press, not the threshold crossing — the
   *  standard drag feel), and the initiating event's own x seeds the first
   *  drop-slot computation so the preview is true from move one. Captures the
   *  frozen row geometry and takes over the gesture with window capture-phase
   *  listeners (pointer capture on the tab keeps REAL pipeline moves flowing,
   *  but the session never depends on it — dispatched/synthetic pointers work
   *  identically). */
  const beginDrag = (ws: Workspace, e: PointerEvent, originX: number) => {
    if (drag() || !tabsEl) return;
    const vis = visibleWorkspaces();
    const from = vis.findIndex((w) => w.id === ws.id);
    if (from < 0 || vis.length < 2) return;
    const rects: DragSession["rects"] = [];
    for (const el of tabsEl.children) {
      const id = (el as HTMLElement).dataset.workspace;
      if (!id) continue;
      const r = el.getBoundingClientRect();
      rects.push({ id, left: r.left, width: r.width, center: r.left + r.width / 2 });
    }
    if (rects.length !== vis.length) return; // mid-measure anomaly — refuse
    const first = rects[0];
    const last = rects[rects.length - 1];
    if (!first || !last) return;
    const session: DragSession = {
      id: ws.id,
      pointerId: e.pointerId,
      from,
      rects,
      rowLeft: first.left,
      rowRight: last.left + last.width,
      originX,
      visible: new Set(visibleSet()),
    };
    setDrag(session);
    setDropIdx(from);
    setDragDx(0);
    updateDrag(e.clientX); // seed dx + drop slot from the initiating move
    const isMine = (ev: PointerEvent) => ev.pointerId === e.pointerId;
    const onMove = (ev: PointerEvent) => {
      if (isMine(ev)) updateDrag(ev.clientX);
    };
    const onUp = (ev: PointerEvent) => {
      if (!isMine(ev)) return;
      updateDrag(ev.clientX); // a drop with no trailing move still lands true
      commitDrag();
    };
    const onCancel = (ev: PointerEvent) => {
      if (isMine(ev)) endDragSession(); // system gesture took over — abort
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") endDragSession(); // abort to original order
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    // Same terminal-event completeness as the press-freeze release above: a
    // lostpointercapture with no pointerup/cancel must ABORT the session —
    // a wedged drag() would make beginDrag's `if (drag())` guard reject
    // every future drag. Same-abort-as-pointercancel; idempotent after a
    // normal commit (endDragSession removed these listeners before the
    // browser fires its post-pointerup lostpointercapture).
    window.addEventListener("lostpointercapture", onCancel, true);
    window.addEventListener("keydown", onKey, true);
    dragCleanup = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("lostpointercapture", onCancel, true);
      window.removeEventListener("keydown", onKey, true);
    };
  };


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
          {(ws) => (
            <WorkspaceTab
              ws={ws}
              preview={() => previewFor(ws.id)}
              beginDrag={(e, originX) => beginDrag(ws, e, originX)}
            />
          )}
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

/** One workspace tab. Owns its local interaction state: the pointer gesture
 *  model (press → drag-to-reorder | long-press menu), the context menu
 *  (right-click / long-press / F2 → Rename | Move left/right | Close | Close
 *  others) and the inline rename the menu can open.
 *
 * PRESS GESTURE MODEL (drag/menu disambiguation — pointer-type aware):
 *  - MOUSE/PEN: a >MENU_PRESS_DRIFT_PX move while the primary button is held
 *    starts a drag IMMEDIATELY (desktop convention — no hold required). A
 *    stationary 500ms hold opens the menu WHILE STILL PRESSED (the landed
 *    behavior, pinned by e2e), and right-click / F2 / Menu-key open it too.
 *  - TOUCH: a stationary 500ms hold ARMS the press (no menu yet — the menu
 *    open moment is deferred to release so a post-hold drag can never race an
 *    already-open menu). After arming: >drift movement starts the drag; a
 *    stationary release opens the menu. Movement past the drift threshold
 *    BEFORE the hold matures cancels the timer (scroll intent — no drag, no
 *    menu).
 * When the model says "drag", the tab hands the gesture to the strip's drag
 *  session via beginDrag() and keeps only a local dragStarted flag (to gate
 *  its own handlers + suppress the release click). */
function WorkspaceTab(props: {
  ws: Workspace;
  /** Strip-level drag preview for this tab (follow offset / dragging flag). */
  preview: () => { dx: number; dragging: boolean };
  /** Hand the press to the strip's drag session (called once per press, at
   *  drag start — the threshold-crossing pointermove; originX = the press x). */
  beginDrag: (e: PointerEvent, originX: number) => void;
}) {
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

  // ---- press gesture model (see the WorkspaceTab docblock) -------------------
  // pointerdown arms the 500ms timer; pointermove disambiguates (drift
  // threshold); pointerup resolves (menu / commit / plain click).
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  let pressX = 0;
  let pressY = 0;
  // Press context captured at pointerdown (the gesture's pointer type/button
  // decide which disambiguation rules apply when the drift threshold crosses).
  let pressButton = 0;
  let pressType: string = "mouse";
  /** TOUCH arm: the 500ms timer fired on a still-pressed, unmoved touch — the
   *  press is now a drag candidate; a stationary release opens the menu. */
  let dragArmed = false;
  /** This press became a drag — the strip session owns the gesture from here;
   *  the flag only gates this tab's own handlers + the release click. */
  let dragStarted = false;
  // Set when the press resolves as menu-armed (touch) or drag: consumed by the
  // tab's click handler so the release click never ALSO switches the
  // workspace. Reset on every pointerdown so an unconsumed flag can never
  // swallow a later click.
  let suppressClick = false;
  const clearPressTimer = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = undefined;
    }
  };
  const onTabPointerDown = (e: PointerEvent) => {
    suppressClick = false;
    dragArmed = false;
    dragStarted = false;
    if (editing() || menu.open()) return;
    clearPressTimer();
    pressButton = e.button;
    pressType = e.pointerType;
    pressX = e.clientX;
    pressY = e.clientY;
    // Capture the pointer for the press so moves OUTSIDE this tab still feed
    // these handlers (a mouse drag crosses sibling tabs immediately). Synthetic
    // (dispatched) pointers are not active — setPointerCapture throws
    // NotFoundError there; the drag still works because the strip session
    // listens on window (capture phase sees every dispatched move too).
    if (e.button === 0 && tabEl) {
      try {
        tabEl.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer — window-level session listeners cover it */
      }
    }
    pressTimer = setTimeout(() => {
      pressTimer = undefined;
      // If a contextmenu event already opened it (Android Chrome fires one on
      // long-press too), this is a duplicate — don't re-place or re-flag.
      if (menu.open()) return;
      suppressClick = true; // the release must not ALSO switch the workspace
      if (pressType === "touch") {
        // Arm the drag; the menu is deferred to a stationary release so a
        // post-hold drag can never race an already-open menu.
        dragArmed = true;
      } else {
        // Mouse/pen: the menu opens while still pressed (the landed behavior).
        menu.openPopover();
      }
    }, MENU_PRESS_MS);
  };
  const onTabPointerMove = (e: PointerEvent) => {
    if (dragStarted) return; // the strip session owns the gesture
    if (!pressTimer && !dragArmed) return; // hover / no press in flight
    const dist = Math.hypot(e.clientX - pressX, e.clientY - pressY);
    if (dist <= MENU_PRESS_DRIFT_PX) return;
    // Pre-arm drift cancels the menu arm (scroll intent — the landed rule).
    clearPressTimer();
    // Drag start. Only a primary-button press drags, never while a surface is
    // open on this tab (menu/rename own it then). Mouse/pen drag immediately;
    // touch only once the hold ARMED the press.
    if (pressButton !== 0 || editing() || menu.open()) return;
    if (pressType === "touch" && !dragArmed) return;
    dragStarted = true;
    dragArmed = false;
    suppressClick = true; // a drag release must not ALSO switch the workspace
    props.beginDrag(e, pressX);
  };
  const onTabPointerUp = () => {
    clearPressTimer();
    if (dragArmed && !dragStarted) {
      // Stationary touch release after the hold → the menu (the armed path's
      // non-drag outcome; suppressClick was set at arm time).
      dragArmed = false;
      if (!menu.open()) menu.openPopover();
      return;
    }
    dragArmed = false;
  };
  const onTabPointerCancel = () => {
    // A system gesture took the pointer over — neither menu nor drag.
    clearPressTimer();
    dragArmed = false;
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
        [s.tabDragging]: props.preview().dragging,
      }}
      data-testid="ws-tab"
      data-workspace={props.ws.id}
      data-active={active() ? "1" : "0"}
      data-editing={editing() ? "1" : "0"}
      data-menu-open={menu.open() ? "1" : "0"}
      // Drag preview observables (e2e): the dragged tab flags data-dragging;
      // sibling tabs translated by the drop gap carry data-shift (signed px;
      // absent when at rest). The preview itself is a transform — style-only.
      data-dragging={props.preview().dragging ? "1" : "0"}
      data-shift={
        props.preview().dx !== 0 && !props.preview().dragging
          ? String(Math.round(props.preview().dx))
          : undefined
      }
      style={
        props.preview().dx !== 0
          ? { transform: `translateX(${props.preview().dx}px)` }
          : undefined
      }
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
      // after a fired long-press (menu just opened or armed; consumed), after
      // a drag (drag ≠ activation; consumed), while renaming, and when this
      // tab's own menu is open (tap-again = toggle it closed).
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
      // The press gesture model: down arms, move disambiguates (drag vs
      // scroll-intent), up/cancel resolve (see the WorkspaceTab docblock).
      onPointerDown={onTabPointerDown}
      onPointerMove={onTabPointerMove}
      onPointerUp={onTabPointerUp}
      // Leaving the tab while merely PRESSED (pre-arm/pre-threshold) cancels
      // the menu timer; once a drag started the strip session owns the
      // gesture, so this can never abort one.
      onPointerLeave={clearPressTimer}
      onPointerCancel={onTabPointerCancel}
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

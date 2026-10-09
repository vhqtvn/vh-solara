import { For, Show, createEffect, createMemo, createSignal, untrack } from "solid-js";
import {
  activeWorkspaceId,
  needsYouCountFor,
  reorderWorkspace,
  setActiveWorkspace,
  statusPairsFor,
  workspaces,
} from "../dockview/store";
import { TABSTRIP_POPOVER_GROUP, usePopoverSurface } from "./popover";
import tabStyles from "./Tabstrip.module.css";
import s from "./WorkspaceOverflow.module.css";

/** Width of the per-row overflow menu (matches the tab context menu). */
const OVERFLOW_ROW_MENU_WIDTH_PX = 176;

/**
 * Workspace OVERFLOW affordance (priority-fit tabstrip, S3): the "⋯" trigger
 * that appears when the tabstrip cannot fit every workspace tab, plus the
 * popover listing the hidden ones.
 *
 *  - TRIGGER CUE (hidden-attention summary): when any HIDDEN workspace has
 *    attention, the trigger carries a badge — amber counting hidden
 *    workspaces with needs-you sessions, otherwise accent counting hidden
 *    workspaces with any running/unread activity. It counts WORKSPACES, never
 *    summed sessions (card constraint), and it updates LIVE even while strip
 *    membership is frozen (the freeze gates membership only, never badges).
 *  - POPOVER: a keyboard-accessible search filter over workspace names + one
 *    row per hidden workspace with the SAME live badge run the tab renders
 *    (needs-you pill + per-pane running/unread micro-badges via
 *    statusPairsFor). Clicking / Enter on a row activates that workspace and
 *    closes the popover — activation makes it visible by the active rule
 *    (priority tier 0).
 *  - SURFACE STACK: joins TABSTRIP_POPOVER_GROUP via usePopoverSurface
 *    (popover.ts) — Escape-topmost dismissal, outside-click, mutual exclusion
 *    with the other tabstrip popovers. Surface id "ws-overflow" (distinct —
 *    the registry is singleton-per-id).
 *
 * GPU-cheap only: plain bg/border/shadow; no mask-image, no backdrop-filter
 * (AGENTS.md Firefox/WebRender rules).
 */
export function WorkspaceOverflow(props: { hiddenIds: () => string[] }) {
  let wrapEl: HTMLDivElement | undefined;
  const [filter, setFilter] = createSignal("");

  const surface = usePopoverSurface({
    id: "ws-overflow",
    group: TABSTRIP_POPOVER_GROUP,
    anchor: () => wrapEl,
    onOpen: () => setFilter(""),
  });

  // Hidden workspaces resolved to their live store entries (canonical order).
  const hiddenWorkspaces = createMemo(() => {
    const ids = new Set(props.hiddenIds());
    return workspaces().filter((ws) => ids.has(ws.id));
  });

  // Filtered rows: case-insensitive substring on the workspace name. An empty
  // filter shows every hidden workspace.
  const rows = createMemo(() => {
    const q = filter().trim().toLowerCase();
    if (!q) return hiddenWorkspaces();
    return hiddenWorkspaces().filter((ws) => ws.name.toLowerCase().includes(q));
  });

  // ---- hidden-attention cue (counts WORKSPACES, not summed sessions) -------
  // needs-you takes precedence (the demand signal); otherwise any
  // running/unread activity. Recomputed LIVE from the store signals — never
  // frozen, so a hidden workspace going needy surfaces on the trigger even
  // while strip membership is frozen.
  const hiddenAttention = createMemo(() => {
    let needy = 0;
    let active = 0;
    for (const ws of hiddenWorkspaces()) {
      if (needsYouCountFor(ws.id) > 0) {
        needy++;
        continue;
      }
      const pairs = statusPairsFor(ws.id);
      if (pairs.some((p) => p.running > 0 || p.unread > 0)) active++;
    }
    return { needy, active };
  });

  const choose = (wsId: string) => {
    surface.closePopover();
    setActiveWorkspace(wsId);
  };

  // ---- per-row menu (reorder affordance for a HIDDEN workspace) -----------
  // The overflow rows are the ONLY way to reach a hidden workspace's reorder
  // entry (its tab is not on the strip). ONE menu surface serves whichever
  // row's ⋮ was clicked (the popover registry is singleton-per-id anyway —
  // one surface id, one live menu). It deliberately does NOT join
  // TABSTRIP_POPOVER_GROUP: same-group registration would mutually-exclude
  // its own PARENT (the ws-overflow popover hosting it). Dismissal stays
  // independent: Escape closes the topmost (this menu) first, the anchor is
  // the row wrapper (clicks inside never count as outside), and the menu is
  // position:fixed — it escapes the .list max-height/overflow clip.
  let rowMenuAnchor: HTMLDivElement | undefined;
  const [rowMenuWsId, setRowMenuWsId] = createSignal<string | null>(null);
  const [rowMenuPos, setRowMenuPos] = createSignal({ left: 0, top: 0 });
  const placeRowMenu = () => {
    const r = rowMenuAnchor?.getBoundingClientRect();
    if (!r) return;
    const vw = document.documentElement.clientWidth;
    setRowMenuPos({
      left: Math.max(
        4,
        Math.min(r.right - OVERFLOW_ROW_MENU_WIDTH_PX, vw - OVERFLOW_ROW_MENU_WIDTH_PX - 8),
      ),
      top: r.bottom + 2,
    });
  };
  const rowMenu = usePopoverSurface({
    id: "ws-overflow-row-menu",
    anchor: () => rowMenuAnchor,
    onOpen: placeRowMenu,
  });
  // The row menu lives INSIDE the overflow popover's rows: when the parent
  // popover closes (another tabstrip popover's same-group exclusion, Escape
  // ×2, outside click), its rows unmount — close the row menu with it instead
  // of leaving an orphaned fixed-position menu over detached DOM.
  createEffect(() => {
    surface.open();
    if (!untrack(surface.open) && untrack(rowMenu.open)) rowMenu.closePopover();
  });
  const openRowMenu = (wsId: string, rowEl: HTMLDivElement) => {
    rowMenuAnchor = rowEl;
    setRowMenuWsId(wsId);
    rowMenu.openPopover();
  };
  const menuWs = createMemo(() =>
    rowMenuWsId() === null ? undefined : workspaces().find((w) => w.id === rowMenuWsId()),
  );
  // CANONICAL boundary guards (workspaces() order — the hidden/visible split
  // is irrelevant here: Move left on the first workspace, Move right on the
  // last, are no-ops; the swap partner may be a visible tab).
  const menuIsLeftmost = () => {
    const ws = menuWs();
    return !!ws && workspaces()[0]?.id === ws.id;
  };
  const menuIsRightmost = () => {
    const ws = menuWs();
    const list = workspaces();
    return !!ws && list.length > 0 && list[list.length - 1]?.id === ws.id;
  };
  const rowMenuMove = (dir: -1 | 1) => () => {
    const ws = menuWs();
    if (!ws) return;
    // Boundary: a FULL no-op that keeps the menu open (the Close-guard
    // pattern) — canonical first/last, regardless of the hidden/visible split.
    if ((dir === -1 && menuIsLeftmost()) || (dir === 1 && menuIsRightmost())) return;
    rowMenu.closePopover();
    reorderWorkspace(ws.id, dir);
  };
  const onRowMenuItem = (run: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    run();
  };

  return (
    <div class={s.wrap} ref={wrapEl}>
      <button
        type="button"
        class={s.trigger}
        title={`More workspaces (${hiddenWorkspaces().length} hidden)`}
        aria-label={`More workspaces (${hiddenWorkspaces().length} hidden)`}
        aria-expanded={surface.open() ? "true" : "false"}
        data-testid="ws-overflow-trigger"
        data-hidden-count={hiddenWorkspaces().length}
        onClick={() => surface.togglePopover()}
      >
        ⋯
        <Show when={hiddenAttention().needy > 0 || hiddenAttention().active > 0}>
          <span
            classList={{
              [s.cue]: true,
              [s.cueNeedy]: hiddenAttention().needy > 0,
            }}
            data-testid="ws-overflow-cue"
            data-kind={hiddenAttention().needy > 0 ? "needs-you" : "activity"}
            data-count={hiddenAttention().needy > 0 ? hiddenAttention().needy : hiddenAttention().active}
            title={
              hiddenAttention().needy > 0
                ? `${hiddenAttention().needy} hidden workspace${hiddenAttention().needy === 1 ? "" : "s"} need you`
                : `${hiddenAttention().active} hidden workspace${hiddenAttention().active === 1 ? "" : "s"} active`
            }
          >
            {hiddenAttention().needy > 0 ? hiddenAttention().needy : hiddenAttention().active}
          </span>
        </Show>
      </button>
      <Show when={surface.open()}>
        <div class={s.popover} data-testid="ws-overflow-popover" aria-label="Hidden workspaces">
          <input
            ref={(el) => queueMicrotask(() => el.focus())}
            class={s.search}
            type="text"
            placeholder="Filter workspaces"
            aria-label="Filter workspaces"
            data-testid="ws-overflow-search"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
          <div class={s.list} role="listbox" aria-label="Hidden workspaces">
            <For each={rows()}>
              {(ws) => {
                const need = () => needsYouCountFor(ws.id);
                const pairs = () => statusPairsFor(ws.id);
                const showPairs = () => pairs().some((p) => p.running > 0 || p.unread > 0);
                const pairsText = () =>
                  pairs().map((p) => `(${p.running >= 10 ? "9+" : p.running}|${p.unread >= 10 ? "9+" : p.unread})`).join("");
                const isActive = () => activeWorkspaceId() === ws.id;
                return (
                  <div class={tabStyles.overflowRowWrap}>
                    <button
                      type="button"
                      classList={{ [s.row]: true, [tabStyles.overflowRowMain]: true }}
                      role="option"
                      aria-selected={isActive() ? "true" : "false"}
                      data-testid="ws-overflow-row"
                      data-workspace={ws.id}
                      onClick={() => choose(ws.id)}
                    >
                      <span class={s.rowName} title={ws.name}>
                        {ws.name}
                      </span>
                      {/* The SAME live badge run the tab renders — these keep
                          updating while the popover is open (membership may be
                          frozen; badges never are). */}
                      <Show when={showPairs()}>
                        <span
                          class={tabStyles.tabPairs}
                          data-testid="ws-overflow-pairs"
                          data-workspace={ws.id}
                          data-pairs={pairsText()}
                        >
                          <For each={pairs()}>
                            {(p, i) => (
                              <Show when={p.running > 0 || p.unread > 0}>
                                <span class={tabStyles.paneBadges} data-pane-index={i()}>
                                  <Show when={p.running > 0}>
                                    <span
                                      class={tabStyles.badgeRunning}
                                      data-kind="running"
                                      data-count={p.running}
                                      title={`${p.running} running`}
                                    >
                                      {p.running >= 10 ? "9+" : p.running}
                                    </span>
                                  </Show>
                                  <Show when={p.unread > 0}>
                                    <span
                                      class={tabStyles.badgeUnread}
                                      data-kind="unread"
                                      data-count={p.unread}
                                      title={`${p.unread} unread`}
                                    >
                                      {p.unread >= 10 ? "9+" : p.unread}
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
                          class={tabStyles.needBadge}
                          data-testid="ws-overflow-need"
                          data-workspace={ws.id}
                          title={`${need()} session${need() === 1 ? "" : "s"} need you`}
                        >
                          {need()}
                        </span>
                      </Show>
                    </button>
                    {/* ⋮ — the row's own menu trigger (Move left/right). A
                        SIBLING of the row button (never nested), so activating
                        it cannot choose the workspace. */}
                    <button
                      type="button"
                      class={tabStyles.overflowRowKebab}
                      data-testid="ws-overflow-row-menu-trigger"
                      data-workspace={ws.id}
                      title={`Workspace menu: ${ws.name}`}
                      aria-label={`Workspace menu: ${ws.name}`}
                      aria-haspopup="menu"
                      aria-expanded={rowMenu.open() && rowMenuWsId() === ws.id ? "true" : "false"}
                      onClick={(e) => {
                        e.stopPropagation();
                        openRowMenu(ws.id, e.currentTarget.parentElement as HTMLDivElement);
                      }}
                    >
                      ⋮
                    </button>
                    {/* ROW MENU — a position:fixed CHILD of the row wrapper
                        (the surface's ANCHOR): clicks on the menu are inside
                        the anchor, so the surface stack's outside-click pass
                        never dismisses-before-activate (the tab-menu pattern;
                        fixed also escapes the .list overflow clip). Rendered
                        only while this row's menu is open AND the target ws
                        still exists (defensive: it cannot vanish while the
                        frozen popover is open, but the guard keeps the menu
                        honest if it ever does). */}
                    <Show when={rowMenu.open() && rowMenuWsId() === ws.id && menuWs()}>
                      <div
                        class={tabStyles.tabMenu}
                        style={{ left: `${rowMenuPos().left}px`, top: `${rowMenuPos().top}px` }}
                        role="menu"
                        data-testid="ws-overflow-row-menu"
                        data-workspace={ws.id}
                        aria-label={`Workspace menu: ${ws.name}`}
                      >
                        <button
                          type="button"
                          classList={{
                            [tabStyles.tabMenuItem]: true,
                            [tabStyles.tabMenuItemDisabled]: menuIsLeftmost(),
                          }}
                          data-testid="ws-menu-move-left"
                          data-workspace={ws.id}
                          role="menuitem"
                          aria-disabled={menuIsLeftmost() ? "true" : undefined}
                          title={
                            menuIsLeftmost()
                              ? "Already the first workspace"
                              : `Move "${ws.name}" left`
                          }
                          onClick={onRowMenuItem(rowMenuMove(-1))}
                        >
                          Move left
                        </button>
                        <button
                          type="button"
                          classList={{
                            [tabStyles.tabMenuItem]: true,
                            [tabStyles.tabMenuItemDisabled]: menuIsRightmost(),
                          }}
                          data-testid="ws-menu-move-right"
                          data-workspace={ws.id}
                          role="menuitem"
                          aria-disabled={menuIsRightmost() ? "true" : undefined}
                          title={
                            menuIsRightmost()
                              ? "Already the last workspace"
                              : `Move "${ws.name}" right`
                          }
                          onClick={onRowMenuItem(rowMenuMove(1))}
                        >
                          Move right
                        </button>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
            <Show when={rows().length === 0}>
              <div class={s.empty} data-testid="ws-overflow-empty">
                No matching workspace
              </div>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

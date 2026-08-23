import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { autoTransposeOn, setAutoTranspose } from "../viewportShape";
import { focusedId, hostOps, panes } from "../dockview/store";
import {
  NAMED_LAYOUT_NAME_MAX,
  deleteNamedLayout,
  listNamedLayouts,
  normalizeLayoutName,
} from "../dockview/namedLayouts";
import { TABSTRIP_POPOVER_GROUP, usePopoverSurface } from "./popover";
import s from "./Settings.module.css";

/**
 * Host-shell SETTINGS popover (tabstrip gear) — the host's only settings
 * surface (the statusbar and per-pane headers are both gone, so after a
 * deploy the operator had no way to reload short of summoning a keyboard).
 *
 * OPEN/CLOSE goes through the shared surface stack (popover.ts), the SAME
 * primitive AddServer uses: Escape closes (topmost-only — with the layout
 * overlay also open, one Escape dismisses only the topmost surface), a
 * pointerdown outside the wrap closes, and the tabstrip group keeps this
 * popover mutually exclusive with AddServer. The listeners live only while
 * a surface is open — no shell-lifetime document handlers.
 * Note the click-outside limit: pointerdown on a CROSS-ORIGIN IFRAME never
 * reaches this document, so tapping a pane does not close the popover —
 * Escape + any host-chrome tap do.
 *
 * EXTENSIBLE BY DESIGN: the menu items are a plain typed array below. Adding
 * a future setting = appending one entry (action or toggle); no rendering
 * changes. A persisted toggle stays live automatically when its `isOn` reads
 * a storage-synced reactive accessor (see viewportShape.autoTransposeOn).
 * Items are host-chrome ONLY (no iframe lifecycle impact) and all GPU-cheap
 * CSS (plain bg/border — no mask-image/backdrop-filter/contain).
 *
 * Production-capable: the toggle reads/writes viewportShape's localStorage
 * helpers (NOT the DEV bridge). The auto-rotate item applies LIVE because
 * viewportShape.applyTranspose re-reads the key on EVERY evaluation — no
 * reload needed.
 *
 * "Layout…" is the host-side, no-gesture entry to the layout overlay (the
 * statusbar removal in aa244b3 had left the overlay gesture-only). It routes
 * through the production HostOps path (hostOps().openLayoutOverlay) anchored
 * to the focused pane, closes this popover on activation (surface handoff),
 * and is aria-disabled + dimmed when no pane is focused.
 *
 * "Layouts…" swaps the popover's CONTENT to the named-layouts manager (see
 * layoutsView below) — the sub-panel lives entirely inside this popover (no
 * new permanent chrome), with a "‹ Menu" back affordance. The view resets to
 * the menu whenever the popover closes.
 */

/** A one-shot menu entry (runs an action when activated). */
interface ActionItem {
  kind: "action";
  testid: string;
  label: string;
  description: string;
  /** Disabled accessor, read reactively while the popover is open (the JSX
   *  attributes below call it inside their expressions, so SolidJS tracks it).
   *  A disabled action renders aria-disabled + a dimmed non-interactive style
   *  and activation is a full no-op. The button itself stays focusable so
   *  keyboard/screen-reader users can still discover the entry. */
  disabled?(): boolean;
  /** When true, activating this action CLOSES the popover after run() — for
   *  actions whose result is the NEXT surface (Layout… opens the layout
   *  overlay; two popovers open at once is confusing). */
  closeAfterRun?: boolean;
  run(): void;
}

/** A boolean menu entry (aria-checked checkbox semantics). `isOn` is read
 *  reactively (a Solid signal accessor) so the checkmark tracks the state. */
interface ToggleItem {
  kind: "toggle";
  testid: string;
  label: string;
  description: string;
  isOn(): boolean;
  set(on: boolean): void;
}

type MenuItem = ActionItem | ToggleItem;

export function Settings() {
  let wrapEl: HTMLDivElement | undefined;

  const surface = usePopoverSurface({
    id: "settings",
    group: TABSTRIP_POPOVER_GROUP,
    anchor: () => wrapEl,
  });

  // ---- named-layouts manager sub-view ---------------------------------------
  // "menu" renders the item list; "layouts" swaps the popover's content to the
  // manager (save-current + the saved list). The view resets to the menu on
  // every popover close, so reopening always starts at the item list.
  const [view, setView] = createSignal<"menu" | "layouts">("menu");
  createEffect(() => {
    if (!surface.open()) setView("menu");
  });

  const [layoutName, setLayoutName] = createSignal("");
  // Refresh token: bumped on every local mutation (save/delete) + on entering
  // the view, so the saved-list memo re-reads localStorage. (Cross-document
  // writes while the popover is open are not tracked — single-tab posture,
  // same as the rest of the shell's popovers.)
  const [layoutRev, setLayoutRev] = createSignal(0);
  const namedList = createMemo(() => {
    void layoutRev();
    return listNamedLayouts();
  });

  /** Can the current arrangement be saved? Requires BOTH a non-empty
   *  (trimmed) name AND at least one pane in the ACTIVE workspace — saving an
   *  empty workspace's layout is legal at the storage layer but useless, so
   *  the UI guards it with a hint (mission decision). `panes()` reflects the
   *  active workspace only, and is read inside these expressions so the state
   *  is LIVE while the popover is open. */
  const canSave = (): boolean =>
    panes().length > 0 && normalizeLayoutName(layoutName()) !== "";

  const saveHint = (): string => {
    if (panes().length === 0) return "No panes to save — the active workspace is empty.";
    if (normalizeLayoutName(layoutName()) === "") return "Enter a name to save the current arrangement.";
    return "";
  };

  const enterLayouts = () => {
    setLayoutName("");
    setLayoutRev((n) => n + 1);
    setView("layouts");
  };

  const doSave = () => {
    if (!canSave()) return; // aria-disabled guard — full no-op
    const ok = hostOps()?.saveLayout?.(layoutName()) ?? false;
    if (ok) {
      // Clear the input; the list refresh (rev bump) showing the new entry
      // with its name + relative time IS the confirmation. Same-name saves
      // overwrite (documented in namedLayouts.ts).
      setLayoutName("");
      setLayoutRev((n) => n + 1);
    }
  };

  const doLoad = (name: string) => {
    const id = hostOps()?.loadLayout?.(name);
    // Close on a successful instantiation: the new workspace activates (the
    // manager's result is the workspace, not more manager). A failed lookup
    // (null — no such saved layout) keeps the popover open.
    if (id) surface.closePopover();
  };

  const doDelete = (name: string) => {
    // Pure storage mutation (same production posture as the auto-rotate
    // toggle's setAutoTranspose): deleteNamedLayout is the namedLayouts
    // module's own function, not a DEV-bridge surface. Single-tap delete is
    // a deliberate v1 default (the workspace tabstrip's two-step confirm is
    // overkill for a re-creatable snapshot; noted as reversible).
    deleteNamedLayout(name);
    setLayoutRev((n) => n + 1);
  };

  // The menu. Append entries here; the <For> below renders both kinds.
  // The auto-rotate toggle's isOn reads autoTransposeOn — a REACTIVE mirror
  // of the persisted key that tracks every writer (same-document writes via
  // setAutoTranspose — including the DEV bridge — and cross-document writes
  // via the storage event), so the checkmark can never go stale while the
  // popover is open (finding 7).
  //
  // "Layout…" (FIRST — the most frequent action) restores a host-side,
  // production-capable, NO-GESTURE trigger for the layout overlay: since the
  // statusbar removal (aa244b3) the overlay was gesture-only (double-Ctrl /
  // triple-tap), leaving no fallback if gestures fail on a device. It routes
  // through the SAME production HostOps path the gesture does
  // (hostOps().openLayoutOverlay), anchored to the FOCUSED pane, and is
  // disabled (aria-disabled + dimmed, click = no-op) when no pane is focused
  // (empty workspace) because the overlay must anchor to a pane.
  //
  // "Layouts…" (second, next to its sibling overlay entry) swaps this
  // popover's content to the named-layouts manager. NOT closeAfterRun — the
  // popover stays open; only its content changes.
  const items: MenuItem[] = [
    {
      kind: "action",
      testid: "settings-layout",
      label: "Layout…",
      description: "Split, swap, or close the focused pane.",
      disabled: () => !focusedId(),
      closeAfterRun: true,
      run: () => {
        const id = focusedId();
        if (id) hostOps()?.openLayoutOverlay?.(id);
      },
    },
    {
      kind: "action",
      testid: "settings-layouts",
      label: "Layouts…",
      description: "Save the current arrangement, or load a saved one.",
      run: () => enterLayouts(),
    },
    {
      kind: "action",
      testid: "settings-reload",
      label: "Reload page",
      description: "Load the freshly deployed version.",
      run: () => location.reload(),
    },
    {
      kind: "toggle",
      testid: "settings-autorotate",
      label: "Auto-rotate layout",
      description: "Flip split orientation when the viewport rotates.",
      isOn: () => autoTransposeOn(),
      set: (v) => setAutoTranspose(v),
    },
  ];

  const activate = (item: MenuItem) => {
    if (item.kind === "action") {
      // A disabled action is a full no-op — no run, no close-after-run (the
      // popover stays open so the operator can still pick another entry).
      if (item.disabled?.()) return;
      item.run();
      // Reload navigates anyway; closeAfterRun actions (Layout…) hand off to
      // their surface as the next one open.
      if (item.closeAfterRun) surface.closePopover();
      return;
    }
    item.set(!item.isOn());
    // A toggle keeps the popover open (the operator may flip several
    // settings in one visit); the state change is visible in-place.
  };

  return (
    <div class={s.wrap} ref={wrapEl}>
      <button
        type="button"
        class={s.trigger}
        title="Settings"
        aria-label="Settings"
        aria-haspopup="menu"
        aria-expanded={surface.open() ? "true" : "false"}
        data-testid="settings-btn"
        onClick={() => surface.togglePopover()}
      >
        <span class={s.triggerIcon} aria-hidden="true">⚙</span>
      </button>
      <Show when={surface.open()}>
        <div class={s.popover} role="menu" data-testid="settings-popover" aria-label="Settings">
          <Show when={view() === "menu"}>
            <div class={s.heading}>Settings</div>
            <div class={s.menu} role="presentation">
              <For each={items}>
                {(item) => (
                  <button
                    type="button"
                    // The disabled accessor is CALLED in the class/aria-disabled
                    // expressions so SolidJS tracks it — the state is live while
                    // the popover is open and re-derived on every open (the
                    // <Show> content remounts).
                    class={
                      item.kind === "action" && item.disabled?.()
                        ? `${s.item} ${s.itemDisabled}`
                        : s.item
                    }
                    data-testid={item.testid}
                    role={item.kind === "toggle" ? "menuitemcheckbox" : "menuitem"}
                    aria-checked={item.kind === "toggle" ? (item.isOn() ? "true" : "false") : undefined}
                    // aria-disabled (NOT the native disabled attr): the button
                    // stays focusable/discoverable; the dimmed style + activate's
                    // guard make it non-interactive.
                    aria-disabled={
                      item.kind === "action" && item.disabled?.() ? "true" : undefined
                    }
                    onClick={() => activate(item)}
                  >
                    <span class={s.itemText}>
                      <span class={s.itemLabel}>{item.label}</span>
                      <span class={s.itemDesc}>{item.description}</span>
                    </span>
                    {item.kind === "toggle" ? (
                      /* Cheap checkbox affordance: a bordered square with a ✓
                         glyph when on. Plain bg/border — no GPU-heavy CSS. */
                      <span class={s.itemCheck} aria-hidden="true">
                        <Show when={item.isOn()}>
                          <span class={s.itemCheckMark}>✓</span>
                        </Show>
                      </span>
                    ) : null}
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={view() === "layouts"}>
            <div class={s.manager} data-testid="layouts-manager">
              <div class={s.managerHead}>
                <button
                  type="button"
                  class={s.backBtn}
                  data-testid="layouts-back"
                  aria-label="Back to Settings"
                  onClick={() => setView("menu")}
                >
                  ‹ Menu
                </button>
                <div class={s.managerTitle}>Layouts</div>
              </div>
              <div class={s.saveForm}>
                <label class={s.field}>
                  <span class={s.fieldLabel}>Layout name</span>
                  <input
                    class={s.nameInput}
                    type="text"
                    maxlength={NAMED_LAYOUT_NAME_MAX}
                    placeholder="e.g. morning"
                    value={layoutName()}
                    aria-label="Layout name"
                    data-testid="layout-name-input"
                    onInput={(e) => setLayoutName(e.currentTarget.value)}
                  />
                </label>
                <button
                  type="button"
                  class={canSave() ? s.saveBtn : `${s.saveBtn} ${s.saveBtnDisabled}`}
                  data-testid="layout-save"
                  aria-disabled={canSave() ? undefined : "true"}
                  onClick={() => doSave()}
                >
                  Save current
                </button>
                <Show when={saveHint()}>
                  <div class={s.saveHint} data-testid="layout-save-hint">
                    {saveHint()}
                  </div>
                </Show>
              </div>
              <div class={s.list} data-testid="layout-list">
                <For each={namedList()}>
                  {(entry) => (
                    /* A plain flex row of two SIBLING real buttons (the
                     * AddServer catalog-row pattern): Load is the row's main
                     * target, × deletes. Siblings — not nested — so there is
                     * no propagation path from Load to delete and both are
                     * natively keyboard-activatable (Enter/Space for free). */
                    <div class={s.row} data-testid="layout-row" data-name={entry.name}>
                      <button
                        type="button"
                        class={s.rowMain}
                        aria-label={`Load layout ${entry.name}`}
                        title={`Load ${entry.name} as a new workspace`}
                        data-testid="layout-load"
                        onClick={() => doLoad(entry.name)}
                      >
                        <span class={s.rowName}>{entry.name}</span>
                        <span class={s.rowMeta}>{relTime(entry.savedAt)}</span>
                      </button>
                      <button
                        type="button"
                        class={s.delBtn}
                        aria-label={`Delete layout ${entry.name}`}
                        title={`Delete ${entry.name}`}
                        data-testid="layout-delete"
                        onClick={() => doDelete(entry.name)}
                      >
                        ×
                      </button>
                    </div>
                  )}
                </For>
                <Show when={namedList().length === 0}>
                  <div class={s.empty} data-testid="layout-empty">
                    No saved layouts yet.
                  </div>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** Coarse relative age for a saved layout (cheap, no ticker — computed at
 *  render; a stale minute while the popover stays open is fine). */
function relTime(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

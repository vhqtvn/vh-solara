import { For, Show } from "solid-js";
import { autoTransposeOn, setAutoTranspose } from "../viewportShape";
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
 */

/** A one-shot menu entry (runs an action when activated). */
interface ActionItem {
  kind: "action";
  testid: string;
  label: string;
  description: string;
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

  // The menu. Append entries here; the <For> below renders both kinds.
  // The auto-rotate toggle's isOn reads autoTransposeOn — a REACTIVE mirror
  // of the persisted key that tracks every writer (same-document writes via
  // setAutoTranspose — including the DEV bridge — and cross-document writes
  // via the storage event), so the checkmark can never go stale while the
  // popover is open (finding 7).
  const items: MenuItem[] = [
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
      item.run(); // reload navigates anyway; other future actions may close
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
          <div class={s.heading}>Settings</div>
          <div class={s.menu} role="presentation">
            <For each={items}>
              {(item) => (
                <button
                  type="button"
                  class={s.item}
                  data-testid={item.testid}
                  role={item.kind === "toggle" ? "menuitemcheckbox" : "menuitem"}
                  aria-checked={item.kind === "toggle" ? (item.isOn() ? "true" : "false") : undefined}
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
        </div>
      </Show>
    </div>
  );
}

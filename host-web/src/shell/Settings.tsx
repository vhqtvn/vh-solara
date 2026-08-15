import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { autoTransposeEnabled, setAutoTranspose } from "../viewportShape";
import s from "./Settings.module.css";

/**
 * Host-shell SETTINGS popover (tabstrip gear) — the host's only settings
 * surface (the statusbar and per-pane headers are both gone, so after a
 * deploy the operator had no way to reload short of summoning a keyboard).
 *
 * Mirrors the AddServer popover's structure/positioning (anchored dropdown
 * top-right of the tabstrip trigger, z-50) and adds the close affordances
 * AddServer never had: click-outside (document pointerdown) + Escape.
 * Note the click-outside limit: pointerdown on a CROSS-ORIGIN IFRAME never
 * reaches this document, so tapping a pane does not close the popover —
 * Escape + any host-chrome tap do. Same limitation class as every other
 * popover here; acceptable for a settings menu.
 *
 * EXTENSIBLE BY DESIGN: the menu items are a plain typed array below. Adding
 * a future setting = appending one entry (action or toggle); no rendering
 * changes. Items are host-chrome ONLY (no iframe lifecycle impact) and all
 * GPU-cheap CSS (plain bg/border — no mask-image/backdrop-filter/contain).
 *
 * Production-capable: reads/writes the toggle through viewportShape's
 * exported localStorage helpers (NOT the DEV bridge). The auto-rotate item
 * applies LIVE because viewportShape.applyTranspose re-reads the key on
 * EVERY evaluation — no reload, no listener needed.
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
  const [open, setOpen] = createSignal(false);
  // Auto-rotate UI state. Synced FROM localStorage on every open (so an
  // external write — DEV bridge, another tab — is reflected), written back
  // through setAutoTranspose on toggle. The signal exists only to make the
  // checkbox reactive; localStorage remains the source of truth.
  const [autoRotate, setAutoRotate] = createSignal(autoTransposeEnabled());

  let wrapEl: HTMLDivElement | undefined;

  const openPopover = () => {
    setAutoRotate(autoTransposeEnabled()); // reflect current persisted state
    setOpen(true);
  };

  const closePopover = () => setOpen(false);

  const togglePopover = () => {
    if (open()) closePopover();
    else openPopover();
  };

  // Click-outside + Escape close (onMount → listeners live for the shell's
  // lifetime; they early-return while the popover is closed — same pattern
  // as LayoutOverlay's Esc handling). pointerdown (not click) so the close
  // wins the race against whatever the outside tap activates.
  onMount(() => {
    const onPointerDown = (ev: PointerEvent): void => {
      if (!open()) return;
      const t = ev.target as Node | null;
      if (t && wrapEl?.contains(t)) return; // trigger + popover are inside
      closePopover();
    };
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (open() && ev.key === "Escape") closePopover();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    });
  });

  // The menu. Append entries here; the <For> below renders both kinds.
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
      isOn: () => autoRotate(),
      set: (v) => {
        setAutoTranspose(v);
        setAutoRotate(v);
      },
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
        aria-expanded={open() ? "true" : "false"}
        data-testid="settings-btn"
        onClick={() => togglePopover()}
      >
        <span class={s.triggerIcon} aria-hidden="true">⚙</span>
      </button>
      <Show when={open()}>
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

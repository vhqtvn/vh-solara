import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

// Shared popup chrome for the inline pending-input cards (QuestionCard,
// PermissionCard). Both render the SAME `body()` inline AND inside a SolidJS
// <Portal> overlay (a "second render surface" of the card, sharing the card's
// signals). The lifecycle chrome between them was identical — and now it is
// identical here:
//
//   • open/close with focus CAPTURE (move focus onto the overlay container,
//     which carries tabindex="-1") and focus RESTORE (return focus to the exact
//     element that opened the popup) on close.
//   • a keyboard contract active ONLY while the overlay is mounted:
//       - ESC          → close
//       - Tab/Shift+Tab → cycle only among focusables INSIDE the overlay
//         (wrap first↔last), so focus can never escape to elements behind the
//         overlay. The focusable set is re-queried on EVERY Tab so dynamically
//         relevant targets (option buttons, the custom textarea, the action
//         buttons, the close affordance, the H/V toggle) are never stale.
//
// The card still owns its signals and its `body()`; this module owns only the
// popup chrome. It does NOT touch the inline surface — when the popup is closed
// the inline `body()` stays normally tabbable (the listener is torn down with
// onCleanup the moment `open()` flips false and the <Show> unmounts the Portal).

// Standard focusable approximation. `:not([tabindex="-1"])` excludes the dialog
// container itself, which carries tabindex="-1" as the ESC/focus target and must
// NOT be part of the Tab cycle.
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface CardPopup {
  /** Reactive open flag — drive the card's `<Show when={open()}>` Portal mount. */
  open: Accessor<boolean>;
  /** Bind to the overlay container element: `ref={setPopRef}`. */
  setPopRef: (el: HTMLDivElement) => void;
  /** Open: capture current focus, mount the overlay, focus the container. */
  show: () => void;
  /** Close: unmount the overlay, restore focus to the element that opened it. */
  hide: () => void;
}

// Returns the shared popup controller. Call once at the top of the card body;
// wire `open()` into the `<Show>`, `setPopRef` into the overlay container's
// `ref`, and `show`/`hide` into the open/close affordances (and the overlay
// backdrop click). Both cards use the exact same wiring.
export function useCardPopup(): CardPopup {
  const [open, setOpen] = createSignal(false);
  let lastFocus: HTMLElement | null = null;
  let popEl: HTMLDivElement | undefined;

  const setPopRef = (el: HTMLDivElement) => {
    popEl = el;
  };
  const show = () => {
    lastFocus = document.activeElement as HTMLElement | null;
    setOpen(true);
    // Solid mounts the <Show> branch synchronously on the signal flip, so the
    // ref callback has populated `popEl` by the time this microtask runs; the
    // deferral lets the browser lay out the overlay before focusing it.
    queueMicrotask(() => popEl?.focus());
  };
  const hide = () => {
    setOpen(false);
    queueMicrotask(() => lastFocus?.focus?.());
  };

  // One keydown listener owns BOTH ESC and the Tab trap. It is registered only
  // while `open()` is true; onCleanup removes it when the <Show> unmounts, so
  // the trap never affects the inline surface.
  createEffect(() => {
    if (!open()) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        hide();
        return;
      }
      if (e.key !== "Tab") return;
      const root = popEl;
      if (!root) return;
      // Re-query on every Tab: the focusable set is a function of the card's
      // shared signals (option picked, busy state) and must never go stale.
      const nodes = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      const active = document.activeElement as HTMLElement | null;
      if (nodes.length === 0) {
        // No tabbable target inside — pin focus to the container so Tab can't
        // leak through it.
        e.preventDefault();
        if (active !== root) root.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey) {
        // Backward: at first, or focus already escaped the overlay → wrap to last.
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Forward: at last, or focus already escaped the overlay → wrap to first.
        if (active === last || !root.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

  return { open, setPopRef, show, hide };
}

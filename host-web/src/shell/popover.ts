// Centralized dismissible-surface stack for the host shell ("surface stack").
//
// App-like dismissal semantics — the host-web adaptation of the inner SPA's
// back-stack principle (f7bba45, web/src/lib/backStack.ts): ONE Escape (or
// back gesture) dismisses ONLY the topmost open surface, LIFO. The inner SPA
// arbitrates via URL history + popstate because its surfaces participate in
// browser navigation; host-shell surfaces (tabstrip popovers, the layout
// overlay) do not, so the arbiter here is a module-level stack plus exactly
// ONE window keydown listener and ONE document pointerdown listener.
//
// What the stack provides (the three dismissal debts this resolves):
//  - TOPMOST-ONLY Escape (finding 4): with e.g. Settings and the layout
//    overlay open at once, a single Escape used to fire every surface's own
//    window keydown listener and close them all. Now only the topmost entry
//    closes; the next Escape dismisses the next surface.
//  - MUTUAL EXCLUSION per group (finding 1): surfaces sharing a group id
//    (the two tabstrip popovers, TABSTRIP_POPOVER_GROUP) are mutually
//    exclusive — opening one closes the others. Only one anchored popover
//    from the tabstrip cluster can be open, so they can never stack over
//    each other's controls.
//  - ATTACH-ON-OPEN listeners (finding 9): the keydown + pointerdown
//    listeners exist ONLY while at least one surface is open. No
//    shell-lifetime document listeners guarding a rarely-open popover.
//
// OUTSIDE-CLICK: a pointerdown outside a surface's `anchor` element (the
// trigger + popover wrapper) closes it. pointerdown (not click) so the close
// wins the race against whatever the outside tap activates. A pointerdown
// inside a CROSS-ORIGIN IFRAME never reaches this document, so pane taps do
// NOT flow through that listener — they route through the pane-activate
// bridge instead: the SPA forwards {type:"host-gesture",gesture:"pane-
// activate"} on every pane focus/pointerdown/focusin (web/src/hostGesture.ts),
// and the host's routeMessage (dockview/store.ts, host-gesture branch) calls
// dismissAnchoredSurfaces() on each VALID activation — closing every anchored
// popover exactly like a host-chrome tap would. Surfaces that own their own
// outside handling (the layout overlay's <main> capture layer) register
// WITHOUT an anchor and are skipped by BOTH the outside-click pass and
// dismissAnchoredSurfaces.
//
// This module is UI-framework-lazy on purpose: registerSurface/releaseSurface
// are plain functions (the layout overlay wires them in an effect), while
// usePopoverSurface is the SolidJS hook the tabstrip popovers use.

import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";

/** Group id for the tabstrip's anchored popovers (AddServer + Settings):
 *  mutually exclusive — opening one closes the other. */
export const TABSTRIP_POPOVER_GROUP = "tabstrip";

/** One open dismissible surface. `anchor` is an ACCESSOR (read at event time)
 *  for the element that contains both the trigger and the popover; a pointerdown
 *  inside it never dismisses the surface. Omit it for surfaces that own their
 *  own outside-dismissal (the layout overlay). */
export interface SurfaceEntry {
  /** Stable identity (one per surface kind; components here are singletons). */
  readonly id: string;
  /** Surfaces sharing a group are mutually exclusive. */
  readonly group?: string;
  /** Containment root for outside-click dismissal (optional — see above). */
  readonly anchor?: () => HTMLElement | null | undefined;
  /** Dismiss the surface (Escape-topmost, outside-click, group exclusion). */
  close(): void;
}

// The stack, topmost LAST. Module-level singleton: one host window.
const stack: SurfaceEntry[] = [];
let listenersAttached = false;

/** Escape arbiter: dismiss ONLY the topmost surface (app-like back-nav, the
 *  f7bba45 principle — one Escape, one surface). */
function onKeyDown(ev: KeyboardEvent): void {
  if (ev.key !== "Escape") return;
  const top = stack[stack.length - 1];
  if (top) top.close();
}

/** Outside-click pass: close every surface whose anchor does not contain the
 *  pointerdown target. Anchor-less surfaces (own outside handling) are skipped. */
function onPointerDown(ev: PointerEvent): void {
  const target = ev.target;
  if (!(target instanceof Node)) return;
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i];
    const anchor = entry.anchor?.();
    if (!anchor || anchor.contains(target)) continue;
    entry.close();
  }
}

/** Attach the listeners when the first surface opens; detach when the last
 *  closes (no shell-lifetime listeners — finding 9). */
function syncListeners(): void {
  const need = stack.length > 0;
  if (need === listenersAttached) return;
  listenersAttached = need;
  if (need) {
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
  } else {
    document.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("keydown", onKeyDown);
  }
}

/** Register an OPEN surface (pushes it topmost). Same-group surfaces still in
 *  the stack are closed first (mutual exclusion); their own releaseSurface runs
 *  in their effect cleanup after the close propagates. */
export function registerSurface(entry: SurfaceEntry): void {
  if (entry.group !== undefined) {
    for (let i = stack.length - 1; i >= 0; i--) {
      const other = stack[i];
      if (other.group === entry.group) other.close();
    }
  }
  // Defensive: replace a stale same-id entry (register-while-registered).
  const existing = stack.findIndex((s) => s.id === entry.id);
  if (existing !== -1) stack.splice(existing, 1);
  stack.push(entry);
  syncListeners();
}

/** Release a surface (it closed or unmounted). No-op for unknown ids. */
export function releaseSurface(id: string): void {
  const i = stack.findIndex((s) => s.id === id);
  if (i !== -1) stack.splice(i, 1);
  syncListeners();
}

/** Dismiss every ANCHORED surface (the tabstrip popovers). Anchor-less
 *  surfaces — those that own their outside-dismissal (the layout overlay's
 *  <main> capture layer) — are skipped, mirroring onPointerDown's anchor-less
 *  skip. (One deliberate difference: the test here is anchor EXISTENCE, not
 *  the accessor's event-time return — a pane tap is outside every popover, so
 *  even a transiently null-resolving anchored surface still closes here where
 *  the outside-click pass would have skipped it.)
 *
 *  This is the cross-boundary completion of the outside-click pass: a tap
 *  inside a cross-origin pane iframe never fires this document's pointerdown,
 *  so the SPA's forwarded pane-activate gesture is the only signal that
 *  attention moved into a pane. routeMessage (dockview/store.ts) calls this
 *  on every VALID pane-activate (source-bound + origin-checked), BEFORE its
 *  idempotent focus no-op — a tap on an already-focused pane still dismisses. */
export function dismissAnchoredSurfaces(): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i];
    if (!entry.anchor) continue;
    entry.close();
  }
}

export interface PopoverSurface {
  /** Reactive open state. */
  open: Accessor<boolean>;
  /** Open (runs `onOpen` first — prefill/sync bookkeeping). Same-group
   *  surfaces close via registerSurface's exclusion pass. */
  openPopover(): void;
  closePopover(): void;
  togglePopover(): void;
}

/** SolidJS hook: an open signal wired to the surface stack. While open() is
 *  true the surface is registered (Escape-topmost + outside-click + group
 *  exclusion); the registration is released on close/unmount via effect
 *  cleanup, so the stack can never hold a closed surface past one flush. */
export function usePopoverSurface(opts: {
  id: string;
  group?: string;
  anchor?(): HTMLElement | null | undefined;
  onOpen?(): void;
}): PopoverSurface {
  const [open, setOpen] = createSignal(false);
  createEffect(() => {
    if (!open()) return;
    registerSurface({
      id: opts.id,
      group: opts.group,
      anchor: opts.anchor,
      close: () => setOpen(false),
    });
    onCleanup(() => releaseSurface(opts.id));
  });
  return {
    open,
    openPopover: () => {
      if (open()) return;
      opts.onOpen?.();
      setOpen(true);
    },
    closePopover: () => setOpen(false),
    togglePopover: () => (open() ? setOpen(false) : (opts.onOpen?.(), setOpen(true))),
  };
}

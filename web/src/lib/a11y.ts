// Accessibility helpers for modal surfaces.
//
// `modal` is a Solid directive (use:modal) for dialog overlays: it marks the
// element aria-modal, moves focus inside on open, traps Tab/Shift+Tab within it,
// and restores focus to the previously-focused element on close. Escape/outside-
// click closing is left to each dialog (they already handle it).
import { createSignal, onCleanup } from "solid-js";

// Count of open modal dialogs (anything using the `modal` directive). Lets
// global hotkeys/menus stand down while a dialog owns the keyboard.
const [modalCount, setModalCount] = createSignal(0);
export const anyModalOpen = () => modalCount() > 0;

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (e) => e.offsetParent !== null || e === document.activeElement,
  );
}

// HTML input types that pop the on-screen (soft) keyboard when focused on a
// touch device. Auto-focusing one of these as a dialog opens shrinks the
// viewport by summoning the keyboard — reported as jarring on mobile. To avoid
// that, focusFirst() skips these on coarse pointers and lands on the next
// focusable (e.g. the close button), or on the container if there is none.
//
// A dialog opts back IN to focusing a keyboard-popper on open by setting
// `data-autofocus-keyboard` on its root element (CommandPalette does this,
// since its entire purpose is immediate typing). Scope is strict: <select>,
// checkboxes, radios, ranges, the date/time family, file, and buttons do NOT
// pop a soft keyboard, so they are excluded and stay valid auto-focus targets.
const KEYBOARD_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
]);
function popsKeyboard(el: HTMLElement): boolean {
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    const t = (el as HTMLInputElement).type; // "" when no type attr → behaves as text
    return t === "" || KEYBOARD_TYPES.has(t);
  }
  return false;
}

export function attachModal(el: HTMLElement): () => void {
  const prev = document.activeElement as HTMLElement | null;
  setModalCount((n) => n + 1);
  el.setAttribute("aria-modal", "true");
  if (!el.getAttribute("role")) el.setAttribute("role", "dialog");
  // Move focus in so the keyboard/SR user starts inside the modal, not on the
  // obscured page. Deferred: a portaled dialog's children may not exist yet when
  // the ref runs. Skip if the dialog already focused something itself.
  const focusFirst = () => {
    if (el.contains(document.activeElement)) return;
    const candidates = focusables(el);
    // On a coarse pointer (touch) don't auto-focus an element that pops the
    // soft keyboard on open — that shrinks the viewport. Pick the first NON-
    // keyboard focusable instead. A dialog opts back in with
    // `data-autofocus-keyboard` (CommandPalette's reason for being is immediate
    // typing). Fine pointers (desktop) keep today's behavior unchanged.
    const coarse =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    const allowKeyboard = el.dataset.autofocusKeyboard !== undefined;
    const pick =
      coarse && !allowKeyboard
        ? candidates.find((c) => !popsKeyboard(c))
        : candidates[0];
    if (pick) pick.focus();
    else {
      el.tabIndex = -1;
      el.focus();
    }
  };
  queueMicrotask(focusFirst);
  // Listen on document (capture) so Tab is trapped even when focus has drifted
  // outside the dialog (a listener on `el` would never see those keystrokes).
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const f = focusables(el);
    if (!f.length) {
      e.preventDefault();
      return;
    }
    const first = f[0];
    const last = f[f.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!el.contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener("keydown", onKey, true);
  return () => {
    document.removeEventListener("keydown", onKey, true);
    setModalCount((n) => Math.max(0, n - 1));
    // Restore focus to whatever had it before the dialog opened.
    if (prev && document.contains(prev)) prev.focus();
  };
}

// Solid directive form: <div use:modal> on the dialog element.
export function modal(el: HTMLElement) {
  onCleanup(attachModal(el));
}

// Solid directive: <div use:dismiss={() => setOpen(false)}> closes a popover on
// an outside click or Escape. Armed on the next tick so the click that opened it
// doesn't immediately dismiss it. Uses composedPath (not el.contains) so a click
// on an inner control that re-renders mid-click still counts as "inside" — the
// Solid event-delegation footgun every popover was handling by hand. Best on a
// panel that's mounted only while open (the listener lifetime tracks the panel).
//
// Pass a function (same handler for outside-click + Escape), or an object
// { onClose, onEscape } when Escape needs different behaviour (e.g. close an
// inner overlay first).
export type DismissValue = (() => void) | { onClose: () => void; onEscape?: () => void };
export function dismiss(el: HTMLElement, value: () => DismissValue) {
  const v = value();
  const onClose = typeof v === "function" ? v : v.onClose;
  const onEscape = typeof v === "function" ? v : (v.onEscape ?? v.onClose);
  const onDoc = (e: MouseEvent) => {
    if (!e.composedPath().includes(el)) onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") onEscape();
  };
  const id = window.setTimeout(() => {
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
  }, 0);
  onCleanup(() => {
    clearTimeout(id);
    document.removeEventListener("click", onDoc);
    document.removeEventListener("keydown", onKey);
  });
}

declare module "solid-js" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface Directives {
      modal: true;
      dismiss: DismissValue;
    }
  }
}

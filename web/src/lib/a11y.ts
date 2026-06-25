// Accessibility helpers for modal surfaces.
//
// `modal` is a Solid directive (use:modal) for dialog overlays: it marks the
// element aria-modal, moves focus inside on open, traps Tab/Shift+Tab within it,
// and restores focus to the previously-focused element on close. Escape/outside-
// click closing is left to each dialog (they already handle it).
import { onCleanup } from "solid-js";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (e) => e.offsetParent !== null || e === document.activeElement,
  );
}

export function attachModal(el: HTMLElement): () => void {
  const prev = document.activeElement as HTMLElement | null;
  el.setAttribute("aria-modal", "true");
  if (!el.getAttribute("role")) el.setAttribute("role", "dialog");
  // Move focus in so the keyboard/SR user starts inside the modal, not on the
  // obscured page. Deferred: a portaled dialog's children may not exist yet when
  // the ref runs. Skip if the dialog already focused something itself.
  const focusFirst = () => {
    if (el.contains(document.activeElement)) return;
    const first = focusables(el)[0];
    if (first) first.focus();
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
export function dismiss(el: HTMLElement, value: () => () => void) {
  const onClose = value();
  const onDoc = (e: MouseEvent) => {
    if (!e.composedPath().includes(el)) onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
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
      dismiss: () => void;
    }
  }
}

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

declare module "solid-js" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface Directives {
      modal: true;
    }
  }
}

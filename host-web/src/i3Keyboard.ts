import { activeWorkspaceId, focusedId, hostOps, panes } from "./dockview/store";
import type { FocusDir, LayoutMode } from "./dockview/types";

// =============================================================================
// i3 KEYBOARD SHORTCUTS (host-shell Phase 1, Item 4)
//
// Wired at the HOST document level. Fires only when the host shell has focus
// (clicking a tab/statusbar/workspace chrome). When focus is inside a cross-
// origin iframe (a server pane), the host gets NO keydown — the shortcut
// doesn't fire, so embedded SPA keybindings are never stolen.
//
// MOD KEY = Alt (suggested; reversible-default). Ctrl conflicts with browser
// shortcuts (Ctrl+H = history, Ctrl+W = close tab) so Alt is the safer choice.
//
// SHORTCUTS:
//   Alt+H          split horizontal (split right)
//   Alt+V          split vertical   (split down)
//   Alt+W          tabbed mode
//   Alt+S          stacked mode
//   Alt+F          zoom (maximize group)
//   Alt+Shift+Q    close focused pane
//   Alt+Arrow      focus the spatially-nearest pane in that direction
//   Alt+Shift+Arrow move the focused pane in that direction (swap with neighbor)
//
// COMPOSITION with keyboardFocus.ts (the soft-keyboard maximize): these are
// KEYBOARD keydown handlers; keyboardFocus.ts handles visualViewport (soft-
// keyboard open/close). Different event sources; no ownership conflict. Both
// run side-by-side. The i3 zoom (Alt+F) uses toggleZoom (the same survival-safe
// maximizeGroup/exit primitive keyboardFocus.ts uses), so they share the
// maximize surface without clobbering each other's ownership tracking.
//
// GUARD: shortcuts are suppressed when a HOST input/textarea/contenteditable is
// focused (rename field, AddServer form) so typing doesn't trigger them.
// =============================================================================

let installed = false;
let handler: ((ev: KeyboardEvent) => void) | null = null;

/** True when an editable host element currently has focus (so shortcuts that
 *  would interfere with typing are suppressed). Iframe focus is NOT host focus,
 *  so typing inside a server pane never reaches here. */
function hostEditableFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (el as HTMLElement).isContentEditable;
}

function actOnFocused(): string | null {
  if (hostEditableFocused()) return null;
  return focusedId();
}

function dirFromArrow(key: string): FocusDir | null {
  switch (key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    default:
      return null;
  }
}

function onKey(ev: KeyboardEvent): void {
  if (!ev.altKey) return; // all i3 shortcuts use Alt as the mod key
  if (ev.ctrlKey || ev.metaKey) return; // avoid clashing with OS/browser combos
  // Close: Alt+Shift+Q (handle first — it's a shifted key).
  if (ev.shiftKey && (ev.key === "Q" || ev.key === "q")) {
    const id = actOnFocused();
    if (!id) return;
    ev.preventDefault();
    hostOps()?.closePane?.(id);
    return;
  }
  if (ev.shiftKey) {
    // Alt+Shift+Arrow → move direction
    const dir = dirFromArrow(ev.key);
    if (dir) {
      const id = actOnFocused();
      if (!id) return;
      ev.preventDefault();
      hostOps()?.moveDirection?.(id, dir);
    }
    return;
  }
  // Alt+<key> (no shift)
  const k = ev.key;
  const id = actOnFocused();
  // Arrow focus (no focused-id guard needed to PREVENT default, but the op is a
  // no-op without a focused pane — still preventDefault so the browser doesn't
  // scroll the host).
  const arrowDir = dirFromArrow(k);
  if (arrowDir) {
    if (!id) return;
    ev.preventDefault();
    hostOps()?.focusDirection?.(id, arrowDir);
    return;
  }
  if (!id) return;
  switch (k) {
    case "h":
    case "H":
      ev.preventDefault();
      hostOps()?.split?.(id, "right");
      break;
    case "v":
    case "V":
      ev.preventDefault();
      hostOps()?.split?.(id, "down");
      break;
    case "w":
    case "W":
      ev.preventDefault();
      hostOps()?.setLayoutMode?.(id, "tabbed" as LayoutMode);
      break;
    case "s":
    case "S":
      ev.preventDefault();
      hostOps()?.setLayoutMode?.(id, "stacked" as LayoutMode);
      break;
    case "f":
    case "F":
      ev.preventDefault();
      hostOps()?.toggleZoom?.(id);
      break;
    default:
      break;
  }
}

/**
 * Install the i3 keyboard shortcuts at the host document. Idempotent. The
 * listener is attached to window with capture=false so embedded iframes (which
 * the host never receives keydown from anyway) and host editable elements are
 * naturally isolated; the hostEditableFocused() guard is the belt-and-suspenders
 * for the host's own inputs (rename/AddServer).
 */
export function installI3Keyboard(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  installed = true;
  handler = onKey;
  window.addEventListener("keydown", handler, false);
}

/** Tear down the listener (hot-reload / unmount). */
export function uninstallI3Keyboard(): void {
  if (!installed) return;
  installed = false;
  if (handler && typeof window !== "undefined") {
    window.removeEventListener("keydown", handler, false);
  }
  handler = null;
}

// DEV bridge (window.__hostI3Keys) — minimal, for the keyboard e2e to assert
// the module is wired + to inspect the mod-key choice. Gated behind DEV so prod
// never exposes it (Vite dead-code-eliminates it, mirroring window.__host).
if (import.meta.env && (import.meta.env as { DEV?: boolean }).DEV) {
  (window as unknown as Record<string, unknown>).__hostI3Keys = {
    installed: () => installed,
    modKey: "Alt",
    // Read the active workspace's pane count (used by the keyboard e2e to verify
    // the module sees the live tree).
    paneCount: () => {
      void activeWorkspaceId();
      return panes().length;
    },
  };
}

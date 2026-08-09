import type { DockviewApi } from "dockview-core";
import { activeWorkspaceId, workspaceApiFor } from "./dockview/store";

// =============================================================================
// HOST-OWNED KEYBOARD FOCUS-MODE
//
// Mission: "When the keyboard is shown, the focused pane takes the whole
// remaining viewport." When the soft keyboard opens in an embedded SPA pane,
// the focused pane's group is maximized (overlays the others in place) AND the
// host root is shrunk to the visible area, so the focused IFRAME ELEMENT itself
// resizes to the visible area. The SPA's own-vv-only viewport tracking then
// puts its composer above the keyboard with no gap. On keyboard close the
// layout restores.
//
// WHY THE HOST OWNS THIS (root-cause note). The earlier SPA-side fix
// (web/src/viewport.ts, commit bb21408) capped the SPA's --app-h at the parent's
// visualViewport.height. That was the wrong layer: the iframe ELEMENT stayed
// full-size while --app-h shrank → .app shorter than the iframe box → composer
// parked high + an empty iframe-background band filled the gap below, full
// width. The host meta lacks interactive-widget=resizes-content, so under the
// browser default (resizes-visual) the keyboard shrinks only the host's VISUAL
// viewport, not its layout viewport, hence not the iframe element. The fix is
// to make the host shrink the iframe element directly (root resize + maximize),
// after which the SPA's normal standalone path tracks it. The SPA-side parent
// cap is retired (see web/src/viewport.ts).
//
// SURVIVAL INVARIANT (load-bearing). This MUST NOT reparent/move/remove any
// iframe — that reloads it. It uses ONLY api.maximizeGroup()/exitMaximizedGroup()
// (the same survival-safe overlay primitive manual zoom uses; overlays in place,
// no reparent, no reload) + an explicit pixel height on the host root. The
// iframe stays mounted where Dockview created it; only geometry/visibility
// changes.
// =============================================================================

// ---- tunables (flagged for on-device adjustment) ---------------------------

/** Keyboard-open heuristic threshold. The mobile address-bar shrink on scroll
 *  is small (~10-15%); a soft keyboard is a large persistent shrink (typically
 *  30-50%). We treat visualViewport.height below this fraction of
 *  window.innerHeight (the LAYOUT viewport) as "keyboard open". 0.7 separates
 *  the two well; adjust on-device if it false-triggers (raise) or misses a
 *  short keyboard (lower). */
const KEYBOARD_THRESHOLD = 0.7;
/** Debounce so rapid/transient visualViewport fluctuations (address-bar
 *  show/hide, scroll bounce) do not flicker the maximize. ~180ms is below the
 *  keyboard open/close animation (~250-300ms) but above a frame's jitter. */
const DEBOUNCE_MS = 180;

// ---- module state (singleton; one keyboard per host window) ----------------

let installed = false;
/** Accessor for the host root element (the `.app` container in App.tsx) whose
 *  inline height is overridden on keyboard-open. Captured at install time. */
let getAppEl: (() => HTMLElement | null) | null = null;
let vvListener: (() => void) | null = null;
let debounceTimer: number | undefined;
let keyboardOpen = false;
/** The workspace whose maximize focus-mode OWNS (null = not opened by us, e.g.
 *  the user had already manually maximized a pane when the keyboard opened, so
 *  we leave it alone and do not exit it on close). Scoped to a single ws: the
 *  one active when we maximized. */
let ownedWs: string | null = null;
/** Captured inline height string to restore on close ("" = no prior inline
 *  override; restore to CSS default by clearing the inline style). */
let savedHeight = "";

function activeApi(): DockviewApi | undefined {
  return workspaceApiFor(activeWorkspaceId());
}

/** Soft keyboards only exist on touch-primary devices. Desktops (no touch) are
 *  excluded so transient vv changes never false-trigger there. Touch laptops
 *  report maxTouchPoints>0 but have a physical keyboard — the shrink heuristic
 *  still won't fire on them (no keyboard → no large persistent shrink), so this
 *  gate is a cheap correctness floor, not a claim of "is a phone". */
function isTouchCapable(): boolean {
  return typeof navigator !== "undefined" && (navigator.maxTouchPoints ?? 0) > 0;
}

/** True iff the host's visual viewport has shrunk past the keyboard threshold. */
function keyboardDetected(): boolean {
  const vv = window.visualViewport;
  if (!vv) return false;
  return vv.height < KEYBOARD_THRESHOLD * window.innerHeight;
}

/** Apply the keyboard-open state: shrink the host root to the visible area and
 *  maximize the active pane's group (if we don't already own / the user hasn't
 *  manually maximized). */
function applyOpen(visibleHeight: number): void {
  keyboardOpen = true;
  setRootHeight(visibleHeight);
  maximizeActive();
}

/** Apply the keyboard-close state: restore the host root and exit the maximize
 *  we own (never the one the user manually entered). */
function applyClose(): void {
  keyboardOpen = false;
  restoreRootHeight();
  exitOwned();
}

/** P3: read whether keyboard focus-mode is currently open. Used by the NEXT
 *  hero button's keyboard-composition rule (keep mode for a same-pane target;
 *  exit it for a cross-pane target). Mirrors the DEV bridge's isOpen(). */
export function isKeyboardOpen(): boolean {
  return keyboardOpen;
}

/** P3: programmatically exit keyboard focus-mode (restore the host root + exit
 *  the maximize focus-mode owns). Used by the NEXT hero button when crossing to
 *  a different pane so the previously-focused pane's keyboard-maximize does not
 *  pin the layout. PRESERVES a user's manual maximize — exitOwned() only exits
 *  what focus-mode entered (ownedWs !== null); a user-owned maximize is never
 *  touched. No-op (and cheap) when the keyboard is already closed. */
export function exitKeyboardFocus(): void {
  if (!keyboardOpen) return;
  applyClose();
}

function setRootHeight(h: number): void {
  const el = getAppEl?.();
  if (!el) return;
  // Capture the current inline height once (so close restores exactly), then
  // override to the visible height. The root's CSS is height:100vh; an inline
  // pixel height wins and propagates via the flex column to the Dockview
  // container, whose ResizeObserver recomputes the maximized overlay's geometry.
  if (savedHeight === "") savedHeight = el.style.height;
  el.style.height = `${Math.round(h)}px`;
}

function restoreRootHeight(): void {
  const el = getAppEl?.();
  if (!el) return;
  el.style.height = savedHeight; // "" → clears inline override → CSS 100vh wins
  savedHeight = "";
}

/** Maximize the active workspace's focused pane group, recording ownership only
 *  when WE entered the maximize (not when the user had already manually
 *  maximized). */
function maximizeActive(): void {
  const a = activeApi();
  const ws = activeWorkspaceId();
  if (!a || !ws) {
    ownedWs = null;
    return;
  }
  const active = a.activePanel;
  if (!active) {
    ownedWs = null;
    return;
  }
  if (a.hasMaximizedGroup()) {
    // A group is already maximized — the user did it manually (or it's leftover
    // from a prior open). Do NOT clobber; record that we don't own it so close
    // leaves it alone.
    ownedWs = null;
    return;
  }
  // SURVIVAL-SAFE: maximizeGroup overlays the group in place. No iframe is
  // reparented/moved/removed → no reload. This is the SAME primitive manual
  // zoom (toggleZoom) uses; proven survival-safe by the maximize+restore gate.
  a.maximizeGroup(active);
  ownedWs = ws;
}

/** Exit the maximize focus-mode owns (if still maximized). Never touches a
 *  user-manual maximize (ownedWs === null in that case). */
function exitOwned(): void {
  const ws = ownedWs;
  ownedWs = null;
  if (!ws) return;
  const a = workspaceApiFor(ws);
  if (a && a.hasMaximizedGroup()) a.exitMaximizedGroup();
}

// ---- real keyboard detection (the on-device path) --------------------------

function scheduleDetection(): void {
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined;
    const now = keyboardDetected();
    if (now && !keyboardOpen) {
      const vv = window.visualViewport;
      applyOpen(vv ? vv.height : window.innerHeight);
    } else if (!now && keyboardOpen) {
      applyClose();
    }
  }, DEBOUNCE_MS);
}

/**
 * Install the keyboard focus-mode. Wires the host's visualViewport listener
 * (the on-device detection path, gated on touch-capability) and the DEV bridge
 * (always available in DEV so the headless mechanism-proof runs on every
 * engine — Firefox does not report maxTouchPoints under hasTouch, so the
 * listener gate cannot also gate the test surface). No-op in non-browser
 * environments. Idempotent.
 *
 * @param appEl accessor for the host root element (the `.app` container in
 *   App.tsx) whose inline height is overridden on keyboard-open so the focused
 *   pane's iframe element shrinks to the visible area.
 */
export function installKeyboardFocus(appEl: () => HTMLElement | null): void {
  if (installed) return;
  if (typeof window === "undefined" || !window.visualViewport) return;
  installed = true;
  getAppEl = appEl;
  // The DEV bridge is always installed in DEV (independent of the touch gate)
  // so the headless e2e mechanism-proof runs on engines that don't emulate
  // touch (Firefox). The touch gate below controls only the REAL on-device
  // listener — the production detection path.
  installDevBridge();
  if (!isTouchCapable()) return; // desktop: no soft keyboard → no real listener
  vvListener = scheduleDetection;
  window.visualViewport.addEventListener("resize", vvListener);
  window.visualViewport.addEventListener("scroll", vvListener);
}

/** Tear down the listener + DEV bridge and restore any open keyboard state.
 *  Used on hot-reload / unmount so the root is never left shrunk. */
export function uninstallKeyboardFocus(): void {
  if (!installed) return;
  installed = false;
  if (vvListener && window.visualViewport) {
    window.visualViewport.removeEventListener("resize", vvListener);
    window.visualViewport.removeEventListener("scroll", vvListener);
  }
  vvListener = null;
  getAppEl = null;
  if (debounceTimer !== undefined) {
    window.clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
  // Restore on teardown so a hot-reload or unmount never leaves the root
  // shrunk or a stale maximize owned.
  if (keyboardOpen) applyClose();
  removeDevBridge();
}

/**
 * Notify focus-mode that the active workspace changed. Called by App.tsx's
 * reactive effect on activeWorkspaceId(). While the keyboard is open, focus-
 * mode re-points at the new active pane: exit the previously-owned ws's
 * maximize (we own it) and maximize the newly-active ws's focused pane (if the
 * user hasn't already). No-op when the keyboard is closed (the user's manual
 * maximizes are never touched). Edge case, kept simple.
 */
export function onWorkspaceActivated(): void {
  if (!keyboardOpen) return;
  exitOwned();
  maximizeActive();
}

// ---- DEV bridge (window.__hostKbdFocus) ------------------------------------
// Drives the keyboard focus-mode programmatically for deterministic headless
// e2e. The real soft-keyboard OUTCOME is not-demonstrable headlessly (no engine
// can open a keyboard); these hooks prove the MECHANISM (root resize +
// maximize + restore + identity-survival) without depending on the debounce or
// a real keyboard. Gated behind import.meta.env.DEV (same as window.__host) so
// production builds never expose the surface (Vite dead-code-eliminates it).

interface KbdFocusDevBridge {
  /** Current keyboard-open state (focus-mode's view). */
  isOpen(): boolean;
  /** Workspace id whose maximize focus-mode owns (null = user-owned / none). */
  ownedWs(): string | null;
  /** Simulate keyboard-open at a given visible height (px). Bypasses the gate
   *  + heuristic so the mechanism is provable headlessly. Idempotent. */
  open(visibleHeight: number): void;
  /** Simulate keyboard-close. Restores the root + exits the owned maximize. */
  close(): void;
  /** Force the REAL detection path to run now (used by the e2e to prove the
   *  heuristic + debounce fire after a visualViewport height change). */
  flushDetection(): void;
}

const DEV_BRIDGE_KEY = "__hostKbdFocus";

function installDevBridge(): void {
  if (!import.meta.env.DEV) return;
  const bridge: KbdFocusDevBridge = {
    isOpen: () => keyboardOpen,
    ownedWs: () => ownedWs,
    open: (visibleHeight: number) => {
      if (keyboardOpen) return;
      applyOpen(visibleHeight);
    },
    close: () => {
      if (!keyboardOpen) return;
      applyClose();
    },
    flushDetection: () => {
      if (debounceTimer !== undefined) {
        window.clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      const now = keyboardDetected();
      if (now && !keyboardOpen) {
        const vv = window.visualViewport;
        applyOpen(vv ? vv.height : window.innerHeight);
      } else if (!now && keyboardOpen) {
        applyClose();
      }
    },
  };
  (window as unknown as Record<string, unknown>)[DEV_BRIDGE_KEY] = bridge;
}

function removeDevBridge(): void {
  if (!import.meta.env.DEV) return;
  delete (window as unknown as Record<string, unknown>)[DEV_BRIDGE_KEY];
}

import type { DockviewApi } from "dockview-core";
import {
  activeWorkspaceId,
  configuredOriginFor,
  lookupContentWindow,
  workspaceApiFor,
} from "./dockview/store";

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
/** Captured inline transform to restore on close ("" = no prior inline
 *  override). The transform pins the root's TOP to visualViewport.offsetTop
 *  during keyboard-open (see applyGeometry) so the root occupies the visible
 *  band, not just the right height at the wrong position; this restores the
 *  pre-open transform exactly on close. */
let savedTransform = "";
/** Whether savedHeight/savedTransform have been captured this open cycle. MUST
 *  be a distinct flag (not ""-as-sentinel): the pre-open inline height/transform
 *  are genuinely "" (the CSS defaults), so a `=== ""` guard would re-capture the
 *  OVERRIDDEN values on the continuous re-apply calls and restore would write
 *  them back instead of clearing. */
let geometryCaptured = false;

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

/** Apply the keyboard-open state: pin the host root to the visible rect (height
 *  + top-offset) and maximize the active pane's group (if we don't already own
 *  / the user hasn't manually maximized). */
function applyOpen(height: number, offsetTop: number): void {
  keyboardOpen = true;
  applyGeometry(height, offsetTop);
  maximizeActive();
  // Tell the embedded SPA focus-mode is active so it suppresses its triple-tap
  // layout gesture while the operator is typing. See web/src/hostGesture.ts for
  // why the SPA cannot infer this from its own visualViewport (the host shrinks
  // the iframe element, so the iframe's own vv/innerHeight ratio stays ~1.0).
  postHostMode("keyboard-focus");
}

/** Apply the keyboard-close state: restore the host root (height + transform)
 *  and exit the maximize we own (never the one the user manually entered). */
function applyClose(): void {
  keyboardOpen = false;
  restoreGeometry();
  exitOwned();
  postHostMode("normal");
}

/** Post the host-mode signal to the ACTIVE workspace's active pane. Targeted at
 *  the pane's configured origin (never '*'); no-op when there is no active pane
 *  or its origin/contentWindow is unbound (e.g. a freshly-created workspace). */
function postHostMode(mode: "keyboard-focus" | "normal"): void {
  const api = workspaceApiFor(activeWorkspaceId());
  const paneId = api?.activePanel?.id;
  if (!paneId) return;
  const cw = lookupContentWindow(paneId);
  const origin = configuredOriginFor(paneId);
  if (!cw || !origin) return;
  try {
    cw.postMessage({ type: "host-mode", mode }, origin);
  } catch {
    /* pane gone — ignore */
  }
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

/** Pin the host root to the visible rect: height = visible height, top glued to
 *  visualViewport.offsetTop.
 *
 *  WHY (the bug this fixes). When the soft keyboard opens and the browser
 *  scrolls the layout viewport to reveal the caret in the cross-origin iframe,
 *  visualViewport.offsetTop becomes nonzero — the visible band, in the root's
 *  (layout-viewport) coordinate space, shifts from [0,H] to [offsetTop,
 *  offsetTop+H]. The host root had the right SIZE (height=H) but the wrong
 *  POSITION (still at layout-y 0), so its top scrolled off-screen above the
 *  visual viewport and a body-background band opened below it (operator report,
 *  captured while the now-removed bottom statusbar existed: "app shifts above
 *  the viewport, the bottom bar floats mid-screen, black band below"). Pinning
 *  the root's top to offsetTop makes it occupy exactly the visible band.
 *
 *  MECHANISM CHOICE (transform, not position/top/fixed). transform: translateY
 *  is GPU-cheap (composite-only, no layout, no repaint) and shifts the WHOLE
 *  app — including Dockview's maximize overlay and any fixed/absolute
 *  descendants — uniformly to the visible rect, so nothing is left behind at
 *  layout-y 0. A transform on `.app` does become the containing block for fixed
 *  descendants, but `.app` is itself the visible-rect-sized band, so an
 *  inset:0 fixed child still fills it equivalently. position:fixed/top:offsetTop
 *  was rejected: mobile fixed positioning is relative to the layout viewport
 *  with engine-specific caret-scroll interaction, less predictable than an
 *  explicit document-space translate. The host root has overflow:hidden +
 *  height:100vh, so window.scrollY stays 0 and offsetTop IS the full
 *  visible-rect offset; pageTop (the scrollY-robust generalization) is
 *  equivalent here — switch to pageTop if a future host layout ever allows
 *  document scroll. Horizontal offset (offsetLeft) and pinch-scale are
 *  non-issues for this app (portrait, no user-zoom) and intentionally ignored. */
function applyGeometry(height: number, offsetTop: number): void {
  const el = getAppEl?.();
  if (!el) return;
  // Capture the current inline height + transform ONCE per open cycle (the flag
  // is distinct from the captured values, which are genuinely "" pre-open), then
  // pin to the visible rect. The root's CSS is height:100vh + transform:none;
  // inline pixel values win and propagate via the flex column to the Dockview
  // container, whose ResizeObserver recomputes the maximized overlay's geometry.
  if (!geometryCaptured) {
    savedHeight = el.style.height;
    savedTransform = el.style.transform;
    geometryCaptured = true;
  }
  el.style.height = `${Math.round(height)}px`;
  el.style.transform = `translateY(${Math.round(offsetTop)}px)`;
}

/** Restore the pre-open inline height + transform exactly ("" clears the inline
 *  override → CSS defaults win: height:100vh, transform:none). */
function restoreGeometry(): void {
  const el = getAppEl?.();
  if (!el) return;
  el.style.height = savedHeight;
  el.style.transform = savedTransform;
  savedHeight = "";
  savedTransform = "";
  geometryCaptured = false;
}

/** Continuous re-apply: re-pin the root to the CURRENT visible rect on every
 *  resize AND scroll while the keyboard is open. The browser can re-scroll on
 *  caret moves mid-typing (offsetTop changes); a single application at
 *  keyboard-open is NOT enough. Immediate (no debounce) so the root tracks the
 *  visible rect every event; the debounced detection gates only the open↔close
 *  TRANSITION, not the geometry. */
function reapplyGeometryIfOpen(): void {
  if (!keyboardOpen) return;
  const vv = window.visualViewport;
  if (!vv) return;
  applyGeometry(vv.height, vv.offsetTop);
}

/** visualViewport event entry (fires on resize OR scroll): (1) immediately
 *  re-pin the root to the current visible rect while the keyboard is open
 *  (continuous offset compensation — the browser can re-scroll on caret moves
 *  mid-typing), then (2) schedule the debounced open↔close detection. Both
 *  resize and scroll route here: resize = visible HEIGHT changed (keyboard
 *  open/close animation); scroll = visible OFFSET changed (caret-reveal
 *  re-scroll mid-typing). */
function onVvEvent(): void {
  reapplyGeometryIfOpen();
  scheduleDetection();
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
      applyOpen(vv ? vv.height : window.innerHeight, vv ? vv.offsetTop : 0);
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
  // resize AND scroll both route through onVvEvent (see its doc): resize covers
  // the keyboard open/close HEIGHT animation; scroll covers the caret-reveal
  // OFFSET re-scroll mid-typing. Both re-pin the root continuously while open.
  vvListener = onVvEvent;
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
   *  + heuristic so the mechanism is provable headlessly. The host root is
   *  pinned to the visible rect: height = visibleHeight, transform.top =
   *  visualViewport.offsetTop (0 unless a test mocks vv.offsetTop, so the
   *  offset-compensation path is exercisable headlessly). Idempotent. */
  open(visibleHeight: number): void;
  /** Simulate keyboard-close. Restores the root + exits the owned maximize. */
  close(): void;
  /** Force the REAL detection path to run now (used by the e2e to prove the
   *  heuristic + debounce fire after a visualViewport height change). */
  flushDetection(): void;
  /** Force the continuous re-apply path to run now (re-pin the root to the
   *  current visualViewport height + offsetTop). Used by the e2e to prove the
   *  offset-compensation MATH headlessly on engines whose synthetic
   *  visualViewport event dispatch does not reach addEventListener listeners
   *  (firefox): the production onVvEvent wiring is proven separately on
   *  chromium, where synthetic events DO fire the listeners. No-op when the
   *  keyboard is closed. */
  reapplyGeometry(): void;
}

const DEV_BRIDGE_KEY = "__hostKbdFocus";

function installDevBridge(): void {
  if (!import.meta.env.DEV) return;
  const bridge: KbdFocusDevBridge = {
    isOpen: () => keyboardOpen,
    ownedWs: () => ownedWs,
    open: (visibleHeight: number) => {
      if (keyboardOpen) return;
      const vv = window.visualViewport;
      // Height from the arg (so a test pins the visible height without mocking
      // vv.height); offsetTop from the live vv (0 unless the test mocks it, so
      // the offset-compensation path is exercisable headlessly).
      applyOpen(visibleHeight, vv ? vv.offsetTop : 0);
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
        applyOpen(vv ? vv.height : window.innerHeight, vv ? vv.offsetTop : 0);
      } else if (!now && keyboardOpen) {
        applyClose();
      }
    },
    reapplyGeometry: () => {
      reapplyGeometryIfOpen();
    },
  };
  (window as unknown as Record<string, unknown>)[DEV_BRIDGE_KEY] = bridge;
}

function removeDevBridge(): void {
  if (!import.meta.env.DEV) return;
  delete (window as unknown as Record<string, unknown>)[DEV_BRIDGE_KEY];
}

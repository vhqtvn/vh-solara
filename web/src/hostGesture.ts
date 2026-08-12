// Host gesture recognizer + pane-activate forward (embed-gated) for the
// production SPA.
//
// Two concerns share this module because they share the IDENTICAL security
// model + handshake-origin capture + closed `host-gesture` message kind:
//
// (A) GESTURE RECOGNIZER — replaces the dropped host-side Alt keyboard shortcuts
// (the host structurally CANNOT see keys/taps inside a cross-origin iframe, so
// Alt-hotkeys never fired when a pane had focus). The operator performs a
// gesture INSIDE the embedded SPA, and the SPA forwards ONE closed postMessage
// intent to the host, which opens its layout overlay anchored to the source
// pane. Two recognizers, ONE outbound gesture value:
//   - DESKTOP: double bare-Ctrl (two presses of the Control key alone, no other
//     key, within DOUBLE_CTRL_WINDOW_MS). Deliberately NOT Ctrl+something — a
//     bare-Ctrl double-press is a discrete gesture that does not collide with
//     any browser/spa shortcut (Ctrl+C, Ctrl+S, etc. all press a non-modifier
//     key, which RESETS the sequence, so copy/save never triggers the overlay).
//   - MOBILE: TWO recognizers, either of which opens the overlay (the operator
//     may naturally try either; both are cheap and the overlay is idempotent):
//     · triple-tap — three primary-pointer taps, each within TRIPLE_TAP_GAP_MS
//       of the previous and each within the (pointerType-keyed) movement
//       tolerance of the first. A non-primary pointerdown is IGNORED (not a
//       hard reset): real touch routinely brushes a palm/thumb edge as a brief
//       second pointer, and hard-cancelling on it rejected almost every real
//       triple-tap (operator report m0309).
//     · 3-finger-tap — three fingers down simultaneously within
//       THREE_FINGER_TAP_WINDOW_MS. The literal "3 fingers" interpretation and
//       the robust one (counts pointers, not positions/timing). Distinct from
//       every native gesture (single-tap, double-tap-zoom, long-press, scroll).
//     Both suppress while the host's soft-keyboard focus-mode is active (the
//     host tells us via {type:'host-mode'}).
//
// (B) PANE-ACTIVATE FORWARD — fixes the cross-origin activation gap. Phase 1
// removed the per-pane headers (operator's request) that were the only host-DOM
// click target wired to Dockview's native onDidActivePanelChange. Panes are now
// full-bleed cross-origin iframes with no host chrome; a tap inside a cross-
// origin iframe does NOT bubble to the host, so Dockview never sees the
// activation and the focus indicator + statusbar actions stay stuck on the
// stale pane (this blocks the operator on mobile entirely — there is no
// alternative path). The SPA forwards a `pane-activate` signal when it gains
// focus / receives a pointerdown; the host calls focusPane(sourcePaneId) →
// setActive() → onDidActivePanelChange → the focus indicator + statusbar target
// move. The SPA owns the signal because it has the events inside its focused
// document; the host structurally cannot see them (same cross-origin constraint
// that killed the Alt-hotkeys). Same pattern the gesture recognizer proved.
//
// SECURITY MODEL (mirrors heartbeat.ts / statusEmitter.ts / selectListener.ts
// EXACTLY — read those first):
//   - embed gate (`window.parent === window` → no-op standalone);
//   - inbound source-guard (`ev.source !== window.parent` → reject, BEFORE any
//     state mutation);
//   - captured-origin targeting for the OUTBOUND message (`hostOrigin` from the
//     inbound handshake MessageEvent.origin — NEVER a literal '*' and NEVER a
//     build-time config).
//
// OUTBOUND CONTRACT: exactly `{type:"host-gesture", gesture: GESTURE}` where
// GESTURE is `"layout-overlay-request"` (the gesture recognizer) or
// `"pane-activate"` (the activate forward). NO other fields (no pane/server/dir
// IDs, no direction, no coordinates, no raw events) — the host derives the
// source pane from event.source (the pane's bound contentWindow), NEVER trusting
// a sender-claimed id. This is the same source-binding the heartbeat/status
// bridges rely on. Both values reuse the ONE `host-gesture` message kind — the
// activate forward only widens the closed gesture enum by one value.
//
// HANDSHAKE ORIGIN CAPTURE (design choice, documented): this module installs its
// OWN inbound handshake listener to capture hostOrigin, mirroring heartbeat.ts
// and statusEmitter.ts (which each install their own). The three listeners are a
// known duplication; a future refactor could extract a shared `hostOrigin.ts`
// accessor, but touching the two load-bearing bridges is out of scope for this
// slice and risks their established unit tests. The host-mode listener (below)
// is COMBINED with the handshake listener so this module adds exactly ONE
// message listener total (handshake + host-mode on the same handler).

const DOUBLE_CTRL_WINDOW_MS = 450;
// Per-tap GAP (not total-from-first): each advancing tap must follow the
// previous within this window. Per-gap is the standard multi-tap model and
// tolerates real-touch imprecision better than a tight total window (3 real
// taps land in ~600-900ms total; a 600ms-from-first gate rejected them).
// TUNABLE on-device.
const TRIPLE_TAP_GAP_MS = 500;
// Movement tolerance measured from the FIRST tap's position (the "in place"
// requirement). Split by pointerType: real fingers drift 15-25px on landing +
// lift (and 3 separate landings drift more), so touch gets a generous gate;
// mouse/pen stay tight. Both TUNABLE on-device — the touch value was the #1
// suspect in operator report m0309 (the old single 12px gate rejected every
// real touch sequence).
const TRIPLE_TAP_MAX_MOVEMENT_PX = 12; // mouse / pen
const TRIPLE_TAP_MAX_MOVEMENT_TOUCH_PX = 30; // touch
// 3-finger-tap: three fingers down simultaneously within this window of the
// first of the three. Robust on real touch (counts pointers, not positions or
// per-tap timing). TUNABLE on-device.
const THREE_FINGER_TAP_WINDOW_MS = 300;

/** Outbound intent — a closed single-variant message. See file header. */
export interface HostGestureMessage {
  type: "host-gesture";
  gesture: "layout-overlay-request" | "pane-activate";
}

/**
 * Install the embed-gated gesture recognizer + pane-activate forward. Captures
 * the host origin from the inbound handshake (same listener shape as
 * heartbeat.ts), recognizes the desktop double-Ctrl + mobile triple-tap gestures
 * (posting `{type:"host-gesture", gesture:"layout-overlay-request"}`), and
 * forwards a `{type:"host-gesture", gesture:"pane-activate"}` signal when this
 * document gains focus / receives a pointerdown (the cross-origin activation
 * bridge). All three posts target the captured host origin (never '*').
 *
 * Gesture recognizer: idempotent-on-recognition (recognitions do not stack; a
 * second recognition simply posts again — the host re-anchors its overlay).
 *
 * Activate forward: forwards on EVERY focus / pointerdown (NO throttle). The
 * host idempotently no-ops when the source pane is already the focused pane, so
 * redundant forwards are harmless and keep the effective volume single-per-
 * activation. This handles every real case: a desktop click-into-pane fires
 * focus (and its pointerdown forwards again — the host dedupes); a mobile tap
 * fires pointerdown (focus may not fire); repeated taps in the same pane each
 * forward (host dedupes). A prior once-per-focus-session throttle (reset on
 * window.blur) was REMOVED — the cross-origin window.blur that reset it is not
 * reliably delivered on real touch, so a re-activated pane could stay throttled
 * and never notify the host (operator report m0317). The activate listener is
 * SEPARATE from the triple-tap pointerdown recognizer (it fires on every
 * pointerdown; the triple-tap recognizer independently counts — the host
 * dedupes the per-tap forwards). Taps on interactive elements STILL activate
 * the pane (tapping a button in pane X means pane X should be active); the
 * activate listener deliberately does NOT share the triple-tap recognizer's
 * interactive-element ignore list.
 *
 * No-op when standalone. Returns a disposer that removes the listeners (the
 * recognizer otherwise lives for the document lifetime; a reload re-runs this
 * module). Wire alongside startHeartbeat()/startStatusEmitter()/
 * startSelectListener() in index.tsx.
 */
export function startHostGesture(): (() => void) | undefined {
  if (typeof window === "undefined") return;
  // Constraint #1 (mirror heartbeat): embed gate. Do nothing standalone — the
  // common single-server case has no host to receive the gesture.
  if (window.parent === window) return;

  // Q2-A (mirror heartbeat): host origin captured from the inbound handshake
  // MessageEvent.origin — never a literal '*' and never build-time config.
  let hostOrigin: string | null = null;
  // Whether the host's soft-keyboard focus-mode is currently active (host tells
  // us via {type:'host-mode', mode:'keyboard-focus'|'normal'}). When active, the
  // triple-tap gesture is SUPPRESSED (the operator is typing — a stray triple-
  // tap on non-interactive SPA content should not yank the layout). The
  // double-Ctrl gesture is unaffected (a physical keyboard is attached; the
  // operator is not tripping over a soft keyboard). See file header for why the
  // SPA cannot reliably infer this from its own visualViewport.
  let keyboardFocusActive = false;

  const onMessage = (ev: MessageEvent): void => {
    const data = ev.data as { type?: string; mode?: string } | null;
    if (!data || typeof data !== "object") return;
    // F1 (mirror heartbeat): inbound source-guard, BEFORE any state mutation.
    // Only the actual parent window may establish the reply target / drive host
    // mode; an untrusted sibling pane that grabbed this window's WindowProxy
    // must not capture the attacker's origin or fake a keyboard-mode signal.
    if (ev.source !== window.parent) return;
    if (data.type === "vh-host-handshake") {
      hostOrigin = ev.origin;
    } else if (
      data.type === "host-mode" &&
      (data.mode === "keyboard-focus" || data.mode === "normal")
    ) {
      keyboardFocusActive = data.mode === "keyboard-focus";
    }
  };
  window.addEventListener("message", onMessage);

  // ---- outbound intent (ONE closed variant, idempotent-on-recognition) ------
  const postOverlayRequest = (): void => {
    // Hold off until the host has handshaked (origin captured). Keeps every
    // reply origin-bound (Q2-A). A gesture before the handshake lands is lost —
    // acceptable: the handshake is issued on iframe load and lands within ~1
    // event loop tick, long before a human can gesture.
    if (hostOrigin === null) return;
    const msg: HostGestureMessage = {
      type: "host-gesture",
      gesture: "layout-overlay-request",
    };
    try {
      // Q2-A: targeted to the captured host origin — never '*'.
      window.parent.postMessage(msg, hostOrigin);
    } catch {
      /* parent window gone — ignore */
    }
  };

  // ---- pane-activate forward (cross-origin activation bridge) ---------------
  // Phase 1 removed the per-pane headers that were the only host-DOM click
  // target wired to Dockview's onDidActivePanelChange. A tap inside a cross-
  // origin iframe does NOT bubble to the host, so Dockview never sees the
  // activation → the focus indicator + statusbar actions stay on the stale
  // pane. The SPA forwards a `pane-activate` signal on focus / pointerdown; the
  // host calls focusPane(sourcePaneId) → the indicator + statusbar move. Same
  // security model as the overlay request (captured origin, closed payload).
  //
  // NO THROTTLE: every focus / pointerdown forwards. The host IDEMPOTENTLY
  // no-ops when the source pane is already the focused pane (routeMessage's
  // focusedId()===paneId early return — zero mutation: no overlay dismiss, no
  // focusPane call), so redundant forwards are harmless. A prior once-per-focus-
  // session throttle (an `activatePosted` flag reset on window.blur) was REMOVED
  // (operator report m0317): the cross-origin window.blur that reset it is NOT
  // reliably delivered on real touch (notably Edge Android) when focus moves
  // between sibling iframes, so a pane previously activated could keep its flag
  // stuck → its next tap forwarded nothing → the host never re-activated it →
  // the focus indicator + statusbar stayed on the stale pane. Forwarding
  // unconditionally removes that failure surface; the host dedup keeps the
  // effective message volume single-per-activation. (A time-based debounce was
  // also considered and dropped: its reset/expire signal is no more reliable
  // cross-origin than window.blur, and it would re-introduce a suppression
  // window that can drop a genuine activation.)
  //
  // COEXISTENCE WITH TRIPLE-TAP: the activate listener is on `document`; the
  // triple-tap recognizer is on `window`. Both fire on the same pointerdown but
  // neither calls stopPropagation/preventDefault on the early taps, so they do
  // not conflict. Each pointerdown of a triple-tap sequence forwards one
  // activate (the host dedupes when the pane is already focused). Taps on
  // interactive elements STILL activate the pane (tapping a button in pane X
  // means pane X should be active); the activate listener deliberately does NOT
  // consult the triple-tap recognizer's interactive-element ignore list.
  const postActivate = (): void => {
    if (hostOrigin === null) return; // same handshake gate as the overlay request
    const msg: HostGestureMessage = {
      type: "host-gesture",
      gesture: "pane-activate",
    };
    try {
      // Q2-A: targeted to the captured host origin — never '*'.
      window.parent.postMessage(msg, hostOrigin);
    } catch {
      /* parent window gone — ignore */
    }
  };

  // window.focus fires when the iframe (this document) gains focus — the
  // desktop click-into-pane path. pointerdown on document is more reliable on
  // mobile (some engines fire focus unreliably on tap). Both forward
  // unconditionally; the host dedupes. No-op before the handshake captured the
  // host origin (postActivate gates on hostOrigin).
  const onFocusActivate = (): void => {
    postActivate();
  };
  const onPointerDownActivate = (): void => {
    postActivate();
  };
  window.addEventListener("focus", onFocusActivate);
  document.addEventListener("pointerdown", onPointerDownActivate, false);

  // ---- desktop gesture: double bare-Ctrl ------------------------------------
  // Count non-repeated keydown events where event.key === "Control"; two within
  // DOUBLE_CTRL_WINDOW_MS → recognized. NO preventDefault/stopPropagation (the
  // gesture must never disturb typing, IME, or browser shortcuts). Any
  // intervening NON-modifier key resets the sequence (so Ctrl+C, Ctrl+S, etc.
  // never trigger — the letter key resets). Modifier keys (Shift/Alt/Meta)
  // between twoCtrls do NOT reset (they are inert for this recognizer). IME
  // composition active → reset.
  let lastCtrlAt = 0;
  const onKeyDown = (ev: KeyboardEvent): void => {
    // IME composition active → reset (a composing key is not a discrete
    // keypress the gesture should chain on). keyCode 229 is the legacy
    // composition sentinel; isComposing is the modern signal.
    if (ev.isComposing || ev.keyCode === 229) {
      lastCtrlAt = 0;
      return;
    }
    if (ev.key === "Control") {
      if (ev.repeat) return; // an auto-repeated Control does not advance
      const now = Date.now();
      if (lastCtrlAt > 0 && now - lastCtrlAt <= DOUBLE_CTRL_WINDOW_MS) {
        // Recognized: a second bare-Ctrl within the window. Reset BEFORE posting
        // so a held/rapid sequence cannot stack recognitions.
        lastCtrlAt = 0;
        postOverlayRequest();
      } else {
        // First press (or a press outside the window) — start/extend the chain.
        lastCtrlAt = now;
      }
      return;
    }
    // A modifier key (Shift/Alt/Meta) is inert here — it neither advances nor
    // resets the bare-Ctrl chain (only a bare Control advances; only a non-
    // modifier resets). This keeps a Ctrl modifier-chord from spuriously
    // resetting a pending double-Ctrl.
    if (ev.key === "Shift" || ev.key === "Alt" || ev.key === "Meta") return;
    // Any other (non-modifier) key resets the chain. This is what makes Ctrl+C,
    // Ctrl+S, arrow keys, etc. NOT trigger the overlay: the intervening letter
    // / arrow / etc. clears lastCtrlAt before a second bare-Ctrl can chain.
    lastCtrlAt = 0;
  };
  window.addEventListener("keydown", onKeyDown, false);

  // ---- mobile gesture: triple-tap (sequential, single-finger) ---------------
  // Three primary-pointer taps, each within TRIPLE_TAP_GAP_MS of the previous
  // and each within the movement tolerance of the FIRST tap. Rules: a non-
  // primary pointerdown is IGNORED (not a hard reset — real touch routinely
  // registers an incidental palm/thumb edge as a brief second pointer, and
  // hard-cancelling on it rejected almost every real triple-tap; genuine
  // multi-finger intent is handled by the dedicated 3-finger-tap recognizer
  // below); taps originating on interactive elements are ignored; a non-
  // collapsed text selection cancels; suppressed while keyboard-focus-mode is
  // active. preventDefault ONLY on the 3rd completed tap (so the 1st/2nd taps
  // keep their normal behavior — selection, scroll, click). Movement tolerance
  // is pointerType-keyed (touch drifts far more than mouse).
  let tapCount = 0;
  let firstTap: { x: number; y: number } | null = null; // position anchor (set on tap 1)
  let lastTapAt = 0; // time of the last advancing tap (per-gap timing)

  const resetTaps = (): void => {
    tapCount = 0;
    firstTap = null;
    lastTapAt = 0;
  };
  const onPointerDown = (ev: PointerEvent): void => {
    // Multi-touch: a non-primary pointerdown is IGNORED (does not reset). Real
    // touch routinely brushes a palm/thumb edge as a brief second pointer;
    // hard-resetting on it (the old behavior) rejected almost every real
    // triple-tap. The primary pointer keeps its own count; genuine multi-finger
    // intent is the 3-finger-tap recognizer's job. (This also keeps a 3-finger-
    // tap's non-primary fingers from disturbing a concurrent primary sequence.)
    if (!ev.isPrimary) return;
    // Suppress while the host's soft-keyboard focus-mode is active. NOTE: do NOT
    // reset the sequence here — just ignore this tap. (keyboardFocusActive is a
    // coarse mode; a tap arriving during it should neither count nor seed.)
    if (keyboardFocusActive) return;
    // Ignore taps that originate on an interactive element (the operator is
    // aiming at a button/link/input, not gesturing). Reset so a button tap does
    // not seed a later triple-tap.
    if (isInteractiveTarget(ev.target)) {
      resetTaps();
      return;
    }
    // Ignore while a non-collapsed text selection exists (the operator may be
    // tap-dragging to select; a triple-tap-on-selection would be surprising).
    if (hasNonCollapsedSelection()) {
      resetTaps();
      return;
    }
    const now = Date.now();
    const x = ev.clientX;
    const y = ev.clientY;
    // Touch pointers drift far more than mouse (a real finger landing + lift
    // moves 15-25px; 3 separate landings drift more). Use a generous tolerance
    // for touch, keep the tight one for mouse/pen.
    const tolerance = ev.pointerType === "touch"
      ? TRIPLE_TAP_MAX_MOVEMENT_TOUCH_PX
      : TRIPLE_TAP_MAX_MOVEMENT_PX;
    if (
      !firstTap ||
      now - lastTapAt > TRIPLE_TAP_GAP_MS ||
      Math.hypot(x - firstTap.x, y - firstTap.y) > tolerance
    ) {
      // Start a new sequence with this tap as the first.
      firstTap = { x, y };
      tapCount = 1;
      lastTapAt = now;
      return;
    }
    tapCount += 1;
    lastTapAt = now;
    if (tapCount >= 3) {
      // Third completed tap: preventDefault ONLY here (keeps the 1st/2nd taps'
      // native behavior intact). This prevents the 3rd tap from e.g. placing
      // the caret / starting a selection right as the overlay opens.
      ev.preventDefault();
      resetTaps();
      postOverlayRequest();
    }
  };
  window.addEventListener("pointerdown", onPointerDown, false);

  // ---- mobile gesture: 3-finger-tap (robust alternative; literal "3 fingers")
  // ----
  // Three fingers down simultaneously within THREE_FINGER_TAP_WINDOW_MS of the
  // first of the three. DISTINGUISHES from sequential triple-tap (1 finger, 3
  // times), single-tap, double-tap-zoom, long-press, and scroll (all are <3
  // simultaneous pointers), so it does not collide with any native gesture.
  // ROBUST on real touch: no per-tap timing fragility, no movement/drift
  // tolerance (counts pointers, not positions). The operator's report ("3
  // fingers still doesn't work") may literally mean a 3-finger-tap; shipped
  // ALONGSIDE the relaxed sequential triple-tap so the operator can pick what
  // feels right on-device. Fires on the 3rd pointerdown (before movement), so a
  // 3-finger SWIPE would false-fire — accepted for v1 (3-finger swipe is rare
  // in this app; the overlay is cheap to dismiss); flag for on-device tuning.
  //
  // Touch-only: a mouse cannot have 3 simultaneous pointers, and gating on
  // pointerType==="touch" keeps this recognizer's active-pointer Set out of the
  // sequential recognizer's mouse/default-pointerType tests. Suppressed while
  // keyboard-focus-mode is active (same as triple-tap). Does NOT consult the
  // interactive-element or selection filters — 3 simultaneous fingers is
  // unambiguous layout intent, not an aim at a control or a selection gesture.
  const activePointers = new Set<number>();
  let threeFingerStartAt = 0;
  // Suppress re-fire until all pointers lift (so a 4th/5th finger in the same
  // contact, or accumulated primary taps across repeated 3-finger gestures,
  // cannot stack recognitions).
  let threeFingerArmed = false;

  const onDownThreeFinger = (ev: PointerEvent): void => {
    if (ev.pointerType !== "touch") return; // mouse/pen: no 3-finger concept
    if (keyboardFocusActive) return;
    activePointers.add(ev.pointerId);
    if (activePointers.size === 1) {
      threeFingerStartAt = Date.now();
      threeFingerArmed = true;
    }
    if (
      threeFingerArmed &&
      activePointers.size >= 3 &&
      Date.now() - threeFingerStartAt <= THREE_FINGER_TAP_WINDOW_MS
    ) {
      // Fire on the pointerdown that brings the simultaneous count to 3.
      ev.preventDefault();
      threeFingerArmed = false; // suppress until all pointers lift
      resetTaps(); // keep the sequential recognizer from accumulating the
      // primary finger across repeated 3-finger gestures and double-firing.
      postOverlayRequest();
    }
  };
  const onUpThreeFinger = (ev: PointerEvent): void => {
    activePointers.delete(ev.pointerId);
    if (activePointers.size === 0) {
      threeFingerArmed = false;
      threeFingerStartAt = 0;
    }
  };
  window.addEventListener("pointerdown", onDownThreeFinger, false);
  window.addEventListener("pointerup", onUpThreeFinger, false);
  window.addEventListener("pointercancel", onUpThreeFinger, false);

  return () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("keydown", onKeyDown, false);
    window.removeEventListener("pointerdown", onPointerDown, false);
    window.removeEventListener("pointerdown", onDownThreeFinger, false);
    window.removeEventListener("pointerup", onUpThreeFinger, false);
    window.removeEventListener("pointercancel", onUpThreeFinger, false);
    window.removeEventListener("focus", onFocusActivate);
    document.removeEventListener("pointerdown", onPointerDownActivate, false);
  };
}

/**
 * True iff `target` is (or is inside) an interactive element whose tap should
 * NOT seed a triple-tap sequence. Covers form controls, links, buttons,
 * contenteditable, and the common ARIA interactive roles + anything with a
 * non-negative tabindex (a focusable element the operator is aiming at, not
 * gesturing past). tabindex="-1" is EXCLUDED: it marks programmatic-focus
 * containers (scroll containers, QuestionCard/PermissionCard/MermaidViewer)
 * that are NOT operator-aimed controls — a triple-tap on one must still seed.
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const sel =
    'a,button,input,textarea,select,[contenteditable=""],[contenteditable="true"],' +
    '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],' +
    '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],' +
    '[role="switch"],[role="treeitem"],[tabindex]:not([tabindex="-1"])';
  return !!target.closest(sel);
}

/**
 * True iff the window has a non-collapsed text selection (a real highlighted
 * range). A collapsed selection (caret only) does NOT count — the operator is
 * just focused, not selecting. Guarded for environments without getSelection.
 */
function hasNonCollapsedSelection(): boolean {
  const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
  if (!sel || sel.rangeCount === 0) return false;
  // isCollapsed true = caret only (no highlighted text); a real selection has
  // isCollapsed false OR a non-empty string.
  return !sel.isCollapsed || sel.toString().length > 0;
}

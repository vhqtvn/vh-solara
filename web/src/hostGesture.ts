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
//   - MOBILE: triple-tap (three primary-pointer taps within a short window,
//     each near the first). Suppresses while the host's soft-keyboard focus-
//     mode is active (the host tells us via {type:'host-mode'}).
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
const TRIPLE_TAP_WINDOW_MS = 600;
const TRIPLE_TAP_MAX_MOVEMENT_PX = 12;

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
 * Activate forward: throttled to ONCE PER FOCUS SESSION (prompt option (a):
 * "post at most once per focus session"). A `window.focus` or
 * `document.pointerdown` posts at most one activate until `window.blur` resets
 * the session (focus lost + regained posts again). This handles every real
 * case: a desktop click-into-pane fires focus (then its pointerdown is a
 * no-op); a mobile tap fires pointerdown (focus may not fire); repeated taps in
 * the same pane stay at one post; tapping another pane blurs this document
 * (reset) and focuses that one (its own session). The host no-ops when the
 * source pane is already active, so residual duplicate posts are harmless. The
 * activate listener is SEPARATE from the triple-tap pointerdown recognizer (it
 * fires on the first pointerdown of a sequence; the triple-tap recognizer
 * independently counts — no double-count). Taps on interactive elements STILL
 * activate the pane (tapping a button in pane X means pane X should be active);
 * the activate listener deliberately does NOT share the triple-tap recognizer's
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
  // THROTTLE: once per FOCUS SESSION (prompt option (a)). `activatePosted` is
  // set on the first post and cleared on `window.blur` (focus lost). A regained
  // focus / new pointerdown after blur posts again. The host no-ops when the
  // source pane is already active, so residual duplicate posts are harmless;
  // the throttle governs message VOLUME, not correctness. (A time-based
  // debounce was considered and dropped: the session flag alone covers dual
  // focus+pointerdown triggers, cross-pane switches, and intra-pane taps, and a
  // debounce would over-suppress a genuine blur-then-refocus.)
  //
  // COEXISTENCE WITH TRIPLE-TAP: the activate listener is on `document`; the
  // triple-tap recognizer is on `window`. Both fire on the same pointerdown but
  // neither calls stopPropagation/preventDefault on the early taps, so they do
  // not conflict. The activate posts ONCE on the first pointerdown of a focus
  // session (subsequent taps in the session are no-ops) — it does not double-
  // count across a triple-tap sequence. Taps on interactive elements STILL
  // activate the pane (tapping a button in pane X means pane X should be
  // active); the activate listener deliberately does NOT consult the triple-tap
  // recognizer's interactive-element ignore list.
  let activatePosted = false; // has activate posted in the current focus session?

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

  /** Post at most one activate per focus session. Resets on window.blur. No-op
   *  before the handshake captured the host origin. */
  const maybePostActivate = (): void => {
    if (hostOrigin === null) return;
    if (activatePosted) return; // once per focus session
    activatePosted = true;
    postActivate();
  };

  // window.focus fires when the iframe (this document) gains focus — the
  // desktop click-into-pane path. pointerdown on document is more reliable on
  // mobile (some engines fire focus unreliably on tap). Both feed the same
  // throttled maybePostActivate so whichever fires first wins the session.
  const onFocusActivate = (): void => {
    maybePostActivate();
  };
  const onBlurActivate = (): void => {
    // Focus left this document → a future regain is a new session eligible to
    // post again. (window.blur fires when the operator taps another pane's
    // iframe — this document loses focus, that pane's document gains it.)
    activatePosted = false;
  };
  const onPointerDownActivate = (): void => {
    maybePostActivate();
  };
  window.addEventListener("focus", onFocusActivate);
  window.addEventListener("blur", onBlurActivate);
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

  // ---- mobile gesture: triple-tap -------------------------------------------
  // Three primary-pointer taps within TRIPLE_TAP_WINDOW_MS, each within
  // TRIPLE_TAP_MAX_MOVEMENT_PX of the first. Rules: primary pointer only; a
  // non-primary pointerdown (multi-touch) cancels; taps originating on
  // interactive elements (buttons/links/inputs/ARIA-interactive) are ignored;
  // a non-collapsed text selection cancels; suppressed while keyboard-focus-mode
  // is active. preventDefault ONLY on the 3rd completed tap (so the 1st/2nd
  // taps keep their normal behavior — selection, scroll, click).
  let tapCount = 0;
  let firstTap: { x: number; y: number; time: number } | null = null;

  const resetTaps = (): void => {
    tapCount = 0;
    firstTap = null;
  };
  const onPointerDown = (ev: PointerEvent): void => {
    // Multi-touch: a non-primary pointerdown cancels any in-flight sequence.
    // (The first primary pointer keeps its own count; a second finger is the
    // signal that this is not a deliberate triple-tap.)
    if (!ev.isPrimary) {
      resetTaps();
      return;
    }
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
    if (
      !firstTap ||
      now - firstTap.time > TRIPLE_TAP_WINDOW_MS ||
      Math.hypot(x - firstTap.x, y - firstTap.y) > TRIPLE_TAP_MAX_MOVEMENT_PX
    ) {
      // Start a new sequence with this tap as the first.
      firstTap = { x, y, time: now };
      tapCount = 1;
      return;
    }
    tapCount += 1;
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

  return () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("keydown", onKeyDown, false);
    window.removeEventListener("pointerdown", onPointerDown, false);
    window.removeEventListener("focus", onFocusActivate);
    window.removeEventListener("blur", onBlurActivate);
    document.removeEventListener("pointerdown", onPointerDownActivate, false);
  };
}

/**
 * True iff `target` is (or is inside) an interactive element whose tap should
 * NOT seed a triple-tap sequence. Covers form controls, links, buttons,
 * contenteditable, and the common ARIA interactive roles + anything with a
 * tabindex (a focusable element the operator is aiming at, not gesturing past).
 */
function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const sel =
    'a,button,input,textarea,select,[contenteditable=""],[contenteditable="true"],' +
    '[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],' +
    '[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],' +
    '[role="switch"],[role="treeitem"],[tabindex]';
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

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
//   - DESKTOP: triple COMPLETED bare-Ctrl (THREE full Control down→up cycles,
//     firing on the THIRD RELEASE). Each press must be isolated — no other key
//     down while Control is held, no other live modifier flag on the press
//     itself — and each release→next-keydown gap must be <= CTRL_TAP_GAP_MS
//     (a PER-GAP window, not a total deadline for the whole triple).
//     Deliberately NOT Ctrl+something — a bare-Ctrl triple is a discrete
//     gesture that does not collide with any browser/SPA shortcut (Ctrl+C,
//     Ctrl+S, etc. press a non-modifier key, which RESETS the sequence, so
//     copy/save never triggers the overlay). WHY release-qualified: a keydown
//     cannot prove a press is "bare" — a chord's letter keydown lands while
//     Control is still held, so a keydown-counting recognizer (the v1 double-
//     Ctrl, removed after the operator reported accidental abandon-repress
//     double presses firing the overlay) has already fired before the chord is
//     revealed. Qualifying a tap only at its keyup means any chord is
//     invalidated BEFORE the press can complete, and exactly TWO completed
//     presses can never fire. Other modifiers (Shift/Alt/Meta) between or
//     during presses now RESET the chain (v1 was deliberately inert toward
//     them — this tightening is intentional: a chain one stray Shift away from
//     completing is a false-fire waiting to happen). RESIDUAL RISKS (accepted,
//     documented): NO hold-duration threshold — a long isolated hold still
//     counts as one completed press; three abandoned bare presses within the
//     gaps still activate (no recognizer can distinguish intention from an
//     identical accepted sequence). See the recognizer section below for the
//     full state machine.
//   - MOBILE: 3-finger-tap (the ONLY mobile recognizer — the sequential
//     triple-tap recognizer was REMOVED: any 3 quick taps within 500ms
//     false-fired it during ordinary fast single-tap use; the operator
//     confirmed 3-finger-tap is the intended gesture). HARDENED with
//     lift-distance gating so a 3-finger SWIPE no longer false-fires (the v0
//     recognizer fired on the 3rd pointerDOWN, before it could tell a tap from
//     a swipe). Fires ONLY when all 3 touch pointers have LIFTED with each
//     finger still within THREE_FINGER_TAP_MAX_MOVEMENT_PX of its landing
//     position, within THREE_FINGER_TAP_WINDOW_MS of the first down:
//       - tap  = 3 down → 3 up, minimal per-finger movement → FIRE;
//       - swipe = 3 down → move → up (any finger beyond tolerance) → reset,
//         no fire.
//     Distinct from every native gesture (single-tap, double-tap-zoom,
//     long-press, scroll). Suppressed while the host's soft-keyboard focus-mode
//     is active (the host tells us via {type:'host-mode'}).
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

import { isEmbedded } from "./embedded";

// Desktop triple bare-Ctrl: the MAXIMUM gap from one qualifying Control
// RELEASE to the next Control keydown (inclusive, <=). A PER-GAP window, NOT a
// total deadline for the whole triple — a late press simply starts a fresh
// sequence. TUNABLE on-device if deliberate triples get rejected.
const CTRL_TAP_GAP_MS = 450;
// Desktop triple bare-Ctrl: completed isolated down→up cycles required,
// firing on the THIRD qualifying release. Three (not two) deterministically
// rejects the reported abandon-repress double-press accident while remaining
// one deliberate gesture. Paired with CTRL_TAP_GAP_MS above.
const CTRL_TAP_COUNT = 3;
// 3-finger-tap: all three fingers down + lifted within this window of the
// FIRST down (total first-down → last-up elapsed). Robust on real touch (counts
// pointers, not per-tap timing). TUNABLE on-device.
const THREE_FINGER_TAP_WINDOW_MS = 300;
// 3-finger-tap lift-distance gate: each finger may drift at most this far
// between its pointerDOWN and pointerUP/pointercancel position. A finger beyond
// this tolerance means the operator is SWIPING (scroll/navigation gestures move
// fingers 30px+), not tapping — the gesture resets and never fires. Real
// finger taps drift <10px; 15px leaves headroom for imprecise landings while
// still rejecting any deliberate swipe. TUNABLE on-device — if real taps get
// rejected on-device, raise toward 20-25; if swipes false-fire, lower toward 10.
const THREE_FINGER_TAP_MAX_MOVEMENT_PX = 15;

/** Outbound intent — a closed single-variant message. See file header. */
export interface HostGestureMessage {
  type: "host-gesture";
  gesture: "layout-overlay-request" | "pane-activate";
}

/**
 * Install the embed-gated gesture recognizer + pane-activate forward. Captures
 * the host origin from the inbound handshake (same listener shape as
 * heartbeat.ts), recognizes the desktop triple bare-Ctrl + mobile 3-finger-tap
 * gestures (posting `{type:"host-gesture", gesture:"layout-overlay-request"}`),
 * and forwards a `{type:"host-gesture", gesture:"pane-activate"}` signal when
 * this document gains focus / receives a pointerdown (the cross-origin
 * activation bridge). Both posts target the captured host origin (never '*').
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
 * SEPARATE from the 3-finger pointerdown recognizer (it fires on every
 * pointerdown; the 3-finger recognizer independently counts — the host dedupes
 * the per-tap forwards). Taps on interactive elements STILL activate the pane
 * (tapping a button in pane X means pane X should be active).
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
  if (!isEmbedded()) return;

  // Q2-A (mirror heartbeat): host origin captured from the inbound handshake
  // MessageEvent.origin — never a literal '*' and never build-time config.
  let hostOrigin: string | null = null;
  // Whether the host's soft-keyboard focus-mode is currently active (host tells
  // us via {type:'host-mode', mode:'keyboard-focus'|'normal'}). When active, the
  // 3-finger-tap gesture is SUPPRESSED (the operator is typing — a stray
  // multi-finger tap on non-interactive SPA content should not yank the
  // layout). The triple-Ctrl gesture is unaffected (a physical keyboard is
  // attached; the operator is not tripping over a soft keyboard). See file
  // header for why the SPA cannot reliably infer this from its own
  // visualViewport.
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
  // COEXISTENCE WITH THE 3-FINGER RECOGNIZER: the activate listener is on
  // `document`; the 3-finger recognizer is on `window`. Both fire on the same
  // pointerdown but neither calls stopPropagation/preventDefault on the downs,
  // so they do not conflict. Each pointerdown of a 3-finger tap forwards one
  // activate (the host dedupes when the pane is already focused).
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
  // mobile (some engines fire focus unreliably on tap). focusin covers the case
  // window.focus misses (focus moving between elements WITHIN an already-focused
  // window — e.g. clicking the composer in a pane whose window already had
  // focus). All three forward unconditionally; the host dedupes. No-op before
  // the handshake captured the host origin (postActivate gates on hostOrigin).
  //
  // CAPTURE PHASE (the reliability fix): the document pointerdown + focusin
  // listeners are registered in the CAPTURE phase (3rd arg `true`). An element-,
  // library- (SolidJS delegates `pointerdown` to document), or browser-level
  // handler that calls e.stopPropagation() on the BUBBLE path cannot block a
  // capture-phase listener — capture fires BEFORE any target/bubble handler, so
  // stopPropagation in the bubble phase is too late to suppress us. (Only an
  // EARLIER capture listener calling stopImmediatePropagation could, which is
  // not the reported pattern.) This closes an intermittent on-device failure:
  // "clicking the input text box sometimes failed to make the target pane
  // focus." In an already-focused pane, window.focus does not fire either, so a
  // bubble-phase pointerdown blocked by stopPropagation left NEITHER path
  // forwarding → the host never re-activated → the focus indicator stayed stuck
  // on the stale pane. window.focus is kept (not capture-able meaningfully — it
  // does not bubble) as belt-and-suspenders for window-level focus changes that
  // focusin may miss when focus returns to the document body.
  const onFocusActivate = (): void => {
    postActivate();
  };
  const onFocusInActivate = (): void => {
    postActivate();
  };
  const onPointerDownActivate = (): void => {
    postActivate();
  };
  window.addEventListener("focus", onFocusActivate);
  document.addEventListener("focusin", onFocusInActivate, true);
  document.addEventListener("pointerdown", onPointerDownActivate, true);

  // ---- desktop gesture: triple COMPLETED bare-Ctrl ----------------------------
  // THREE full Control down→up cycles, firing on the THIRD qualifying RELEASE
  // (CTRL_TAP_COUNT). A qualifying TAP is an ISOLATED press: no other key down
  // while Control is held, no other live modifier flag on the press itself,
  // and the release→next-keydown gap within CTRL_TAP_GAP_MS.
  //
  // WHY RELEASE-QUALIFIED: a keydown cannot prove a press is "bare" — in a
  // Ctrl+letter chord the letter's keydown lands while Control is still held,
  // so a keydown-counting recognizer has already fired before the chord is
  // revealed. Qualifying a tap only at its keyup means any chord is
  // invalidated BEFORE the press can complete (the letter resets the chain AND
  // abandons the pending press — its later Ctrl keyup finds nothing tracked
  // and is an orphan that counts nothing).
  //
  // Resets/invalidations (all clear the completed-tap count AND any pending
  // press):
  //   - ANY non-Control keydown — Shift/Alt/Meta INCLUDED. This is an
  //     INTENTIONAL TIGHTENING over the v1 double-Ctrl recognizer, which was
  //     deliberately inert toward other modifiers: a pending chain one stray
  //     Shift away from completing is a false-fire waiting to happen. Cost: a
  //     legitimate triple-Ctrl with an accidental modifier in between must be
  //     restarted.
  //   - IME composition (isComposing / legacy keyCode 229).
  //   - window blur (focus left this document mid-sequence — an abandoned
  //     chain must not complete on a later press).
  //   - A Control keydown carrying other live modifier flags (shiftKey/
  //     altKey/metaKey — e.g. Ctrl+Shift pressed as one chord, or Shift
  //     already held), and a Control KEYUP carrying them (modifier still held
  //     at lift ⇒ the press was not isolated).
  //   - A Control keydown while another Ctrl is already tracked (overlapping
  //     left+right Ctrl — not isolated taps; the reset also abandons the
  //     tracked press, so BOTH subsequent releases are orphans).
  //   - A release→keydown gap > CTRL_TAP_GAP_MS: the late press starts a
  //     FRESH sequence (the window is per-gap, not a whole-triple deadline).
  // ev.repeat keydowns neither advance nor reset (held-Control auto-repeat is
  // ignored). A Control keyup with no tracked qualifying down (orphan release)
  // is ignored — it neither counts nor resets.
  //
  // RESIDUAL RISKS (accepted, documented — see also the file header): NO
  // hold-duration threshold — a long isolated hold still counts as one
  // completed press (an unmeasured duration cap would trade one false-fire
  // class for another); three abandoned bare presses within the gaps still
  // activate. NO preventDefault/stopPropagation anywhere — the gesture must
  // never disturb typing, IME, or browser shortcuts.
  let ctrlTaps = 0; // completed qualifying taps in the current chain
  let lastCtrlReleaseAt = 0; // Date.now() of the last qualifying release (0 = none)
  let ctrlPressActive = false; // a qualifying Ctrl keydown is held awaiting its keyup

  const resetCtrlChain = (): void => {
    // Also abandons any pending press: its eventual keyup finds nothing
    // tracked and is ignored as an orphan (a chord's Ctrl release, an
    // overlap-abandoned press, etc. must never complete a tap).
    ctrlTaps = 0;
    lastCtrlReleaseAt = 0;
    ctrlPressActive = false;
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    // IME composition active → reset (a composing key is not a discrete
    // keypress the gesture should chain on). keyCode 229 is the legacy
    // composition sentinel; isComposing is the modern signal.
    if (ev.isComposing || ev.keyCode === 229) {
      resetCtrlChain();
      return;
    }
    if (ev.key === "Control") {
      if (ev.repeat) return; // auto-repeated Control: neither advances nor resets
      // A Ctrl press carrying other live modifier flags (Shift/Alt/Meta held
      // when Control goes down) is not a BARE press — reject and reset.
      if (ev.shiftKey || ev.altKey || ev.metaKey) {
        resetCtrlChain();
        return;
      }
      // Overlapping Ctrl (a second Control down before the first lift — e.g.
      // left+right): not isolated taps. Reset the chain and abandon the
      // tracked press; both subsequent releases are orphans.
      if (ctrlPressActive) {
        resetCtrlChain();
        return;
      }
      // Per-gap window: this keydown must land within CTRL_TAP_GAP_MS of the
      // last qualifying RELEASE. A late press starts a fresh sequence (this is
      // NOT a total deadline for the whole triple). A first press (no prior
      // release) has no gap constraint.
      if (lastCtrlReleaseAt > 0 && Date.now() - lastCtrlReleaseAt > CTRL_TAP_GAP_MS) {
        ctrlTaps = 0;
        lastCtrlReleaseAt = 0;
      }
      ctrlPressActive = true;
      return;
    }
    // Every OTHER key — non-modifiers AND Shift/Alt/Meta (the intentional
    // tightening documented above) — resets the chain and abandons any
    // pending press. This is what makes Ctrl+C, Ctrl+S, arrows, etc. never
    // trigger the overlay: the intervening key clears the chain before the
    // next bare-Ctrl can complete, and kills an in-flight press mid-chord.
    resetCtrlChain();
  };

  const onKeyUp = (ev: KeyboardEvent): void => {
    // Releases of other keys are irrelevant (resets happen on keydown).
    if (ev.key !== "Control") return;
    // An IME-composing release is not a discrete completed tap.
    if (ev.isComposing || ev.keyCode === 229) {
      resetCtrlChain();
      return;
    }
    // Orphan release: no tracked qualifying down (chord-killed, overlap-
    // abandoned, or simply unmatched). Ignored — neither counts nor resets.
    if (!ctrlPressActive) return;
    // Modifier flags live on the release itself (Shift/Alt/Meta still held at
    // lift): the press was not isolated — disqualify, do not count.
    if (ev.shiftKey || ev.altKey || ev.metaKey) {
      resetCtrlChain();
      return;
    }
    // A qualifying completed tap.
    ctrlPressActive = false;
    lastCtrlReleaseAt = Date.now();
    ctrlTaps++;
    if (ctrlTaps >= CTRL_TAP_COUNT) {
      // Reset BEFORE posting so a held/rapid sequence cannot stack
      // recognitions; the next activation needs a full fresh triple.
      ctrlTaps = 0;
      lastCtrlReleaseAt = 0;
      postOverlayRequest();
    }
  };
  window.addEventListener("keydown", onKeyDown, false);
  window.addEventListener("keyup", onKeyUp, false);
  // Focus left this document (operator switched panes/tabs mid-sequence): an
  // abandoned chain must not complete on a later press. Unlike the activate
  // forward's m0317 throttle story (where an UNRELIABLE blur stuck a pane),
  // here a missed blur only fails to drop a chain — the cost is one stale
  // triple, never a wedged pane — so blur is sound for the desktop chain.
  const onBlurGesture = (): void => {
    resetCtrlChain();
  };
  window.addEventListener("blur", onBlurGesture);

  // ---- mobile gesture: 3-finger-tap (the ONLY mobile recognizer) ------------
  // HARDENED with lift-distance gating (replaces both the removed sequential
  // triple-tap recognizer AND the v0 fire-on-3rd-pointerdown behavior, which
  // false-fired on 3-finger SWIPES). State machine:
  //   - pointerdown (touch): record the pointer's LANDING position. First touch
  //     of a gesture starts the window clock. When the simultaneous count
  //     reaches 3 within THREE_FINGER_TAP_WINDOW_MS, the gesture is armed; a
  //     4th pointer at ANY time hard-resets (unambiguous multi-finger intent
  //     that is not a 3-finger-tap), as does reaching 3 too slowly.
  //   - pointerup / pointercancel (touch): measure how far THAT finger moved
  //     from its landing position. Any finger beyond
  //     THREE_FINGER_TAP_MAX_MOVEMENT_PX → it was a swipe → reset, no fire.
  //     When the LAST finger lifts: armed + within the total window + every
  //     finger within tolerance → FIRE (postOverlayRequest). Otherwise reset.
  //   - A gesture that never reaches 3 simultaneous pointers (1-2 fingers)
  //     simply cannot arm → no fire on lift.
  // Firing on ALL-LIFTED (not on the 3rd pointerdown) is the crux: only at lift
  // time does the recognizer KNOW the fingers did not swipe. No preventDefault
  // is possible on the lift (the interaction is over; preventing pointerup's
  // default does not reliably suppress the already-fired compat click, and the
  // overlay opens ABOVE the iframe content anyway) — unlike the removed
  // sequential recognizer there is no 3rd-tap caret/selection side effect to
  // suppress mid-gesture.
  //
  // Touch-only: a mouse cannot have 3 simultaneous pointers, and gating on
  // pointerType==="touch" keeps this recognizer's active-pointer Map out of the
  // desktop paths. Suppressed while keyboard-focus-mode is active (same as the
  // removed triple-tap: a stray multi-finger tap while typing should not yank
  // the layout). Does NOT consult interactive-element or selection filters — 3
  // simultaneous fingers is unambiguous layout intent, not an aim at a control
  // or a selection gesture.
  const activePointers = new Map<number, { x: number; y: number }>();
  let threeFingerStartAt = 0; // time of the FIRST down of the current gesture
  let threeFingerArmed = false; // 3 simultaneous pointers seen within the window

  const resetThreeFinger = (): void => {
    activePointers.clear();
    threeFingerStartAt = 0;
    threeFingerArmed = false;
  };

  const onDownThreeFinger = (ev: PointerEvent): void => {
    if (ev.pointerType !== "touch") return; // mouse/pen: no 3-finger concept
    if (keyboardFocusActive) return; // suppressed while the soft keyboard owns focus
    if (activePointers.size === 0) threeFingerStartAt = Date.now();
    activePointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (activePointers.size > 3) {
      // A 4th pointer: unambiguously NOT a 3-finger-tap. Hard-reset so this
      // contact cluster can never fire (the matching lifts then delete from an
      // empty Map — harmless no-ops).
      resetThreeFinger();
      return;
    }
    if (activePointers.size === 3) {
      if (Date.now() - threeFingerStartAt <= THREE_FINGER_TAP_WINDOW_MS) {
        threeFingerArmed = true;
      } else {
        // The 3rd finger landed too slowly — not a simultaneous tap. Reset.
        resetThreeFinger();
      }
    }
  };

  const onUpThreeFinger = (ev: PointerEvent): void => {
    const start = activePointers.get(ev.pointerId);
    if (start === undefined) return; // not a tracked touch pointer (mouse up, or a post-reset lift)
    const moved = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
    activePointers.delete(ev.pointerId);
    if (moved > THREE_FINGER_TAP_MAX_MOVEMENT_PX) {
      // That finger swiped → the gesture was a swipe, not a tap. Reset so the
      // remaining lifts cannot fire.
      resetThreeFinger();
      return;
    }
    if (activePointers.size > 0) return; // fingers remain; decide on the last lift
    // Last finger lifted. Fire iff armed + the TOTAL first-down→last-up elapsed
    // fits the window (a slow, deliberate separation is not a simultaneous tap).
    const elapsed = Date.now() - threeFingerStartAt;
    const armed = threeFingerArmed;
    resetThreeFinger();
    if (armed && elapsed <= THREE_FINGER_TAP_WINDOW_MS) {
      postOverlayRequest();
    }
  };
  window.addEventListener("pointerdown", onDownThreeFinger, false);
  window.addEventListener("pointerup", onUpThreeFinger, false);
  window.addEventListener("pointercancel", onUpThreeFinger, false);

  return () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("keydown", onKeyDown, false);
    window.removeEventListener("keyup", onKeyUp, false);
    window.removeEventListener("blur", onBlurGesture);
    window.removeEventListener("pointerdown", onDownThreeFinger, false);
    window.removeEventListener("pointerup", onUpThreeFinger, false);
    window.removeEventListener("pointercancel", onUpThreeFinger, false);
    window.removeEventListener("focus", onFocusActivate);
    document.removeEventListener("focusin", onFocusInActivate, true);
    document.removeEventListener("pointerdown", onPointerDownActivate, true);
  };
}

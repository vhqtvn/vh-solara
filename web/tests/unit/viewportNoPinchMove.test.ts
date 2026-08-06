// @vitest-environment jsdom
//
// Characterization test for the `noPinchMove` pinch-zoom guard in
// src/viewport.ts (registered inside installViewport()).
//
// The guard blocks the browser pinch-zoom gesture at the TOUCH level: it is a
// `touchmove` listener on `document` (registered with { passive: false } so
// preventDefault takes effect) that calls `e.preventDefault()` IFF
// `e.touches.length >= 2`. The contract it pins has TWO sides, and each must
// hold or the app breaks in a user-visible way:
//
//   - BLOCK 2+-finger touchmove  -> the actual pinch gesture is cancelled so
//     visualViewport.height stays stable (a pinch would otherwise shrink it and
//     push the composer off the bottom; see the rationale comment in viewport.ts).
//   - PASS 1-finger touchmove     -> ordinary scrolling MUST NOT be cancelled,
//     or the whole page becomes unscrollable on touch devices.
//
// noPinchMove is a closure local to installViewport() (not exported), so the
// test exercises it through its real registration surface: call installViewport()
// once to attach it to `document`, then dispatch synthetic `touchmove` events
// and read `event.defaultPrevented` — the faithful DOM-observable outcome of
// preventDefault() having been called on a cancelable event. jsdom has no
// TouchEvent constructor, so the event is built as a plain cancelable Event and
// given a `touches` array via defineProperty (the guard only reads
// `.touches.length` and calls `.preventDefault()`).
import { describe, it, expect, beforeAll } from "vitest";
import { installViewport } from "../../src/viewport";

// Dispatch a cancelable `touchmove` on document with `touchCount` touches and
// report whether the listener cancelled it (defaultPrevented). This is the
// exact signal the browser would act on: a cancelled touchmove does not drive
// the pinch zoom.
function dispatchTouchmove(touchCount: number): boolean {
  const ev = new Event("touchmove", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "touches", {
    value: new Array(touchCount).fill({}),
    configurable: true,
  });
  document.dispatchEvent(ev);
  return ev.defaultPrevented;
}

describe("installViewport — noPinchMove guard", () => {
  // Attach the listener once. (Subsequent calls would stack listeners, but the
  // assertion logic is unaffected; a single attach is the cleanest model.)
  beforeAll(() => installViewport());

  it("cancels a 2-finger touchmove (the pinch gesture at the threshold)", () => {
    // Regression: if the guard stopped blocking pinch (e.g. `> 2` instead of
    // `>= 2`, or the listener was dropped), a 2-finger pinch would zoom the
    // page and this expectation would flip to false.
    expect(dispatchTouchmove(2)).toBe(true);
  });

  it("cancels 3+ finger touchmove (above the pinch threshold)", () => {
    expect(dispatchTouchmove(3)).toBe(true);
    expect(dispatchTouchmove(5)).toBe(true);
  });

  it("does NOT cancel a 1-finger touchmove (normal scrolling must pass through)", () => {
    // Regression: if the guard started blocking non-pinch (e.g. `>= 1`, or
    // unconditionally), ordinary one-finger scrolling would be cancelled and
    // the page would be unscrollable on touch devices — this expectation would
    // flip to true.
    expect(dispatchTouchmove(1)).toBe(false);
  });

  it("does NOT cancel a 0-touch touchmove", () => {
    // Edge case at the low boundary: touches.length === 0 must pass through.
    expect(dispatchTouchmove(0)).toBe(false);
  });
});

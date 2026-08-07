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
//
// jsdom ALSO does not enforce passive-listener semantics: it cannot tell a
// registration of { passive: false } apart from the default (passive), so the
// behavioral tests below (defaultPrevented) CANNOT detect a regression that
// silently drops { passive: false } — in jsdom preventDefault still "works"
// either way, while a real browser would ignore it on a passive listener and
// the pinch gesture would re-enable. A separate registration-contract test
// ("registers touchmove with { passive: false }") closes that gap by spying on
// document.addEventListener and pinning the options shape directly.
import { describe, it, expect, beforeAll, vi } from "vitest";
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

  it("registers touchmove with { passive: false } so preventDefault takes effect", () => {
    // REGISTRATION-CONTRACT coverage (not behavioral). jsdom ignores the
    // passive flag entirely, so the defaultPrevented-based tests above cannot
    // observe a regression that drops { passive: false } — yet in a real
    // browser that flag is exactly what lets noPinchMove's preventDefault()
    // cancel the pinch gesture (a passive listener's preventDefault is a
    // no-op there). Pin the registration shape directly: spy on
    // document.addEventListener around a fresh installViewport() call and
    // assert the touchmove registration carries passive === false. Asserting
    // only that field (via objectContaining) avoids brittle exact-object
    // equality if unrelated listener options are added later.
    //
    // The spy calls through to the real addEventListener (vi.spyOn default),
    // so installViewport()'s other wiring still attaches normally; we only
    // need the recorded calls. try/finally guarantees mockRestore even if an
    // assertion throws, so the spy never leaks into sibling tests.
    const spy = vi.spyOn(document, "addEventListener");
    try {
      installViewport();
      const touchmoveCall = spy.mock.calls.find(
        ([type]) => type === "touchmove",
      );
      expect(
        touchmoveCall,
        "installViewport must register a touchmove listener on document",
      ).toBeDefined();
      const options = touchmoveCall![2];
      expect(options).toEqual(expect.objectContaining({ passive: false }));
    } finally {
      spy.mockRestore();
    }
  });
});

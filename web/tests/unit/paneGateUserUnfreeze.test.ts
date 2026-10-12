// @vitest-environment jsdom
//
// INTEGRATION contract — 2026-10-12 recurrence on v1.77.3 (contains the
// self-healing gate ad3856c): the working-dots still freeze permanently in
// real usage ("animate for a while after page load, then pause permanently,
// no recovery").
//
// ROOT CAUSE under test: every heal path re-derives docVisible from
// `document.visibilityState` and treats it as ground truth. When the BROWSER
// ITSELF strands that state at "hidden" (the WebKit standalone-PWA
// lock/unlock failure class — the same posture the original freeze trace
// named), the visibilitychange listener, the focus/pageshow resyncs, AND the
// periodic interval each faithfully re-derive the lie forever: the heal
// cannot observe the reveal because its "ground truth" is the stuck part.
// This is invisible to the fake-timer unit lane (which drives resync
// directly and never models the browser lying).
//
// CONTRACT:
//   1. Stuck-hidden state + every existing heal (focus, periodic interval
//      firing for real while believed hidden) MAINTAINS the freeze — the
//      reproduction of the production posture.
//   2. A REAL user tap (trusted pointerdown) while the pane is believed
//      hidden is proof the operator is looking at this pane: it must
//      un-latch the gate (class OFF) and fire the paneVisible transition so
//      the sync facade heals through the same edge.
//   3. The override is NARROW: untrusted (synthetic) pointerdowns do nothing;
//      a genuine visibilitychange→hidden re-pauses (the perf gate survives);
//      the host's own visible:false still re-pauses (host truth wins).
//   4. While the stuck state is discredited by input, a later resync does
//      not re-freeze; a REAL visibilitychange re-trusts the state.
//
// Real wiring: startPaneVisibility() + installPaneAnimationGate() exactly as
// index.tsx wires them. REAL timers throughout (no vi.useFakeTimers) — the
// scheduler itself must fire while the pane is believed hidden; the interval
// cadence is accelerated via the test-only resyncMs option (behavior-neutral).
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  PANE_HIDDEN_CLASS,
  startPaneVisibility,
  installPaneAnimationGate,
  onPaneVisibilityChange,
  __resetPaneVisibilityForTest,
  __setHostVisibleForTest,
} from "../../src/paneVisibility";

const classOn = (): boolean => document.documentElement.classList.contains(PANE_HIDDEN_CLASS);

/** Force the document's visibilityState the way a real tab switch would be
 *  observed: instance-shadow getter + the real visibilitychange event. */
function setDocVisibility(v: "visible" | "hidden", opts?: { event?: boolean }): void {
  Object.defineProperty(document, "visibilityState", { get: () => v, configurable: true });
  if (opts?.event !== false) document.dispatchEvent(new Event("visibilitychange"));
}

/** The WebKit failure posture: the document is back in the foreground but
 *  the STATE stays "hidden" and NO further visibilitychange fires. Every
 *  "re-derive from live state" heal now re-derives the lie. */
function visibilityStateStuckHidden(): void {
  Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
}

/** A real user tap. `isTrusted` is LegacyUnforgeable — no engine lets a
 *  synthetic event claim it — so the gate is installed below with
 *  `testTrustAllInput` for the POSITIVE paths (everything downstream of the
 *  one-line trust check runs real); the trust check line itself is covered
 *  by the synthetic-tap negative test and by the lane-6 e2e's real click. */
function realTap(): void {
  document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
}

/** Synthetic (untrusted) pointerdown — what random page scripts can emit. */
function syntheticTap(): void {
  document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
}

/** Re-wire the real gate WITHOUT the test trust bypass (for the negative
 *  test that must observe the real isTrusted gate). */
function rewireStrictGate(): void {
  __resetPaneVisibilityForTest();
  startPaneVisibility();
  installPaneAnimationGate({ resyncMs: 250 });
}

/** The production freeze posture: load visible, first lock/app-switch hides
 *  for real, then the unlock never flips the state back. */
function enterStuckFrozenPosture(): void {
  setDocVisibility("hidden"); // the real lock: state + event
  expect(classOn(), "sanity: the real hide paused the gate").toBe(true);
  visibilityStateStuckHidden(); // the WebKit unlock failure: state never flips
}

beforeEach(() => {
  setDocVisibility("visible", { event: false });
  __resetPaneVisibilityForTest();
  startPaneVisibility();
  // testTrustAllInput: isTrusted is unforgeable, so the positive paths bypass
  // exactly the one-line trust check (covered separately: negative test here
  // without the bypass + the lane-6 e2e's real trusted click).
  installPaneAnimationGate({ resyncMs: 250, testTrustAllInput: true });
});

afterEach(() => {
  __resetPaneVisibilityForTest();
  setDocVisibility("visible", { event: false });
});

describe("stuck-visibilityState freeze (the v1.77.3 recurrence)", () => {
  it("reproduces the production posture: every existing heal maintains the freeze", async () => {
    enterStuckFrozenPosture();

    // Focus heal (the operator taps back in — window focus fires):
    window.dispatchEvent(new Event("focus"));
    expect(classOn(), "focus resync re-derives the stuck state → still frozen").toBe(true);

    // Pageshow heal (bfcache-restore class):
    window.dispatchEvent(new Event("pageshow"));
    expect(classOn(), "pageshow resync re-derives the stuck state → still frozen").toBe(true);

    // The periodic interval — REAL timer, firing while the pane is believed
    // hidden (the scheduler is NOT suspended; it still re-derives the lie):
    await new Promise((r) => setTimeout(r, 400));
    expect(classOn(), "periodic resync fired and re-derived the stuck state → still frozen").toBe(true);
  });

  it("a REAL user tap unfreezes the pane (input is proof the operator sees it)", () => {
    enterStuckFrozenPosture();
    const transitions: boolean[] = [];
    const unsub = onPaneVisibilityChange((v) => transitions.push(v));

    realTap();

    expect(classOn(), "trusted pointerdown un-latches the gate").toBe(false);
    expect(transitions, "the sync-side facade heals through the same edge").toContain(true);
    unsub();
  });

  it("synthetic pointerdowns do NOT unfreeze (untrusted input is not evidence)", () => {
    rewireStrictGate(); // real isTrusted gate, no bypass
    enterStuckFrozenPosture();
    syntheticTap();
    expect(classOn(), "untrusted pointerdown ignored").toBe(true);
  });

  it("a genuine re-hide re-pauses (the perf gate survives the override)", () => {
    enterStuckFrozenPosture();
    realTap();
    expect(classOn()).toBe(false);

    setDocVisibility("hidden"); // a REAL hide: state flips + event fires
    expect(classOn(), "genuine visibilitychange→hidden re-pauses").toBe(true);
  });

  it("the host's own visible:false still re-pauses after an input override", () => {
    enterStuckFrozenPosture();
    realTap();
    expect(classOn()).toBe(false);

    __setHostVisibleForTest(false); // host truthfully hides this pane
    expect(classOn(), "host-hidden wins over the input override").toBe(true);
  });

  it("a resync while the state is discredited stays visible; a real visibilitychange re-trusts it", async () => {
    enterStuckFrozenPosture();
    realTap();
    expect(classOn()).toBe(false);

    // The state is STILL stuck "hidden" here. A later heal (focus, or the
    // periodic interval) must not re-derive the discredited lie.
    window.dispatchEvent(new Event("focus"));
    expect(classOn(), "resync holds the input-derived visible").toBe(false);

    // A REAL visibilitychange event = the browser is talking again: re-trust
    // the state. A subsequent genuine hide must pause again.
    setDocVisibility("hidden");
    expect(classOn(), "real event re-trusts the state → genuine hide pauses").toBe(true);
  });
});

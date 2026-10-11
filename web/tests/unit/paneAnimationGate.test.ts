// @vitest-environment jsdom
//
// (2026-10-12 freeze trace) Self-healing animation gate.
//
// CONTRACT under test:
//   1. The .pane-hidden class (which pauses ALL CSS animations via
//      tokens.css `animation-play-state: paused !important`) must never stay
//      applied to a VISIBLE document. Its only resume writer used to be the
//      single `visibilitychange → visible` event; one lost event (iOS
//      standalone PWA lock/unlock, bfcache restore) stranded a visible pane
//      paused forever — notify()'s edge dedupe swallowed every later resync
//      (the host's ~10s vh-host-visibility included) because docVisible was
//      stale-hidden.
//   2. Heal triggers: pageshow, window focus, and the ~30s periodic resync
//      each RE-DERIVE docVisible from live document.visibilityState and
//      re-apply the class (see installPaneAnimationGate).
//   3. The heal is not class-only: resyncDocVisibility fires the
//      paneVisible transition when the cache was stale, so the sync facade
//      (suspend/resume listeners) heals through the same edge — the dedupe
//      no longer swallows healing resyncs.
//   4. A GENUINELY hidden document stays paused across resyncs (the
//      self-heal must not un-pause real hidden panes — the whole point of
//      the gate is that hidden panes stop ticking the refresh driver).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PANE_HIDDEN_CLASS,
  PANE_GATE_RESYNC_MS,
  startPaneVisibility,
  installPaneAnimationGate,
  resyncDocVisibility,
  onPaneVisibilityChange,
  __resetPaneVisibilityForTest,
} from "../../src/paneVisibility";

/** Drive document visibility through the REAL signal path (listener installed
 *  by startPaneVisibility), as a browser tab switch would. */
function setDocVisibility(v: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    get: () => v,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Simulate the LOST-EVENT posture: the document's live state flips back to
 *  visible but NO visibilitychange fires (iOS PWA unlock / bfcache restore
 *  swallowing the event). The cached docVisible signal is now stale-hidden. */
function loseShowEvent(): void {
  Object.defineProperty(document, "visibilityState", {
    get: () => "visible",
    configurable: true,
  });
}

const classOn = (): boolean =>
  document.documentElement.classList.contains(PANE_HIDDEN_CLASS);

beforeEach(() => {
  vi.useFakeTimers();
  __resetPaneVisibilityForTest();
  setDocVisibility("visible");
  __resetPaneVisibilityForTest(); // re-seed `last` against the live state
  startPaneVisibility();
  installPaneAnimationGate();
});

afterEach(() => {
  __resetPaneVisibilityForTest();
  vi.clearAllTimers();
  vi.useRealTimers();
  setDocVisibility("visible"); // jsdom hygiene for later files
});

describe("lost visibilitychange → visible strands a visible pane paused (bug posture, then heals)", () => {
  it("hide applies the class; the lost show event leaves it stuck (the bug)", () => {
    setDocVisibility("hidden");
    expect(classOn(), "hidden doc → paused").toBe(true);
    loseShowEvent();
    expect(document.visibilityState).toBe("visible");
    // No heal trigger has fired yet — the stale-cache posture is still stuck.
    expect(classOn(), "lost event → still paused (pre-heal)").toBe(true);
  });

  it("pageshow heals: class removed and the paneVisible transition FIRES", () => {
    const transitions: boolean[] = [];
    const unsub = onPaneVisibilityChange((v) => transitions.push(v));
    setDocVisibility("hidden");
    loseShowEvent();

    window.dispatchEvent(new Event("pageshow"));

    expect(classOn(), "pageshow re-derives + re-applies → un-paused").toBe(false);
    // The dedupe no longer swallows the healing resync: the stale cache made
    // this a real false→true edge, so sync-side suspend/resume listeners ran.
    expect(transitions, "heal fires the visible transition").toContain(true);
    unsub();
  });

  it("window focus heals the same posture", () => {
    setDocVisibility("hidden");
    loseShowEvent();
    window.dispatchEvent(new Event("focus"));
    expect(classOn(), "focus re-derives → un-paused").toBe(false);
  });

  it("the periodic resync heals (standalone backstop — no host, no pageshow)", () => {
    setDocVisibility("hidden");
    loseShowEvent();
    vi.advanceTimersByTime(PANE_GATE_RESYNC_MS);
    expect(classOn(), "~30s periodic resync → un-paused").toBe(false);
  });
});

describe("resyncDocVisibility semantics (the heal primitive)", () => {
  it("re-derives from live state: stale-hidden cache heals, fresh cache no-ops", () => {
    const transitions: boolean[] = [];
    const unsub = onPaneVisibilityChange((v) => transitions.push(v));

    setDocVisibility("hidden"); // real edge: fires false
    loseShowEvent(); // stale cache, live doc visible
    resyncDocVisibility();
    expect(transitions).toEqual([false, true]);

    // A second resync with a correct cache is a no-op (edge-triggered, no churn).
    resyncDocVisibility();
    expect(transitions, "no spurious transitions").toEqual([false, true]);
    unsub();
  });

  it("heals the stale-hidden cache WITHOUT an intervening visibilitychange", () => {
    // The exact dedupe-swallow from the trace: cache hidden, live visible.
    setDocVisibility("hidden");
    loseShowEvent();
    expect(classOn()).toBe(true);
    resyncDocVisibility();
    expect(classOn(), "pure re-derivation un-pauses").toBe(false);
  });
});

describe("self-heal must NOT un-pause genuinely hidden panes", () => {
  it("document really hidden: pageshow/focus/periodic all keep the class ON", () => {
    setDocVisibility("hidden");
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(PANE_GATE_RESYNC_MS * 3);
    expect(classOn(), "re-derivation sees hidden → stays paused").toBe(true);
  });

  it("host-hidden (doc visible, host signal false) stays paused across resyncs", async () => {
    const paneVis = await import("../../src/paneVisibility");
    paneVis.__setHostVisibleForTest(false);
    expect(classOn(), "host-hidden → paused").toBe(true);
    window.dispatchEvent(new Event("pageshow"));
    vi.advanceTimersByTime(PANE_GATE_RESYNC_MS * 3);
    expect(classOn(), "host signal still false → stays paused").toBe(true);
  });
});

describe("gate install hygiene", () => {
  it("re-install after a module reset re-applies the class from current state", async () => {
    const paneVis = await import("../../src/paneVisibility");
    setDocVisibility("hidden");
    paneVis.__resetPaneVisibilityForTest(false, false);
    expect(classOn(), "reset does not touch the DOM class").toBe(true);
    installPaneAnimationGate();
    expect(classOn(), "install always re-syncs the class").toBe(true);
    // Doc returns visible AND host reveals: the re-installed gate's listener
    // must carry the transition (host signal driven → notify → apply).
    setDocVisibility("visible");
    expect(classOn(), "still host-hidden → stays paused").toBe(true);
    paneVis.__setHostVisibleForTest(true);
    expect(classOn(), "reveal through the re-installed gate").toBe(false);
  });

  it("the periodic resync interval is torn down on reset (no leaked heals)", async () => {
    const paneVis = await import("../../src/paneVisibility");
    const intervalsBefore = vi.getTimerCount();
    paneVis.__resetPaneVisibilityForTest();
    expect(vi.getTimerCount(), "reset clears the gate interval").toBe(
      intervalsBefore - 1,
    );
  });

  // Carried from the 19f9e81 contract (preserved through the 2026-10-12
  // self-heal rewrite): double-install must not double-subscribe — which now
  // also guards pageshow/focus/interval, where a duplicate means a leaked
  // interval firing heals forever.
  it("is idempotent — a second install adds no listener and no interval", async () => {
    const paneVis = await import("../../src/paneVisibility");
    const timersBefore = vi.getTimerCount();
    installPaneAnimationGate();
    installPaneAnimationGate();
    expect(vi.getTimerCount(), "no leaked resync interval").toBe(timersBefore);
    paneVis.__setHostVisibleForTest(false);
    paneVis.__setHostVisibleForTest(true);
    paneVis.__setHostVisibleForTest(false);
    expect(classOn()).toBe(true);
    expect(
      document.documentElement.className.match(/pane-hidden/g)?.length,
      "class appears exactly once",
    ).toBe(1);
  });
});

// Carried from the 19f9e81 contract: the TS class toggle and the tokens.css
// rule are two halves of one mechanism — these keep them from silently
// drifting apart (the pause must stay play-state/resumable, never `none`).
describe("pane-hidden CSS contract (tokens.css)", () => {
  const css = readFileSync(
    resolve(__dirname, "../../src/styles/foundation/tokens.css"),
    "utf8",
  );

  it("names the exact class the TS gate toggles", async () => {
    const paneVis = await import("../../src/paneVisibility");
    expect(css).toContain(`:root.${paneVis.PANE_HIDDEN_CLASS}`);
  });

  it("PAUSES animations (play-state), does not remove them, and uses !important", () => {
    const m = css.match(/:root\.pane-hidden[^{]*\{[^}]*\}/);
    expect(m).not.toBeNull();
    expect(m![0]).toContain("animation-play-state: paused !important");
    expect(m![0]).not.toContain("animation: none");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  bottommostRead as BottommostRead,
  clearReadAnchor as ClearReadAnchor,
  clearReadAnchors as ClearReadAnchors,
  getReadAnchor as GetReadAnchor,
  orderAhead as OrderAhead,
  setReadAnchor as SetReadAnchor,
} from "../../src/lib/scroll";

// In-memory localStorage for the node test env. The store module reads its
// cache once on import (module load), so tests reset the module each time and
// control storage BEFORE re-importing — that way the import-time load + legacy
// cleanup run against a known state.
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
};

// `bottommostRead` + `orderAhead` + `classifyScrollDelta` are pure functions
// (no module state), so they can be imported statically and exercised directly.
import {
  bottommostRead,
  bottommostReadWithFallback,
  classifyScrollDelta,
  orderAhead,
} from "../../src/lib/scroll";
import type {
  ScrollGeometry,
  ScrollMode,
} from "../../src/lib/scroll";

// Re-import the store (which holds module-level cache) fresh per test.
async function store() {
  vi.resetModules();
  const m = await import("../../src/lib/scroll");
  return {
    getReadAnchor: m.getReadAnchor as typeof GetReadAnchor,
    setReadAnchor: m.setReadAnchor as typeof SetReadAnchor,
    clearReadAnchor: m.clearReadAnchor as typeof ClearReadAnchor,
    clearReadAnchors: m.clearReadAnchors as typeof ClearReadAnchors,
  };
}

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  vi.resetModules();
});

describe("read-anchor store", () => {
  it("round-trips an anchor inside a {v,data} envelope", async () => {
    const s = await store();
    s.setReadAnchor("s1", "m5");
    expect(s.getReadAnchor("s1")).toBe("m5");
    // envelope shape is versioned (vh.scroll.v2)
    const env = JSON.parse(mem["vh.scroll.v2"]);
    expect(env).toEqual({ v: 1, data: { s1: "m5" } });
  });

  it("is sparse: a session with no entry reads as undefined (caught-up default)", async () => {
    const s = await store();
    expect(s.getReadAnchor("unknown")).toBeUndefined();
  });

  it("setReadAnchor is a no-op for a falsy messageID", async () => {
    const s = await store();
    s.setReadAnchor("s1", "");
    expect(s.getReadAnchor("s1")).toBeUndefined();
    expect(mem["vh.scroll.v2"]).toBeUndefined(); // nothing written
  });

  it("does not rewrite storage when the value is unchanged", async () => {
    const s = await store();
    s.setReadAnchor("s1", "m5");
    const before = mem["vh.scroll.v2"];
    s.setReadAnchor("s1", "m5"); // same value
    expect(mem["vh.scroll.v2"]).toBe(before);
  });

  it("clearReadAnchor drops one session and restores the sparse default", async () => {
    const s = await store();
    s.setReadAnchor("s1", "m5");
    s.setReadAnchor("s2", "m9");
    s.clearReadAnchor("s1");
    expect(s.getReadAnchor("s1")).toBeUndefined();
    expect(s.getReadAnchor("s2")).toBe("m9"); // others untouched
  });

  it("clearReadAnchor is a no-op when nothing is stored", async () => {
    const s = await store();
    s.clearReadAnchor("never");
    expect(mem["vh.scroll.v2"]).toBeUndefined();
  });

  it("clearReadAnchors drops many at once (archive prune)", async () => {
    const s = await store();
    s.setReadAnchor("s1", "m5");
    s.setReadAnchor("s2", "m9");
    s.setReadAnchor("s3", "m2");
    s.clearReadAnchors(["s1", "s3", "missing"]);
    expect(s.getReadAnchor("s1")).toBeUndefined();
    expect(s.getReadAnchor("s2")).toBe("m9");
    expect(s.getReadAnchor("s3")).toBeUndefined();
  });

  it("ignores + cleans up a legacy px-offset store (vh.scroll.v1) on load", async () => {
    // Seed a legacy px-offset value under the old key BEFORE the import-time
    // cleanup runs.
    mem["vh.scroll.v1"] = JSON.stringify({ v: 1, data: { s1: 12345 } });
    const s = await store(); // import triggers the legacy cleanup
    // A legacy px offset is meaningless as a message anchor → no anchor (bottom).
    expect(s.getReadAnchor("s1")).toBeUndefined();
    // The legacy key is cleaned up on load.
    expect(mem["vh.scroll.v1"]).toBeUndefined();
  });

  it("survives a corrupt legacy payload without throwing", async () => {
    mem["vh.scroll.v1"] = "{not json";
    const s = await store();
    expect(s.getReadAnchor("s1")).toBeUndefined();
    expect(mem["vh.scroll.v1"]).toBeUndefined(); // still removed
  });
});

describe("bottommostRead (pure geometry helper)", () => {
  it("returns undefined when nothing has scrolled past the top", () => {
    // All rows still below the viewport top (positive deltas).
    expect(bottommostRead([{ id: "m1", top: 40 }, { id: "m2", top: 200 }])).toBeUndefined();
  });

  it("returns the single row at/above the top", () => {
    expect(bottommostRead([{ id: "m1", top: -300 }])).toBe("m1");
  });

  it("returns the bottommost read-through row (the last with top <= 0)", () => {
    expect(
      bottommostRead([
        { id: "m1", top: -800 },
        { id: "m2", top: -400 },
        { id: "m3", top: 0 }, // pinned at the viewport top → counts as read
        { id: "m4", top: 160 }, // below the top → not read yet
      ]),
    ).toBe("m3");
  });

  it("treats a row exactly at the top (top === 0) as read-through", () => {
    expect(bottommostRead([{ id: "m1", top: 0 }, { id: "m2", top: 100 }])).toBe("m1");
  });

  it("stops at the first row below the top (document-order assumption)", () => {
    // The scan breaks at the first positive top; a later out-of-order <= 0 row
    // is never reached (rows are assumed in document order, which the caller
    // guarantees by iterating messages() in order).
    expect(
      bottommostRead([
        { id: "m1", top: -100 },
        { id: "m2", top: 50 }, // first below the top → stop
        { id: "m3", top: -10 }, // would-be match ignored (document order)
      ]),
    ).toBe("m1");
  });

  it("returns undefined for an empty list", () => {
    expect(bottommostRead([])).toBeUndefined();
  });
});

describe("bottommostReadWithFallback (pure geometry helper + scroll-origin fallback)", () => {
  it("returns the bottommost read-through id when some rows scrolled past the top (Case A)", () => {
    // Same behavior as bottommostRead when there IS a read-through row.
    expect(
      bottommostReadWithFallback([
        { id: "m1", top: -800 },
        { id: "m2", top: -400 },
        { id: "m3", top: 0 }, // pinned at viewport top → counts as read
        { id: "m4", top: 160 }, // below the top → not read yet
      ]),
    ).toBe("m3");
  });

  it("falls back to rows[0]?.id when nothing scrolled past the top (Case B — scroll-origin)", () => {
    // All rows still below the viewport top (positive deltas). bottommostRead
    // returns undefined; the fallback returns the topmost row, which IS visibly
    // in-view and the correct read anchor. This is the load-bearing case: without
    // the fallback, no anchor would be written and the read position would be
    // lost on reopen.
    expect(
      bottommostReadWithFallback([
        { id: "m1", top: 16 }, // +16px (chat-scroll padding) — above the <= 0 threshold
        { id: "m2", top: 200 },
      ]),
    ).toBe("m1");
  });

  it("returns undefined for an empty list (Case C)", () => {
    expect(bottommostReadWithFallback([])).toBeUndefined();
  });
});

describe("orderAhead (monotonic read-cursor guard)", () => {
  // The message-order array (newest-known session message order). orderAhead is
  // pure: order is passed explicitly, no closure captures. Modeled on the
  // bottommostRead tests above. Covers the 5 cases pinned in P1-WEB-002.
  const order = ["m1", "m2", "m3", "m4"];

  it("treats a missing stored anchor as behind (candidate is ahead → true)", () => {
    // First write always lands: nothing stored means the candidate establishes
    // the cursor regardless of its position in order.
    expect(orderAhead("m3", undefined, order)).toBe(true);
  });

  it("is not ahead when candidate equals stored (→ false)", () => {
    // Equal is not forward progress; the guard no-ops so storage isn't rewritten.
    expect(orderAhead("m2", "m2", order)).toBe(false);
  });

  it("is ahead when the candidate is newer than stored (→ true)", () => {
    expect(orderAhead("m4", "m1", order)).toBe(true);
  });

  it("is not ahead when the candidate is older than stored (→ false)", () => {
    // Monotonic: scrolling up to re-read never lowers the stored anchor.
    expect(orderAhead("m1", "m3", order)).toBe(false);
  });

  it("returns true when both candidate and stored are absent", () => {
    // At the call site cand is always a non-empty string (flushReadCursor guards
    // `if (!cand) return;` before calling), so "both absent" is a pure-helper
    // edge that never fires at runtime. The former closure's first short-circuit
    // (`if (!stored) return true;`) resolves it to true before cand is examined;
    // this pins that faithful behavior (no new semantics invented). An empty
    // cand string represents "absent" the same way setReadAnchor treats falsy.
    expect(orderAhead("", undefined, order)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyScrollDelta — dual-axis geometry reducer (option A_plus).
//
// Every case models a real scroll-surface transition the chat view must
// classify correctly. Geometry is {scrollTop, scrollHeight, clientHeight}; the
// reducer decomposes content-delta + viewport-delta + clamp and treats genuine
// user scroll-intent as the RESIDUAL. See scroll.ts for the full rationale.
// ---------------------------------------------------------------------------

// Convenience: build a tail-mode call centered on the common "glued to bottom"
// starting geometry (scrollHeight 2000, clientHeight 600 → maxBottom 1400).
function tail(
  previous: ScrollGeometry,
  current: ScrollGeometry,
  following = true,
) {
  return classifyScrollDelta({
    previous,
    current,
    mode: "tail" as ScrollMode,
    following,
  });
}

describe("classifyScrollDelta — tail/following", () => {
  // Starting glued to the bottom: scrollTop === maxBottom (1400).
  const atBottom = (): ScrollGeometry => ({ scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 });

  it("content grow-at-tail, viewport unchanged → re-pin to new bottom (no intent flip)", () => {
    const d = tail(atBottom(), { scrollTop: 1400, scrollHeight: 2200, clientHeight: 600 });
    expect(d.contentDelta).toBe(200);
    expect(d.viewportDelta).toBe(0);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("none"); // layout churn, NOT user scroll
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(1600); // new maxBottom
  });

  it("content grow-at-tail + viewport shrink (typing during a live stream) → re-pin", () => {
    // Simultaneous content-grow and viewport-shrink in ONE frame: the single-axis
    // `shrank` classifier mis-fired on this; the dual-axis reducer handles both.
    const d = tail(atBottom(), { scrollTop: 1400, scrollHeight: 2200, clientHeight: 500 });
    expect(d.contentDelta).toBe(200);
    expect(d.viewportDelta).toBe(-100);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(1700);
  });

  it("content grow-at-tail + viewport grow → re-pin", () => {
    const d = tail(atBottom(), { scrollTop: 1400, scrollHeight: 2200, clientHeight: 700 });
    expect(d.viewportDelta).toBe(100);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(1500);
  });

  it("content shrink, viewport unchanged → clamped to new bottom, reached-bottom", () => {
    // Was at bottom (1400); content shrank so maxBottom fell to 1200 and the
    // browser clamped scrollTop to 1200.
    const d = tail(atBottom(), { scrollTop: 1200, scrollHeight: 1800, clientHeight: 600 });
    expect(d.contentDelta).toBe(-200);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("reached-bottom");
    expect(d.shouldScroll).toBe(false); // already clamped, no write needed
  });

  it("content shrink + viewport shrink → reached-bottom, no churn", () => {
    const d = tail(atBottom(), { scrollTop: 1300, scrollHeight: 1800, clientHeight: 500 });
    expect(d.contentDelta).toBe(-200);
    expect(d.viewportDelta).toBe(-100);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("reached-bottom");
    expect(d.shouldScroll).toBe(false);
  });

  it("content shrink + viewport grow → reached-bottom, no churn", () => {
    const d = tail(atBottom(), { scrollTop: 1100, scrollHeight: 1800, clientHeight: 700 });
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("reached-bottom");
    expect(d.shouldScroll).toBe(false);
  });

  it("viewport-only shrink (composer grow) → residual 0, intent none, re-pin (keep following)", () => {
    // THE deadlock root: previously this flipped following false. The reducer
    // classifies it as layout churn (intent none) so the caller keeps following
    // and the tail branch re-glues to the new bottom.
    const d = tail(atBottom(), { scrollTop: 1400, scrollHeight: 2000, clientHeight: 500 });
    expect(d.contentDelta).toBe(0);
    expect(d.viewportDelta).toBe(-100);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(1500);
  });

  it("viewport shrink while following, browser partially compensated (resid dominated by viewport) → keep following + re-pin to new bottom", () => {
    // The load-only flake root (ChatView onScrolled dropping following at the
    // tail): a UI bar appears → clientHeight shrinks 137px; browser
    // scroll-anchoring nudges scrollTop down 43px. The residual (+43) is outside
    // epsilon and WOULD classify as user-scroll-down (dropping following), but the
    // VIEWPORT delta (-137) dominates, so the transition is layout churn: intent
    // none, and the tail re-glue re-pins to the new bottom (2823) — the reader
    // stays glued to the tail with no "↓ Latest" recovery needed.
    const d = tail(
      { scrollTop: 2686, scrollHeight: 2891, clientHeight: 205 },
      { scrollTop: 2729, scrollHeight: 2891, clientHeight: 68 },
    );
    expect(d.viewportDelta).toBe(-137);
    expect(d.residualUserDelta).toBe(43);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(2823);
  });

  it("viewport-only grow (composer shrink, stuck-on-Latest fix) → reached-bottom re-engage signal", () => {
    // Following was false (killed by the deadlock); composer shrinks back so
    // clientHeight grows, browser clamps scrollTop down to the new maxBottom.
    // No scroll event fires for a pure clientHeight grow, so the RO must see
    // reached-bottom and the caller re-engages following.
    const d = tail(
      { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 },
      { scrollTop: 1300, scrollHeight: 2000, clientHeight: 700 },
      false, // following already false (stuck state)
    );
    expect(d.viewportDelta).toBe(100);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("reached-bottom");
    // Tail branch is gated on following (false) → no programmatic write; the
    // reached-bottom intent is the re-engage signal the caller acts on.
    expect(d.shouldScroll).toBe(false);
  });

  it("residual user-scroll-up → user-scroll-up, no re-pin (drop following)", () => {
    const d = tail(atBottom(), { scrollTop: 800, scrollHeight: 2000, clientHeight: 600 });
    expect(d.residualUserDelta).toBe(-600);
    expect(d.intent).toBe("user-scroll-up");
    expect(d.shouldScroll).toBe(false); // tail branch skips on user-scroll-up
    expect(d.newScrollTop).toBeUndefined();
  });

  it("residual user-scroll-down (still above bottom) → user-scroll-down, no re-engage yet", () => {
    // Was scrolled up (800); user scrolled down to 1000 but not yet to bottom.
    const d = tail(
      { scrollTop: 800, scrollHeight: 2000, clientHeight: 600 },
      { scrollTop: 1000, scrollHeight: 2000, clientHeight: 600 },
      false,
    );
    expect(d.residualUserDelta).toBe(200);
    expect(d.intent).toBe("user-scroll-down");
    expect(d.shouldScroll).toBe(false);
  });

  it("residual user-scroll-down reaching the bottom → reached-bottom wins (re-engage)", () => {
    // atBottom is checked before the residual-down branch, so scrolling all the
    // way down classifies as reached-bottom (the re-engage signal), not
    // user-scroll-down.
    const d = tail(
      { scrollTop: 800, scrollHeight: 2000, clientHeight: 600 },
      { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 },
      false,
    );
    expect(d.intent).toBe("reached-bottom");
  });

  it("content-insert anchoring move while following (send-window flake) → churn, re-pin, keep following", () => {
    // The scroll-follow e2e flake (tests 9/11), signature B: glued at the tail
    // (969 = 1296-327), a [[stall]] send appends the user message (+95 content)
    // and browser scroll-anchoring moves scrollTop +13 with NO user input.
    // Pre-guard this classified user-scroll-down → following dropped + latch
    // armed → the Live pill never rendered. The down-residual is bounded by the
    // concurrent content grow, so it is anchoring churn: intent none, tail
    // re-glue re-pins to the new bottom.
    const d = tail(
      { scrollTop: 969, scrollHeight: 1296, clientHeight: 327 },
      { scrollTop: 982, scrollHeight: 1391, clientHeight: 327 },
    );
    expect(d.contentDelta).toBe(95);
    expect(d.viewportDelta).toBe(0);
    expect(d.residualUserDelta).toBe(13);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(1064); // 1391 - 327
  });

  it("hydration-era anchoring move vs the stale mount baseline (load flake) → churn, re-pin, keep following", () => {
    // The same flake, signature A: the first scroll event of the page's life,
    // classified against the pre-hydration mount baseline (empty transcript,
    // scrollTop 0) after hydration grew the content 439→1296 and the viewport
    // churned 439→318. The browser anchored scrollTop to 948 (no user input);
    // the whole position read as a +948 residual. The absorption budget
    // contentDelta + |viewportDelta| (857 + 121) covers the move.
    const d = tail(
      { scrollTop: 0, scrollHeight: 439, clientHeight: 439 },
      { scrollTop: 948, scrollHeight: 1296, clientHeight: 318 },
    );
    expect(d.contentDelta).toBe(857);
    expect(d.viewportDelta).toBe(-121);
    expect(d.residualUserDelta).toBe(948);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(978); // 1296 - 318
  });

  it("content-anchoring absorption budget boundary: residual at exactly the budget is churn, one px past it is intent", () => {
    // The guard admits residualUserDelta <= contentDelta + |viewportDelta| + eps.
    // Pin BOTH sides of that boundary so a future edit that nudges the budget
    // (or drops the +eps) fails loudly here instead of shifting the load-window
    // flake surface silently. prev=(1000,2000,600); content grows +100,
    // viewport shrinks -50 → budget = 100 + 50 + 1 = 151.
    const prev = { scrollTop: 1000, scrollHeight: 2000, clientHeight: 600 };
    const at = tail(prev, { scrollTop: 1151, scrollHeight: 2100, clientHeight: 550 });
    expect(at.residualUserDelta).toBe(151);
    expect(at.intent).toBe("none"); // exactly at the budget (<=) → absorbed
    expect(at.shouldScroll).toBe(true);
    expect(at.newScrollTop).toBe(1550); // 2100 - 550
    const past = tail(prev, { scrollTop: 1152.5, scrollHeight: 2100, clientHeight: 550 });
    expect(past.residualUserDelta).toBe(152.5);
    expect(past.intent).toBe("user-scroll-down"); // past the budget → user intent
  });

  it("genuine user scroll-down with no content change stays user-scroll-down (guard is content-gated)", () => {
    // Negative control: while following, a down-move on a frame with NO content
    // change cannot be anchoring (nothing was inserted) — it must still
    // classify as user intent. (The guard requires contentDelta > 0.)
    const d = tail(
      { scrollTop: 800, scrollHeight: 2000, clientHeight: 600 },
      { scrollTop: 1000, scrollHeight: 2000, clientHeight: 600 },
    );
    expect(d.contentDelta).toBe(0);
    expect(d.residualUserDelta).toBe(200);
    expect(d.intent).toBe("user-scroll-down");
    // Pre-existing tail-re-glue semantics: the classifier proposes a re-pin for
    // any non-up intent while following; onScrolled's user-intent branch drops
    // following and never applies it. The INTENT is the asserted contract here.
    expect(d.shouldScroll).toBe(true);
  });

  it("down-residual EXCEEDING the content+viewport budget stays user-scroll-down", () => {
    // Negative control: a down-move larger than the concurrent layout mutation
    // (contentDelta + |viewportDelta| + eps) is not attributable to anchoring —
    // keep classifying it as user intent.
    const d = tail(
      { scrollTop: 800, scrollHeight: 2000, clientHeight: 600 },
      { scrollTop: 1150, scrollHeight: 2100, clientHeight: 600 },
    );
    expect(d.contentDelta).toBe(100);
    expect(d.viewportDelta).toBe(0);
    expect(d.residualUserDelta).toBe(350); // 350 > 100 + 0 + 1
    expect(d.intent).toBe("user-scroll-down");
  });

  it("upward move on a content-grow frame still drops following (guard is DOWN-only)", () => {
    // Negative control: the canonical reader-intent signal is an UPWARD move —
    // even on a frame where content grew (mid-stream wheel-up), it must
    // classify as user-scroll-up so the intent latch arms (tests 10b/17b).
    const d = tail(
      { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 },
      { scrollTop: 1300, scrollHeight: 2200, clientHeight: 600 },
    );
    expect(d.contentDelta).toBe(200);
    expect(d.residualUserDelta).toBe(-100);
    expect(d.intent).toBe("user-scroll-up");
  });

  it("max-scroll clamp on dramatic content shrink → reached-bottom, no churn", () => {
    const d = tail(atBottom(), { scrollTop: 400, scrollHeight: 1000, clientHeight: 600 });
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("reached-bottom");
    expect(d.shouldScroll).toBe(false);
  });

  it("sub-pixel residual within epsilon → none (absorbs clamp churn)", () => {
    const d = classifyScrollDelta({
      previous: atBottom(),
      current: { scrollTop: 1400.4, scrollHeight: 2200, clientHeight: 600 },
      mode: "tail",
      following: true,
      epsilon: 1,
    });
    expect(d.residualUserDelta).toBeCloseTo(0.4, 6);
    expect(d.intent).toBe("none");
  });

  it("residual just outside epsilon → classified as intent", () => {
    const d = classifyScrollDelta({
      previous: atBottom(),
      current: { scrollTop: 800, scrollHeight: 2200, clientHeight: 600 },
      mode: "tail",
      following: true,
      epsilon: 1,
    });
    // expected = clamp(1400, 1600) = 1400; residual = 800 - 1400 = -600
    expect(d.residualUserDelta).toBe(-600);
    expect(d.intent).toBe("user-scroll-up");
  });

  it("tail re-pin is epsilon-guarded against a no-op frame (no churn)", () => {
    // Already exactly at the new bottom: the write would be a no-op, so
    // shouldScroll stays false to avoid infinite RO/onScroll churn.
    const d = tail(atBottom(), { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 });
    expect(d.intent).toBe("reached-bottom");
    expect(d.shouldScroll).toBe(false);
  });
});

describe("classifyScrollDelta — read/not-following (anchor preservation)", () => {
  // Read-mode starting geometry: scrolled up to 500, viewport 600, content 2000.
  const readStart = (): ScrollGeometry => ({ scrollTop: 500, scrollHeight: 2000, clientHeight: 600 });

  function read(previous: ScrollGeometry, current: ScrollGeometry, anchorDelta?: number) {
    return classifyScrollDelta({
      previous,
      current,
      mode: "read" as ScrollMode,
      following: false,
      anchorDelta,
    });
  }

  it("grow-above-viewport, browser compensated (overflow-anchor worked) → anchor preserved, no write", () => {
    // Content grew above the anchor by 200; the browser kept the anchor pinned
    // so scrollTop tracked +200.
    const d = read(readStart(), { scrollTop: 700, scrollHeight: 2200, clientHeight: 600 }, 200);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(false);
  });

  it("grow-above-viewport, browser FROZE → compensation failure corrects the anchor", () => {
    // overflow-anchor:auto failed during hydration: anchor moved +200 but
    // scrollTop stayed at 500. The reducer corrects it mechanically.
    const d = read(readStart(), { scrollTop: 500, scrollHeight: 2200, clientHeight: 600 }, 200);
    expect(d.expectedScrollTop).toBe(700);
    expect(d.residualUserDelta).toBe(-200);
    expect(d.intent).toBe("none"); // corrected, NOT mistaken for user scroll
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(700);
  });

  it("grow-below (content appended below anchor) → read position unchanged", () => {
    const d = read(readStart(), { scrollTop: 500, scrollHeight: 2500, clientHeight: 600 }, 0);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(false);
  });

  it("shrink-above, browser compensated → anchor preserved", () => {
    // Content above the anchor shrank by 100; browser tracked scrollTop -100.
    const d = read(readStart(), { scrollTop: 400, scrollHeight: 1900, clientHeight: 600 }, -100);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(false);
  });

  it("shrink-above, browser FROZE → compensation failure corrects the anchor", () => {
    const d = read(readStart(), { scrollTop: 500, scrollHeight: 1900, clientHeight: 600 }, -100);
    expect(d.expectedScrollTop).toBe(400);
    expect(d.residualUserDelta).toBe(100);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(400);
  });

  it("viewport shrink (composer grow) without residual → visible anchor preserved", () => {
    const d = read(readStart(), { scrollTop: 500, scrollHeight: 2000, clientHeight: 500 }, 0);
    expect(d.viewportDelta).toBe(-100);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(false);
  });

  it("viewport grow (composer shrink) without residual → visible anchor preserved", () => {
    const d = read(readStart(), { scrollTop: 500, scrollHeight: 2000, clientHeight: 700 }, 0);
    expect(d.viewportDelta).toBe(100);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(false);
  });

  it("simultaneous grow-above + viewport shrink, browser compensated → both axes handled", () => {
    const d = read(readStart(), { scrollTop: 700, scrollHeight: 2200, clientHeight: 500 }, 200);
    expect(d.contentDelta).toBe(200);
    expect(d.viewportDelta).toBe(-100);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(false);
  });

  it("simultaneous shrink-above + viewport grow, browser compensated → both axes handled", () => {
    const d = read(readStart(), { scrollTop: 400, scrollHeight: 1900, clientHeight: 700 }, -100);
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(false);
  });

  it("residual user-scroll-up still detected while not following (read mode)", () => {
    const d = read(readStart(), { scrollTop: 200, scrollHeight: 2000, clientHeight: 600 }, 0);
    expect(d.residualUserDelta).toBe(-300);
    expect(d.intent).toBe("user-scroll-up");
    expect(d.shouldScroll).toBe(false);
  });
});

describe("classifyScrollDelta — restore / hydration / load-more", () => {
  function read(previous: ScrollGeometry, current: ScrollGeometry, anchorDelta?: number) {
    return classifyScrollDelta({
      previous,
      current,
      mode: "read" as ScrollMode,
      following: false,
      anchorDelta,
    });
  }

  it("stored data-mid anchor arrives after partial load → corrects to anchor", () => {
    // Partial load left scrollTop at 500; the anchor element then arrives and
    // hydration adds height above it (anchorDelta +100) but the browser froze.
    const d = read(
      { scrollTop: 500, scrollHeight: 1500, clientHeight: 600 },
      { scrollTop: 500, scrollHeight: 1600, clientHeight: 600 },
      100,
    );
    expect(d.expectedScrollTop).toBe(600);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(600);
  });

  it("deferred hydration changes height above anchor → corrects proportionally", () => {
    const d = read(
      { scrollTop: 500, scrollHeight: 1500, clientHeight: 600 },
      { scrollTop: 500, scrollHeight: 1750, clientHeight: 600 },
      250,
    );
    expect(d.expectedScrollTop).toBe(750);
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(750);
  });

  it("load-more prepends content above anchor → read position preserved", () => {
    const d = read(
      { scrollTop: 500, scrollHeight: 2000, clientHeight: 600 },
      { scrollTop: 500, scrollHeight: 2400, clientHeight: 600 },
      400,
    );
    expect(d.expectedScrollTop).toBe(900);
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(900);
  });

  it("anchor-correction (read mode) and tail-follow (tail mode) are mutually exclusive in one cycle", () => {
    // Same geometry, different mode: tail re-pins to bottom; read preserves the
    // read position. A single reducer call picks exactly one behavior.
    const prev = { scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 };
    const curr = { scrollTop: 1400, scrollHeight: 2200, clientHeight: 600 };

    const tailDecision = classifyScrollDelta({
      previous: prev,
      current: curr,
      mode: "tail",
      following: true,
    });
    expect(tailDecision.shouldScroll).toBe(true);
    expect(tailDecision.newScrollTop).toBe(1600); // re-pin to bottom

    const readDecision = classifyScrollDelta({
      previous: prev,
      current: curr,
      mode: "read",
      following: false,
      anchorDelta: 0, // no anchor shift → no correction
    });
    // Read mode does NOT chase the bottom; it leaves the viewport where it is.
    expect(readDecision.intent).toBe("none");
    expect(readDecision.shouldScroll).toBe(false);
    expect(readDecision.newScrollTop).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// trustedNoUserInput — partial browser scroll-anchoring correction.
//
// During Deferred hydration the browser's overflow-anchor:auto PARTIALLY
// tracks an above-anchor shrink: it moves scrollTop by less than anchorDelta
// (its anchor node sits below our logical data-mid row). The strict
// compensation gate (browser did not move at all) skips the cycle, the
// remainder is never corrected (no further RO frames fire once heights
// settle), and the restored reader sits ~a row off the anchor permanently —
// the read-position e2e flake (observed −103px at 48 messages:
// anchorDelta −287, browser moved −184, remainder +103 frozen).
//
// When the caller asserts input provenance (no fresh wheel/pointer over the
// viewport — ChatView's Approach-A infra), the same-frame scrollTop movement
// can only be browser/system anchoring, so the remainder is corrected to the
// anchor-tracked expectation. Without the assertion the strict gate stands:
// a genuinely scrolling reader is never corrected.
// ---------------------------------------------------------------------------
describe("classifyScrollDelta — trustedNoUserInput partial-tracking correction", () => {
  function read(
    previous: ScrollGeometry,
    current: ScrollGeometry,
    anchorDelta?: number,
    trustedNoUserInput?: boolean,
  ) {
    return classifyScrollDelta({
      previous,
      current,
      mode: "read" as ScrollMode,
      following: false,
      anchorDelta,
      trustedNoUserInput,
    });
  }

  it("partial browser tracking WITHOUT provenance → strict gate stands (no correction; pre-fix behavior)", () => {
    // The e2e-observed undershoot frame: anchor offset −287, browser moved
    // scrollTop only −184. Without provenance this must stay uncorrected —
    // the movement is indistinguishable from a user scroll.
    const d = read(
      { scrollTop: 3039, scrollHeight: 6633, clientHeight: 406 },
      { scrollTop: 2855, scrollHeight: 5894, clientHeight: 406 },
      -287,
    );
    expect(d.expectedScrollTop).toBe(2752);
    expect(d.residualUserDelta).toBe(103);
    expect(d.intent).toBe("user-scroll-down");
    expect(d.shouldScroll).toBe(false);
  });

  it("partial browser tracking WITH provenance → remainder corrected to anchor-tracked expectation", () => {
    const d = read(
      { scrollTop: 3039, scrollHeight: 6633, clientHeight: 406 },
      { scrollTop: 2855, scrollHeight: 5894, clientHeight: 406 },
      -287,
      true,
    );
    expect(d.expectedScrollTop).toBe(2752);
    expect(d.intent).toBe("none"); // corrected, NOT mistaken for user scroll
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(2752);
  });

  it("partial tracking on GROW-above with provenance → corrected too", () => {
    // Mirror shape: hydration grows above the anchor (+250) but the browser
    // tracked only +100 (its anchor node below ours under-tracked).
    const d = read(
      { scrollTop: 500, scrollHeight: 1500, clientHeight: 600 },
      { scrollTop: 600, scrollHeight: 1750, clientHeight: 600 },
      250,
      true,
    );
    expect(d.expectedScrollTop).toBe(750);
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(750);
  });

  it("provenance does NOT override a movement LARGER than anchorDelta (over-tracking/external stays strict)", () => {
    // scrollTop moved −400 while the anchor only shifted −287: the excess
    // (−113) looks like user scroll. Provenance must not "correct" it back —
    // the loosened gate only admits movement smaller than the anchor shift.
    const d = read(
      { scrollTop: 3039, scrollHeight: 6633, clientHeight: 406 },
      { scrollTop: 2639, scrollHeight: 5894, clientHeight: 406 },
      -287,
      true,
    );
    expect(d.residualUserDelta).toBe(-113);
    expect(d.intent).toBe("user-scroll-up");
    expect(d.shouldScroll).toBe(false);
  });

  it("provenance with anchorDelta 0 (grow-below) → still churn, no write", () => {
    const d = read(
      { scrollTop: 500, scrollHeight: 2000, clientHeight: 600 },
      { scrollTop: 500, scrollHeight: 2500, clientHeight: 600 },
      0,
      true,
    );
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(false);
  });

  it("full browser tracking WITH provenance → already correct, no write", () => {
    // Browser moved exactly anchorDelta: residual 0 → nothing to correct.
    const d = read(
      { scrollTop: 3039, scrollHeight: 6633, clientHeight: 406 },
      { scrollTop: 2752, scrollHeight: 5894, clientHeight: 406 },
      -287,
      true,
    );
    expect(d.residualUserDelta).toBe(0);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Interaction-scoped follow hold (Approach E) — pure classifier invariant.
//
// While the operator interacts with the PendingInput blocker card, ChatView
// suppresses ONLY the content-resize re-glue-to-bottom write (holdActive gate).
// This is safe ONLY because the pure classifier, given a held-steady scrollTop
// and growing content, NEVER classifies the cycle as user-scroll-up. These
// tests pin that invariant: repeated content-grow cycles while held stay
// intent "none" with shouldScroll + a new maxBottom, and on release the
// deferred write lands cleanly without arming userScrolledUp.
// ---------------------------------------------------------------------------
describe("classifyScrollDelta — interaction-scoped follow hold (Approach E) invariant", () => {
  // Start glued to the bottom (scrollTop === maxBottom === 1400).
  const atBottom = (): ScrollGeometry => ({ scrollTop: 1400, scrollHeight: 2000, clientHeight: 600 });

  it("repeated content-grow while scrollTop is held steady → intent stays 'none' across cycles (never user-scroll-up)", () => {
    // This is the core safety invariant: the RO advances pinnedGeom to the
    // settled geometry each cycle (which, while held, has the SAME scrollTop as
    // the previous cycle — the write was skipped). So prev.scrollTop ===
    // curr.scrollTop every cycle → residual 0 → intent "none".
    let prev: ScrollGeometry = atBottom();
    // Cycle 1: content grows by 100, scrollTop held at 1400 (write skipped).
    let curr: ScrollGeometry = { scrollTop: 1400, scrollHeight: 2100, clientHeight: 600 };
    let d = tail(prev, curr, true);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(1500); // new maxBottom (2100-600)
    // RO advances baseline to settled geometry (scrollTop unchanged because
    // the write was suppressed).
    prev = curr;

    // Cycle 2: content grows another 100, scrollTop still 1400.
    curr = { scrollTop: 1400, scrollHeight: 2200, clientHeight: 600 };
    d = tail(prev, curr, true);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(1600);
    prev = curr;

    // Cycle 3: more growth.
    curr = { scrollTop: 1400, scrollHeight: 2500, clientHeight: 600 };
    d = tail(prev, curr, true);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(1900);
  });

  it("on release, the deferred write lands cleanly — single cycle classifies shouldScroll + no userScrolledUp", () => {
    // After the hold releases, scrollTop is still at the held value (1400) but
    // the write is no longer suppressed. The RO fires once more with the SAME
    // settled geometry; the classifier sees residual 0 (prev.scrollTop advanced
    // to the held 1400, curr.scrollTop still 1400) → intent "none", shouldScroll
    // true, newScrollTop = current maxBottom. A single re-pin lands; following
    // stays true; userScrolledUp is never armed.
    const prev: ScrollGeometry = { scrollTop: 1400, scrollHeight: 2500, clientHeight: 600 };
    const curr: ScrollGeometry = { scrollTop: 1400, scrollHeight: 2500, clientHeight: 600 };
    const d = tail(prev, curr, true);
    expect(d.intent).toBe("none");
    expect(d.shouldScroll).toBe(true);
    expect(d.newScrollTop).toBe(1900); // 2500 - 600
    expect(d.residualUserDelta).toBe(0);
  });

  it("hold does not mask genuine user-scroll-up — if the operator scrolls up while held, the classifier still sees it", () => {
    // The hold suppresses the WRITE, not the classifier. If the operator
    // genuinely scrolls up during the hold, the next RO cycle sees a negative
    // residual and classifies user-scroll-up — ChatView then drops following
    // and arms userScrolledUp as usual. This guarantees manual scroll-up is
    // respected even during the hold.
    const prev: ScrollGeometry = { scrollTop: 1400, scrollHeight: 2500, clientHeight: 600 };
    const curr: ScrollGeometry = { scrollTop: 800, scrollHeight: 2500, clientHeight: 600 };
    const d = tail(prev, curr, true);
    expect(d.intent).toBe("user-scroll-up");
    expect(d.shouldScroll).toBe(false);
  });
});

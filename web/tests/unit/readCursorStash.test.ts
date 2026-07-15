// Pure state-machine tests for web/src/lib/readCursorStash.ts.
//
// This is the unit guard for the P1-WEB-004 arm-time stash extracted from
// ChatView.tsx: a throttled leading-edge capture of the OUTGOING session's read
// position, flushed (under a monotonic guard) on session switch so the <400ms
// switch gap does not lose the read cursor. The stash was previously inlined as
// the `armedCand` / `lastArmMs` closures in ChatView with zero coverage.
//
// The helper is pure (no Solid, no DOM): the clock is the `now` arg to arm() and
// the read-position producer is an injected `read` callback, so these tests run
// in the default node environment — no jsdom required.
//
// Contracts pinned:
//   (1) throttle window — at most one capture per throttleMs; leading edge fires
//       immediately after create/consume.
//   (2) guards — draft + no-viewport arm are no-ops (no capture, no throttle
//       advance); empty read() still advances the throttle but records nothing.
//   (3) flushForOutgoing truth table — session match + monotonic orderAhead guard.
//   (4) flushForOutgoing is non-mutating (pure decision).
//   (5) invalidateIfSession — clears only the matching session.
//   (6) consume — clears the stash AND resets the throttle (next arm is leading).
import { describe, expect, it, vi } from "vitest";
import { createReadCursorStash } from "../../src/lib/readCursorStash";

// Build an arm input with sensible defaults so each test overrides only the
// field it cares about. `read` defaults to a deterministic producer.
function armInput(opts: Partial<{
  now: number;
  draft: boolean;
  hasViewport: boolean;
  sessionId: string;
  read: () => string | undefined;
}>) {
  return {
    now: 1000,
    draft: false,
    hasViewport: true,
    sessionId: "s-A",
    read: () => "m-1",
    ...opts,
  };
}

describe("createReadCursorStash — throttle window (P1-WEB-004 leading edge)", () => {
  it("fires the first arm immediately (leading edge) after create", () => {
    const read = vi.fn(() => "m-1");
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 5_000_000, read }));
    // lastArmMs started at 0 → now-0 >= 200 → capture fires on the first call.
    expect(read).toHaveBeenCalledTimes(1);
    expect(stash.peek()).toEqual({ sid: "s-A", cand: "m-1" });
  });

  it("captures at most once per 200ms window (default throttle)", () => {
    const read = vi.fn(() => "m-1");
    const stash = createReadCursorStash();
    // Leading edge at t=1000.
    stash.arm(armInput({ now: 1000, read }));
    expect(read).toHaveBeenCalledTimes(1);
    // 199ms later — still within the window, throttled (read NOT called).
    stash.arm(armInput({ now: 1199, read }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(stash.peek()).toEqual({ sid: "s-A", cand: "m-1" });
    // Exactly 200ms after the last arm — window open again, capture fires.
    stash.arm(armInput({ now: 1200, read }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(stash.peek()).toEqual({ sid: "s-A", cand: "m-1" });
  });

  it("respects a custom throttleMs", () => {
    const read = vi.fn(() => "m-x");
    const stash = createReadCursorStash({ throttleMs: 50 });
    stash.arm(armInput({ now: 100, read }));
    stash.arm(armInput({ now: 149, read })); // <50ms → throttled
    expect(read).toHaveBeenCalledTimes(1);
    stash.arm(armInput({ now: 150, read })); // ==50ms → fires
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not advance the throttle when the time guard fails (window stays open until it passes)", () => {
    const read = vi.fn(() => "m-1");
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, read })); // leading edge, lastArmMs=1000
    // A flurry of sub-throttle calls must NOT silently push lastArmMs forward.
    for (let t = 1001; t < 1200; t++) stash.arm(armInput({ now: t, read }));
    expect(read).toHaveBeenCalledTimes(1);
    // The window still opens at exactly 1200 (200ms after the real arm at 1000),
    // proving none of the throttled calls advanced the cursor.
    stash.arm(armInput({ now: 1200, read }));
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("createReadCursorStash — arm guards", () => {
  it("draft sessions never capture (no read cursor persisted)", () => {
    const read = vi.fn(() => "m-1");
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, draft: true, read }));
    expect(read).not.toHaveBeenCalled();
    expect(stash.peek()).toBeUndefined();
    // The draft guard returns BEFORE the throttle cursor advances, so a later
    // non-draft arm still fires on its own leading edge.
    stash.arm(armInput({ now: 1000, draft: false, read }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(stash.peek()).toEqual({ sid: "s-A", cand: "m-1" });
  });

  it("no viewport never captures (nothing to read)", () => {
    const read = vi.fn(() => "m-1");
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, hasViewport: false, read }));
    expect(read).not.toHaveBeenCalled();
    expect(stash.peek()).toBeUndefined();
  });

  it("records the passed sessionId alongside the candidate", () => {
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, sessionId: "s-outgoing", read: () => "m-42" }));
    expect(stash.peek()).toEqual({ sid: "s-outgoing", cand: "m-42" });
  });

  it("advances the throttle even when read() returns nothing (empty capture)", () => {
    // Mirrors the inlined original: `lastArmMs = now` ran unconditionally inside
    // the time-guard branch, BEFORE bottommostReadFromDom. So a no-candidate arm
    // still consumes the throttle window — the next arm within 200ms is skipped.
    let calls = 0;
    const read = vi.fn(() => {
      calls++;
      return calls === 1 ? undefined : "m-late";
    });
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, read })); // read→undefined: no capture, but throttle advanced
    expect(stash.peek()).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    // Within the window → throttled (would-be second capture lost).
    stash.arm(armInput({ now: 1199, read }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(stash.peek()).toBeUndefined();
    // Window open → captures the late candidate.
    stash.arm(armInput({ now: 1200, read }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(stash.peek()).toEqual({ sid: "s-A", cand: "m-late" });
  });
});

describe("createReadCursorStash — flushForOutgoing truth table (monotonic guard)", () => {
  // order array: oldest → newest. orderAhead(cand, stored, order) is true when
  // cand is newer than stored (or stored is missing); false when equal or older.
  const order = ["m-1", "m-2", "m-3", "m-4"];

  it("writes when the stash matches prevId and the candidate is ahead of the stored anchor", () => {
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-3" }));
    const d = stash.flushForOutgoing("s-A", "m-1", order);
    expect(d).toEqual({ write: true, cand: "m-3" });
  });

  it("writes when the stash matches prevId and there is no stored anchor (first write lands)", () => {
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-2" }));
    const d = stash.flushForOutgoing("s-A", undefined, order);
    expect(d).toEqual({ write: true, cand: "m-2" });
  });

  it("does NOT write when the candidate equals the stored anchor (orderAhead false on equal)", () => {
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-3" }));
    const d = stash.flushForOutgoing("s-A", "m-3", order);
    expect(d.write).toBe(false);
    expect(d.cand).toBeUndefined();
  });

  it("does NOT write when the candidate is BEHIND the stored anchor (monotonic — re-read never lowers)", () => {
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-1" }));
    const d = stash.flushForOutgoing("s-A", "m-3", order);
    expect(d.write).toBe(false);
  });

  it("does NOT write when the stash belongs to a different session than prevId", () => {
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-3" }));
    // prevId is s-B — the stashed capture is for a different (already-flushed or
    // never-entered) session. Must not cross-apply.
    const d = stash.flushForOutgoing("s-B", undefined, order);
    expect(d.write).toBe(false);
  });

  it("does NOT write when prevId is falsy (first mount, no outgoing session)", () => {
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-3" }));
    const d = stash.flushForOutgoing(undefined, undefined, order);
    expect(d.write).toBe(false);
  });

  it("does NOT write when nothing is stashed", () => {
    const stash = createReadCursorStash();
    const d = stash.flushForOutgoing("s-A", "m-1", order);
    expect(d.write).toBe(false);
  });

  it("treats a candidate absent from order against a stored anchor as behind (indexOf -1 loses)", () => {
    // orderAhead: indexOf(cand) > indexOf(stored). A candidate not in order has
    // indexOf -1; a present stored anchor has indexOf >= 0 → -1 > k is false.
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-gone" }));
    const d = stash.flushForOutgoing("s-A", "m-2", order);
    expect(d.write).toBe(false);
  });
});

describe("createReadCursorStash — purity / non-mutation", () => {
  it("flushForOutgoing does not consume the stash (pure decision; consume is separate)", () => {
    const order = ["m-1", "m-2"];
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-2" }));
    // A flush decision must leave the stash intact so the caller can apply the
    // write and then call consume() explicitly.
    stash.flushForOutgoing("s-A", "m-1", order);
    expect(stash.peek()).toEqual({ sid: "s-A", cand: "m-2" });
  });

  it("a second flushForOutgoing on the same stash returns the same decision", () => {
    const order = ["m-1", "m-2", "m-3"];
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-3" }));
    const first = stash.flushForOutgoing("s-A", "m-1", order);
    const second = stash.flushForOutgoing("s-A", "m-1", order);
    expect(second).toEqual(first);
    expect(second).toEqual({ write: true, cand: "m-3" });
  });
});

describe("createReadCursorStash — invalidateIfSession (caught-up sites)", () => {
  it("clears the stash when sid matches", () => {
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-3" }));
    stash.invalidateIfSession("s-A");
    expect(stash.peek()).toBeUndefined();
  });

  it("leaves the stash when sid does not match", () => {
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-3" }));
    stash.invalidateIfSession("s-B");
    expect(stash.peek()).toEqual({ sid: "s-A", cand: "m-3" });
  });

  it("is a no-op when nothing is stashed", () => {
    const stash = createReadCursorStash();
    expect(() => stash.invalidateIfSession("s-A")).not.toThrow();
    expect(stash.peek()).toBeUndefined();
  });
});

describe("createReadCursorStash — consume (session-switch reset)", () => {
  it("clears the stash", () => {
    const stash = createReadCursorStash();
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-3" }));
    stash.consume();
    expect(stash.peek()).toBeUndefined();
  });

  it("resets the throttle so the next arm fires on the leading edge", () => {
    const read = vi.fn(() => "m-1");
    const stash = createReadCursorStash();
    // Arm at t=1000 → lastArmMs=1000.
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read }));
    expect(read).toHaveBeenCalledTimes(1);
    // Switch: consume() resets lastArmMs=0. The entering session re-arms on its
    // own scroll at t=1050 (only 50ms after the last arm — would normally be
    // throttled, but the reset makes it the new leading edge).
    stash.consume();
    stash.arm(armInput({ now: 1050, sessionId: "s-B", read }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(stash.peek()).toEqual({ sid: "s-B", cand: "m-1" });
  });

  it("consume on an empty stash is a safe no-op that still resets the throttle", () => {
    const read = vi.fn(() => "m-1");
    const stash = createReadCursorStash();
    stash.consume();
    // After a consume with nothing stashed, the next arm is still leading-edge.
    // (lastArmMs is 0, so the arm fires whenever now >= throttleMs — true for any
    // realistic clock; Date.now() in the component is always >> 200.)
    stash.arm(armInput({ now: 1000, read }));
    expect(read).toHaveBeenCalledTimes(1);
  });
});

// End-to-end switch sequence: arm the outgoing session, then on switch flush +
// consume, asserting the monotonic write happens exactly once and the stash is
// left clean for the entering session.
describe("createReadCursorStash — full switch sequence", () => {
  it("flushes the outgoing position on switch, then re-arms the entering session cleanly", () => {
    const order = ["m-1", "m-2", "m-3", "m-4"];
    let applied: string | undefined;
    const setReadAnchor = (_sid: string, cand: string) => {
      applied = cand;
    };
    const stash = createReadCursorStash();

    // User scrolls in s-A; the debounce has NOT fired yet (the <400ms gap).
    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-3" }));

    // Switch s-A → s-B: flush the outgoing stash under the monotonic guard.
    const prevStashed = stash.peek();
    if (prevStashed && prevStashed.sid === "s-A") {
      const d = stash.flushForOutgoing("s-A", "m-1", order);
      if (d.write && d.cand) setReadAnchor("s-A", d.cand);
    }
    stash.consume();
    expect(applied).toBe("m-3"); // outgoing position persisted despite the pending debounce
    expect(stash.peek()).toBeUndefined();

    // Entering session s-B re-arms on its own scroll (leading edge after consume).
    stash.arm(armInput({ now: 1050, sessionId: "s-B", read: () => "m-9" }));
    expect(stash.peek()).toEqual({ sid: "s-B", cand: "m-9" });
  });

  it("does not persist when the user caught up to the bottom before switching (invalidate fired first)", () => {
    const order = ["m-1", "m-2", "m-3"];
    let applied: string | undefined;
    const stash = createReadCursorStash();

    stash.arm(armInput({ now: 1000, sessionId: "s-A", read: () => "m-2" }));
    // User scrolls back to the bottom → onScrolled reached-bottom / flushReadCursor
    // nearBottom branch invalidates the stash (a stale mid-history capture must
    // NOT survive a return-to-bottom → switch sequence).
    stash.invalidateIfSession("s-A");
    expect(stash.peek()).toBeUndefined();

    // Switch: nothing stashed → no write.
    const d = stash.flushForOutgoing("s-A", undefined, order);
    if (d.write && d.cand) applied = d.cand;
    stash.consume();
    expect(applied).toBeUndefined();
  });
});

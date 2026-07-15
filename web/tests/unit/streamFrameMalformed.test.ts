// @vitest-environment jsdom
// Unit tests for applyTreeFrame — the P1-WEB-043 hardening of the Stream-1
// (tree) event listeners against a malformed MessageEvent.data payload.
//
// The contract (see the applyTreeFrame doc comment in src/sync/stream.ts):
//   - a malformed frame MUST NOT throw out of the public surface;
//   - the resume cursor MUST still advance to the frame's seq, so a permanently-
//     bad frame the server keeps resending from the saved cursor can't wedge
//     reconnect in an infinite replay loop;
//   - the store MUST NOT be mutated by a malformed frame (the apply fn is not
//     invoked);
//   - a well-formed frame dispatches to the apply fn byte-identically to the
//     legacy inline `applySessionEvent(kind, seq, JSON.parse(ev.data))`.
//
// applyTreeFrame takes the apply fn as a parameter (injectable), so the
// malformed-PARSE contract is unit-testable in isolation without an
// EventSource — mirroring the applySessionSnapshot extraction precedent.
// jsdom is required because advanceCursor → persist() schedules via
// window.setTimeout.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import { applyTreeFrame, applySessionEvent } from "../../src/sync/stream";
import { state, setState } from "../../src/sync/store";

// Reset only the slices these tests touch (sessions + cursor). Solid's setState
// MERGES objects, so reconcile({}) is used to truly empty a slice — the
// selectors.test.ts / applySnapshot.test.ts convention.
beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("cursor", 0);
});

describe("applyTreeFrame — malformed MessageEvent.data hardening (P1-WEB-043)", () => {
  it("does not throw on a malformed (non-JSON) data payload", () => {
    const apply = vi.fn();
    // The exact shape a corrupt/garbled SSE frame's .data would carry: a string
    // that is not valid JSON.
    expect(() => applyTreeFrame("session.upsert", 42, "{not json", apply)).not.toThrow();
  });

  it("does not invoke the apply fn on a malformed frame (store left untouched)", () => {
    const apply = vi.fn();
    applyTreeFrame("session.upsert", 42, "}}garbage{{", apply);
    expect(apply).not.toHaveBeenCalled();
  });

  it("still advances the resume cursor to the frame's seq on a malformed frame", () => {
    // The core anti-wedge guarantee: even though the frame is garbage, the
    // cursor moves past it so the server's resume replay (events with seq >
    // cursor) skips it instead of resending → re-throwing → looping forever.
    const apply = vi.fn();
    setState("cursor", 10);
    applyTreeFrame("session.upsert", 99, "not json at all", apply);
    expect(state.cursor).toBe(99);
  });

  it("does not advance the cursor when seq is falsy (0), even on malformed input", () => {
    // Mirrors advanceCursor's own `if (seq)` guard: a seq of 0 means "no SSE id
    // on this frame" — advancing to 0 would RESET the resume point. A malformed
    // frame with no id must not corrupt the cursor.
    const apply = vi.fn();
    setState("cursor", 50);
    applyTreeFrame("session.upsert", 0, "garbage", apply);
    expect(state.cursor).toBe(50);
  });

  it("end-to-end: a malformed frame through the REAL applySessionEvent advances cursor without mutating sessions", () => {
    // The production call site passes applySessionEvent. A malformed frame must
    // advance the cursor (resume skips it) but leave the session store empty —
    // proving the cursor-accounting fix holds against the real reducer path,
    // not just an injected spy.
    setState("cursor", 7);
    setState("sessions", reconcile({}));
    applyTreeFrame("session.upsert", 123, "{broken", applySessionEvent);
    expect(state.cursor).toBe(123);
    expect(Object.keys(state.sessions)).toHaveLength(0);
  });

  it("dispatches to apply on a well-formed frame (byte-identical to the legacy inline parse)", () => {
    // Regression guard: the hardening must not change well-formed behavior. The
    // apply fn receives (kind, seq, parsedPayload) exactly as the old
    // `applySessionEvent(kind, seq, JSON.parse(ev.data))` did.
    const seen: Array<{ kind: string; seq: number; payload: unknown }> = [];
    const apply = (kind: string, seq: number, payload: unknown) => seen.push({ kind, seq, payload });
    applyTreeFrame("session.upsert", 5, '{"id":"s1"}', apply);
    expect(seen).toEqual([{ kind: "session.upsert", seq: 5, payload: { id: "s1" } }]);
  });

  it("does not advance the cursor twice on a well-formed frame (apply owns cursor advancement)", () => {
    // On the success path applyTreeFrame only PARSES — cursor advancement is the
    // apply fn's job (applySessionEvent/applyMessageEvent via trackCursor). The
    // extracted wrapper must not double-advance. Use the real applySessionEvent
    // (which sets s.cursor = seq) and confirm the cursor lands on seq exactly.
    setState("cursor", 3);
    applyTreeFrame("session.delete", 77, '{"id":"sX"}', applySessionEvent);
    expect(state.cursor).toBe(77);
  });

  it("propagates a throw from the apply fn (only the PARSE is hardened, by design)", () => {
    // Deliberate scope: applyTreeFrame wraps JSON.parse, NOT the apply call. The
    // apply fns (applySessionEvent/applyMessageEvent) are already defensive
    // (optional chaining throughout) and never throw on arbitrary shapes; a
    // throw from them is a genuine reducer bug that must SURFACE, not be
    // swallowed + cursor-advanced (which would silently lose a well-formed
    // frame's mutation). This guards against accidentally widening the try block.
    const apply = () => {
      throw new Error("reducer bug");
    };
    expect(() => applyTreeFrame("session.upsert", 1, '{"id":"s1"}', apply)).toThrow("reducer bug");
  });
});

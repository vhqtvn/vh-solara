// @vitest-environment jsdom
// Slice A (send-net-resilience) — the D1 snapshot-clobber closure + the
// epoch-identity discipline (adjudication 1) at the REAL applySnapshot /
// applyScopedSnapshot / reconcileEvent seams. RED-first invariants from the
// research packet §Q7 slice-A:
//   (1) a snapshot with snap.seq < acceptedCursor (same epoch) never rewinds
//       cursor/state;
//   (2) an epoch change ⇒ full invalidate + NO cross-epoch seq compare
//       (the rebuild re-baselines the cursor even when numerically smaller);
//   plus: cross-epoch HTTP-provenance snapshots are discarded + trigger an
//   epoch-reset recovery; the live-event cursor advance becomes a ratchet
//   (the session-stream sesCursor guard generalized).
import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { applySnapshot, applyScopedSnapshot, applySessionEvent, applyMessageEvent } from "../../src/sync/reconcile";
import { state, setState } from "../../src/sync/store";
import { readSyncDiag, _resetRecoveryCountersForTest } from "../../src/sync/recovery-reasons";
import { _resetCascadeForTest, _getCascadeStateForTest } from "../../src/sync/cascade";
import type { Snapshot } from "../../src/types";

const scopedPartial = (seq: number, epoch: string, scope: string[]): Snapshot => ({
  seq,
  epoch,
  sessions: scope.map((id) => ({ id, title: `p-${id}` })),
  partial: {
    mode: "tree-stream-1-frontier",
    scope,
    authority: {
      sessions: "frontier",
      activity: "frontier",
      gate: "frontier",
      lastAgents: "frontier",
      currentVerbs: "frontier",
      questions: "global",
      permissions: "global",
      unread: "global",
      todos: "omitted",
      statuses: "omitted",
      messages: "omitted",
    },
  },
});

beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("lastAgents", reconcile({}));
  setState("epoch", "");
  setState("epochChanged", false);
  setState("cursor", 0);
  _resetCascadeForTest();
  _resetRecoveryCountersForTest();
});

describe("INV1 — same-epoch stale snapshot never rewinds cursor/state (D1 closure)", () => {
  it("applySnapshot: snap.seq < acceptedCursor ⇒ discarded wholesale", () => {
    // Baseline snapshot accepted at seq 100 (same epoch).
    applySnapshot({ seq: 100, epoch: "e1", sessions: [{ id: "base" }] } as Snapshot);
    expect(state.cursor).toBe(100);
    // A live event advances the accepted cursor to 150 and adds a session.
    applySessionEvent("session.upsert", 150, { id: "live", title: "live" });
    expect(state.cursor).toBe(150);
    expect(state.sessions.live).toBeDefined();
    // A STALE same-epoch snapshot (a late decode / racing capture) at seq 120
    // arrives LAST. Pre-fix it wholesale-replaced sessions (dropping `live`)
    // and rewound the cursor to 120.
    applySnapshot({ seq: 120, epoch: "e1", sessions: [{ id: "stale" }] } as Snapshot);
    expect(state.cursor).toBe(150); // never rewound
    expect(state.sessions.live).toBeDefined(); // state never rewound
    expect(state.sessions.stale).toBeUndefined(); // the stale projection never landed
    expect(state.sessions.base).toBeDefined();
  });

  it("applyScopedSnapshot: same-epoch partial below the cursor ⇒ discarded", () => {
    applySnapshot({ seq: 100, epoch: "e1", sessions: [{ id: "base" }] } as Snapshot);
    applySessionEvent("session.upsert", 130, { id: "live", title: "live" });
    expect(state.cursor).toBe(130);
    applyScopedSnapshot(scopedPartial(110, "e1", ["lateScope"]));
    expect(state.cursor).toBe(130);
    expect(state.sessions.lateScope).toBeUndefined();
  });

  it("a same-epoch snapshot AT/ABOVE the cursor still applies and advances monotonically", () => {
    applySnapshot({ seq: 100, epoch: "e1", sessions: [{ id: "base" }] } as Snapshot);
    applySnapshot({ seq: 100, epoch: "e1", sessions: [{ id: "base2" }] } as Snapshot);
    expect(state.cursor).toBe(100); // equal — no-op advance
    applySnapshot({ seq: 180, epoch: "e1", sessions: [{ id: "base3" }] } as Snapshot);
    expect(state.cursor).toBe(180); // forward advance
    expect(state.sessions.base3).toBeDefined();
  });
});

describe("INV2 — epoch change ⇒ full invalidate, no cross-epoch seq compare", () => {
  it("a cross-epoch stream snapshot rebuilds and re-baselines the cursor (even downward)", () => {
    applySnapshot({ seq: 900, epoch: "eA", sessions: [{ id: "old1" }], lastAgents: { old1: "x" } } as Snapshot);
    expect(state.cursor).toBe(900);
    applySessionEvent("session.upsert", 950, { id: "old2", title: "o2" });
    expect(state.cursor).toBe(950);
    expect(state.sessions.old2).toBeDefined();
    // Daemon restart: the rebuild snapshot carries a NEW random epoch and a
    // seq that is numerically SMALLER — comparing across epochs is forbidden;
    // the rebuild re-baselines.
    applySnapshot({ seq: 40, epoch: "eB", sessions: [{ id: "new1" }] } as Snapshot);
    expect(state.epoch).toBe("eB");
    expect(state.cursor).toBe(40); // re-baselined DOWN — no cross-epoch compare
    expect(state.sessions.old1).toBeUndefined(); // prior-epoch detail invalidated
    expect(state.sessions.old2).toBeUndefined();
    expect(state.sessions.new1).toBeDefined();
  });

  it("a cross-epoch scoped partial rebuild clears prior-epoch frontier detail (existing invalidate preserved)", () => {
    applySnapshot({ seq: 10, epoch: "eA", sessions: [{ id: "buried" }, { id: "front" }] } as Snapshot);
    applyScopedSnapshot(scopedPartial(11, "eB", ["front"]));
    expect(state.epoch).toBe("eB");
    expect(state.sessions.front).toBeDefined();
    expect(state.sessions.buried).toBeUndefined(); // epoch-change clear (transition 9)
  });
});

describe("cross-epoch HTTP provenance — discard + conservative epoch-reset re-sync", () => {
  it("an http detail bundle from another store lifetime is discarded and requests epoch-reset", () => {
    applySnapshot({ seq: 500, epoch: "eA", sessions: [{ id: "keep" }] } as Snapshot);
    expect(state.cursor).toBe(500);
    // The expand-children HTTP detail bundle raced a daemon restart.
    applyScopedSnapshot(scopedPartial(3, "eB", ["httpScope"]), "http");
    expect(state.epoch).toBe("eA");
    expect(state.cursor).toBe(500);
    expect(state.sessions.httpScope).toBeUndefined();
    expect(state.sessions.keep).toBeDefined();
    // The conservative re-sync was requested (counted reason; cascade pass).
    expect(readSyncDiag().recovery["epoch-reset"]?.count).toBeGreaterThanOrEqual(1);
    expect(_getCascadeStateForTest().lastReasons).toContain("epoch-reset");
  });

  it("an http bundle matching the live epoch still applies (no false discard)", () => {
    applySnapshot({ seq: 500, epoch: "eA", sessions: [{ id: "keep" }] } as Snapshot);
    applyScopedSnapshot(scopedPartial(505, "eA", ["httpScope"]), "http");
    expect(state.sessions.httpScope).toBeDefined();
    expect(state.cursor).toBe(505);
  });
});

describe("live-event cursor ratchet (the sesCursor guard generalized)", () => {
  it("a tracked event with a LOWER seq never rewinds the accepted cursor", () => {
    applySnapshot({ seq: 200, epoch: "e1", sessions: [] } as Snapshot);
    expect(state.cursor).toBe(200);
    // An out-of-order/replayed event frame (pre-fix: unconditional rewind).
    applyMessageEvent("lastAgent.set", 150, { sessionID: "s", agent: "a" });
    expect(state.cursor).toBe(200);
    expect(state.lastAgents.s).toBe("a"); // the projection itself still applied
    // Forward events still advance.
    applyMessageEvent("lastAgent.set", 210, { sessionID: "s", agent: "b" });
    expect(state.cursor).toBe(210);
  });
});

describe("back-compat — legacy (no-epoch) snapshots keep today's apply semantics", () => {
  it("a legacy snapshot with no epoch field applies and sets the cursor (boot/old daemon)", () => {
    applySnapshot({ seq: 42, sessions: [{ id: "legacy" }] } as Snapshot);
    expect(state.cursor).toBe(42);
    expect(state.sessions.legacy).toBeDefined();
  });
});

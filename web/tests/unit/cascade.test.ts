// @vitest-environment jsdom
// Slice A (send-net-resilience) — the convergence cascade (AMEND-A5): the
// generation-keyed, coalescing, supersession-aware recovery supervisor in
// src/sync/cascade.ts. BINDING CONTRACT:
// researches/decisions/2026-10-10-send-convergence-cascade-and-connstatus.md.
// These are the RED-first invariants the decision record
// binds:
//   (3) N overlapping triggers within one window ⇒ exactly ONE cascade executes
//   (4) superseded cascade's late outputs do not commit after a newer generation
//   (5) flapping tunnel (repeated drop/restore) converges without unbounded
//       snapshot stacking
// plus AMEND-A5 flapping (reason storm → one pass; supersession mid-pass),
// epoch-reset, server-ring-gap (SSE cause:"reconnect" consumption), and the
// unified queue-reconcile trigger.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import {
  requestRecovery,
  noteExternalRecovery,
  noteTreeConverged,
  noteSessionConverged,
  noteServerRingGap,
  notifyStreamLive,
  guardSnapshotApply,
  setQueueReconcileTrigger,
  clearQueueReconcileTrigger,
  _resetCascadeForTest,
  _getCascadeStateForTest,
  _setCascadeTimeoutForTest,
} from "../../src/sync/cascade";
import { state, setState } from "../../src/sync/store";
import { readSyncDiag, _resetRecoveryCountersForTest } from "../../src/sync/recovery-reasons";
import * as diaglog from "../../src/sync/diaglog";

// Flush the pass-completion microtask (the queue trigger fires on a microtask
// so it never runs inside a Solid batch / listener frame).
const flushMicro = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const scopedPartial = (seq: number, epoch: string, scope: string[]) => ({
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
    } as Record<string, "global" | "frontier" | "omitted">,
  },
});

beforeEach(() => {
  // Reset the singleton store slices these tests touch (applySnapshot.test.ts
  // convention: Solid setState MERGES, so reconcile({}) truly empties a slice).
  setState("sessions", reconcile({}));
  setState("epoch", "");
  setState("epochChanged", false);
  setState("cursor", 0);
  setState("authoritativeReady", false);
  _resetCascadeForTest();
  _resetRecoveryCountersForTest();
  _setCascadeTimeoutForTest(15_000);
});

describe("cascade — coalescing (invariant 3 + AMEND-A5 reason storm)", () => {
  it("N overlapping triggers within one window ⇒ exactly ONE cascade executes", async () => {
    setState("epoch", "e1");
    setState("cursor", 100);
    const direct = vi.fn();
    const trigger = vi.fn();
    setQueueReconcileTrigger(trigger);
    // A reason storm: five gap forces + two watchdog stale forces, one window.
    for (let i = 0; i < 5; i++) requestRecovery("tree-seq-gap", direct, { tree: "fresh" });
    requestRecovery("tree-transport-stale", direct, { tree: "resume" });
    requestRecovery("tree-idle-stale", direct, { tree: "resume" });
    // ONE recovery action executed; the rest coalesced into the running pass.
    expect(direct).toHaveBeenCalledTimes(1);
    const st = _getCascadeStateForTest();
    expect(st.started).toBe(1);
    expect(st.coalesced).toBe(6);
    expect(st.inFlight).toBe(true);
    // Convergence fires the queue-reconcile trigger exactly once.
    noteTreeConverged();
    await flushMicro();
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(_getCascadeStateForTest().queueTriggers).toBe(1);
    expect(_getCascadeStateForTest().inFlight).toBe(false);
    // The storm's reasons were canonicalized into the single pass's reason-set.
    expect(_getCascadeStateForTest().lastReasons).toEqual(
      expect.arrayContaining(["tree-seq-gap", "tree-transport-stale", "tree-idle-stale"]),
    );
  });

  it("a coalesced multi-stream storm runs each DISTINCT stream's action once and awaits both convergences", async () => {
    setState("epoch", "e1");
    const treeDirect = vi.fn();
    const sesDirect = vi.fn();
    const trigger = vi.fn();
    setQueueReconcileTrigger(trigger);
    requestRecovery("tree-seq-gap", treeDirect, { tree: "fresh" });
    // A soft session reason mid-pass: coalesces into the SAME pass — its
    // reason unions in, the pass adds the session step and runs that action
    // (a distinct stream's recovery is never dropped) — but the pass stays
    // ONE (no second cascade).
    requestRecovery("idle-content-stale", sesDirect, { session: "fresh" });
    expect(_getCascadeStateForTest().started).toBe(1);
    expect(treeDirect).toHaveBeenCalledTimes(1);
    expect(sesDirect).toHaveBeenCalledTimes(1);
    // A DUPLICATE tree reason now coalesces fully (tree step already pending)
    // — the redundant reconnect is the work the cascade exists to dedupe.
    requestRecovery("tree-transport-stale", treeDirect, { tree: "resume" });
    expect(treeDirect).toHaveBeenCalledTimes(1);
    noteTreeConverged();
    await flushMicro();
    // Session step still pending → no trigger yet.
    expect(trigger).not.toHaveBeenCalled();
    expect(_getCascadeStateForTest().inFlight).toBe(true);
    noteSessionConverged();
    await flushMicro();
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});

describe("cascade — supersession (invariant 4 + AMEND-A5 mid-pass)", () => {
  it("an epoch change mid-pass supersedes; the superseded pass's late output never commits", async () => {
    _setCascadeTimeoutForTest(15);
    setState("epoch", "e1");
    setState("cursor", 10);
    const directA = vi.fn();
    const directB = vi.fn();
    const trigger = vi.fn();
    setQueueReconcileTrigger(trigger);
    requestRecovery("tree-transport-stale", directA, { tree: "resume" }); // pass A
    // Daemon restarts mid-pass (a rebuild snapshot landed elsewhere).
    setState("epoch", "e2");
    requestRecovery("tree-seq-gap", directB, { tree: "fresh" }); // supersedes A
    expect(directB).toHaveBeenCalledTimes(1);
    expect(_getCascadeStateForTest().superseded).toBe(1);
    expect(_getCascadeStateForTest().started).toBe(2);
    // Pass B converges → exactly ONE trigger (B's — A was superseded).
    noteTreeConverged();
    await flushMicro();
    expect(trigger).toHaveBeenCalledTimes(1);
    // A's would-be late timeout window elapses (15ms) — no further commit.
    await new Promise((r) => setTimeout(r, 40));
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(_getCascadeStateForTest().inFlight).toBe(false);
  });

  it("a proven loss whose implied steps ALL converged supersedes the running pass", async () => {
    setState("epoch", "e1");
    const sesDirect = vi.fn();
    const treeDirect = vi.fn();
    const trigger = vi.fn();
    setQueueReconcileTrigger(trigger);
    // Soft session-only pass; its tree step is undeclared (nothing awaited).
    requestRecovery("idle-content-stale", sesDirect, { session: "fresh" });
    expect(sesDirect).toHaveBeenCalledTimes(1);
    // A tree loss arrives: tree is "converged" for the running pass (undeclared)
    // ⇒ the pass cannot absorb a proven tree loss ⇒ supersede.
    requestRecovery("tree-seq-gap", treeDirect, { tree: "fresh" });
    expect(_getCascadeStateForTest().superseded).toBe(1);
    expect(treeDirect).toHaveBeenCalledTimes(1);
    // The superseding pass INHERITED the unconverged session step (same epoch):
    // tree alone must not fire the trigger.
    noteTreeConverged();
    await flushMicro();
    expect(trigger).not.toHaveBeenCalled();
    noteSessionConverged();
    await flushMicro();
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});

describe("cascade — flapping (invariant 5)", () => {
  it("repeated drop/restore storms converge with bounded passes — no stacking", async () => {
    setState("epoch", "e1");
    const trigger = vi.fn();
    setQueueReconcileTrigger(trigger);
    for (let cycle = 0; cycle < 3; cycle++) {
      const direct = vi.fn();
      requestRecovery("tree-seq-gap", direct, { tree: "fresh" });
      requestRecovery("tree-transport-stale", direct, { tree: "resume" });
      requestRecovery("tree-idle-stale", direct, { tree: "resume" });
      expect(direct).toHaveBeenCalledTimes(1); // one action per cycle
      noteTreeConverged(); // the restore delivers the baseline
      await flushMicro();
      expect(_getCascadeStateForTest().inFlight).toBe(false); // cleared before the next cycle
    }
    expect(_getCascadeStateForTest().started).toBe(3); // one pass per cycle, never stacked
    expect(trigger).toHaveBeenCalledTimes(3);
  });
});

describe("cascade — epoch-reset (cross-epoch discipline, adjudication 1)", () => {
  it("an http-provenance cross-epoch snapshot is discarded by the guard", () => {
    setState("epoch", "eA");
    setState("cursor", 500);
    const v = guardSnapshotApply({ seq: 3, epoch: "eB", sessions: [] } as any, "http");
    expect(v.apply).toBe(false);
    expect(v.discard).toBe("stale-epoch");
  });

  it("a stream-provenance cross-epoch snapshot is a trusted rebuild (rebaseline)", () => {
    setState("epoch", "eA");
    setState("cursor", 500);
    const v = guardSnapshotApply({ seq: 3, epoch: "eB", sessions: [] } as any, "stream");
    expect(v.apply).toBe(true);
    expect(v.rebaseline).toBe(true);
  });

  it("a same-epoch snapshot below the accepted cursor is discarded (D1)", () => {
    setState("epoch", "eA");
    setState("cursor", 500);
    const v = guardSnapshotApply({ seq: 499, epoch: "eA", sessions: [] } as any, "stream");
    expect(v.apply).toBe(false);
    expect(v.discard).toBe("stale-seq");
  });

  it("epoch-reset requests a tree-fresh pass (conservative re-sync)", () => {
    setState("epoch", "eA");
    const direct = vi.fn();
    requestRecovery("epoch-reset", direct, { tree: "fresh" });
    expect(direct).toHaveBeenCalledTimes(1);
    expect(_getCascadeStateForTest().lastReasons).toContain("epoch-reset");
  });
});

describe("cascade — server ring-gap (partial.ringGap precise signal, Slice B)", () => {
  it("counts server-ring-gap and fires the queue trigger at tree convergence", async () => {
    // Slice B: noteServerRingGap is consumed from the transport's `snapshot`
    // listener on partial.ringGap=true (the server's sole true-gap stamp,
    // server.go :3019-3021); the coarse tree.snapshot cause:"reconnect" is now
    // benign telemetry ("server-reconnect-resume"). The cascade surface itself
    // (count + tree-await pass + trigger-at-convergence) is unchanged.
    setState("epoch", "e1");
    setState("authoritativeReady", false);
    const trigger = vi.fn();
    setQueueReconcileTrigger(trigger);
    noteServerRingGap();
    expect(readSyncDiag().recovery["server-ring-gap"]?.count).toBe(1);
    expect(_getCascadeStateForTest().inFlight).toBe(true);
    expect(trigger).not.toHaveBeenCalled(); // tree convergence pending
    noteTreeConverged();
    await flushMicro();
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});

describe("cascade — unified queue-reconcile trigger (stream-live reconnect)", () => {
  it("notifyStreamLive awaits pending tree convergence before the trigger", async () => {
    setState("authoritativeReady", false);
    const trigger = vi.fn();
    setQueueReconcileTrigger(trigger);
    notifyStreamLive();
    expect(_getCascadeStateForTest().inFlight).toBe(true);
    expect(trigger).not.toHaveBeenCalled();
    noteTreeConverged();
    await flushMicro();
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(readSyncDiag().recovery["cascade-queue-reconcile"]?.count).toBe(1);
  });

  it("with the tree already authoritative the trigger fires on a microtask", async () => {
    setState("authoritativeReady", true);
    const trigger = vi.fn();
    setQueueReconcileTrigger(trigger);
    notifyStreamLive();
    await flushMicro();
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("clearQueueReconcileTrigger disarms (token-guarded)", async () => {
    setState("authoritativeReady", true);
    const trigger = vi.fn();
    const token = setQueueReconcileTrigger(trigger);
    clearQueueReconcileTrigger(token);
    notifyStreamLive();
    await flushMicro();
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe("cascade — pass timeout (bounded, no wedge)", () => {
  it("a never-converging pass times out WITHOUT the queue trigger; the next request starts fresh", async () => {
    _setCascadeTimeoutForTest(10);
    const trigger = vi.fn();
    setQueueReconcileTrigger(trigger);
    requestRecovery("tree-seq-gap", vi.fn(), { tree: "fresh" });
    await new Promise((r) => setTimeout(r, 40));
    expect(trigger).not.toHaveBeenCalled();
    expect(_getCascadeStateForTest().inFlight).toBe(false);
    const direct = vi.fn();
    requestRecovery("tree-seq-gap", direct, { tree: "fresh" });
    expect(direct).toHaveBeenCalledTimes(1); // a fresh pass runs after the timeout
    expect(_getCascadeStateForTest().started).toBe(2);
  });
});

describe("cascade — external-recovery observation (direct-action paths)", () => {
  it("noteExternalRecovery unions the reason into a running pass without starting one", () => {
    setState("epoch", "e1");
    requestRecovery("tree-transport-stale", vi.fn(), { tree: "resume" });
    noteExternalRecovery("tree-overlap-capture");
    expect(_getCascadeStateForTest().started).toBe(1);
    expect(_getCascadeStateForTest().lastReasons).toContain("tree-overlap-capture");
    // With no pass in flight it is a pure no-op.
    noteTreeConverged();
    noteExternalRecovery("resume-silent-fallback");
    expect(_getCascadeStateForTest().started).toBe(1);
  });
});

describe("cascade — generation key", () => {
  it("the pass's generation key binds (epoch, acceptedCursor, canonical reason-set)", () => {
    setState("epoch", "e1");
    setState("cursor", 4242);
    requestRecovery("tree-seq-gap", vi.fn(), { tree: "fresh" });
    requestRecovery("tree-transport-stale", vi.fn(), { tree: "resume" });
    const st = _getCascadeStateForTest();
    expect(st.lastGenKey?.epoch).toBe("e1");
    expect(st.lastGenKey?.acceptedCursor).toBe(4242);
    // Canonical = sorted, deduped.
    expect(st.lastGenKey?.reasons).toEqual(["tree-seq-gap", "tree-transport-stale"]);
  });
});

// ── Pass-boundary diag stamps (capture-2, card ──────────────────────────────
// task-2026-10-29t06-06-05): the cascade stamps its pass LIFECYCLE edges
// (start / step convergence / completion / the 15s timeout / supersession)
// into the default-OFF diaglog ring — bounded by construction (edges only,
// never per-tick), so a future capture shows the convergence cascade's
// timeline next to the conn-grade + stream-open stamps in the same ring.
describe("cascade — pass-boundary diag stamps (capture-2, 2026-10-29)", () => {
  beforeEach(() => {
    localStorage.clear();
    diaglog._resetDiagForTest();
    diaglog.setDiagLogOn(true);
  });
  afterEach(() => {
    diaglog.setDiagLogOn(false);
    localStorage.clear();
    diaglog._resetDiagForTest();
  });

  const cascadeEntries = (): diaglog.CascadeDiagEntry[] =>
    diaglog.diagEntries().filter((e): e is diaglog.CascadeDiagEntry => e.kind === "cascade");

  it("a converging pass stamps pass-start → step-converged → pass-converged, in ring order", async () => {
    setState("epoch", "e1");
    setQueueReconcileTrigger(() => {});
    requestRecovery("tree-seq-gap", vi.fn(), { tree: "fresh" });
    expect(cascadeEntries().map((e) => e.event)).toEqual(["pass-start"]);
    const start = cascadeEntries()[0];
    expect(start.reasons).toEqual(["tree-seq-gap"]);
    expect(start.pending).toEqual(["tree"]);

    noteTreeConverged();
    await flushMicro();
    const evs = cascadeEntries();
    expect(evs.map((e) => e.event)).toEqual(["pass-start", "step-converged", "pass-converged"]);
    expect(evs[1].stream).toBe("tree");
    expect(evs[2].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(evs[2].pending).toBeUndefined(); // converged = nothing pending
    // The rendered line is capture-readable (the "Copy all" surface).
    expect(diaglog.entryLine(evs[2])).toContain("cascade event=pass-converged");
    expect(diaglog.entryLine(evs[2])).toContain("reasons=tree-seq-gap");
    expect(diaglog.entryLine(evs[2])).toContain("elapsed=");
  });

  it("a multi-step pass stamps each step's convergence (tree then session)", async () => {
    setState("epoch", "e1");
    setQueueReconcileTrigger(() => {});
    requestRecovery("tree-seq-gap", vi.fn(), { tree: "fresh" });
    requestRecovery("idle-content-stale", vi.fn(), { session: "fresh" });
    noteTreeConverged();
    await flushMicro();
    noteSessionConverged();
    await flushMicro();
    expect(cascadeEntries().map((e) => [e.event, e.stream ?? null])).toEqual([
      ["pass-start", null],
      ["step-converged", "tree"],
      ["step-converged", "session"],
      ["pass-converged", null],
    ]);
  });

  it("the pass timeout stamps pass-timeout with the still-pending steps + elapsed (the 15s ceiling, observable)", async () => {
    _setCascadeTimeoutForTest(10);
    setQueueReconcileTrigger(() => {});
    requestRecovery("tree-seq-gap", vi.fn(), { tree: "fresh" });
    await new Promise((r) => setTimeout(r, 40));
    const evs = cascadeEntries();
    expect(evs.map((e) => e.event)).toEqual(["pass-start", "pass-timeout"]);
    const t = evs[1];
    expect(t.pending).toEqual(["tree"]);
    // NOT >= the 10ms timer setting: setTimeout can fire marginally EARLY vs
    // a Date.now() delta (observed 9ms on a 10ms timer under multi-worker
    // load — timer clamping vs wall-clock coarseness). The stamp's content
    // is the event + pending set; elapsed only needs to be present + sane.
    expect(t.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(diaglog.entryLine(t)).toContain("cascade event=pass-timeout");
    expect(diaglog.entryLine(t)).toContain("pending=tree");
  });

  it("supersession stamps the dying pass's boundary before the successor's start (S1 epoch change)", async () => {
    setState("epoch", "e1");
    setQueueReconcileTrigger(() => {});
    requestRecovery("tree-transport-stale", vi.fn(), { tree: "resume" }); // pass A
    setState("epoch", "e2"); // daemon restart mid-pass
    requestRecovery("tree-seq-gap", vi.fn(), { tree: "fresh" }); // supersedes A
    noteTreeConverged(); // pass B converges
    await flushMicro();
    expect(cascadeEntries().map((e) => e.event)).toEqual([
      "pass-start", // A
      "pass-superseded", // A died (S1) — before B's start
      "pass-start", // B
      "step-converged",
      "pass-converged",
    ]);
    const sup = cascadeEntries()[1];
    expect(sup.reasons).toEqual(["tree-transport-stale"]);
    expect(sup.pending).toEqual(["tree"]); // A's unconverged step at death
  });

  it("no cascade stamps while capture is off (the default)", async () => {
    diaglog.setDiagLogOn(false); // the describe's beforeEach enabled it — flip back
    setQueueReconcileTrigger(() => {});
    requestRecovery("tree-seq-gap", vi.fn(), { tree: "fresh" });
    noteTreeConverged();
    await flushMicro();
    expect(cascadeEntries()).toEqual([]);
  });
});

// state is intentionally referenced by the harness (store slices reset above);
// keep the import live for future assertions without tripping unused linting.
void state;

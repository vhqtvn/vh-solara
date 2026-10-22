// @vitest-environment jsdom
//
// switchProject epoch adoption — the project-switch produce block must CLEAR
// the epoch state (s.epoch = "" + the epochChanged latch) so an in-session
// A→B switch behaves like a fresh boot of B, not like a daemon restart.
//
// Stores — and their crypto-random epochs — are PER-PROJECT-AGGREGATOR
// (pkg/aggregator/aggregator.go:334–339 builds one store per dir;
// pkg/web/server_aggregators.go:264 lazily one aggregator per project), and
// the tree stream targets the per-project store (dir= on the URL), so an
// in-session switch carries two non-empty epochs. Pre-fix, the SPA never
// reset state.epoch on a switch, so B's first frontier-scoped partial (epoch
// eB) diffed against A's latched eA and the epoch-changed guard fired:
//   1. the epoch-clear in projectScopedPartial (reconcile.ts) WIPED the
//      produce block's fresh localStorage re-seeds of B's activity/lastAgents
//      — buried (non-frontier) B sessions lost their chips until a
//      full-snapshot path, while a fresh page load of B (prevEpoch "" → no
//      clear) preserved them: inconsistent;
//   2. epochChanged latched → the ConnectionToast fired a spurious
//      "vh-solara restarted — re-syncing…" toast (persists under the e-ink
//      quiet profile).
// The fix clears the epoch in switchProject's produce block, so the guard
// takes the empty-prev-epoch BOOT path (guardSnapshotApply: apply +
// rebaseline — the same verdict a genuine first load of B receives).
//
// Sibling of switchProjectResetParity.test.ts (same harness) because that
// suite pins per-session SURFACE resets while this one pins the epoch
// SCALARS + buried re-seed survival — different setup (localStorage-seeded
// re-seeds, an applied A-frame to latch an epoch) and different assertions.
//
// RED-FIRST: assertions (a)/(b) below fail pre-fix — (a) because the latch
// fired, (b) because the epoch-clear wiped the buried re-seeded entries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import { connect } from "../../src/sync/tree-transport";
import { closeSessionStream } from "../../src/sync/session-stream";
import { setProjectDirRaw, setState, state, lsActivity, lsLastAgents } from "../../src/sync/store";
import { resetTreeStore } from "../../src/sync/treeState";
import { switchProject } from "../../src/sync/actions";
import { applyScopedSnapshot } from "../../src/sync/reconcile";
import { saveVersioned } from "../../src/lib/store";

// --- Mock EventSource (mirrors switchProjectResetParity.test.ts) ---
// jsdom doesn't implement EventSource. switchProject → connect() constructs
// one per project; we only need construction + close to not throw. Frames
// are delivered at the reconcile seam (applyScopedSnapshot), not via SSE.
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class MockEventSource {
  static CLOSED = CLOSED;
  static OPEN = OPEN;
  static CONNECTING = CONNECTING;

  url: string;
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(): void {
    /* no SSE frame delivery in this suite */
  }

  close(): void {
    this.readyState = CLOSED;
  }
}

// The slices this suite seeds or asserts on — reset so a previous test's
// entries can never make an absence assertion pass or fail vacuously, and
// the epoch scalars re-boot to the store's factory values.
const SURFACES = ["sessions", "activity", "lastAgents", "gate", "currentVerbs"] as const;

beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  localStorage.clear();
  setProjectDirRaw("");
  resetTreeStore();
  for (const surface of SURFACES) setState(surface, reconcile({}));
  setState("epoch", "");
  setState("epochChanged", false);
});

afterEach(() => {
  closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

// A frame in the exact shape a fresh tree=2 connect ships for a project
// (Slice-A D7 frontier-scoped partial; same form as the parity suite's),
// parameterized by epoch/scope so both A's latch frame and B's first frame
// use the realistic wire shape.
function frontierPartial(seq: number, epoch: string, scope: string[]) {
  const inScope = scope[0];
  return {
    seq,
    epoch,
    sessions: [{ id: inScope }],
    activity: { [inScope]: "busy" },
    gate: { [inScope]: { hasMessages: true } },
    lastAgents: { [inScope]: "plan" },
    currentVerbs: { [inScope]: { tool: "edit", state: { status: "running" } } },
    questions: { [inScope]: [] },
    permissions: { [inScope]: [] },
    unread: [inScope],
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
      },
    },
  } as any;
}

describe("switchProject — epoch adoption (a switch boots B, never diffs against A)", () => {
  it("B's first frame does not fire the epoch-change clear or latch: buried re-seeded chips survive, frontier merges, epoch adopted", () => {
    // Latch an A-epoch the way a live A connection does: A's fresh connect
    // delivered a frontier partial (epoch eA), which applied via the
    // empty-prev-epoch boot path and set state.epoch = "eA".
    setProjectDirRaw("/proj-A");
    connect(true);
    expect(applyScopedSnapshot(frontierPartial(10, "eA", ["a1"]))).toBe(true);
    expect(state.epoch).toBe("eA");
    expect(state.sessions.a1?.id).toBe("a1");

    // B's persisted per-project chips — the produce block's re-seed source.
    // b1 is B's FRONTIER (the frame carries it); b2 is BURIED (non-frontier:
    // the frame's scope never includes it, so only the re-seed holds it —
    // exactly the entry class the pre-fix epoch-clear wiped).
    saveVersioned(lsActivity("/proj-B"), 1, { b1: "busy", b2: "error" });
    saveVersioned(lsLastAgents("/proj-B"), 1, { b1: "plan", b2: "review" });

    switchProject("/proj-B");

    // The re-seed landed immediately (pre-frame) for BOTH the frontier and
    // the buried id — the switch's own produce block did this.
    expect(state.activity.b2).toBe("error");
    expect(state.lastAgents.b2).toBe("review");
    expect(state.activity.b1).toBe("busy");

    // B's first frontier-scoped partial carries B's own store epoch (eB ≠
    // eA: per-project-aggregator epochs). Delivered at the reconcile seam —
    // the transport listener lands here after SSE parse.
    const applied = applyScopedSnapshot(frontierPartial(21, "eB", ["b1"]));

    // The frame APPLIED (the guard's boot path — empty prev epoch → apply +
    // rebaseline, the same verdict a fresh load of B receives).
    expect(applied).toBe(true);
    // (a) NO epoch transition latched — a project switch must not present
    // B's first frame as a daemon restart (the spurious-toast misfire).
    expect.soft(state.epochChanged).toBe(false);
    // (b) The BURIED re-seeded entries SURVIVE the frame (pre-fix the
    // epoch-clear wiped them — the red this suite was written against).
    // soft so one run reports (a) AND (b) together (parity-suite convention).
    expect.soft(state.activity.b2).toBe("error");
    expect.soft(state.lastAgents.b2).toBe("review");
    // (c) B's frontier data still merges (the fix must not overcorrect into
    // dropping the frame's own scope).
    expect(state.sessions.b1?.id).toBe("b1");
    expect(state.activity.b1).toBe("busy");
    expect(state.lastAgents.b1).toBe("plan");
    // (d) B's epoch is adopted (the boot-path apply sets it).
    expect(state.epoch).toBe("eB");
  });

  it("switching A → '' (no project) leaves the epoch cleared harmlessly — no frame ever arrives to adopt one", () => {
    // Same A-latch, then the no-project teardown: connect() early-returns on
    // the empty dir, so NO frame can arrive — the cleared epoch simply waits
    // (and the next switch away from '' boots that project the same way).
    setProjectDirRaw("/proj-A");
    connect(true);
    expect(applyScopedSnapshot(frontierPartial(10, "eA", ["a1"]))).toBe(true);
    expect(state.epoch).toBe("eA");

    switchProject("");

    expect(state.epoch).toBe("");
    expect(state.epochChanged).toBe(false);
  });
});

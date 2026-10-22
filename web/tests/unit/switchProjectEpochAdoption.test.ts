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
//
// FOLLOW-UP PINS (post-23ef65b review, both TEST-ONLY — no production change):
//   Pin 1 (tier1_b-F1): the reset's LATCH-CLEARING half, independently. The
//     first test below latches state.epoch (eA) but never latches
//     epochChanged=true BEFORE the switch, so nothing pins that an A-lifetime
//     restart latch is dropped at the switch. A genuine double-snapshot latch
//     (eA1 → eA2 on A) now covers it.
//   Pin 2 (A-F2): the HTTP-provenance expand-page detail bundle interleaved
//     after a switch — audited benign at 23ef65b, never pinned. The guard's
//     boot branch (cascade.ts:505) fires BEFORE the provenance split, so an
//     http bundle against an EMPTY state epoch boot-applies (never discards);
//     against B's adopted epoch it takes the same-epoch seq-compare path.
//     Both orders (stream-first and HTTP-racing-first) are pinned.
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
  // Cursor, unlike the slices above, is a scalar the frames re-baseline on
  // their first boot-path apply — but reset it anyway so a prior test's cursor
  // can never leak into a test that asserts monotonic-advance values.
  setState("cursor", 0);
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

// The expand-children HTTP detail bundle — the frame shape the server stamps
// in ExpandChildrenWithDetail (pkg/state/tree_emitter.go:1152–1161): the
// page's node IDs as scope, mode "expand-page", the same authority tags as
// the frontier frame. The expand fetch path installs it via
// applyScopedSnapshot(…, "http") (tree-transport.ts:1829–1837). Unlike
// frontierPartial (one frontier id), this fills EVERY page id so a multi-id
// expand page exercises the merge across scope.
function pageDetailBundle(seq: number, epoch: string, scope: string[]) {
  const activity: Record<string, string> = {};
  const gate: Record<string, { hasMessages: boolean }> = {};
  const lastAgents: Record<string, string> = {};
  const currentVerbs: Record<string, unknown> = {};
  for (const id of scope) {
    activity[id] = "busy";
    gate[id] = { hasMessages: true };
    lastAgents[id] = "plan";
    currentVerbs[id] = { tool: "edit", state: { status: "running" } };
  }
  return {
    seq,
    epoch,
    sessions: scope.map((id) => ({ id })),
    activity,
    gate,
    lastAgents,
    currentVerbs,
    questions: {},
    permissions: {},
    unread: [],
    partial: {
      mode: "expand-page",
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

  it("Pin 1 — an epochChanged latched during A's lifetime is cleared at the switch: B's boot inherits no A restart latch", () => {
    // GENUINE latch construction (no direct setState): two A frames with
    // DIFFERENT store epochs, the way a real A-restart looks at this seam.
    setProjectDirRaw("/proj-A");
    connect(true);
    // A boots: the first frame adopts eA1 via the empty-prev-epoch boot path
    // (changed === false — a first adoption is not a transition).
    expect(applyScopedSnapshot(frontierPartial(10, "eA1", ["a1"]))).toBe(true);
    expect(state.epoch).toBe("eA1");
    expect(state.epochChanged).toBe(false);
    // A's aggregator restarts: the next A frame carries a fresh crypto-random
    // epoch (eA2 ≠ eA1). Cross-epoch STREAM provenance ⇒ apply + rebaseline;
    // projectScopedPartial's epoch-change clear fires and the transition
    // latches epochChanged (reconcile.ts "if (changed) s.epochChanged = true").
    expect(applyScopedSnapshot(frontierPartial(11, "eA2", ["a1"]))).toBe(true);
    expect(state.epoch).toBe("eA2");
    // The premise itself is pinned: if this fails, the latch construction was
    // wrong — not the switch under test.
    expect(state.epochChanged).toBe(true);

    switchProject("/proj-B");

    // (a) THE PIN (pre-frame, before any B data arrives): the switch's
    // produce block dropped A's unconsumed latch. Without this half of the
    // reset, the ConnectionToast would surface A's restart notice while
    // connected to B, and projectSnapshot's resync window (reducers.ts
    // mergeLastAgents) would treat B's first full snapshot as mid-restart
    // aggregation — both boot-inconsistent for B.
    expect(state.epoch).toBe("");
    expect(state.epochChanged).toBe(false);

    // (b) B's first partial applies via the boot path and does NOT re-latch:
    // prev epoch is "" so changed === false — the guard never diffs eB
    // against A's eA2.
    expect(applyScopedSnapshot(frontierPartial(21, "eB", ["b1"]))).toBe(true);
    expect(state.epochChanged).toBe(false);
    // (c) B's data merges and B's epoch is adopted (the full boot contract).
    expect(state.sessions.b1?.id).toBe("b1");
    expect(state.activity.b1).toBe("busy");
    expect(state.epoch).toBe("eB");
  });

  it("Pin 2a — an HTTP expand-page detail bundle for B, after B's stream frame: B detail lands, no A resurrection, no latch", () => {
    // A delivered a frame pre-switch (a1 latched into sessions/activity, eA
    // adopted) — the entries whose NON-resurrection the pin asserts.
    setProjectDirRaw("/proj-A");
    connect(true);
    expect(applyScopedSnapshot(frontierPartial(10, "eA", ["a1"]))).toBe(true);
    expect(state.sessions.a1?.id).toBe("a1");

    switchProject("/proj-B");

    // B's stream frame lands first: boot path applies, adopts eB, cursor 21.
    expect(applyScopedSnapshot(frontierPartial(21, "eB", ["b1"]))).toBe(true);
    expect(state.epoch).toBe("eB");

    // The expand-children HTTP detail bundle for B (page scope b1+b2 — b2 is
    // a child the frontier frame never carried) resolves next. Guard verdict:
    // same epoch (eB) + seq above the cursor ⇒ the same-epoch seq-compare
    // apply (monotonic advance) — HTTP provenance only mistrusts a CROSS-
    // epoch identity (both non-empty, differing).
    const applied = applyScopedSnapshot(pageDetailBundle(22, "eB", ["b1", "b2"]), "http");
    expect(applied).toBe(true);
    // Correct application: B detail data lands — b2 came ONLY from the bundle.
    expect(state.sessions.b2?.id).toBe("b2");
    expect(state.activity.b2).toBe("busy");
    expect(state.lastAgents.b2).toBe("plan");
    expect(state.gate.b2?.hasMessages).toBe(true);
    expect(state.currentVerbs.b2).toBeDefined();
    // NO resurrection of A entries (the switch cleared them; neither the
    // stream frame nor the HTTP bundle re-derives them).
    expect(state.sessions.a1).toBeUndefined();
    expect(state.activity.a1).toBeUndefined();
    // NO epoch transition latched; the cursor advanced monotonically to the
    // bundle's seq (no rebaseline — same store lifetime).
    expect(state.epochChanged).toBe(false);
    expect(state.epoch).toBe("eB");
    expect(state.cursor).toBe(22);
  });

  it("Pin 2b — the HTTP bundle RACING B's first stream frame (bundle first): empty state epoch ⇒ HTTP boot-applies, never discards", () => {
    setProjectDirRaw("/proj-A");
    connect(true);
    expect(applyScopedSnapshot(frontierPartial(10, "eA", ["a1"]))).toBe(true);

    switchProject("/proj-B");

    // The audited interleaving: the expand HTTP response resolves BEFORE B's
    // first stream frame reaches the reconcile seam. stateEpoch is "" —
    // guardSnapshotApply's boot branch (cascade.ts:505) returns apply +
    // rebaseline BEFORE the provenance split is ever consulted, so the http
    // bundle applies and ADOPTS eB. (An http discard would strand expand
    // detail until the next frame and request a spurious epoch-reset re-sync.)
    const applied = applyScopedSnapshot(pageDetailBundle(21, "eB", ["b1", "b2"]), "http");
    expect(applied).toBe(true);
    expect(state.epoch).toBe("eB");
    expect(state.epochChanged).toBe(false);
    expect(state.sessions.b2?.id).toBe("b2");

    // B's stream frame lands AFTER the bundle: same epoch (eB), seq above the
    // bundle's — the seq-compare path applies it. The frontier merge must not
    // treat the bundle's out-of-scope detail (b2) as stale: it survives as
    // buried detail (the scoped installer's preserve-buried contract).
    expect(applyScopedSnapshot(frontierPartial(22, "eB", ["b1"]))).toBe(true);
    expect(state.sessions.b1?.id).toBe("b1");
    expect(state.activity.b1).toBe("busy");
    expect(state.sessions.b2?.id).toBe("b2");
    expect(state.activity.b2).toBe("busy");
    // No A resurrection, no latch, epoch adopted — the full benign verdict.
    expect(state.sessions.a1).toBeUndefined();
    expect(state.epochChanged).toBe(false);
    expect(state.epoch).toBe("eB");
    // The stream frame's seq-compare leg advanced the cursor monotonically
    // (mirrors Pin 2a's explicit cursor assertion).
    expect(state.cursor).toBe(22);
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

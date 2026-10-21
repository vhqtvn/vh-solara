// @vitest-environment jsdom
//
// switchProject B2b-parity — the project-switch produce block must reset EVERY
// per-session surface, not just the twelve it historically covered.
//
// c14703e completed the removal-side analogue (projectSessionRemoval prunes
// gate/currentVerbs/refreshing alongside the other per-session maps, with the
// no-leak / no-resurrect-on-id-reuse rationale). The SWITCH side lagged: the
// produce block reset/rehydrated 12 of 15 per-session surfaces and left gate,
// currentVerbs, and refreshing untouched. The wire does NOT heal the gap: a
// fresh tree=2 connect ships a frontier-scoped PARTIAL (pkg/web/stream_http.go,
// Slice-A D7) which only MERGES gate/currentVerbs for in-scope ids
// (projectScopedPartial in reconcile.ts) — a project-A id is never in project
// B's scope; an epoch-change clear can't fire at a project switch (epochs are
// per-daemon-store-lifetime, and switching projects does not restart the
// daemon store); and the no-project branch ('') receives no frame at all
// (connect early-returns on empty dir). Survival is therefore
// connection-lifetime. All three maps are ephemeral (never persisted), so this
// pin is the in-session twin of the removal-side parity: deleted/project-A
// facts must not leak into project B or resurrect when B reuses an id.
//
// Harness mirrors labelsProjectScope.test.ts: jsdom + a no-delivery
// MockEventSource (switchProject → connect() constructs one per project; jsdom
// ships none) + setProjectDirRaw reset. No frames are delivered in test 1, so
// every assertion observes the switch's OWN reset before any snapshot could
// land. expect.soft is used so ONE run reports every failing surface (the
// red-first receipt), not just the first.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import { connect } from "../../src/sync/tree-transport";
import { closeSessionStream } from "../../src/sync/session-stream";
import { setProjectDirRaw, setState, state } from "../../src/sync/store";
import { resetTreeStore } from "../../src/sync/treeState";
import { switchProject } from "../../src/sync/actions";
import { applyScopedSnapshot } from "../../src/sync/reconcile";

// --- Mock EventSource (mirrors labelsProjectScope.test.ts) ---
// jsdom doesn't implement EventSource. switchProject → connect() constructs one
// per project; we only need construction + close to not throw. Test 1 delivers
// NO frames (the reset semantics under test are the switch's own); test 2
// delivers at the reconcile seam instead (see there).
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
    instances.push(this);
  }

  addEventListener(): void {
    /* no frame delivery in this suite */
  }

  close(): void {
    this.readyState = CLOSED;
  }
}

let instances: MockEventSource[] = [];

// Every per-session surface the switch must clear of the outgoing project's
// ids. The first twelve were already reset/rehydrated pre-slice; gate /
// currentVerbs / refreshing are the B2b additions this suite pins.
const A_SURFACES = [
  "sessions",
  "lastAgents",
  "gate",
  "messageWindows",
  "messagesDelivered",
  "messagesError",
  "refreshing",
  "activity",
  "currentVerbs",
  "permissions",
  "questions",
  "unread",
  "messages",
] as const;

type ASurface = (typeof A_SURFACES)[number];

function aEntry(surface: ASurface): unknown {
  return (state as unknown as Record<string, Record<string, unknown>>)[surface].a1;
}

// Reset the module-level Solid store slices this suite seeds (same form as
// deletionCascadeParity.test.ts) so a previous test's entries can never make
// an absence assertion pass or fail vacuously.
beforeEach(() => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  localStorage.clear();
  setProjectDirRaw("");
  resetTreeStore();
  for (const surface of A_SURFACES) setState(surface, reconcile({}));
});

afterEach(() => {
  closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

// Seed EVERY per-session map with one project-A id, using the same literal
// shapes deletionCascadeParity.test.ts seeds (typecheck-proven there).
function seedProjectA(): void {
  setState("sessions", "a1", { id: "a1", title: "A session" } as any);
  setState("lastAgents", "a1", "build");
  setState("gate", "a1", { hasMessages: true, permissionWasBlocked: true });
  setState("messageWindows", "a1", { hasOlder: true, oldestResidentID: "m1" });
  setState("messagesDelivered", "a1", true);
  setState("messagesError", "a1", true);
  setState("refreshing", "a1", true);
  setState("activity", "a1", "busy");
  setState("currentVerbs", "a1", { tool: "read", state: { status: "running" } });
  setState("permissions", "a1", { p1: { id: "p1", sessionID: "a1", type: "bash" } });
  setState("questions", "a1", { q1: { id: "q1", sessionID: "a1", questions: [{ question: "Proceed?" }] } });
  setState("unread", "a1", true);
  // Same slot shape openSession reserves (actions.ts).
  setState("messages", "a1", { order: [], byId: {} });
}

describe("switchProject — B2b reset parity (every per-session surface clears)", () => {
  it("switching A → B clears every A entry immediately, before any frame lands (gate/currentVerbs/refreshing included)", () => {
    // Land on project A and make it live, mirroring how A became active in
    // labelsProjectScope.test.ts, then seed A's per-session facts.
    setProjectDirRaw("/proj-A");
    connect(true);
    seedProjectA();
    for (const surface of A_SURFACES) {
      expect.soft(aEntry(surface), `${surface}.a1 must be seeded before the switch`).toBeDefined();
    }

    switchProject("/proj-B");

    // The switch itself ran (not the same-dir early return): a NEW tree
    // EventSource was constructed for B alongside A's.
    expect(instances.length).toBe(2);
    // Every A entry is gone IMMEDIATELY — the reset fired inside
    // switchProject's produce block, before B's snapshot arrives (the mock
    // delivers none, so nothing but the switch could have mutated these).
    for (const surface of A_SURFACES) {
      expect.soft(aEntry(surface), `${surface}.a1 must be cleared by the switch itself`).toBeUndefined();
    }
  });

  it("the fresh B connect's frontier-scoped partial frame does not resurrect any A entry (wire-doesn't-heal pin)", () => {
    // Same setup: A live + seeded, then switch to B.
    setProjectDirRaw("/proj-A");
    connect(true);
    seedProjectA();
    switchProject("/proj-B");
    for (const surface of A_SURFACES) {
      expect(aEntry(surface), `${surface}.a1 must be cleared by the switch itself`).toBeUndefined();
    }

    // Deliver the frame a fresh tree=2 connect actually ships for B: a
    // FRONTIER-SCOPED PARTIAL (Slice-A D7; stream_http.go SnapshotWithTreePartial)
    // — delivered here at the reconcile seam (applyScopedSnapshot is where the
    // transport listener lands after SSE parse; the parse path itself is
    // pinned by the treeStreamCompression/coherentBarrier suites). epoch "e1"
    // against the store's default empty epoch cannot trigger the epoch-change
    // clear (epochChanged needs both non-empty), so this cannot pass vacuously
    // via that branch. B's frontier carries only b1.
    const applied = applyScopedSnapshot({
      seq: 21,
      epoch: "e1",
      sessions: [{ id: "b1" }],
      activity: { b1: "busy" },
      gate: { b1: { hasMessages: true } },
      lastAgents: { b1: "plan" },
      currentVerbs: { b1: { tool: "edit", state: { status: "running" } } },
      questions: { b1: [] },
      permissions: { b1: [] },
      unread: ["b1"],
      partial: {
        mode: "tree-stream-1-frontier",
        scope: ["b1"],
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
    } as any);

    // The frame APPLIED (guards passed) and established B's frontier…
    expect(applied).toBe(true);
    expect(state.sessions.b1?.id).toBe("b1");
    expect(state.gate.b1).toBeTruthy();
    expect(state.currentVerbs.b1?.tool).toBe("edit");
    // …and no A entry resurrected: the frontier merge only touches in-scope
    // ids, and the global-replace maps (questions/permissions/unread) were
    // rebuilt from B's own (empty-of-A) payload.
    for (const surface of A_SURFACES) {
      expect.soft(aEntry(surface), `${surface}.a1 must stay cleared after B's frontier partial`).toBeUndefined();
    }
  });
});

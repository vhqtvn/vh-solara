// @vitest-environment jsdom
//
// Per-project labels — project-switch wiring (slice 4 web).
//
// labels.test.ts pins the facade's scope-gen guard in isolation (resetLabelsScope
// + performMutation's late-result drop). THIS file pins the WIRING: that the
// central project-switch seam (sync/actions.ts switchProject) actually calls
// resetLabelsScope on every switch and on the no-project teardown, so the
// outgoing project's labels are cleared BEFORE the incoming project's stream
// connects — mirroring how switchProject already resets the session map, tree
// store, and per-project facets.
//
// jsdom is required because switchProject → connect() opens an EventSource
// (jsdom ships none), so we install a MockEventSource shaped like
// resyncTree.test.ts. No DOM is exercised; the env is only for EventSource +
// localStorage scaffolding that the sync store touches on a real switch.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "../../src/sync/tree-transport";
import { closeSessionStream } from "../../src/sync/session-stream";
import { setProjectDirRaw } from "../../src/sync/store";
import { resetTreeStore } from "../../src/sync/treeState";
import { switchProject } from "../../src/sync/actions";
import {
  __resetLabelsForTest,
  applyLabelsSnapshot,
  labelsConnected,
  labelsGroups,
  labelsRevision,
  labelsTags,
  resetLabelsScope,
} from "../../src/labels";

// --- Mock EventSource (mirrors resyncTree.test.ts) ---
// jsdom doesn't implement EventSource. switchProject → connect() constructs one
// per project; we only need construction + close to not throw. No frames are
// delivered here (the labels-scope semantics are pinned in labels.test.ts); we
// assert state through the labels facade accessors after the switch returns.
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

beforeEach(() => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  __resetLabelsForTest();
  setProjectDirRaw("");
  resetTreeStore();
});

afterEach(() => {
  closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("switchProject — clears labels on every switch (per-project scope)", () => {
  it("switching A → B clears A's labels before B connects", () => {
    // Land on project A and load its labels (as B's snapshot would on its
    // stream). setProjectDirRaw + connect mirrors how A becomes active.
    setProjectDirRaw("/proj-A");
    connect(true);
    applyLabelsSnapshot({ revision: 7, groups: [{ id: "gA", name: "A", color: "blue", collapsed: false, orderedRootSessionIds: ["ra"] }], tags: [], tagIdsByRootSessionId: {} });
    expect(labelsConnected()).toBe(true);
    expect(labelsGroups()).toHaveLength(1);
    expect(labelsRevision()).toBe(7);

    // Switch to B. switchProject resets per-project state (sessions, tree, and
    // now labels) BEFORE connect() opens B's stream.
    switchProject("/proj-B");

    // A's labels are gone immediately — the clear fired inside switchProject,
    // before B's snapshot arrives (none has been delivered yet).
    expect(labelsConnected()).toBe(false);
    expect(labelsGroups()).toEqual([]);
    expect(labelsTags()).toEqual([]);
    expect(labelsRevision()).toBe(0);
  });

  it("switching to no-project (empty dir) clears labels and issues no labels request", () => {
    // Labels loaded for A.
    setProjectDirRaw("/proj-A");
    connect(true);
    applyLabelsSnapshot({ revision: 3, groups: [{ id: "gA", name: "A", color: "blue", collapsed: false, orderedRootSessionIds: [] }], tags: [], tagIdsByRootSessionId: {} });
    expect(labelsGroups()).toHaveLength(1);

    // fetch is stubbed so we can assert NO labels request fires for the empty
    // selection. (labels.ts only PUTs on user mutations and never GETs; the
    // snapshot arrives via the stream, which connect() does not open on empty.)
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    switchProject(""); // A → no-project

    expect(labelsConnected()).toBe(false);
    expect(labelsGroups()).toEqual([]);
    expect(labelsRevision()).toBe(0);
    // No labels request was issued: connect() early-returns on empty dir (no
    // EventSource opened for labels), and labels.ts issued no PUT.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("B's labels.snapshot (after the switch) establishes B's own state", () => {
    setProjectDirRaw("/proj-A");
    connect(true);
    applyLabelsSnapshot({ revision: 9, groups: [{ id: "gA", name: "A", color: "blue", collapsed: false, orderedRootSessionIds: ["ra"] }], tags: [], tagIdsByRootSessionId: {} });

    switchProject("/proj-B");
    expect(labelsGroups()).toEqual([]); // cleared on switch

    // B's stream delivers B's bootstrap snapshot (B's own revision domain).
    applyLabelsSnapshot({ revision: 2, groups: [{ id: "gB", name: "B", color: "red", collapsed: false, orderedRootSessionIds: ["rb"] }], tags: [{ id: "tB", name: "tb", color: "green" }], tagIdsByRootSessionId: { rb: ["tB"] } });

    expect(labelsConnected()).toBe(true);
    expect(labelsRevision()).toBe(2); // B's revision (2 < A's 9 — independent domain)
    expect(labelsGroups()).toHaveLength(1);
    expect(labelsGroups()[0].id).toBe("gB");
    expect(labelsTags()).toHaveLength(1);
  });

  it("switchProject is a no-op when dir === projectDir() (same project resync path)", () => {
    // switchProject early-returns when the dir is unchanged. resetLabelsScope
    // must NOT fire in that case (a same-project resync keeps labels intact —
    // connect(true) swaps the snapshot atomically, mirroring the tree store).
    setProjectDirRaw("/proj-A");
    connect(true);
    applyLabelsSnapshot({ revision: 5, groups: [{ id: "gA", name: "A", color: "blue", collapsed: false, orderedRootSessionIds: [] }], tags: [], tagIdsByRootSessionId: {} });
    expect(labelsGroups()).toHaveLength(1);

    switchProject("/proj-A"); // same dir → early return, no reset

    expect(labelsConnected()).toBe(true);
    expect(labelsGroups()).toHaveLength(1); // NOT cleared
    expect(labelsRevision()).toBe(5);
  });

  it("resetLabelsScope is idempotent + reusable across multiple switches", () => {
    // Drive several resets directly (the unit switchProject calls delegate to
    // it) to confirm the gen stays monotonic and the signals stay clearable
    // across A → B → A cycles without leaking state.
    setProjectDirRaw("/proj-A");
    resetLabelsScope();
    applyLabelsSnapshot({ revision: 1, groups: [{ id: "gA", name: "A", color: "blue", collapsed: false, orderedRootSessionIds: [] }], tags: [], tagIdsByRootSessionId: {} });
    expect(labelsGroups()).toHaveLength(1);

    resetLabelsScope(); // A → B
    expect(labelsGroups()).toEqual([]);
    applyLabelsSnapshot({ revision: 1, groups: [{ id: "gB", name: "B", color: "red", collapsed: false, orderedRootSessionIds: [] }], tags: [], tagIdsByRootSessionId: {} });
    expect(labelsGroups()[0].id).toBe("gB");

    resetLabelsScope(); // B → A again
    expect(labelsGroups()).toEqual([]);
    applyLabelsSnapshot({ revision: 4, groups: [{ id: "gA2", name: "A2", color: "blue", collapsed: false, orderedRootSessionIds: [] }], tags: [], tagIdsByRootSessionId: {} });
    expect(labelsGroups()[0].id).toBe("gA2");
    expect(labelsRevision()).toBe(4);
  });
});

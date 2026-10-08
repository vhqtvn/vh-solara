// @vitest-environment jsdom
//
// Ghost-row regression (L-01 snapshot-side + eager tree prune).
//
// Scenario: archiving the LAST live session in a project leaves the per-dir
// store with zero live sessions, so the server's tree.snapshot frame
// serialized `"nodes":null` (a nil Go slice). The client's decodeTreeSnapshot
// rejected the frame as malformed → the transport routed it to
// markOwnerLegacy WITHOUT reseeding the tree store → the pre-archive treeMap
// (with the archived session's row) survived every reconnect until a full
// page reload: the ghost row.
//
// These tests pin BOTH halves of the fix at the level where the bug lives:
//   1. TRANSPORT (crux): a tree.snapshot with nodes:null (and nodes:[]) —
//      delivered as a real EventSource frame through connect()'s listeners —
//      is ACCEPTED and REPLACES a pre-populated stale tree with the empty
//      authoritative frontier. Both the Q5 coherent path (epoch staged +
//      installed via snapshot.complete) and the legacy path (no epoch) are
//      covered.
//   2. EAGER PRUNE (crux): a successful /vh/archive prunes the affected
//      session's row from the tree store immediately, from the archive
//      response alone (no server round-trip), via the session-removed effect
//      cascade in interpretEffects.
//
// Mock EventSource pattern mirrors resyncTree.test.ts (jsdom has none).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { connect } from "../../src/sync/tree-transport";
import { closeSessionStream } from "../../src/sync/session-stream";
import { setProjectDirRaw, state } from "../../src/sync/store";
import {
  seedTreeStore,
  treeMap,
  resetTreeStore,
} from "../../src/sync/treeState";
import { archiveSession } from "../../src/archive";
import type { TreeNode } from "../../src/sync/treeMap";

// --- Mock EventSource (mirrors resyncTree.test.ts) ---
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
  private listeners = new Map<string, Array<(e: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    const arr = this.listeners.get(type);
    if (arr) arr.push(fn);
    else this.listeners.set(type, [fn]);
  }

  close(): void {
    this.readyState = CLOSED;
  }

  // Dispatch a named SSE event with a JSON string payload + compound SSE id
  // ("globalSeq.ordinal" — what parseSSEID reads via lastEventId).
  fire(type: string, body: unknown, lastEventId: string): void {
    const arr = this.listeners.get(type);
    if (!arr) return;
    const ev = { data: JSON.stringify(body), lastEventId } as MessageEvent;
    for (const fn of [...arr]) fn(ev);
  }
}

let instances: MockEventSource[] = [];

const baseNode = {
  parentId: null,
  title: "ghost",
  activity: "idle",
  childCount: 0,
  loaded: false,
  flags: {
    pendingInput: false,
    subtreeNeedsInput: false,
    subtreeBusy: false,
    permission: false,
    archived: false,
    orphan: false,
  },
  updatedMs: 0,
} as const;

const ghostRow = { id: "ses_ghost", ...baseNode } as TreeNode;
const otherRow = { id: "ses_other", ...baseNode, title: "other" } as TreeNode;

// Seed a STALE tree that contains the about-to-be-archived session's row —
// the precondition of the ghost-row bug.
function seedStaleTree(): void {
  seedTreeStore([ghostRow, otherRow]);
}

beforeEach(() => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  setProjectDirRaw("/test");
  resetTreeStore();
  // The transport fire-and-forgets refreshOpenSessions()/checkVersion on some
  // paths; stub fetch so nothing attempts a real network call in jsdom.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});

afterEach(() => {
  closeSessionStream();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("tree.snapshot with an empty frontier replaces a stale tree", () => {
  it("coherent path: nodes:null is accepted, installed, and clears the stale treeMap", () => {
    seedStaleTree();
    expect(treeMap().has("ses_ghost")).toBe(true);

    connect(true);
    const es = instances[instances.length - 1];
    expect(es).toBeDefined();

    // The exact post-archive reconnect shape: empty store frontier. Pre-fix
    // server: {"nodes":null}; post-fix: {"nodes":[]}. BOTH must be accepted.
    es.fire(
      "tree.snapshot",
      { dir: "/test", tree: "2", epoch: "E1", seq: 5, nodes: null, cause: "reconnect" },
      "5.0",
    );
    // Detail projection of the same capture (Q5 correlation).
    es.fire("snapshot", { epoch: "E1", seq: 5 }, "5.0");
    // Completion boundary — installs BOTH projections atomically.
    es.fire(
      "snapshot.complete",
      { epoch: "E1", revision: 5, projections: ["tree", "detail"] },
      "5.0",
    );

    // CRUX: the authoritative empty frontier REPLACED the stale treeMap —
    // the archived session's row is gone, no page reload.
    expect(treeMap().has("ses_ghost")).toBe(false);
    expect(treeMap().size).toBe(0);
    // The coherent install landed (not the markOwnerLegacy escape hatch).
    expect(state.authoritativeReady).toBe(true);
  });

  it("coherent path: explicit nodes:[] also clears the stale treeMap", () => {
    seedStaleTree();
    connect(true);
    const es = instances[instances.length - 1];
    es.fire(
      "tree.snapshot",
      { dir: "/test", tree: "2", epoch: "E1", seq: 5, nodes: [], cause: "reconnect" },
      "5.0",
    );
    es.fire("snapshot", { epoch: "E1", seq: 5 }, "5.0");
    es.fire(
      "snapshot.complete",
      { epoch: "E1", revision: 5, projections: ["tree", "detail"] },
      "5.0",
    );
    expect(treeMap().size).toBe(0);
    expect(state.authoritativeReady).toBe(true);
  });

  it("legacy path (no epoch): nodes:null is applied independently and clears the stale treeMap", () => {
    seedStaleTree();
    connect(true);
    const es = instances[instances.length - 1];
    // A pre-Q5 daemon body: no epoch → legacy discrimination applies the tree
    // independently (immediately) rather than staging a coherent owner.
    es.fire(
      "tree.snapshot",
      { dir: "/test", tree: "2", seq: 5, nodes: null },
      "5.0",
    );
    expect(treeMap().size).toBe(0);
    expect(state.authoritativeReady).toBe(false); // legacy: no truthful boundary
  });

  it("a NON-empty snapshot still seeds normally (no over-clearing)", () => {
    seedStaleTree();
    connect(true);
    const es = instances[instances.length - 1];
    es.fire(
      "tree.snapshot",
      { dir: "/test", tree: "2", epoch: "E1", seq: 5, nodes: [otherRow] },
      "5.0",
    );
    es.fire("snapshot", { epoch: "E1", seq: 5 }, "5.0");
    es.fire(
      "snapshot.complete",
      { epoch: "E1", revision: 5, projections: ["tree", "detail"] },
      "5.0",
    );
    // The live session survives; only the (server-omitted) ghost is dropped.
    expect(treeMap().has("ses_other")).toBe(true);
    expect(treeMap().has("ses_ghost")).toBe(false);
  });
});

describe("archive success prunes the tree row eagerly", () => {
  it("archiveSession removes the affected row (+ loaded descendants) with no extra round-trip", async () => {
    seedStaleTree();
    const childRow = {
      id: "ses_child",
      ...baseNode,
      parentId: "ses_ghost",
      title: "child",
    } as TreeNode;
    seedTreeStore([ghostRow, childRow, otherRow]);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, affected: ["ses_ghost", "ses_child"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await archiveSession("ses_ghost");

    // Exactly the ONE archive POST — the prune is local (no tree refetch).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // CRUX: the archived session's row (and its loaded descendant) vanished
    // from the tree store immediately; unrelated rows survive.
    expect(treeMap().has("ses_ghost")).toBe(false);
    expect(treeMap().has("ses_child")).toBe(false);
    expect(treeMap().has("ses_other")).toBe(true);
  });
});

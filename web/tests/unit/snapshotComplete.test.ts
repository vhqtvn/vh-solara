// @vitest-environment jsdom
//
// C4 (O1-R1) — the FE coherent-snapshot staging barrier.
//
// The server (Q5) emits `snapshot.complete` as a named SSE event AFTER both
// projections (tree.snapshot + detail snapshot) of the SAME {epoch, seq}
// capture are written. C4 makes that boundary ENFORCEABLE on the FE: a capture
// identified by {epoch, seq} becomes authoritative ONLY when its matching
// detail snapshot, decoded tree snapshot, AND snapshot.complete boundary are
// ALL present; the FE installs both projections atomically before flipping
// state.authoritativeReady.
//
// These tests pin the boundary semantics (readiness, gen guard, malformed
// drops). The comprehensive 13-case acceptance suite lives in
// coherentBarrier.test.ts (Case 12 is the decisive fixture).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { connect } from "../../src/sync/tree-transport";
import { closeSessionStream } from "../../src/sync/session-stream";
import { setProjectDirRaw, state } from "../../src/sync/store";

// --- Mock EventSource (mirrors the treeStreamCompression pattern) ---
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

  fire(type: string, data: unknown, lastEventId = ""): void {
    const ev = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
      lastEventId,
    });
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }

  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }
}

let instances: MockEventSource[] = [];

const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

// A valid TreeNode (per isTreeNode guard in treeOps.ts).
function node(id: string): any {
  return {
    id,
    parentId: null,
    title: `t-${id}`,
    activity: "idle",
    childCount: 0,
    loaded: true,
    updatedMs: 1,
    flags: {},
  };
}

// Drive ONE full coherent capture (RAW synchronous tree.snapshot — no async
// decode needed for the boundary semantics). The owner installs atomically when
// the completion arrives (all three staged + identity valid).
function fireCoherentCapture(
  es: MockEventSource,
  epoch: string,
  seq: number,
  treeIds: string[] = ["s1", "s2"],
): void {
  es.fire(
    "tree.snapshot",
    { tree: "2", epoch, seq, nodes: treeIds.map((id) => node(id)) },
    String(seq),
  );
  es.fire(
    "snapshot",
    { seq, epoch, sessions: treeIds.map((id) => ({ id, title: `d-${id}` })) },
    String(seq),
  );
  es.fire(
    "snapshot.complete",
    { epoch, revision: seq, projections: ["tree", "detail"] },
    String(seq),
  );
}

beforeEach(() => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  setProjectDirRaw("/test");
  window.history.replaceState({}, "", "/?tree=2");
});

afterEach(() => {
  closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  window.history.replaceState({}, "", "/");
});

describe("snapshot.complete — C4 coherent boundary (authoritativeReady)", () => {
  it("flips authoritativeReady=true only after the full coherent capture installs both projections", () => {
    connect(true);
    treeESes()[0].simulateOpen();
    expect(state.authoritativeReady).toBe(false);

    // tree.snapshot alone (epoch-bearing) creates the owner + stages the tree,
    // but does NOT install (detail + completion still missing).
    treeESes()[0].fire(
      "tree.snapshot",
      { tree: "2", epoch: "abc123", seq: 42, nodes: [node("s1"), node("s2")] },
      "42",
    );
    expect(state.authoritativeReady).toBe(false);

    // detail snapshot stages; still no install (completion missing).
    treeESes()[0].fire(
      "snapshot",
      { seq: 42, epoch: "abc123", sessions: [{ id: "s1" }, { id: "s2" }] },
      "42",
    );
    expect(state.authoritativeReady).toBe(false);

    // The completion boundary completes the coherent triple → atomic install →
    // readiness flips AFTER both projections are in place.
    treeESes()[0].fire(
      "snapshot.complete",
      { epoch: "abc123", revision: 42, projections: ["tree", "detail"] },
      "42",
    );
    expect(state.authoritativeReady).toBe(true);
  });

  it("connect(true) resets authoritativeReady=false (new connection)", () => {
    // First connection: coherent capture lands → ready.
    connect(true);
    treeESes()[0].simulateOpen();
    fireCoherentCapture(treeESes()[0], "abc123", 1);
    expect(state.authoritativeReady).toBe(true);

    // Reconnect → the new connection's projections haven't landed yet → reset.
    connect(true);
    expect(state.authoritativeReady).toBe(false);
  });

  it("ignores a stale snapshot.complete from a superseded connection (gen guard)", () => {
    // First connection.
    connect(true);
    treeESes()[0].simulateOpen();

    // Replace the connection BEFORE the stale completion fires.
    connect(true);
    treeESes()[1].simulateOpen();

    expect(state.authoritativeReady).toBe(false);

    // A stale completion from the OLD connection (gen mismatch) is dropped.
    treeESes()[0].fire(
      "snapshot.complete",
      { epoch: "old", revision: 1, projections: ["tree", "detail"] },
      "1",
    );
    expect(state.authoritativeReady).toBe(false);

    // The CURRENT connection's coherent capture installs → readiness.
    fireCoherentCapture(treeESes()[1], "new", 2);
    expect(state.authoritativeReady).toBe(true);
  });

  it("drops a malformed snapshot.complete payload (no install; a later valid capture still works)", () => {
    connect(true);
    treeESes()[0].simulateOpen();
    expect(state.authoritativeReady).toBe(false);

    // Stage tree + detail so the only missing participant is completion.
    treeESes()[0].fire(
      "tree.snapshot",
      { tree: "2", epoch: "abc", seq: 5, nodes: [node("s1")] },
      "5",
    );
    treeESes()[0].fire(
      "snapshot",
      { seq: 5, epoch: "abc", sessions: [{ id: "s1" }] },
      "5",
    );
    expect(state.authoritativeReady).toBe(false);

    // Malformed JSON → JSON.parse throws → caught + dropped (no install).
    treeESes()[0].fire("snapshot.complete", "{not json", "5");
    expect(state.authoritativeReady).toBe(false);

    // A valid completion for the SAME staged capture completes the install.
    treeESes()[0].fire(
      "snapshot.complete",
      { epoch: "abc", revision: 5, projections: ["tree", "detail"] },
      "5",
    );
    expect(state.authoritativeReady).toBe(true);
  });

  it("drops a JSON-valid-but-non-object body (null / primitive / array)", () => {
    connect(true);
    treeESes()[0].simulateOpen();
    treeESes()[0].fire(
      "tree.snapshot",
      { tree: "2", epoch: "ok", seq: 9, nodes: [node("s1")] },
      "9",
    );
    treeESes()[0].fire(
      "snapshot",
      { seq: 9, epoch: "ok", sessions: [{ id: "s1" }] },
      "9",
    );
    expect(state.authoritativeReady).toBe(false);

    // null (JSON.parse("null")) — would throw on property access without the guard.
    treeESes()[0].fire("snapshot.complete", "null", "9");
    expect(state.authoritativeReady).toBe(false);

    // A bare primitive.
    treeESes()[0].fire("snapshot.complete", "42", "9");
    expect(state.authoritativeReady).toBe(false);

    // An array (typeof === "object" but Array.isArray).
    treeESes()[0].fire("snapshot.complete", [1, 2, 3], "9");
    expect(state.authoritativeReady).toBe(false);

    // A valid object body completes the install after the drops.
    treeESes()[0].fire(
      "snapshot.complete",
      { epoch: "ok", revision: 9, projections: ["tree", "detail"] },
      "9",
    );
    expect(state.authoritativeReady).toBe(true);
  });

  it("does NOT install on identity mismatch (epoch/seq cross-projection)", () => {
    connect(true);
    treeESes()[0].simulateOpen();
    // tree {epoch=A, seq=1}; detail {epoch=B, seq=1} → mismatched epoch.
    treeESes()[0].fire(
      "tree.snapshot",
      { tree: "2", epoch: "A", seq: 1, nodes: [node("s1")] },
      "1",
    );
    treeESes()[0].fire(
      "snapshot",
      { seq: 1, epoch: "B", sessions: [{ id: "s1" }] },
      "1",
    );
    treeESes()[0].fire(
      "snapshot.complete",
      { epoch: "A", revision: 1, projections: ["tree", "detail"] },
      "1",
    );
    // Mismatched identity → no install → readiness stays false.
    expect(state.authoritativeReady).toBe(false);
  });

  it("does NOT install when projections omits a participant", () => {
    connect(true);
    treeESes()[0].simulateOpen();
    treeESes()[0].fire(
      "tree.snapshot",
      { tree: "2", epoch: "abc", seq: 7, nodes: [node("s1")] },
      "7",
    );
    treeESes()[0].fire(
      "snapshot",
      { seq: 7, epoch: "abc", sessions: [{ id: "s1" }] },
      "7",
    );
    // projections omits "detail" → validation fails → no install.
    treeESes()[0].fire(
      "snapshot.complete",
      { epoch: "abc", revision: 7, projections: ["tree"] },
      "7",
    );
    expect(state.authoritativeReady).toBe(false);
  });
});

// @vitest-environment jsdom
//
// Q5 C2 — FE consumer of the server's truthful completion boundary.
//
// The server (commit C1, pkg/web/server.go) emits `snapshot.complete` as a
// named SSE event AFTER both projections (tree.snapshot + detail snapshot) of
// the SAME {epoch, seq} capture are written, gated on treeOK && detailOK (no
// false atomicity). This is the ONLY client-side signal that both projections
// are coherent from one authoritative capture — the FE cannot correlate by
// arrival/decode order (tree.snapshot is gzip64-decoded async; detail snapshot
// ships RAW synchronous).
//
// state.authoritativeReady is the verifiable convergence boundary. These tests
// pin:
// 1. snapshot.complete sets authoritativeReady=true (the boundary).
// 2. connect(true) resets authoritativeReady=false (new connection's
//    projections haven't landed yet).
// 3. Generation guard: a stale snapshot.complete from a superseded connection
//    is ignored (does not set authoritativeReady).
// 4. Malformed payload is dropped (no state mutation); a later valid frame
//    still works.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { connect, closeSessionStream } from "../../src/sync/stream";
import { setProjectDirRaw, state } from "../../src/sync/store";

// --- Mock EventSource (mirrors reconcileBusyTree2.test.ts) ---
// jsdom doesn't implement EventSource. The mock supports a lastEventId field
// for parity with the other stream listeners (the snapshot.complete event DOES
// carry an SSE id == the capture seq, though this listener doesn't read it).
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

  /** Fire a named SSE event. lastEventId carries the store seq (F4). */
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

// The tree (Stream-1) EventSource has sessions=& (empty).
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

beforeEach(() => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  setProjectDirRaw("/test");
  // tree=2 so connect() opens the tree.* stream path.
  window.history.replaceState({}, "", "/?tree=2");
});

afterEach(() => {
  closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  window.history.replaceState({}, "", "/");
});

describe("snapshot.complete — Q5 C2 FE convergence boundary", () => {
  it("sets state.authoritativeReady=true on the completion boundary", () => {
    connect(true);
    treeESes()[0].simulateOpen();
    // Before the boundary: not ready (projections may be landing).
    expect(state.authoritativeReady).toBe(false);

    // Fire the completion boundary — the server confirmed both projections
    // of this capture were written.
    treeESes()[0].fire(
      "snapshot.complete",
      { epoch: "abc123", revision: 42, projections: ["tree", "detail"] },
      "42",
    );

    expect(state.authoritativeReady).toBe(true);
  });

  it("connect(true) resets authoritativeReady=false (new connection)", () => {
    // First connection: completion lands → ready.
    connect(true);
    treeESes()[0].simulateOpen();
    treeESes()[0].fire(
      "snapshot.complete",
      { epoch: "abc123", revision: 1, projections: ["tree", "detail"] },
      "1",
    );
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

    // The CURRENT connection's completion sets it.
    treeESes()[1].fire(
      "snapshot.complete",
      { epoch: "new", revision: 2, projections: ["tree", "detail"] },
      "2",
    );
    expect(state.authoritativeReady).toBe(true);
  });

  it("drops a malformed snapshot.complete payload (no state mutation)", () => {
    connect(true);
    treeESes()[0].simulateOpen();
    expect(state.authoritativeReady).toBe(false);

    // Malformed JSON → JSON.parse throws → caught + dropped.
    treeESes()[0].fire("snapshot.complete", "{not json", "1");
    expect(state.authoritativeReady).toBe(false);

    // A valid completion still works after a malformed one.
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
    expect(state.authoritativeReady).toBe(false);

    // null (JSON.parse("null")) — would throw on p.epoch access without the guard.
    treeESes()[0].fire("snapshot.complete", "null", "1");
    expect(state.authoritativeReady).toBe(false);

    // A bare primitive.
    treeESes()[0].fire("snapshot.complete", "42", "2");
    expect(state.authoritativeReady).toBe(false);

    // An array (typeof === "object" but Array.isArray).
    treeESes()[0].fire("snapshot.complete", [1, 2, 3], "3");
    expect(state.authoritativeReady).toBe(false);

    // A valid object body still works after the drops.
    treeESes()[0].fire(
      "snapshot.complete",
      { epoch: "ok", revision: 9, projections: ["tree", "detail"] },
      "9",
    );
    expect(state.authoritativeReady).toBe(true);
  });
});

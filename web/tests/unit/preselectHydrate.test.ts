// @vitest-environment jsdom
//
// INVARIANT GUARD for the sync start-up "pre-selected session" path.
//
// This test exists to PIN, at the unit level, that startSync() — when the page
// loads with a session already pre-selected via URL restore (?session=<id>) —
// opens exactly ONE Stream-2 EventSource for that id and hydrates its
// transcript (messagesLoaded[id] flips true) WITHOUT a manual switch-away-and-
// back, and that a normal manual switch afterwards creates exactly ONE more
// stream (no double-fire, no zero-fire). It is a cheap guard against a future
// regression that reintroduces a double-fire or zero-fire on the init path.
//
// IMPORTANT — relation to the "pre-selected session does not hydrate" report:
// this test pins that the SYNC INIT path is NOT the cause — startSync() opens
// exactly one Stream-2 for the pre-selected id and hydrates it (messagesLoaded
// flips true) with no zero/double-fire, on the very first load. The actual
// pre-select-hydration bug lived in the ChatView REVEAL GATE, in two distinct
// strands, both fixed with regression tests in ChatViewRevealDeadlock.test.tsx:
//   (a) commit 388652a — anchor absent from the partial batch before messages.loaded.
//   (b) this change — messagesLoaded=true reported while the message order is
//       still EMPTY + a stored read anchor (maybeRestore's empty-order defer did
//       not consult delivered()).
// This file stays as a guard against a future regression that reintroduces a
// zero/double-fire on the sync init path.
//
// What this test drives: the REAL startSync() with a pre-selected ?session=
// URL and a mock EventSource, then asserts the Stream-2 opens and hydrates.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock EventSource — mirrors sessionLiveness.test.ts. Tracks construction so we
// can assert how many session streams were created (zero-fire vs double-fire vs
// single-fire) and lets the test fire named SSE events.
// ---------------------------------------------------------------------------
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

  fire(type: string, data: unknown, lastEventId?: string): void {
    const ev = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
    if (lastEventId !== undefined) {
      Object.defineProperty(ev, "lastEventId", { value: lastEventId });
    }
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }

  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }
}

let instances: MockEventSource[] = [];
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

// Flush microtasks from fire-and-forget async paths (deferred effect, openSession,
// refreshOpenSessions, etc.).
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

let sync: typeof import("../../src/sync") = null as unknown as typeof import("../../src/sync");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");

// Set the URL to a pre-selected session BEFORE importing the sync barrel, so the
// module-level urlDir()/currentUrlSession() reads (run at import time) pick up
// the deep link — exactly like a real page load.
async function setupWithPreselected(session: string, dir: string): Promise<void> {
  window.history.replaceState(
    {},
    "",
    `/?session=${encodeURIComponent(session)}&dir=${encodeURIComponent(dir)}`,
  );
  vi.resetModules();
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
  );
  window.localStorage.clear();
  vi.useFakeTimers();
  sync = await import("../../src/sync");
  store = await import("../../src/sync/store");
  stream = await import("../../src/sync/stream");
}

beforeEach(async () => {
  await setupWithPreselected("s1", "/test");
});

afterEach(() => {
  stream?.closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("pre-selected session hydration on first page load", () => {
  it("opens a Stream-2 EventSource for the pre-selected session on startSync (no manual switch)", async () => {
    sync.startSync();
    await flush();
    await flush();

    // Guard #1: a session-stream EventSource MUST be created for s1 during
    // startSync's init. (Pin against a future zero-fire regression on the
    // init branch — the dedup + `!projectDir()` guards must not swallow it.)
    const sES = sessionESes();
    expect(sES).toHaveLength(1);
    expect(sES[0].url).toContain("sessions=s1");
  });

  it("hydrates the transcript (messagesLoaded flips true) once the snapshot arrives — WITHOUT switch-away-and-back", async () => {
    sync.startSync();
    await flush();
    await flush();

    const sES = sessionESes()[0];
    // Simulate the server delivering the active-session snapshot.
    sES.simulateOpen();
    sES.fire("snapshot", {
      seq: 1,
      gate: { s1: { messagesLoaded: true } },
      messages: {},
    });
    await flush();
    await flush();

    // Guard #2: messagesLoaded.s1 MUST be true (the transcript is ready to
    // reveal) on the very first load. The sync layer must deliver this; the
    // VISUAL reveal (.chat-content opacity) is a separate ChatView concern
    // guarded by reveal-gate.spec.ts / ChatViewRevealDeadlock.test.tsx.
    expect(store.state.messagesLoaded.s1).toBe(true);
    expect(store.selectedId()).toBe("s1");
  });

  it("does NOT double-fire openSessionStream on a normal manual switch (happy path unchanged)", async () => {
    sync.startSync();
    await flush();
    await flush();

    // After startSync exactly one session ES exists (the pre-selected s1).
    expect(sessionESes()).toHaveLength(1);

    // Bring it open, then manually switch to s2 — exactly ONE new session ES
    // should be created (the dedup via sesId/ses-healthy must hold: no
    // double-fire on the happy path).
    sessionESes()[0].simulateOpen();
    store.setSelectedIdRaw("s2");
    stream.openSessionStream("s2");
    await flush();
    await flush();

    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[1].url).toContain("sessions=s2");
  });
});

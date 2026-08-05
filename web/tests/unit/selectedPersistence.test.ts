// @vitest-environment jsdom
//
// Resume-state preservation (slice 1): the last-selected session id is
// persisted per-project so an OS-driven relaunch of the installed PWA (which
// drops ?session= by reopening start_url=/) restores the same session. The URL
// still WINS when ?session= is present; localStorage is the fallback ONLY when
// the URL omits it — mirroring the urlDir()/LS_PROJECT pattern.
//
// These are MECHANISM assertions (the persist/restore wiring), NOT outcome
// proofs: the load-bearing outcome (selection survives a real OS-eviction
// resume) is not reproducible in any CI lane in this repo (headless Playwright
// cannot drive OS-level standalone-PWA eviction) and requires the operator's
// manual on-device test. See the slice closeout's behavioral-closure section.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock EventSource — mirrors preselectHydrate.test.ts. Lets us assert which
// session stream startSync() opened (the observable proof a session id was
// restored and opened).
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

  fire(type: string, data: unknown): void {
    const ev = new MessageEvent(type, { data: typeof data === "string" ? data : JSON.stringify(data) });
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }

  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }
}

let instances: MockEventSource[] = [];
const sessionESes = (): MockEventSource[] => instances.filter((e) => /sessions=[^&]/.test(e.url));

// Flush microtasks from fire-and-forget async paths (deferred effect, openSession).
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let actions: typeof import("../../src/sync/actions") = null as unknown as typeof import("../../src/sync/actions");

// Parameterized setup: controls the URL (?session= / ?dir=) and the pre-seeded
// vh.selected.v1:<dir> localStorage value, then (re)imports the sync modules so
// the module-level urlDir()/initialDir reads pick up the configured state —
// exactly like a real page load.
async function setupVariant(opts: {
  session?: string;
  dir: string;
  lsSelected?: string | null;
}): Promise<typeof import("../../src/sync")> {
  const search = opts.session
    ? `?session=${encodeURIComponent(opts.session)}&dir=${encodeURIComponent(opts.dir)}`
    : `?dir=${encodeURIComponent(opts.dir)}`;
  window.history.replaceState({}, "", `/${search}`);
  vi.resetModules();
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
  window.localStorage.clear();
  // Pre-seed the per-project selected-id fallback BEFORE the sync barrel reads
  // it in startSync (loadSelected reads at call time, not import time).
  if (opts.lsSelected !== undefined && opts.lsSelected !== null) {
    window.localStorage.setItem(
      `vh.selected.v1:${opts.dir}`,
      JSON.stringify({ v: 1, data: opts.lsSelected }),
    );
  }
  vi.useFakeTimers();
  const sync = await import("../../src/sync");
  store = await import("../../src/sync/store");
  stream = await import("../../src/sync/stream");
  actions = await import("../../src/sync/actions");
  return sync;
}

beforeEach(() => {
  // no per-test setup; each test calls setupVariant for its own URL/LS matrix.
});

afterEach(() => {
  stream?.closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

// --- Pure helper level: persist/restore round-trip + per-project isolation ---
// (Mirrors store.test.ts's in-memory round-trip style, but against the real
// sync/store helpers via jsdom's localStorage.)
describe("loadSelected / persistSelection helpers", () => {
  it("round-trips a selected id inside the versioned envelope", async () => {
    await setupVariant({ dir: "/p1" });
    store.persistSelection("/p1", "sess-A");
    expect(store.loadSelected("/p1")).toBe("sess-A");
    // Envelope shape on the raw key.
    expect(JSON.parse(window.localStorage.getItem("vh.selected.v1:/p1")!)).toEqual({
      v: 1,
      data: "sess-A",
    });
  });

  it("returns null when no selection was persisted (sparse default)", async () => {
    await setupVariant({ dir: "/p1" });
    expect(store.loadSelected("/p1")).toBeNull();
  });

  it("persists null explicitly (clearing a stale selection)", async () => {
    await setupVariant({ dir: "/p1" });
    store.persistSelection("/p1", "sess-A");
    expect(store.loadSelected("/p1")).toBe("sess-A");
    store.persistSelection("/p1", null);
    expect(store.loadSelected("/p1")).toBeNull();
  });

  it("isolates selections per project directory (dir-suffixed keys)", async () => {
    await setupVariant({ dir: "/p1" });
    store.persistSelection("/p1", "A");
    store.persistSelection("/p2", "B");
    expect(store.loadSelected("/p1")).toBe("A");
    expect(store.loadSelected("/p2")).toBe("B");
    // Writing one must not disturb the other.
    store.persistSelection("/p1", "A2");
    expect(store.loadSelected("/p1")).toBe("A2");
    expect(store.loadSelected("/p2")).toBe("B");
  });

  it("drops a corrupt/legacy payload back to null", async () => {
    await setupVariant({ dir: "/p1" });
    window.localStorage.setItem("vh.selected.v1:/p1", "{not json");
    expect(store.loadSelected("/p1")).toBeNull();
    // A non-string legacy payload also falls back.
    window.localStorage.setItem(
      "vh.selected.v1:/p1",
      JSON.stringify({ v: 1, data: 12345 }),
    );
    expect(store.loadSelected("/p1")).toBeNull();
  });
});

// --- Action level: setSelectedId persists the new selection per-project ---
describe("setSelectedId persists the selection", () => {
  it("writes the new id to the per-project key on a real selection", async () => {
    await setupVariant({ dir: "/p1" });
    // projectDir is "/p1" (from ?dir=); selecting writes vh.selected.v1:/p1.
    actions.setSelectedId("sess-X");
    await flush();
    expect(store.loadSelected("/p1")).toBe("sess-X");
    expect(store.selectedId()).toBe("sess-X");
  });

  it("clearing selection via setSelectedId(null) clears the persisted id", async () => {
    await setupVariant({ dir: "/p1" });
    actions.setSelectedId("sess-X");
    actions.setSelectedId(null);
    await flush();
    expect(store.loadSelected("/p1")).toBeNull();
  });
});

// --- startSync restore matrix: URL wins / LS fallback / neither ---
describe("startSync selection restore (URL wins, localStorage fallback)", () => {
  it("URL ?session= WINS over a persisted localStorage selection (deep-links preserved)", async () => {
    // Both URL and LS carry a session; the URL's must win.
    const sync = await setupVariant({ session: "from-url", dir: "/p1", lsSelected: "from-ls" });
    sync.startSync();
    await flush();
    await flush();

    expect(store.selectedId()).toBe("from-url");
    const sES = sessionESes();
    expect(sES).toHaveLength(1);
    expect(sES[0].url).toContain("sessions=from-url");
    // The URL deep-link also seeds LS so a later OS-relaunch (which drops
    // ?session=) restores it.
    expect(store.loadSelected("/p1")).toBe("from-url");
  });

  it("falls back to the persisted localStorage selection when the URL lacks ?session= (the OS-relaunch case)", async () => {
    // No ?session= (start_url=/) but LS has the last selection — restore it.
    const sync = await setupVariant({ dir: "/p1", lsSelected: "last-opened" });
    expect(window.location.search).not.toContain("session="); // precondition: URL lacks it
    sync.startSync();
    await flush();
    await flush();

    expect(store.selectedId()).toBe("last-opened");
    const sES = sessionESes();
    expect(sES).toHaveLength(1);
    expect(sES[0].url).toContain("sessions=last-opened");
  });

  it("restores NOTHING when neither URL nor localStorage carries a session", async () => {
    const sync = await setupVariant({ dir: "/p1" }); // no ?session=, empty LS
    sync.startSync();
    await flush();
    await flush();

    expect(store.selectedId()).toBeNull();
    expect(sessionESes()).toHaveLength(0);
  });
});

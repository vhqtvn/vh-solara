// @vitest-environment jsdom
//
// F7 (remote-latency brief, 2026-10-12) — project-switch chain overlap.
//
// CONTRACT under test:
//   1. selectProject(dir) fires the /vh/projects GET and the new project's
//      Stream-1 open in the SAME synchronous turn — neither awaits the other
//      (the brief's operator chain paid the /vh/projects round serially at the
//      next switcher-dialog open; ~600ms pre-F1, ~430ms post-F1).
//   2. addProject(rawPath) fires the same overlap (the Add-project gesture
//      lands on a switch too).
//   3. refreshProjectActivity is inflight-coalesced: a second call while one
//      GET is pending issues no second request.
//   4. projectActivity() is the reactive cache the switcher binds: null until
//      the first refresh resolves, then the reduced maps; a failed fetch
//      REPLACES the cache with empty maps (fetchProjectActivity's preserved
//      never-throws degrade-to-empty contract) and never rejects.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const CONNECTING = 0;

class MockEventSource {
  static CLOSED = 2;
  static OPEN = 1;
  static CONNECTING = CONNECTING;
  url: string;
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }
  addEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
}

let instances: MockEventSource[] = [];
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

let projectsMod: typeof import("../../src/projects") = null as unknown as typeof import("../../src/projects");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let fetchMock: ReturnType<typeof vi.fn>;

async function setupFresh(): Promise<void> {
  vi.resetModules();
  instances = [];
  projectsMod = await import("../../src/projects");
  store = await import("../../src/sync/store");
}

beforeEach(async () => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  await setupFresh();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

function deferredFetch(): { resolve: (v: unknown) => void; promise: Promise<unknown> } {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

const okProjectsBody = {
  ok: true,
  status: 200,
  json: async () => [{ dir: "/work/x", roots: 4, running: 1, runningRoots: 1, unreadRoots: 2 }],
} as unknown as Response;

describe("selectProject fires /vh/projects concurrently with the Stream-1 open", () => {
  it("both requests are initiated in the same synchronous turn — neither awaits the other", async () => {
    const { promise: activityP } = deferredFetch();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/vh/projects")) return activityP;
      return Promise.resolve({ ok: true, status: 200, json: async () => [] } as unknown as Response);
    });

    // Synchronous call — NO awaits anywhere in between.
    projectsMod.selectProject("/work/x");

    // (a) The Stream-1 open happened immediately (switchProject → connect(true)
    //     constructs the EventSource synchronously).
    expect(treeESes(), "Stream-1 opened in the same turn").toHaveLength(1);
    expect(store.projectDir()).toBe("/work/x");
    // (b) The /vh/projects GET fired in the same turn, STILL unresolved —
    //     proving the ES open did not wait for it…
    const activityCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/vh/projects"));
    expect(activityCalls.length).toBeGreaterThanOrEqual(1);
    // …and the fetch did not wait for the ES either (both were initiated
    // synchronously; the deferred response is still pending).
    await Promise.resolve();
    expect(treeESes()).toHaveLength(1);
  });

  it("the warmed cache serves the switcher's next open (projectActivity resolves to the reduced maps)", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes("/vh/projects")
        ? Promise.resolve(okProjectsBody)
        : Promise.resolve({ ok: true, status: 200, json: async () => [] } as unknown as Response),
    );
    expect(projectsMod.projectActivity()).toBeNull();
    projectsMod.selectProject("/work/x");
    // Microtask drain lets the fetch + reduce settle.
    await vi.waitFor(() => expect(projectsMod.projectActivity()).not.toBeNull());
    const m = projectsMod.projectActivity()!;
    expect(m.roots.get("/work/x")).toBe(4);
    expect(m.running.get("/work/x")).toBe(1);
    expect(m.unread.get("/work/x")).toBe(2);
  });
});

describe("refreshProjectActivity coalescing + failure tolerance", () => {
  it("a second call while one GET is pending issues no second request", async () => {
    const { resolve: resolveP, promise } = deferredFetch();
    fetchMock.mockImplementation(() => promise);
    projectsMod.refreshProjectActivity();
    projectsMod.refreshProjectActivity();
    projectsMod.refreshProjectActivity();
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("/vh/projects")),
      "one in-flight GET, coalesced",
    ).toHaveLength(1);
    resolveP(okProjectsBody);
    // Wait until the fetch→json→reduce→finally chain fully settles (the
    // inflight guard releases only in finally).
    await vi.waitFor(() => expect(projectsMod.projectActivity()).not.toBeNull());
    // After settling, a new call fetches again (the guard released).
    projectsMod.refreshProjectActivity();
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("/vh/projects")),
    ).toHaveLength(2);
  });

  it("a failed fetch degrades to empty maps (never rejects, never throws)", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error("tunnel down")));
    projectsMod.refreshProjectActivity();
    // fetchProjectActivity's contract: any failure → EMPTY maps (the dialog
    // renders names alone) — preserved exactly from the pre-F7 dialog-open
    // fetch this cache replaced.
    const m = await vi.waitFor(() => {
      const cur = projectsMod.projectActivity();
      expect(cur).not.toBeNull();
      return cur!;
    });
    expect(m.roots.size).toBe(0);
    expect(m.running.size).toBe(0);
    expect(m.unread.size).toBe(0);
  });
});

describe("addProject fires the same overlap", () => {
  it("pins + switches + fires /vh/projects in the same turn", async () => {
    const { promise } = deferredFetch();
    fetchMock.mockImplementation((url: string) => {
      if (url.includes("/vh/projects")) return promise;
      return Promise.resolve({ ok: true, status: 200, json: async () => [] } as unknown as Response);
    });
    projectsMod.addProject("/work/y");
    expect(treeESes(), "Stream-1 opened").toHaveLength(1);
    expect(store.projectDir()).toBe("/work/y");
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("/vh/projects")).length,
    ).toBeGreaterThanOrEqual(1);
  });

  // Pin invariants (review F1/F2): the guard is an idempotent upsert — a new
  // dir is pinned EXACTLY once and persisted; re-adding a pinned dir appends
  // no duplicate. A one-character inversion of this guard passed the whole
  // 3318-test suite before these assertions existed.
  it("pin invariants: new dir pinned once + persisted; re-add adds no duplicate", () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => [] } as unknown as Response),
    );
    projectsMod.addProject("/work/y");
    expect(projectsMod.projects().filter((p) => p.directory === "/work/y")).toHaveLength(1);
    const saved = JSON.parse(localStorage.getItem("vh.projects.v1") || "{}");
    expect(saved.v).toBe(1);
    expect(saved.data.filter((p: { directory: string }) => p.directory === "/work/y")).toHaveLength(1);

    projectsMod.addProject("/work/y"); // re-add: idempotent upsert
    expect(projectsMod.projects().filter((p) => p.directory === "/work/y")).toHaveLength(1);
    const saved2 = JSON.parse(localStorage.getItem("vh.projects.v1") || "{}");
    expect(saved2.data.filter((p: { directory: string }) => p.directory === "/work/y")).toHaveLength(1);
  });
});

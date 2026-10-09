// @vitest-environment jsdom
//
// Weak-link FE-vantage sampler (send-net-resilience slice 4c, debate-2 Q5).
//
// Covers the three pieces the slice adds:
//   1. the sampler module itself (counters, classification, frozen reads);
//   2. the pass-through fetch wrapper (installFetchSampler) — class accuracy
//      AND behavioral transparency (same resolution/rejection, same response
//      identity, idempotent install);
//   3. the TRANSPORT HOOKS — the tree (tree-transport.ts) and session
//      (session-stream.ts) EventSource-CLOSED onerror branches must count
//      exactly one stream drop each (driven through the real connect() /
//      openSessionStream() lifecycle with the MockEventSource pattern from
//      seqGapRecovery.test.ts);
// plus the composition seam: readSyncDiag() (the window.__vhSyncDiag surface)
// must carry the weakLink section.
//
// INSTRUMENTATION-ONLY contract under test: the wrapper never changes what
// the caller sees; the hooks never change reconnect behavior (asserted: the
// tree CLOSED path still schedules its backoff reconnect).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import {
  _resetWeakLinkForTest,
  classifyFetchError,
  installFetchSampler,
  readWeakLink,
  recordFetchFailure,
  recordStreamDrop,
} from "../../src/sync/weaklink";
import { _resetRecoveryCountersForTest, readSyncDiag } from "../../src/sync/recovery-reasons";
import { connect, _resetTreeGapStateForTest } from "../../src/sync/tree-transport";
import {
  closeSessionStream,
  openSessionStream,
  _resetSesGapStateForTest,
} from "../../src/sync/session-stream";
import { setState, setProjectDirRaw, setSelectedIdRaw } from "../../src/sync/store";
import { resetTreeStore } from "../../src/sync/treeState";

// --- Mock EventSource (jsdom lacks one; mirrors seqGapRecovery.test.ts) -----
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
    // Transport-lifecycle test: content listeners are never fired here.
  }

  close(): void {
    this.readyState = CLOSED;
  }

  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }
}

let instances: MockEventSource[] = [];
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));

beforeEach(() => {
  _resetWeakLinkForTest();
  _resetRecoveryCountersForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllTimers();
});

// =============================================================================
// 1. Sampler module
// =============================================================================
describe("weaklink sampler — counters + reads", () => {
  it("counts fetch failures by class and stream drops by stream", () => {
    recordFetchFailure("network");
    recordFetchFailure("network");
    recordFetchFailure("abort");
    recordFetchFailure("http_5xx");
    recordStreamDrop("tree");
    recordStreamDrop("session");
    recordStreamDrop("session");
    const snap = readWeakLink();
    expect(snap.fetchFailures).toEqual({ network: 2, abort: 1, http_5xx: 1 });
    expect(snap.streamDrops).toEqual({ tree: 1, session: 2 });
    expect(typeof snap.generatedAt).toBe("number");
    // Frozen copy semantics: mutating the snapshot must not affect internals.
    snap.fetchFailures.network = 99;
    snap.streamDrops.tree = 99;
    expect(readWeakLink().fetchFailures.network).toBe(2);
    expect(readWeakLink().streamDrops.tree).toBe(1);
  });

  it("classifies fetch rejections: AbortError → abort, everything else → network", () => {
    expect(classifyFetchError(new DOMException("aborted", "AbortError"))).toBe("abort");
    // Duck-typed lookalike (non-DOM environments).
    expect(classifyFetchError({ name: "AbortError" })).toBe("abort");
    expect(classifyFetchError(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyFetchError(null)).toBe("network");
    expect(classifyFetchError(undefined)).toBe("network");
  });
});

// =============================================================================
// 2. Fetch wrapper — class accuracy + behavioral transparency
// =============================================================================
describe("installFetchSampler — pass-through counting wrapper", () => {
  it("counts a successful fetch with NO failure, passes the SAME response through", async () => {
    const res = { ok: true, status: 200 } as Response;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(res)));
    installFetchSampler();
    const out = await fetch("/vh/anything");
    expect(out).toBe(res); // exact identity pass-through
    const snap = readWeakLink();
    expect(snap.fetches).toBe(1);
    expect(snap.fetchFailures).toEqual({ network: 0, abort: 0, http_5xx: 0 });
  });

  it("counts 5xx as http_5xx but NOT 4xx (a definitive answer is not a weak-link event)", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) =>
      Promise.resolve(({ ok: false, status: url.includes("500") ? 500 : 404 }) as Response),
    ));
    installFetchSampler();
    await fetch("/x/500");
    await fetch("/x/404");
    const snap = readWeakLink();
    expect(snap.fetches).toBe(2);
    expect(snap.fetchFailures.http_5xx).toBe(1);
    expect(snap.fetchFailures.network).toBe(0);
  });

  it("classifies rejections (network vs abort) and PROPAGATES them unchanged", async () => {
    const networkErr = new TypeError("Failed to fetch");
    const abortErr = new DOMException("aborted", "AbortError");
    const mock = vi.fn((url: string) =>
      url.includes("/abort") ? Promise.reject(abortErr) : Promise.reject(networkErr),
    );
    vi.stubGlobal("fetch", mock);
    installFetchSampler();
    await expect(fetch("/net")).rejects.toBe(networkErr);
    await expect(fetch("/abort")).rejects.toBe(abortErr);
    const snap = readWeakLink();
    expect(snap.fetches).toBe(2);
    expect(snap.fetchFailures.network).toBe(1);
    expect(snap.fetchFailures.abort).toBe(1);
  });

  it("install is idempotent — a second install never double-counts", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response)));
    installFetchSampler();
    installFetchSampler();
    await fetch("/once");
    expect(readWeakLink().fetches).toBe(1);
  });
});

// =============================================================================
// 3. Composition — the EXISTING __vhSyncDiag surface carries weakLink
// =============================================================================
describe("readSyncDiag composition — one surface, one console call", () => {
  it("exposes the weakLink section alongside recovery + snapshotBytes", () => {
    recordFetchFailure("network");
    recordStreamDrop("tree");
    const diag = readSyncDiag();
    expect(diag.weakLink.fetchFailures.network).toBe(1);
    expect(diag.weakLink.streamDrops.tree).toBe(1);
    expect(diag.weakLink.fetches).toBe(0);
    expect(diag.recovery).toEqual({}); // unchanged sibling section
    expect(diag.snapshotBytes).toEqual({ tree: 0, session: 0 });
  });
});

// =============================================================================
// 4. Transport hooks — the CLOSED onerror branches count the drops
// =============================================================================
describe("transport hooks — EventSource CLOSED counts a stream drop", () => {
  beforeEach(() => {
    instances = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
    localStorage.clear();
    setProjectDirRaw("/test");
    setSelectedIdRaw("s1");
    setState("cursor", 0);
    resetTreeStore();
    _resetTreeGapStateForTest();
    _resetSesGapStateForTest();
  });

  afterEach(() => {
    closeSessionStream();
    setState("messages", reconcile({}));
    setState("refreshing", reconcile({}));
    setSelectedIdRaw(null);
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  });

  it("tree: CLOSED onerror counts exactly one tree drop (and still schedules recovery)", () => {
    vi.useFakeTimers();
    connect(true);
    const es1 = treeESes()[0];
    expect(es1).toBeTruthy();
    es1.simulateOpen();
    // Transport gives up: readyState CLOSED, then onerror fires.
    es1.readyState = CLOSED;
    es1.onerror?.();
    expect(readWeakLink().streamDrops.tree).toBe(1);
    expect(readWeakLink().streamDrops.session).toBe(0);
    // Instrumentation-only: the reconnect scheduling is unchanged — advance
    // the backoff timer and a NEW tree EventSource is constructed.
    vi.advanceTimersByTime(15000);
    expect(treeESes().length).toBeGreaterThan(1);
  });

  it("tree: a CONNECTING onerror (native auto-retry) does NOT count a drop", () => {
    connect(true);
    const es1 = treeESes()[0];
    es1.simulateOpen();
    es1.readyState = CONNECTING; // browser is retrying; not CLOSED
    es1.onerror?.();
    expect(readWeakLink().streamDrops.tree).toBe(0);
  });

  it("session: CLOSED onerror counts exactly one session drop", () => {
    vi.useFakeTimers();
    openSessionStream("s1");
    const es1 = sessionESes()[0];
    expect(es1).toBeTruthy();
    es1.simulateOpen();
    es1.readyState = CLOSED;
    es1.onerror?.();
    expect(readWeakLink().streamDrops.session).toBe(1);
    expect(readWeakLink().streamDrops.tree).toBe(0);
    // Recovery still runs (unchanged behavior): the backoff reopen fires.
    vi.advanceTimersByTime(15000);
    expect(sessionESes().length).toBeGreaterThan(1);
  });
});

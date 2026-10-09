// @vitest-environment jsdom
//
// Slice 5 (webperf build / F7 residual): the LIVENESS SENTINEL — the watchdog
// content-stale boundaries stop guessing and start PROVING worker-pipeline
// liveness via POST /vh/stream/probe + nonce-correlated no-id vh.liveness.
//
// CONTRACT under test (the five outcomes + correlation):
//   (a) IDLE session + probe PROVEN alive → NO recovery; `sentinel-alive`
//       counted; the content clock refresh re-arms the boundary (~2 min/pane
//       probe cadence, not a per-tick loop).
//   (b) IDLE session + probe TIMEOUT → cursor-PRESERVING recovery through
//       the retry seam (URL carries cursor=; NEVER openSessionStream which
//       resets sesCursor); `sentinel-timeout` counted. This is the F7 fix:
//       an idle pane with a dead pipeline now recovers.
//   (c) BUSY session + long content silence + probe PROVEN alive → NO forced
//       snapshot (kills the false-positive cursorless re-snapshot on
//       legitimate silent tool runs); `sentinel-alive` counted.
//   (d) probe 404 (old worker) → legacy behavior EXACTLY (idle-skip /
//       active-force), `sentinel-legacy-fallback` counted, capability memo'd
//       for the session lifetime (no further probe fetches).
//   (e) NONCE CORRELATION: a vh.liveness frame with a WRONG nonce does not
//       resolve the probe (timeout still fires); a probe issued for the
//       session stream is resolved by the frame arriving on the TREE stream
//       ("whichever receives it first" — EmitTransient broadcasts to every
//       project-store subscriber).
//   (f) pane hidden MID-PROBE → the timeout does NOT recover a deliberately
//       suspended pane's stream (the reveal path owns reopening it).
//   (g) slice 5b: the watchdog's CLOSED-stream branch reopens cursor-
//       preserving (the old openSessionStream(sesId) reset sesCursor).
//
// Harness mirrors idleWatchdog.test.ts (MockEventSource + setupFresh with
// vi.resetModules). The fetch stub CAPTURES the probe nonce from the URL so
// tests can fire the matching vh.liveness frame; probeStatus controls the
// stubbed probe response (200 default, 404 for the legacy-fallback tests).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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

  fire(type: string, data?: unknown, lastEventId?: string): void {
    const ev = new MessageEvent(type, {
      data:
        data === undefined
          ? undefined
          : typeof data === "string"
            ? data
            : JSON.stringify(data),
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

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let counters: typeof import("../../src/sync/recovery-reasons") = null as unknown as typeof import("../../src/sync/recovery-reasons");
let paneVisibility: typeof import("../../src/sync/../paneVisibility") = null as unknown as typeof import("../../src/sync/../paneVisibility");

// The fetch stub: captures probe nonces; probeStatus flips the probe answer.
let probeStatus = 200;
let lastProbeNonce = "";
const fetchMock = vi.fn((input: unknown): Promise<Response> => {
  const u = String(input);
  const m = /\/vh\/stream\/probe\?nonce=([^&]+)/.exec(u);
  if (m) lastProbeNonce = decodeURIComponent(m[1]);
  return Promise.resolve(new Response("{}", { status: probeStatus }));
});

async function setupFresh(): Promise<void> {
  vi.resetModules();
  instances = [];
  lastProbeNonce = "";
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  counters = await import("../../src/sync/recovery-reasons");
  paneVisibility = await import("../../src/paneVisibility");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

beforeEach(async () => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  probeStatus = 200;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  vi.useFakeTimers();
  await setupFresh();
});

afterEach(() => {
  stream?.closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const sessionSnapshot = (seq: number, id = "s1") => ({
  seq,
  gate: { [id]: { messagesLoaded: true } },
  messages: {},
});
// The tree snapshot is a WHOLESALE detail-snapshot replace: whatever
// activity map it carries REPLACES state.activity (reducers). Tests that
// rely on a BUSY session must re-assert the marker on every cycle's tree
// snapshot (the same discipline sessionLivenessContentStall.test.ts
// documents); an activity-less fixture legitimately reads as idle.
const treeSnapshot = (seq: number, sessionIds: string[] = ["s1"], activity?: Record<string, string>) => ({
  seq,
  activity,
  sessions: sessionIds.map((id) => ({ id })),
});

// openHealthyStreams: connect both streams, open them, and seed one content
// event each so both content clocks start fresh.
async function openHealthyStreams(): Promise<void> {
  stream.connect();
  treeESes()[0].simulateOpen();
  treeESes()[0].fire("snapshot", treeSnapshot(1), "1");
  stream.openSessionStream("s1");
  sessionESes()[0].simulateOpen();
  sessionESes()[0].fire("snapshot", sessionSnapshot(1), "1");
  await flush();
}

// ageSessionContentStale: cycles of pings-only on the session (transport
// alive, content silent) with a HEALTHY tree control, running the watchdog
// each cycle — until the session content clock crosses CONTENT_STALE_MS and
// the boundary fires (probe issued). activity (when given) is re-asserted on
// each tree snapshot so a busy fixture stays busy across the wholesale
// detail-snapshot replaces.
function ageSessionContentStale(cycles = 9, activity?: Record<string, string>): void {
  for (let cycle = 0; cycle < cycles; cycle++) {
    vi.advanceTimersByTime(15_000);
    treeESes()[0].fire("ping");
    treeESes()[0].fire("snapshot", treeSnapshot(cycle + 2, ["s1"], activity), String(cycle + 2));
    sessionESes()[0].fire("ping");
    stream.watchdogTick();
    if (lastProbeNonce) return; // boundary fired
  }
}

// resolveOnSession fires the matching vh.liveness frame on the session ES.
function resolveOnSession(nonce = lastProbeNonce): void {
  sessionESes()[0].fire("vh.liveness", { nonce });
}

describe("(a) idle + PROVEN alive → no recovery, clock refreshed", () => {
  it("probe issued once per boundary; liveness frame → sentinel-alive, no reconnect, no forced/skip codes", async () => {
    await openHealthyStreams();
    // idle: no activity anywhere → sessionWorking(s1) false, anySessionActive() false.
    ageSessionContentStale();
    expect(lastProbeNonce).not.toBe(""); // the boundary fired a probe
    expect(fetchMock).toHaveBeenCalled();

    resolveOnSession();
    await flush();

    // PROVEN alive → no recovery at all.
    expect(sessionESes()).toHaveLength(1);
    const d = counters.readSyncDiag();
    expect((d.recovery["sentinel-probe-issued"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect((d.recovery["sentinel-alive"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(d.recovery["sentinel-timeout"]).toBeUndefined();
    expect(d.recovery["sentinel-legacy-fallback"]).toBeUndefined();
    expect(d.recovery["idle-content-stale"]).toBeUndefined();
    expect(d.recovery["idle-content-stale-skipped"]).toBeUndefined();

    // The proof refreshed the content clock: more ping-only cycles UNDER
    // CONTENT_STALE_MS must not re-probe (no per-tick probe loop).
    const calls = fetchMock.mock.calls.length;
    for (let cycle = 0; cycle < 4; cycle++) {
      vi.advanceTimersByTime(15_000);
      treeESes()[0].fire("ping");
      sessionESes()[0].fire("ping");
      stream.watchdogTick();
    }
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(sessionESes()).toHaveLength(1);
  });
});

describe("(b) idle + timeout → cursor-preserving recovery (the F7 fix)", () => {
  it("no liveness frame → SENTINEL_TIMEOUT fires → reopen with cursor= (retry seam, NOT cursorless force)", async () => {
    await openHealthyStreams();
    ageSessionContentStale();
    expect(lastProbeNonce).not.toBe("");

    // NO vh.liveness arrives (the dead-pipeline posture). SENTINEL_TIMEOUT
    // (12s) elapses.
    await vi.advanceTimersByTimeAsync(12_000);

    // Cursor-PRESERVING recovery: a second ES whose URL carries the cursor
    // (sesCursor=1 from the snapshot's globalSeq) — never the cursorless
    // openSessionStream(id, true) path.
    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[1].url).toContain("cursor=1");
    expect(sessionESes()[0].readyState).toBe(CLOSED); // old connection torn down
    const d = counters.readSyncDiag();
    expect((d.recovery["sentinel-timeout"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(d.recovery["sentinel-alive"]).toBeUndefined();
    expect(d.recovery["idle-content-stale"]).toBeUndefined(); // never the legacy force
    expect(d.recovery["idle-content-stale-skipped"]).toBeUndefined();
  });
});

describe("(c) busy + long silence + PROVEN alive → NO forced snapshot", () => {
  it("active session on a silent tool run: probe → liveness → no reconnect (was: unconditional cursorless force)", async () => {
    await openHealthyStreams();
    store.setState("activity", "s1", "busy");
    await flush();

    ageSessionContentStale(9, { s1: "busy" });
    expect(lastProbeNonce).not.toBe("");
    resolveOnSession();
    await flush();

    expect(sessionESes()).toHaveLength(1);
    const d = counters.readSyncDiag();
    expect((d.recovery["sentinel-alive"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(d.recovery["idle-content-stale"]).toBeUndefined(); // the old false-positive force is gone
    expect(d.recovery["sentinel-timeout"]).toBeUndefined();
  });
});

describe("(d) 404 → legacy behavior EXACTLY + capability memo", () => {
  it("idle + 404 → idle-skip (no reconnect), sentinel-legacy-fallback counted, memo stops further probes", async () => {
    probeStatus = 404;
    await openHealthyStreams();

    ageSessionContentStale();
    expect(lastProbeNonce).not.toBe("");
    await flush(); // let the 404 .then run (settle + onLegacy)

    // Legacy idle behavior: NO recovery, skip counted per tick.
    expect(sessionESes()).toHaveLength(1);
    const d = counters.readSyncDiag();
    expect((d.recovery["sentinel-legacy-fallback"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect((d.recovery["idle-content-stale-skipped"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(d.recovery["sentinel-timeout"]).toBeUndefined();
    expect(d.recovery["sentinel-alive"]).toBeUndefined();
    expect(d.recovery["idle-content-stale"]).toBeUndefined();

    // Capability memo: further boundaries must NOT fetch again.
    const calls = fetchMock.mock.calls.length;
    for (let cycle = 0; cycle < 6; cycle++) {
      vi.advanceTimersByTime(15_000);
      treeESes()[0].fire("ping");
      sessionESes()[0].fire("ping");
      stream.watchdogTick();
    }
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(sessionESes()).toHaveLength(1);
  });

  it("busy + 404 → legacy force EXACTLY as pre-slice-5 (cursorless, idle-content-stale counted)", async () => {
    probeStatus = 404;
    await openHealthyStreams();
    store.setState("activity", "s1", "busy");
    await flush();

    ageSessionContentStale(9, { s1: "busy" });
    await flush();

    // Legacy active behavior: the forced cursorless fresh-snapshot reconnect.
    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[1].url).not.toMatch(/cursor=/);
    const d = counters.readSyncDiag();
    expect((d.recovery["idle-content-stale"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect((d.recovery["sentinel-legacy-fallback"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("(e) nonce correlation", () => {
  it("WRONG nonce does not resolve the probe — timeout still fires the recovery", async () => {
    await openHealthyStreams();
    ageSessionContentStale();
    // A foreign/echoed-from-another-pane nonce must be ignored.
    sessionESes()[0].fire("vh.liveness", { nonce: "not-the-nonce-you-are-looking-for" });
    await flush();

    await vi.advanceTimersByTimeAsync(12_000);
    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[1].url).toContain("cursor=1");
    const d = counters.readSyncDiag();
    expect(d.recovery["sentinel-alive"]).toBeUndefined();
    expect((d.recovery["sentinel-timeout"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("session-issued probe resolved by the frame arriving on the TREE stream (whichever-first)", async () => {
    await openHealthyStreams();
    ageSessionContentStale();
    expect(lastProbeNonce).not.toBe("");

    // The broadcast reaches EVERY project-store subscriber; the tree stream's
    // copy resolves the pending probe.
    treeESes()[0].fire("vh.liveness", { nonce: lastProbeNonce });
    await flush();

    expect(sessionESes()).toHaveLength(1); // no session recovery — proven alive
    const d = counters.readSyncDiag();
    expect((d.recovery["sentinel-alive"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(d.recovery["sentinel-timeout"]).toBeUndefined();
  });

  it("a vh.liveness frame with NO pending probe is ignored (stray late echo)", async () => {
    await openHealthyStreams();
    resolveOnSession("stray-echo-nonce");
    await flush();
    const d = counters.readSyncDiag();
    expect(d.recovery["sentinel-alive"]).toBeUndefined();
    expect(sessionESes()).toHaveLength(1);
  });
});

describe("(f) pane hidden mid-probe → timeout does not recover a suspended pane", () => {
  it("probe issued while visible, host hides the pane, timeout elapses → NO reopen (reveal owns it)", async () => {
    await openHealthyStreams();
    ageSessionContentStale();
    expect(lastProbeNonce).not.toBe("");

    // The host hides the pane between issue and timeout (the watchdog's
    // entry pane-gate cannot catch this — the probe is already in flight).
    paneVisibility.__setHostVisibleForTest(false);

    await vi.advanceTimersByTimeAsync(12_000);

    // No recovery: the pane's streams are deliberately suspended; the reveal
    // path (resumeSessionStreamForVisibility) owns reopening cursor-
    // preserving. The timeout itself is still counted (honest signal).
    expect(sessionESes()).toHaveLength(1);
    const d = counters.readSyncDiag();
    expect((d.recovery["sentinel-timeout"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("(g) slice 5b: watchdog closed-stream branch reopens cursor-preserving", () => {
  it("fatally-closed session stream → the WATCHDOG branch reopens with the preserved cursor (was cursorless)", async () => {
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();
    sessionESes()[0].fire("snapshot", sessionSnapshot(5), "100.0");
    await flush();

    // The stream is CLOSED but NO backoff retry is pending: close WITHOUT
    // firing onerror (the fatal-error callback is what schedules sesRetry).
    // This makes the watchdog's closed branch — the code slice 5b changed —
    // the ONLY thing that can construct the replacement. (Firing onerror
    // and advancing past the 1500ms backoff would let the PRE-EXISTING retry
    // seam open the ES and the test would pass vacuously on pre-5b code.)
    sessionESes()[0].close();
    expect(sessionESes()[0].readyState).toBe(CLOSED);

    // The watchdog's closed branch fires.
    vi.advanceTimersByTime(1_000); // < sesBackoff (1500ms) — no retry can fire
    stream.watchdogTick();

    // Cursor-PRESERVING: pre-5b this branch called openSessionStream(sesId)
    // → closeSessionStream → sesCursor=0 → a CURSORLESS url. The preserved
    // cursor=100 fails on the pre-5b path — this is the regression pin.
    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[1].url).toContain("cursor=100");
    expect(sessionESes()[1].url).not.toMatch(/cursor=0/);
    // UI honesty: the reopen re-arms the per-session refresh indicator.
    expect(store.state.refreshing["s1"]).toBe(true);
  });
});

describe("(h) tree boundary: capability-confirmed sentinel outcomes", () => {
  // ageTreeContentStale: pings-only on the TREE (transport alive, content
  // silent) with a HEALTHY session control, until the TREE content-stale
  // boundary fires a probe. The session control must keep flowing content so
  // the session boundary never steals the single in-flight probe slot.
  function ageTreeContentStale(cycles = 9): void {
    for (let cycle = 0; cycle < cycles; cycle++) {
      vi.advanceTimersByTime(15_000);
      treeESes()[0].fire("ping");
      sessionESes()[0].fire("ping");
      sessionESes()[0].fire("snapshot", sessionSnapshot(cycle + 2), String(cycle + 2));
      stream.watchdogTick();
      if (lastProbeNonce) return; // tree boundary fired
    }
  }

  it("tree content-stale + PROVEN alive → no tree reconnect; proof refreshes the tree clock", async () => {
    await openHealthyStreams();
    ageTreeContentStale();
    expect(lastProbeNonce).not.toBe("");

    // Whichever-first: the frame arriving on the SESSION stream resolves the
    // TREE-issued probe (the symmetric direction of (e)).
    sessionESes()[0].fire("vh.liveness", { nonce: lastProbeNonce });
    await flush();

    expect(treeESes()).toHaveLength(1);
    const d = counters.readSyncDiag();
    expect((d.recovery["sentinel-alive"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(d.recovery["sentinel-timeout"]).toBeUndefined();
    expect(d.recovery["tree-idle-stale"]).toBeUndefined();
    expect(d.recovery["tree-idle-stale-skipped"]).toBeUndefined();

    // Proof refreshed treeContentSeen: cycles under CONTENT_STALE_MS must
    // neither re-probe nor reconnect.
    const calls = fetchMock.mock.calls.length;
    for (let cycle = 0; cycle < 4; cycle++) {
      vi.advanceTimersByTime(15_000);
      treeESes()[0].fire("ping");
      sessionESes()[0].fire("ping");
      stream.watchdogTick();
    }
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(treeESes()).toHaveLength(1);
  });

  it("tree content-stale + timeout → connect() recovery carrying the shared cursor", async () => {
    await openHealthyStreams();
    ageTreeContentStale();
    expect(lastProbeNonce).not.toBe("");

    await vi.advanceTimersByTimeAsync(12_000);

    // The tree recovery is connect() WITHOUT fresh — the URL carries the
    // shared resume cursor (state.cursor=1 from the tree snapshot's seq),
    // so the server takes the ring-replay branch, not a full re-ship.
    expect(treeESes()).toHaveLength(2);
    expect(treeESes()[1].url).toContain("cursor=1");
    expect(treeESes()[0].readyState).toBe(CLOSED);
    const d = counters.readSyncDiag();
    expect((d.recovery["sentinel-timeout"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(d.recovery["tree-idle-stale"]).toBeUndefined(); // never the legacy force
  });
});

// @vitest-environment jsdom
//
// Slice 2 (webperf build1): pane-visibility sync lifecycle.
//
// CONTRACT under test (the idle 9-pane heat fix):
//   1. A pane hidden via the HOST signal (vh-host-visibility → hostVisible
//      false; document.visibilityState stays "visible" — the cross-origin
//      iframe gap) runs NO watchdog/maybeReconnect/resyncTree recovery: its
//      streams stay suspended instead of churning ~130s reconnects.
//   2. suspendSessionStreamForVisibility closes the ES WITHOUT resetting
//      sesCursor; the reveal reopens THROUGH the retry seam with cursor=N
//      (ring replay), exactly once.
//   3. Tree suspend/resume: the FIRST resume after boot connects FRESH (no
//      cursor — LS-hydrated state is incomplete); later resumes connect with
//      cursor (transient-reconnect resume).
//
// The sync.ts facade glue (onPaneVisibilityChange → suspend/resume) is
// mirrored here manually so the module seams are exercised without booting
// the full startSync surface.
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

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let paneVis: typeof import("../../src/paneVisibility") = null as unknown as typeof import("../../src/paneVisibility");
let health: typeof import("../../src/sync/health") = null as unknown as typeof import("../../src/sync/health");
let counters: typeof import("../../src/sync/recovery-reasons") = null as unknown as typeof import("../../src/sync/recovery-reasons");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  instances = [];
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  paneVis = await import("../../src/paneVisibility");
  health = await import("../../src/sync/health");
  counters = await import("../../src/sync/recovery-reasons");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
  // Mirror the sync.ts facade wiring (startSync's onPaneVisibilityChange +
  // resumeSyncForVisibility's reveal reconciliation), including the slice-1
  // reason counting. (openSession's HTTP leg is omitted — fetch is stubbed.)
  paneVis.onPaneVisibilityChange((visible) => {
    if (visible) {
      counters.countRecovery("visibility-resume");
      stream.resumeTreeFromVisibility();
      health.stampTreeResyncBoundary();
      const sel = store.selectedId();
      const resumable = stream.getResumableSesId();
      if (!sel) {
        if (resumable !== null) stream.closeSessionStream();
      } else if (resumable !== null && resumable === sel) {
        stream.resumeSessionStreamForVisibility();
      } else {
        stream.openSessionStream(sel);
      }
    } else {
      counters.countRecovery("visibility-pause");
      stream.suspendTreeForVisibility();
      stream.suspendSessionStreamForVisibility();
    }
  });
}

beforeEach(async () => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
  );
  window.localStorage.clear();
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

const sessionSnapshot = (seq: number, id = "s1") => ({
  seq,
  gate: { [id]: { messagesLoaded: true } },
  messages: {},
});

describe("hidden pane (host signal) → no recovery of any kind", () => {
  it("watchdogTick does NOT reconnect stale/closed streams while host-hidden", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    // Hide the pane (host signal; document stays "visible" in jsdom).
    paneVis.__setHostVisibleForTest(false);
    expect(treeESes()[0].readyState).toBe(CLOSED); // suspended
    expect(sessionESes()[0].readyState).toBe(CLOSED);

    // Age EVERY clock past both thresholds with the pane hidden.
    vi.advanceTimersByTime(200_000);
    stream.watchdogTick();

    // No recovery: no new EventSources were constructed while hidden.
    expect(treeESes()).toHaveLength(1);
    expect(sessionESes()).toHaveLength(1);
  });

  it("maybeReconnect and resyncTree are no-ops while host-hidden", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await vi.advanceTimersByTimeAsync(0);
    health._resetResyncGateForTest();

    paneVis.__setHostVisibleForTest(false);
    stream.maybeReconnect(); // tree is "closed" (suspended) — must not connect
    health.resyncTree(); // on-focus/periodic funnel — must not connect(true)
    expect(treeESes()).toHaveLength(1);
    expect(sessionESes()).toHaveLength(1);
  });

  it("document-visible but host-hidden is the discriminated case (doc check alone would pass)", async () => {
    // jsdom's document.visibilityState defaults to "visible" — exactly the
    // CSS-hidden-iframe posture. The host signal must gate it.
    expect(document.visibilityState).toBe("visible");
    paneVis.__setHostVisibleForTest(false);
    stream.connect(); // direct connect still works (boot path is gated in the facade)
    expect(treeESes()).toHaveLength(1);
    vi.advanceTimersByTime(200_000);
    stream.watchdogTick();
    expect(treeESes()).toHaveLength(1); // no watchdog reopen
  });
});

describe("session stream suspend/resume (cursor preservation)", () => {
  it("suspend closes the ES; resume reopens ONCE with cursor=N (ring replay)", async () => {
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    sessionESes()[0].fire("snapshot", sessionSnapshot(5), "100.0");
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionESes()).toHaveLength(1);

    paneVis.__setHostVisibleForTest(false); // → suspend (cursor preserved)
    expect(sessionESes()[0].readyState).toBe(CLOSED);

    paneVis.__setHostVisibleForTest(true); // → resume
    // Exactly ONE replacement, carrying the preserved cursor.
    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[1].url).toContain("cursor=100");
    // The resume arms the existing per-session refresh indicator (UI honesty):
    expect(store.state.refreshing["s1"]).toBe(true);

    // A second hide→reveal cycle resumes exactly once MORE (cursor still
    // preserved); a duplicate visible transition (no intervening hide) is a
    // no-op — the paneVisibility last-guard + the sesSuspended flag make the
    // resume edge-triggered, never level-triggered.
    paneVis.__setHostVisibleForTest(false);
    paneVis.__setHostVisibleForTest(true);
    expect(sessionESes()).toHaveLength(3);
    expect(sessionESes()[2].url).toContain("cursor=100");
    paneVis.__setHostVisibleForTest(true); // duplicate: no change event, no reopen
    expect(sessionESes()).toHaveLength(3);
  });

  it("a session SWITCH supersedes the suspension (closeSessionStream clears it)", async () => {
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    sessionESes()[0].fire("snapshot", sessionSnapshot(5), "100.0");
    paneVis.__setHostVisibleForTest(false);

    // Switch while hidden (selection moves AND the stream is re-targeted —
    // the realistic programmatic-switch shape).
    store.setSelectedIdRaw("s2");
    stream.openSessionStream("s2");
    expect(sessionESes()).toHaveLength(2);
    // The s2 open went through the FRESH path (no cursor from s1 leaked).
    expect(sessionESes()[1].url).not.toContain("cursor=");

    // Reveal must NOT reopen anything over the live s2 (the switch cleared
    // the suspension; the reveal's already-open guard holds).
    paneVis.__setHostVisibleForTest(true);
    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[1].readyState).not.toBe(CLOSED);
  });

  it("selection moved while hidden → reveal opens the CURRENT selection fresh (no stale resume)", async () => {
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    sessionESes()[0].fire("snapshot", sessionSnapshot(5), "100.0");
    paneVis.__setHostVisibleForTest(false); // suspend with s1 cursor preserved

    // Host-driven selection change while hidden (vh-host-select): the gated
    // selection effect skips openSessionStream, so only the store moved.
    store.setSelectedIdRaw("s2");

    paneVis.__setHostVisibleForTest(true); // reveal reconciliation
    const es = sessionESes();
    expect(es).toHaveLength(2);
    // The reveal streams the CURRENT selection, fresh (the suspended s1
    // cursor must NOT be replayed onto s2).
    expect(es[1].url).toContain("sessions=s2");
    expect(es[1].url).not.toContain("cursor=");
  });

  it("selection CLEARED while hidden → reveal closes the stream instead of resuming stale", async () => {
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    paneVis.__setHostVisibleForTest(false);
    store.setSelectedIdRaw("");
    paneVis.__setHostVisibleForTest(true);
    expect(sessionESes()).toHaveLength(1); // no reopen of the stale s1
    expect(stream.getResumableSesId()).toBeNull(); // suspension consumed
  });

  it("boot-hidden pane with a restored selection opens it fresh on reveal (exactly once)", async () => {
    // startSync ran while hidden: suspend with nothing open, selection restored.
    paneVis.__setHostVisibleForTest(false);
    store.setSelectedIdRaw("s1");
    paneVis.__setHostVisibleForTest(true);
    const es = sessionESes();
    expect(es).toHaveLength(1);
    expect(es[0].url).toContain("sessions=s1");
    expect(es[0].url).not.toContain("cursor="); // nothing was ever streamed
    paneVis.__setHostVisibleForTest(true); // duplicate transition: no-op
    expect(sessionESes()).toHaveLength(1);
  });
});

describe("tree stream suspend/resume", () => {
  it("first resume after boot connects FRESH; later resumes connect with cursor", async () => {
    paneVis.__setHostVisibleForTest(false); // hidden at boot → suspend, never opened
    paneVis.__setHostVisibleForTest(true); // reveal
    expect(treeESes()).toHaveLength(1);
    // everOpened is false (no onopen fired) → fresh connect (no cursor param,
    // mirroring the boot connect(true) contract for LS-hydrated state).
    expect(treeESes()[0].url).not.toContain("cursor=");

    treeESes()[0].simulateOpen();
    // Advance the store cursor via a live tree event (session.upsert seq 42).
    treeESes()[0].fire("session.upsert", { id: "s1" }, "42.1");
    await vi.advanceTimersByTimeAsync(0);

    paneVis.__setHostVisibleForTest(false);
    expect(treeESes()[0].readyState).toBe(CLOSED);
    paneVis.__setHostVisibleForTest(true);
    expect(treeESes()).toHaveLength(2);
    // Transient-reconnect resume: cursor-based (ring replay).
    expect(treeESes()[1].url).toContain("cursor=");
  });
});

describe("recovery counters track the visibility lifecycle", () => {
  it("visibility-pause / visibility-resume are counted by stable reason", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    paneVis.__setHostVisibleForTest(false);
    paneVis.__setHostVisibleForTest(true);
    const d = counters.readSyncDiag();
    expect(d.recovery["visibility-pause"]?.count).toBe(1);
    expect(d.recovery["visibility-resume"]?.count).toBe(1);
  });
});

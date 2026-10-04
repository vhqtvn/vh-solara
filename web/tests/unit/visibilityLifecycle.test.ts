// @vitest-environment jsdom
//
// Slice 2 (webperf build1): pane-visibility sync lifecycle.
// Hidden-pane STATUS (2026-10-04): the tree stream stays live while
// host-hidden (docs/ai/hidden-pane-status.md).
//
// CONTRACT under test:
//   1. A pane hidden via the HOST signal (vh-host-visibility → hostVisible
//      false; document.visibilityState stays "visible" — the cross-origin
//      iframe gap) suspends ONLY its transcript stream (Stream-2). The TREE
//      stream (Stream-1) stays connected — the host's tab badges derive from
//      it — and keeps its watchdog/maybeReconnect liveness recovery. The
//      session branch of the watchdog and resyncTree stand down while
//      host-hidden (no transcript churn, no drift-churn snapshots).
//   2. A pane hidden via the DOCUMENT (standalone tab backgrounded, or the
//      embedded tab backgrounded) suspends BOTH streams and runs NO recovery
//      of any kind — the original slice-2 posture, preserved.
//   3. suspendSessionStreamForVisibility closes the ES WITHOUT resetting
//      sesCursor; the reveal reopens THROUGH the retry seam with cursor=N
//      (ring replay), exactly once.
//   4. Tree suspend/resume: the FIRST resume after a DOC-hidden boot connects
//      FRESH (no cursor — LS-hydrated state is incomplete); later resumes
//      connect with cursor (transient-reconnect resume). A host-hidden pane
//      boots its tree OPEN (status must be live without a reveal).
//
// The sync.ts facade glue (onPaneVisibilityChange → suspend/resume, and the
// startSync boot branch) is mirrored here manually so the module seams are
// exercised without booting the full startSync surface.
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

/** Drive document visibility through the REAL signal path (listener installed
 *  by startPaneVisibility), as a browser tab switch would. */
function setDocVisibility(v: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    get: () => v,
    configurable: true,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Mirrors sync.ts suspendSyncForVisibility (2026-10-04 policy). */
function suspendSyncMirror(): void {
  counters.countRecovery("visibility-pause");
  if (paneVis.isDocVisible()) {
    // Host-hidden: only the transcript stream suspends; the tree stays live.
    stream.suspendSessionStreamForVisibility();
    return;
  }
  stream.suspendTreeForVisibility();
  stream.suspendSessionStreamForVisibility();
}

/** Mirrors sync.ts resumeSyncForVisibility (reveal reconciliation). */
function resumeSyncMirror(): void {
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
}

/** Mirrors the startSync boot branch (2026-10-04 policy). */
function bootSyncMirror(): void {
  if (!paneVis.isPaneVisible()) {
    suspendSyncMirror();
    if (paneVis.isDocVisible() && store.projectDir()) stream.connect(true);
  } else if (store.projectDir()) {
    stream.connect(true);
  } else {
    stream.closeSessionStream();
  }
}

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
  // Install the REAL document-visibility tracker so setDocVisibility drives
  // the module's own signal (jsdom defaults to "visible" — the embedded
  // iframe posture). Not embedded → no host message listener; the host signal
  // is driven via __setHostVisibleForTest below.
  paneVis.startPaneVisibility();
  // Mirror the sync.ts facade wiring (startSync's onPaneVisibilityChange).
  paneVis.onPaneVisibilityChange((visible) => {
    if (visible) resumeSyncMirror();
    else suspendSyncMirror();
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

describe("host-hidden pane (2026-10-04): tree stays live, session + churn stand down", () => {
  it("host-hide closes ONLY the session stream; the tree stays connected", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    paneVis.__setHostVisibleForTest(false);
    expect(treeESes()[0].readyState, "tree stays OPEN while host-hidden").toBe(OPEN);
    expect(sessionESes()[0].readyState, "session suspends").toBe(CLOSED);
  });

  it("watchdogTick recovers a stalled TREE while host-hidden, never the session", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await vi.advanceTimersByTimeAsync(0);

    paneVis.__setHostVisibleForTest(false);
    // Age the tree's transport clock past STALE_MS with the pane hidden (a
    // dead-but-OPEN socket while the operator never reveals the workspace).
    vi.advanceTimersByTime(200_000);
    stream.watchdogTick();

    // The tree recovered (a NEW EventSource was constructed)…
    expect(treeESes().length).toBeGreaterThan(1);
    // …and the session did NOT (its branch stands down while host-hidden).
    expect(sessionESes()).toHaveLength(1);
  });

  it("maybeReconnect reconnects a closed tree while host-hidden; resyncTree stays a no-op", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await vi.advanceTimersByTimeAsync(0);
    health._resetResyncGateForTest();

    paneVis.__setHostVisibleForTest(false);
    // Simulate the tree dying on its own (server drop): closed, not suspended.
    treeESes()[0].close();
    stream.maybeReconnect();
    expect(treeESes().length, "tree recovered").toBeGreaterThan(1);
    health.resyncTree(); // on-focus/periodic drift funnel — must NOT connect(true)
    const treeCount = treeESes().length;
    expect(sessionESes()).toHaveLength(1);
    // A second resyncTree call confirms the no-op (no cursorless snapshot).
    health.resyncTree();
    expect(treeESes()).toHaveLength(treeCount);
  });

  it("document-visible but host-hidden runs the TREE watchdog branch (the discriminated case)", async () => {
    // jsdom's document.visibilityState defaults to "visible" — exactly the
    // CSS-hidden-iframe posture. The tree branch must RUN in this state.
    expect(document.visibilityState).toBe("visible");
    paneVis.__setHostVisibleForTest(false);
    stream.connect(); // direct connect still works (boot path connects too)
    expect(treeESes()).toHaveLength(1);
    vi.advanceTimersByTime(200_000);
    stream.watchdogTick();
    expect(treeESes().length, "watchdog reopens the dead tree").toBeGreaterThan(1);
  });

  it("boot-hidden (host) with a project still opens the tree; the session defers to reveal", async () => {
    paneVis.__setHostVisibleForTest(false);
    bootSyncMirror();
    expect(treeESes(), "tree opened at boot while host-hidden").toHaveLength(1);
    expect(treeESes()[0].url).not.toContain("cursor=");
    expect(sessionESes(), "session deferred").toHaveLength(0);

    paneVis.__setHostVisibleForTest(true);
    expect(treeESes(), "reveal does not reconnect the live tree").toHaveLength(1);
    expect(sessionESes(), "reveal opens the restored selection").toHaveLength(1);
  });
});

describe("doc-hidden pane (standalone/backgrounded) → no recovery of any kind", () => {
  it("doc-hide suspends BOTH streams; watchdogTick/maybeReconnect/resyncTree are no-ops", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await vi.advanceTimersByTimeAsync(0);
    health._resetResyncGateForTest();

    setDocVisibility("hidden");
    expect(treeESes()[0].readyState).toBe(CLOSED); // suspended
    expect(sessionESes()[0].readyState).toBe(CLOSED);

    vi.advanceTimersByTime(200_000);
    stream.watchdogTick();
    stream.maybeReconnect();
    health.resyncTree();

    expect(treeESes()).toHaveLength(1);
    expect(sessionESes()).toHaveLength(1);
    setDocVisibility("visible"); // restore for afterEach hygiene
  });

  it("doc-hidden boot defers ALL streaming to the reveal", async () => {
    setDocVisibility("hidden");
    bootSyncMirror();
    expect(treeESes()).toHaveLength(0);
    expect(sessionESes()).toHaveLength(0);
    setDocVisibility("visible");
    expect(treeESes(), "reveal connects the tree fresh").toHaveLength(1);
    expect(treeESes()[0].url).not.toContain("cursor=");
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

describe("tree stream suspend/resume (doc-hidden boundary)", () => {
  it("first resume after a doc-hidden boot connects FRESH; later resumes connect with cursor", async () => {
    setDocVisibility("hidden"); // hidden at boot → both suspended, never opened
    bootSyncMirror();
    setDocVisibility("visible"); // reveal
    expect(treeESes()).toHaveLength(1);
    // everOpened is false (no onopen fired) → fresh connect (no cursor param,
    // mirroring the boot connect(true) contract for LS-hydrated state).
    expect(treeESes()[0].url).not.toContain("cursor=");

    treeESes()[0].simulateOpen();
    // Advance the store cursor via a live tree event (session.upsert seq 42).
    treeESes()[0].fire("session.upsert", { id: "s1" }, "42.1");
    await vi.advanceTimersByTimeAsync(0);

    setDocVisibility("hidden"); // doc-hidden suspend (tree suspended)
    expect(treeESes()[0].readyState).toBe(CLOSED);
    setDocVisibility("visible"); // transient-reconnect resume
    expect(treeESes()).toHaveLength(2);
    // Resume: cursor-based (ring replay).
    expect(treeESes()[1].url).toContain("cursor=");
  });

  it("host-hidden → doc-hidden: no transition re-fires (pane already hidden); the tree heals on doc-return", async () => {
    // Host-hidden first (tree stays live)…
    paneVis.__setHostVisibleForTest(false);
    stream.connect();
    treeESes()[0].simulateOpen();
    treeESes()[0].fire("session.upsert", { id: "s1" }, "42.1");
    await vi.advanceTimersByTimeAsync(0);
    // …then the document hides too (operator backgrounds the whole tab).
    // paneVisible was ALREADY false, so notify() fires no transition and the
    // facade suspend does not re-run: the tree stream stays connected. The
    // browser suspends background socket delivery as it sees fit; the
    // doc-gated watchdog stands down while hidden. Documented edge in
    // docs/ai/hidden-pane-status.md (cost: one open SSE per host-hidden pane
    // while the whole browser window is backgrounded).
    setDocVisibility("hidden");
    expect(treeESes()[0].readyState, "no re-suspend at the doc boundary").toBe(OPEN);
    // Simulate the socket dying while the tab is backgrounded…
    treeESes()[0].close();
    // …doc returns (still host-hidden): the watchdog's tree branch runs again
    // and recovers it — hidden-pane status stays fresh without a reveal.
    setDocVisibility("visible");
    vi.advanceTimersByTime(200_000);
    stream.watchdogTick();
    expect(treeESes().length, "tree recovered on doc-return").toBeGreaterThan(1);
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

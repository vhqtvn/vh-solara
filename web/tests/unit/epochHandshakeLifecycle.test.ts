// @vitest-environment jsdom
//
// epochHandshakeLifecycle.test.ts — F1 epoch-handshake round 2: the
// commit-review BLOCK findings C-F1/C-F2 (client-side completeness).
//
// C-F1 — an EventSource URL is FROZEN at construction, and native
// auto-reconnect re-requests that same URL forever. The first tree connect
// of a page life necessarily precedes the snapshot that would tell it the
// epoch. FIX under test: the last-applied epoch is PERSISTED per project dir
// and declared by every subsequent boot's FIRST URL (covering the persisted
// state.cursor — an equally previous-lifetime resume candidate); a live URL
// that is DECLARED-STALE (asserts a lifetime that is no longer current) or a
// mid-life transition (E1→E2 while connected) gets a deferred URL-swap
// reconnect; a plain epoch-less first-establishment does NOT churn a
// reconnect (a reconnect is a significant app event, not a URL swap).
//
// C-F2 — Stream-2's resume cursors (live sesCursor + the lastKnownSesCursor
// memory) can OUTLIVE the store lifetime they were accumulated under, while
// the declared epoch is the CURRENT global state.epoch. FIX under test:
// cursors are sent only when their accumulation epoch equals the declared
// epoch (pairing guards at the open seam), and the cursor memory is
// invalidated when the store lifetime changes.
//
// Harness mirrors session-cursor-persistence.test.ts (resetModules +
// MockEventSource + raw store setters + fake timers) and
// snapshotComplete.test.ts (coherent tree capture driver).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";

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
    });
    Object.defineProperty(ev, "lastEventId", { value: lastEventId });
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
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let sesMod: typeof import("../../src/sync/session-stream") = null as unknown as typeof import("../../src/sync/session-stream");
let treeMod: typeof import("../../src/sync/tree-transport") = null as unknown as typeof import("../../src/sync/tree-transport");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  instances = [];
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  sesMod = await import("../../src/sync/session-stream");
  treeMod = await import("../../src/sync/tree-transport");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

beforeEach(async () => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
  );
  window.localStorage.clear();
  window.history.replaceState({}, "", "/?tree=2");
  vi.useFakeTimers();
  await setupFresh();
});

afterEach(() => {
  stream?.closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  window.history.replaceState({}, "", "/");
});

// Pump the microtask queue (decode/flush continuations are microtasks; fake
// timers do not fake microtasks).
const flushMicro = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

// The epoch-upgrade reconnect is deferred to a QUIET window (2s with no
// in-flight capture/decode) so it never lands mid-burst. Advance fake time
// past it.
const pumpQuietWindow = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(2100);
  await flushMicro();
};

const SID = "s1";
// The per-dir persisted-epoch LS key (mirrors tree-transport bootEpochKey).
const bootEpochKey = (): string => `vh:syncepoch:/test`;

// The URL cursor an EventSource construction carried (0 = cursorless).
const urlCursor = (es: MockEventSource): number => {
  const m = /(?:^|\?|&)cursor=(\d+)/.exec(es.url);
  return m ? Number(m[1]) : 0;
};

// The URL epoch an EventSource construction declared ("" = none).
const urlEpoch = (es: MockEventSource): string => {
  const m = /(?:^|\?|&)epoch=([^&]+)/.exec(es.url);
  return m ? decodeURIComponent(m[1]) : "";
};

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
// decode). Mirrors snapshotComplete.test.ts fireCoherentCapture.
function fireCoherentCapture(es: MockEventSource, epoch: string, seq: number): void {
  es.fire("tree.snapshot", { tree: "2", epoch, seq, nodes: [node("s1"), node("s2")] }, String(seq));
  es.fire("snapshot", { seq, epoch, sessions: [{ id: "s1", title: "d-s1" }, { id: "s2", title: "d-s2" }] }, String(seq));
  es.fire("snapshot.complete", { epoch, revision: seq, projections: ["tree", "detail"] }, String(seq));
}

// A RAW session snapshot for `id` carrying message `msgID`. Mirrors
// session-cursor-persistence.test.ts rawSessionSnap. `epoch` stamps the
// PRODUCER lifetime (round 6: every current daemon marshals Snapshot.Epoch
// into session detail snapshots — omit it to emulate the old-daemon shape
// whose claims fall back to state.epoch).
function rawSessionSnap(seq: number, id: string, msgID: string, epoch?: string): any {
  return {
    seq,
    ...(epoch ? { epoch } : {}),
    gate: { [id]: { messagesLoaded: true } },
    messages: {
      [id]: [{ info: { id: msgID, sessionID: id, role: "assistant", time: { created: 1 } }, parts: [] }],
    },
  };
}

// A REAL gzip64 session snapshot (node:zlib gzipSync + base64 — the server's
// exact round-trip, the session-cursor-persistence.test.ts discipline): the
// listener advances sesCursor at RECEIPT, then decodes on a genuinely async
// native pipe — the mid-decode window of the t1b-F1/t1c-F1 race.
const gzip64Snapshot = (snap: unknown): { encoding: "gzip64"; data: string } => ({
  encoding: "gzip64",
  data: Buffer.from(gzipSync(Buffer.from(JSON.stringify(snap)))).toString("base64"),
});

// noteStoreEpochChanged — imported lazily so a pre-fix tree (missing export)
// fails THIS test cleanly instead of the whole file at link time.
// `prevEpoch` mirrors the tree transport's call: "" = establishment (first
// snapshot of a page life), non-empty = a real transition (restart).
function notifyEpochChanged(epoch: string, prevEpoch: string): void {
  const fn = (sesMod as unknown as Record<string, unknown>).noteStoreEpochChanged as
    | ((e: string, prev: string) => void)
    | undefined;
  if (typeof fn !== "function") {
    throw new Error("pre-fix: session-stream does not export noteStoreEpochChanged");
  }
  fn(epoch, prevEpoch);
}

describe("C-F1 — first-establishment persists the epoch; returning boots declare it in the FIRST URL", () => {
  it("a first-ever boot stays epoch-less and does NOT churn a reconnect; the epoch is persisted; the next open declares it", async () => {
    treeMod.connect(true); // page boot: no epoch anywhere
    const es0 = treeESes()[0];
    expect(es0.url).not.toContain("epoch=");
    es0.simulateOpen();

    // First coherent capture applies → state.epoch established ("" → E1).
    fireCoherentCapture(es0, "E1", 5);
    await flushMicro();
    expect(store.state.epoch).toBe("E1");

    // Establishment is NOT a URL-swap trigger (that would be a reconnect per
    // page load): the quiet window passes with no reconstruction.
    await pumpQuietWindow();
    expect(treeESes()).toHaveLength(1);

    // The established lifetime is PERSISTED for the next boot.
    expect(window.localStorage.getItem(bootEpochKey())).toBe("E1");

    // Any later manual reconstruction (error ladder / watchdog / visibility)
    // goes through connect() — and now declares the epoch, with the cursor.
    treeMod.connect(false, "watchdog", "test");
    const es1 = treeESes()[1];
    expect(urlEpoch(es1)).toBe("E1");
    expect(urlCursor(es1)).toBe(5);
    expect(treeESes()[0].readyState).toBe(CLOSED);
  });

  it("a returning boot (persisted epoch) declares it in the very first URL — same lifetime, no swap", async () => {
    window.localStorage.setItem(bootEpochKey(), "E1");
    treeMod.connect(true);
    const es0 = treeESes()[0];
    expect(urlEpoch(es0)).toBe("E1"); // declared from the first connect
    es0.simulateOpen();

    // Same lifetime re-establishes (state.epoch "" → E1): no transition, no
    // declared-stale URL → no swap ever fires.
    fireCoherentCapture(es0, "E1", 7);
    await flushMicro();
    await pumpQuietWindow();
    expect(treeESes()).toHaveLength(1);
    expect(urlCursor(treeESes()[0] && es0)).toBe(0); // cursorless boot shape unchanged
  });

  it("a returning boot against a RESTARTED store (persisted epoch stale) swaps the mis-declaring URL", async () => {
    window.localStorage.setItem(bootEpochKey(), "E1");
    treeMod.connect(true);
    const es0 = treeESes()[0];
    expect(urlEpoch(es0)).toBe("E1");
    es0.simulateOpen();

    // The daemon restarted while this page was closed: the server's
    // fresh-fallback snapshot carries E2; the URL still DECLARES E1.
    fireCoherentCapture(es0, "E2", 3);
    await flushMicro();
    expect(store.state.epoch).toBe("E2");
    expect(window.localStorage.getItem(bootEpochKey())).toBe("E2"); // re-persisted

    // Declared-stale → the deferred URL swap fires: the new URL declares E2
    // with the re-baselined cursor (native retries of the old URL would
    // fresh-fallback forever otherwise).
    await pumpQuietWindow();
    const trees = treeESes();
    expect(trees).toHaveLength(2);
    expect(urlEpoch(trees[1])).toBe("E2");
    expect(urlCursor(trees[1])).toBe(3);
  });

  it("a MID-LIFE transition (restart while connected) swaps the URL even when it was epoch-less", async () => {
    treeMod.connect(true); // first-ever boot shape (epoch-less URL)
    const es0 = treeESes()[0];
    es0.simulateOpen();
    fireCoherentCapture(es0, "E1", 5);
    await flushMicro();
    await pumpQuietWindow();
    expect(treeESes()).toHaveLength(1); // establishment: still no swap

    // Daemon restarted: the fresh-fallback snapshot under E2 applies on the
    // same connection; guardSnapshotApply re-baselines cursor to seq 9.
    es0.simulateOpen();
    fireCoherentCapture(es0, "E2", 9);
    await flushMicro();
    expect(store.state.epoch).toBe("E2");

    // Mid-life transition (prev E1 ≠ "") arms the swap regardless of the
    // URL's own declaration — post-restart reconnect churn is recovery, and
    // the swapped URL declares E2 from then on.
    await pumpQuietWindow();
    const trees = treeESes();
    expect(trees).toHaveLength(2);
    expect(urlEpoch(trees[1])).toBe("E2");
    expect(urlCursor(trees[1])).toBe(9); // the E2 re-baselined cursor, correctly paired
  });
});

describe("C-F1/C-F2 — session stream: epoch transition invalidates cursors; declared-stale URLs are rebuilt", () => {
  it("noteStoreEpochChanged reopens a DECLARED-stale session ES cursorless under the new epoch (C-F2 core)", async () => {
    store.setState("epoch", "E1");
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    expect(urlEpoch(es0)).toBe("E1");
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    expect(urlCursor(es0)).toBe(0); // pin: first open was cursorless

    // Daemon restart observed by the TREE stream: epoch now E2; this ES's
    // URL asserts E1 (declared-stale) → reconstructed. (A TRANSITION: the
    // tree store had E1 before.)
    store.setState("epoch", "E2");
    notifyEpochChanged("E2", "E1");
    await flushMicro();

    const ses = sessionESes();
    expect(ses).toHaveLength(2);
    expect(urlEpoch(ses[1])).toBe("E2");
    // THE C-F2 CRUX: the E1-accumulated cursor (100) is NOT replayed against
    // the E2 store — the reopen is cursorless → server fresh-snapshots.
    expect(urlCursor(ses[1])).toBe(0);
    expect(ses[0].readyState).toBe(CLOSED);
  });

  it("an epoch-LESS session URL (boot race) is NOT reconstructed at establishment — no reconnect churn", async () => {
    // Session ES opened before the first tree snapshot: URL has no epoch.
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    expect(urlEpoch(es0)).toBe("");
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();

    // The tree snapshot establishes E1 — memory invalidated, but the ES is
    // left alone (its resume safety is the pairing guard, not a churn).
    notifyEpochChanged("E1", "");
    await flushMicro();
    await pumpQuietWindow();
    expect(sessionESes()).toHaveLength(1); // NOT reconstructed
  });

  it("a same-store boot race keeps its APPLIED cursor via the PRODUCER stamp (regression pin — the pins-multiclient full-run shape)", async () => {
    // The boot race: session frames land BEFORE the first tree snapshot. The
    // snapshot carries its OWN producer epoch (E1 — the store serving this
    // page), so the apply-proven claim is stamped E1 before state.epoch even
    // exists. The first tree snapshot then establishes E1 — the store did NOT
    // change. A later preserving reopen (error ladder / watchdog) must still
    // resume from the cursor (replay), NOT downgrade to a cursorless full
    // re-snapshot. (Round 6: this is now PRODUCER-stamping, not adoption —
    // the claim was never ""-stamped because the producer declared itself.)
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1", "E1"), "100.1");
    await flushMicro();
    // Tree snapshot establishes the lifetime id.
    store.setState("epoch", "E1");
    notifyEpochChanged("E1", "");
    await flushMicro();
    sesMod.reopenSessionStreamPreservingCursor("watchdog", "test");
    const es1 = sessionESes()[1];
    expect(urlEpoch(es1)).toBe("E1"); // declared now that it is known
    expect(urlCursor(es1)).toBe(100); // PRODUCER-stamped — cursor preserved (not 0)
  });

  it("reselect after an epoch change (no notification observed) drops the remembered cursor (C-F2 reviewer scenario)", async () => {
    store.setState("epoch", "E1");
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();

    // Switch away (lastKnownSesCursor[s1] = 100, accumulated under E1).
    stream.closeSessionStream();
    // Tree stream re-seeded under E2 while this session was not open.
    store.setState("epoch", "E2");
    // User reselects the session — pre-fix this URL pairs cursor=100 (E1
    // content) with epoch=E2 (matching handshake) → cross-lifetime replay.
    stream.openSessionStream(SID, false, "selection-change", "reselect");
    const es = sessionESes()[1];
    expect(urlEpoch(es)).toBe("E2");
    expect(urlCursor(es)).toBe(0); // pre-fix: 100 — the mispaired cursor is sent
  });

  it("preserving reopen after an epoch change drops the live cursor too", async () => {
    store.setState("epoch", "E1");
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    // Live sesCursor = 100 (E1-stamped). Epoch changes underneath (tree
    // re-seed), then the watchdog preserving-reopen fires.
    store.setState("epoch", "E2");
    sesMod.reopenSessionStreamPreservingCursor("watchdog", "test");
    const es = sessionESes()[1];
    expect(urlEpoch(es)).toBe("E2");
    expect(urlCursor(es)).toBe(0); // pre-fix: 100 — live cursor mispaired with E2
  });
});

describe("additivity pin — no epoch in play ⇒ byte-identical legacy cursor behavior", () => {
  it("same-epoch-unknown (\"\") page life still resumes with the remembered cursor and no epoch param", async () => {
    // state.epoch stays "" throughout (no snapshot ever carried one; no
    // persisted epoch — first-ever visit).
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    // Zero-open excursion (cursor parks at 0), then a preserving reopen — the
    // cursor-loss fix's restored resume must keep working when epochs pair at
    // "" (both unknown = the pre-handshake client shape).
    stream.openSessionStream(SID, true, "recovery-fresh", "test-zeroing");
    await flushMicro();
    sesMod.reopenSessionStreamPreservingCursor("watchdog", "test");
    const es = sessionESes()[2];
    expect(es.url).not.toContain("epoch=");
    expect(urlCursor(es)).toBe(100); // remembered cursor restored — unchanged
  });
});

describe("round 3 (review b-F1) — the session ES never stays epoch-less-or-stale across a known lifetime change", () => {
  it("a TRANSITION reconstructs an epoch-LESS session ES cursorless — its native reconnect would bypass the handshake (b-F1 crux)", async () => {
    // Boot race: the session ES opened before the first tree snapshot, so
    // its URL is epoch-less (first-ever visit — nothing persisted either).
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    expect(urlEpoch(es0)).toBe("");
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    // Tree establishes E1 (adoption; the epoch-less ES is left alone — that
    // no-churn shape is pinned by the round-2 suite above).
    store.setState("epoch", "E1");
    notifyEpochChanged("E1", "");
    await flushMicro();
    expect(sessionESes()).toHaveLength(1);

    // A genuine restart while connected (E1 → E2). The pairing guards run
    // only at OPEN time — the surviving epoch-less URL's native
    // auto-reconnect would send Last-Event-ID 100 with NO epoch param and
    // disable the server check (the b-F1 window). The transition must
    // rebuild it, cursorless, under the new epoch.
    store.setState("epoch", "E2");
    notifyEpochChanged("E2", "E1");
    await flushMicro();

    const ses = sessionESes();
    expect(ses).toHaveLength(2); // RECONSTRUCTED (b-F1 close)
    expect(urlEpoch(ses[1])).toBe("E2");
    expect(urlCursor(ses[1])).toBe(0); // the E1-accumulated cursor is dead
    expect(ses[0].readyState).toBe(CLOSED);
  });

  it("a returning boot's boot-race session open DECLARES the persisted epoch (symmetric with the tree opener)", async () => {
    // The last visit persisted E1; this page's session ES opens BEFORE any
    // tree snapshot. state.epoch is "" — but readBootEpoch() knows E1.
    window.localStorage.setItem(bootEpochKey(), "E1");
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    expect(urlEpoch(es0)).toBe("E1"); // declared — not epoch-less
    expect(urlCursor(es0)).toBe(0); // no cursor yet; declared-epoch-without-cursor is a server no-op

    // Same-lifetime establishment: the URL was already right — no churn.
    store.setState("epoch", "E1");
    notifyEpochChanged("E1", "");
    await flushMicro();
    await pumpQuietWindow();
    expect(sessionESes()).toHaveLength(1);

    // Frames accumulate under E1; a preserving reopen pairs cursor+epoch.
    es0.fire("snapshot", rawSessionSnap(50, SID, "m1"), "50.1");
    await flushMicro();
    sesMod.reopenSessionStreamPreservingCursor("watchdog", "test");
    const es1 = sessionESes()[1];
    expect(urlEpoch(es1)).toBe("E1");
    expect(urlCursor(es1)).toBe(50);
  });

  it("a returning boot against a RESTARTED store: establishment rebuilds the mis-declaring session URL and resumes the PRODUCER-stamped, APPLIED cursor", async () => {
    window.localStorage.setItem(bootEpochKey(), "E1");
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    expect(urlEpoch(es0)).toBe("E1"); // declared the PREVIOUS lifetime

    // Boot-race frames land from the RESTARTED store (E2 data — the tree
    // snapshot just has not arrived yet) and APPLY synchronously (raw
    // encoding) — noteSessionCursorApplied stamps the APPLY-proven cursor
    // with the PRODUCER's own E2 (round 6: the producer stamp is the truth;
    // state.epoch is still "" here).
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1", "E2"), "100.1");
    await flushMicro();

    // Tree snapshot establishes E2 (first of this page life). The E1-
    // declaring URL is permanently wrong — every native retry of it takes a
    // wasteful fresh fallback — so establishment rebuilds it. The rebuild
    // zeroes the LIVE receipt-time cursor (the t1b-F1/t1c-F1 race below)
    // but restores the lastKnown cursor: PRODUCER-stamped E2 at APPLY —
    // apply-proven content of the currently-serving store is safe to resume.
    store.setState("epoch", "E2");
    notifyEpochChanged("E2", "");
    await flushMicro();

    const ses = sessionESes();
    expect(ses).toHaveLength(2);
    expect(urlEpoch(ses[1])).toBe("E2");
    expect(urlCursor(ses[1])).toBe(100); // APPLIED content resumed (not the receipt-time suspect)
    expect(ses[0].readyState).toBe(CLOSED);
  });

  it("the establishment rebuild NEVER resumes the receipt-time cursor across an in-flight gzip64 decode (t1b-F1/t1c-F1)", async () => {
    window.localStorage.setItem(bootEpochKey(), "E1");
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    expect(urlEpoch(es0)).toBe("E1");

    // A REAL gzip64 session snapshot from the restarted (E2) store: the
    // listener advances sesCursor to 100 at RECEIPT, then starts the
    // async native decode — which has NOT applied when the tree establishes.
    es0.fire("snapshot", gzip64Snapshot(rawSessionSnap(100, SID, "m-race")), "100.1");
    await flushMicro(); // receipt handled; the decode pipe is still in flight

    store.setState("epoch", "E2");
    notifyEpochChanged("E2", "");
    await flushMicro();

    const ses = sessionESes();
    expect(ses).toHaveLength(2);
    expect(urlEpoch(ses[1])).toBe("E2");
    // THE RACE: pre-fix, the rebuild resumed the receipt-advanced cursor=100
    // — a MATCHING E2 handshake over content whose baseline decode the
    // rebuild's own sesGen bump had just discarded: the server takes the
    // replay branch and never re-sends the unapplied baseline (silent
    // transcript loss while looking resumed). Post-fix the rebuild is
    // cursorless (the lastKnown map is stamped only at APPLY — nothing to
    // restore) → the server re-baselines with a fresh session snapshot.
    expect(urlCursor(ses[1])).toBe(0);
    expect(ses[0].readyState).toBe(CLOSED);
  });

  it("a HOST-HIDDEN session is zeroed at declared-stale establishment too — the reveal must not resume the receipt-time cursor (round-4 t1c-F1)", async () => {
    window.localStorage.setItem(bootEpochKey(), "E1");
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    expect(urlEpoch(es0)).toBe("E1");

    // Receipt of a REAL gzip64 E2-store snapshot advances the live cursor;
    // the async decode is still in flight when the host hides the pane.
    es0.fire("snapshot", gzip64Snapshot(rawSessionSnap(100, SID, "m-hidden")), "100.1");
    await flushMicro();
    // Visibility suspend: sesGen++ (the in-flight decode is DISCARDED),
    // ses = null, sesId + sesCursor deliberately PRESERVED for cheap resume.
    sesMod.suspendSessionStreamForVisibility();
    expect(es0.readyState).toBe(CLOSED);

    // The tree stream stays live while hidden and establishes E2. The
    // declared-stale establishment must zero the retained cursor DESPITE
    // ses === null — the pre-round-4 guard skipped the zeroing for hidden
    // sessions, and the reveal's pairing guard would then send cursor=100
    // with the now-matching epoch (replay past the discarded baseline).
    store.setState("epoch", "E2");
    notifyEpochChanged("E2", "");
    await flushMicro();
    expect(sessionESes()).toHaveLength(1); // NOT rebuilt while hidden

    // Reveal: reopens through the retry seam — must be cursorless.
    sesMod.resumeSessionStreamForVisibility();
    const ses = sessionESes();
    expect(ses).toHaveLength(2);
    expect(urlEpoch(ses[1])).toBe("E2");
    expect(urlCursor(ses[1])).toBe(0); // the receipt-time cursor was zeroed
  });

  it("a same-lifetime boot-race session URL (declared == established) is NOT rebuilt at establishment — no churn", async () => {
    // The ordinary returning-boot shape: persisted E1, store still E1. The
    // boot-race session URL declared E1 correctly — establishment must not
    // touch it (this is every page load, not a restart).
    window.localStorage.setItem(bootEpochKey(), "E1");
    stream.openSessionStream(SID, false, "first-open", "boot");
    expect(urlEpoch(sessionESes()[0])).toBe("E1");
    store.setState("epoch", "E1");
    notifyEpochChanged("E1", "");
    await flushMicro();
    await pumpQuietWindow();
    expect(sessionESes()).toHaveLength(1); // untouched
  });
});

describe("round 6 (gate t1b-F1) — PRODUCER-stamped claims; a previous-lifetime cursor is never relabeled into the new epoch", () => {
  it("an E1-PRODUCED apply-proven cursor is never relabeled into E2 (restart between session apply and first tree snapshot)", async () => {
    // THE ROUND-6 CRUX. No persisted epoch (first visit). The session stream
    // opens epoch-less; the OLD store (E1) serves the boot race — the
    // snapshot APPLIES carrying its own producer epoch E1 while state.epoch
    // is still "" (the tree snapshot has not landed).
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    expect(urlEpoch(es0)).toBe("");
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1", "E1"), "100.1");
    await flushMicro();

    // The daemon RESTARTS; the first tree snapshot of this page life
    // establishes E2. Pre-round-6, the establishment branch ADOPTED the
    // ""-stamped memory (relabel ""→E2) and the resume sent cursor=100
    // &epoch=E2 — a MATCHING handshake over the dead store's history: the
    // exact P2 cross-lifetime window, laundered client-side where the
    // server's epoch check cannot see it. The producer stamp (E1) must keep
    // the claim foreign: the open is cursorless.
    store.setState("epoch", "E2");
    notifyEpochChanged("E2", "");
    await flushMicro();
    sesMod.reopenSessionStreamPreservingCursor("watchdog", "test");
    const es1 = sessionESes()[1];
    expect(urlEpoch(es1)).toBe("E2");
    expect(urlCursor(es1)).toBe(0); // pre-fix: 100 — the relabeled E1 cursor
  });

  it("a pre-establishment reopen DECLARES the memory's producer epoch and resumes its cursor (server-validated pairing)", async () => {
    // A same-store boot race that APPLIED: the map holds a PRODUCER-stamped
    // claim (E2) while state.epoch and the persisted boot epoch are still
    // empty. The reopen is the first moment the page can name the store's
    // lifetime — declare the PRODUCER's own id WITH the cursor: the server
    // validates the pairing (mismatch ⇒ fresh fallback), and the cursor does
    // not regress into an epoch-less URL (the pre-handshake shape).
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1", "E2"), "100.1");
    await flushMicro();
    sesMod.reopenSessionStreamPreservingCursor("watchdog", "test");
    const es1 = sessionESes()[1];
    expect(urlEpoch(es1)).toBe("E2"); // declared from the producer stamp
    expect(urlCursor(es1)).toBe(100); // restored — same-store producer pairs
  });

  it("unproven (''-stamped) memory dies when the first PROVEN claim lands (strict clear)", async () => {
    // Old-daemon-shaped claims (no producer epoch in the payload) stamp ""
    // via the state.epoch fallback. When a PROVEN (producer-stamped) claim
    // then lands — on ANOTHER session's stream; the map is per-session —
    // the "" entries are unproven provenance: they die at the stamp change
    // rather than being relabeled (adoption is gone).
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    // s2's stream applies a PRODUCER-stamped claim (E2): the stamp change
    // clears s1's unproven entry with it.
    stream.closeSessionStream();
    stream.openSessionStream("s2", false, "selection-change", "reselect");
    sessionESes()[1].fire("snapshot", rawSessionSnap(50, "s2", "m2", "E2"), "50.1");
    await flushMicro();

    // Reselect s1: its remembered cursor is GONE (cleared at the stamp
    // change) — the open is cursorless under the declared E2.
    stream.closeSessionStream();
    stream.openSessionStream(SID, false, "selection-change", "reselect");
    const es2 = sessionESes()[2];
    expect(urlEpoch(es2)).toBe("E2");
    expect(urlCursor(es2)).toBe(0); // pre-fix: 100 — the unproven entry survived
  });

  it("establishment clears a ''-stamped memory (boot-race message-class claims are unproven)", async () => {
    // ""-stamped claims that survive to establishment (message-class claims
    // made pre-establishment never carry a producer epoch) are unproven
    // provenance: the establishment branch clears the map rather than
    // adopting (round-6: adoption was the relabeling hole).
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    // Tree establishes E1 — the ""-stamped memory dies (no adoption).
    store.setState("epoch", "E1");
    notifyEpochChanged("E1", "");
    await flushMicro();
    sesMod.reopenSessionStreamPreservingCursor("watchdog", "test");
    const es1 = sessionESes()[1];
    expect(urlEpoch(es1)).toBe("E1");
    expect(urlCursor(es1)).toBe(0); // pre-fix: 100 — adoption relabeled it
  });
});

describe("round 7 (gate t1b-F1, inverse ordering) — delayed previous-lifetime frames after an establishment never resume", () => {
  it("a DELAYED E1 snapshot on an epoch-less connection AFTER E2 establishment reopens cursorless (live cursor never resumed)", async () => {
    // THE ROUND-7 CRUX. The session ES opens epoch-less (first visit, boot
    // race). The tree then establishes E2 — the epoch-less session ES is
    // deliberately left alive (no churn). The ORIGINAL connection now
    // delivers a DELAYED snapshot from the OLD store (producer E1 —
    // buffered at the transport when the daemon restarted): its generation
    // is still current, so the receipt listener runs — pre-round-7 the LIVE
    // cursor receipt-stamped sesCursor=100 under state.epoch=E2, and the
    // preserving reopen preferred the live arm → cursor=100&epoch=E2, a
    // MATCHING handshake the server cannot reject. Post-round-7 the open
    // resumes ONLY from the apply-proven (producer-stamped E1) memory —
    // which cannot pair with the E2 declaration → cursorless.
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    expect(urlEpoch(es0)).toBe("");
    store.setState("epoch", "E2");
    notifyEpochChanged("E2", "");
    await flushMicro();
    expect(sessionESes()).toHaveLength(1); // epoch-less ES not rebuilt (no churn)

    // The delayed E1-produced snapshot arrives on the ORIGINAL connection.
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1", "E1"), "100.1");
    await flushMicro();

    sesMod.reopenSessionStreamPreservingCursor("watchdog", "test");
    const es1 = sessionESes()[1];
    expect(urlEpoch(es1)).toBe("E2");
    expect(urlCursor(es1)).toBe(0); // pre-fix: 100 — the live arm laundered it
  });

  it("a delayed E1 MESSAGE frame after the E1 snapshot claims under the connection's PRODUCER stamp, never under the new epoch", async () => {
    // Message frames carry no epoch of their own — their producer is the
    // connection's last APPLIED snapshot's producer. A delayed E1 message
    // following the delayed E1 snapshot must claim the cursor memory with
    // the E1 producer stamp (foreign to the declared E2 → never resumed).
    // Pre-round-7 the message claim stamped raw state.epoch=E2: the stamp
    // change CLEARED the E1 entries and re-claimed the E1-produced seq
    // under E2 — the same laundering through the message path.
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    store.setState("epoch", "E2");
    notifyEpochChanged("E2", "");
    await flushMicro();
    // Delayed E1 snapshot applies (map claims E1 by producer), then a
    // delayed E1 message event (seq 105) lands on the same connection.
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1", "E1"), "100.1");
    await flushMicro();
    es0.fire("message.upsert", { id: "m2", sessionID: SID, role: "user", time: { created: 5 } }, "105.1");
    await flushMicro();

    sesMod.reopenSessionStreamPreservingCursor("watchdog", "test");
    const es1 = sessionESes()[1];
    expect(urlEpoch(es1)).toBe("E2");
    expect(urlCursor(es1)).toBe(0); // pre-fix: 105 — the E1-produced seq claimed under E2
  });
});

describe("round 9 (gate F1, buffered-message laundering) — message frames never stamp state.epoch while the producer is unresolved", () => {
  it("a buffered E1 message during a pending E1 gzip64 decode (epoch-less conn, E2 established) reopens cursorless", async () => {
    // THE ROUND-8 PANEL ORDERING, verbatim. The session ES opens epoch-less
    // AND cursorless (first open — sesResumedCursor=false, so nothing about
    // its frames is server-validated). The tree establishes E2; the
    // epoch-less ES is deliberately left alive. The ORIGINAL connection
    // delivers a delayed E1 gzip64 snapshot (live stamp "" — producer
    // invisible until decode) and then a BUFFERED E1 message (seq 105)
    // BEFORE the decode applies. Pre-round-9 the message's receipt stamped
    // the LIVE cursor `sesProducerEpoch || state.epoch` = E2 — a matching
    // handshake the server cannot reject once the reopen's generation bump
    // discards the pending decode (applySnap's foreign-producer reconcile
    // never runs). Post-round-9 the stamp is "" (producer unresolved, conn
    // not server-validated) → the live arm cannot pair → cursorless.
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    expect(urlEpoch(es0)).toBe("");
    expect(urlCursor(es0)).toBe(0);
    store.setState("epoch", "E2");
    notifyEpochChanged("E2", "");
    await flushMicro();
    expect(sessionESes()).toHaveLength(1); // epoch-less ES not rebuilt (no churn)

    // Delayed E1 gzip64 snapshot (REAL gzip64: the decode stays pending
    // across the microtask pumps — suite discipline), then the buffered E1
    // message on the same connection, BEFORE the decode applies.
    es0.fire("snapshot", gzip64Snapshot(rawSessionSnap(100, SID, "m1", "E1")), "100.1");
    await flushMicro();
    es0.fire("message.upsert", { id: "m2", sessionID: SID, role: "user", time: { created: 5 } }, "105.1");
    await flushMicro();

    // Preserving reopen BEFORE the decode applies: the reopen's sesGen bump
    // will gen-drop the pending decode, so its applySnap reconcile never
    // runs — the cursor stamps taken at receipt are all that exist.
    sesMod.reopenSessionStreamPreservingCursor("watchdog", "test");
    const es1 = sessionESes()[1];
    expect(urlEpoch(es1)).toBe("E2");
    expect(urlCursor(es1)).toBe(0); // pre-fix: 105 — buffered E1 message stamped E2 at receipt
  });

  it("a foreign message that APPLIES before any snapshot on a cursorless connection claims under \"\", never state.epoch", async () => {
    // The map-claim variant (no gzip64 involved): a cursorless connection
    // with the tree already established to E2 receives a previous-lifetime
    // message that APPLIES (no snapshot ever landed on this connection —
    // sesProducerEpoch stays \"\"). Pre-round-9 the message-class claim
    // stamped `producerEpoch || sesProducerEpoch || state.epoch` = E2 into
    // the cursor memory — an E2-stamped foreign seq the map arm would
    // restore as cursor=105&epoch=E2. Post-round-9 the claim stamps \"\"
    // (producer unresolved, conn not server-validated) and never pairs.
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    store.setState("epoch", "E2");
    notifyEpochChanged("E2", "");
    await flushMicro();
    // No snapshot at all — the foreign message is the connection's first
    // content frame and applies immediately (nothing to await).
    es0.fire("message.upsert", { id: "m2", sessionID: SID, role: "user", time: { created: 5 } }, "105.1");
    await flushMicro();

    sesMod.reopenSessionStreamPreservingCursor("watchdog", "test");
    const es1 = sessionESes()[1];
    expect(urlEpoch(es1)).toBe("E2");
    expect(urlCursor(es1)).toBe(0); // pre-fix: 105 — the map claim stamped the E1-produced seq under E2
  });

  it("additivity pin: a SERVER-VALIDATED resume connection still stamps its frames with the declared epoch (pins convergence path)", async () => {
    // The round-9 rule must NOT widen into the replay-resume path: a
    // connection opened WITH a cursor is server-validated (the server
    // checked cursor+epoch pairing before choosing replay), so its
    // message frames — even before any snapshot applies on the connection
    // — stamp the URL-declared epoch and keep pairing. This is the
    // convergence path whose removal regressed pins-multiclient in the
    // round-7 A/B experiment; it must stay byte-identical.
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    // First snapshot applies under E1 (the normal boot shape).
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1", "E1"), "100.1");
    await flushMicro();
    store.setState("epoch", "E1"); // tree establishes the same lifetime
    notifyEpochChanged("E1", "");
    await flushMicro();

    // A preserving reopen RESUMES (cursor=100, epoch=E1 — server-validated
    // pairing), then replay message frames land with NO snapshot on the new
    // connection. They must stamp E1 (sesResumedCursor path).
    sesMod.reopenSessionStreamPreservingCursor("watchdog", "test");
    const es1 = sessionESes()[1];
    expect(urlEpoch(es1)).toBe("E1");
    expect(urlCursor(es1)).toBe(100);
    es1.fire("message.upsert", { id: "m2", sessionID: SID, role: "user", time: { created: 5 } }, "105.1");
    await flushMicro();

    // And the NEXT preserving reopen still resumes from 105 — the stamp
    // kept the live arm paired (this is the pins(c) convergence invariant).
    sesMod.reopenSessionStreamPreservingCursor("watchdog", "test");
    const es2 = sessionESes()[2];
    expect(urlEpoch(es2)).toBe("E1");
    expect(urlCursor(es2)).toBe(105);
  });
});

// @vitest-environment jsdom
//
// Gap #3 (stream-invariant-audit §7b) — the cross-stream completion bridge.
//
// INVARIANT: when Stream 1 (tree/structural) receives `activity=idle`, the
// reducer stamps `time.completed` on the session's last assistant message IN
// THE SAME `setState(produce(...))` draft that clears `activity`. Both writes
// land in one Solid batch, so `settled` (which reads `info.time.completed`)
// flips in the SAME reactive flush that unmounts `.working-text` (which reads
// `activity[id]`).
//
// WHY IT MATTERS: Stream 1 (activity=idle) and Stream 2 (message.upsert with
// time.completed) are independent connections whose delivery order is NOT
// guaranteed. When Stream 1 wins, `.working-text` unmounts BEFORE Stream 2's
// completed upsert has flipped `settled`, so the streaming view (`.md-stream`)
// briefly outlives the busy indicator — the session-completion flake. The
// bridge closes that window by stamping completed optimistically on the tree
// stream, atomically with the activity clear.
//
// The bridge lives in `applyMessageEvent`'s `case "activity"` branch
// (stream.ts ~line 350-382), reached synchronously via the tree-ES listener +
// coveredAwait fast path (no pending tree-snapshot owner). It is scoped to
// `state === "idle"` only: busy/retry are mid-turn and must NOT be stamped.
//
// Real timers (NOT fake): the gzip64 decode path (used by gap #4's sibling
// test) runs through DecompressionStream's real async reader chain. This file
// does not exercise a decode, but mirrors the established harness so the two
// gap files share a single mental model.
//
// Mock EventSource + atomic observer mirror coherentBarrier.test.ts /
// streamIntegration.test.ts.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import { buildMessages } from "../../src/lib/reduce";

// ---------------------------------------------------------------------------
// Mock EventSource — same shape as coherentBarrier.test.ts. The tree stream
// URL has sessions=& (empty); the session stream URL carries sessions=<id>.
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

const treeESes = (): MockEventSource[] =>
  instances.filter((e) => e.readyState !== CLOSED && !/sessions=[^&]/.test(e.url));

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
// Dynamically imported WITH the module reset in setupFresh — the file's
// stream/store are fresh instances, so statically-imported reconcile /
// session-stream would operate on the PRE-RESET module graph (a different
// store) and silently no-op. Same discipline as stream/store above.
let reconcile: typeof import("../../src/sync/reconcile") = null as unknown as typeof import("../../src/sync/reconcile");
let sessionStream: typeof import("../../src/sync/session-stream") = null as unknown as typeof import("../../src/sync/session-stream");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  reconcile = await import("../../src/sync/reconcile");
  sessionStream = await import("../../src/sync/session-stream");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

// Pump macro+microtasks. Real timers — kept for parity with the gap-#4 file
// (which does need it for the gzip64 decode drain).
const tick = async (n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

// encodeForTest mirrors the server's maybeCompressSnapshot: JSON → gzip →
// base64. Unused by the bridge tests directly, but kept so the fixture story
// matches the audit's gzip64 envelope description.
function encodeForTest(value: unknown): string {
  const inner = JSON.stringify(value);
  return Buffer.from(gzipSync(Buffer.from(inner))).toString("base64");
}

beforeEach(async () => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
  );
  window.localStorage.clear();
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  await setupFresh();
});

afterEach(() => {
  stream?.closeSessionStream();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

// ---------------------------------------------------------------------------
// Fixture: seed the store with a STREAMING assistant message (no
// time.completed) and a non-idle activity facet. This is the pre-bridge state
// the completion flake exhibits: the assistant turn is in flight, activity is
// busy, settled is false.
// ---------------------------------------------------------------------------
function seedStreamingAssistant(sessionID: string, msgID: string, activity: string): void {
  store.setState("sessions", sessionID, { id: sessionID });
  store.setState("messages", sessionID, buildMessages([
    { info: { id: msgID, sessionID, role: "assistant" }, parts: [] },
  ]));
  store.setState("activity", sessionID, activity);
}

describe("Gap #3 — cross-stream completion bridge (activity=idle ⇢ time.completed)", () => {
  it("stamps time.completed on the last assistant message in the SAME Solid flush that activity flips to idle (atomic — no idle-without-completed tuple)", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // Pre-bridge state: assistant turn streaming, activity=busy, no completed.
    seedStreamingAssistant("s1", "m1", "busy");

    // Atomicity observer: record every [activity, completed] tuple Solid
    // flushes. The bridge invariant is that NO observed tuple has
    // activity==="idle" while completed===false — the activity clear and the
    // completed stamp land in ONE produce() draft = ONE Solid batch = ONE
    // flush. Under the prior code (no bridge, or completed stamped in a later
    // flush), the observer would capture ("idle", false) — the flake window
    // where .working-text has unmounted but settled is still false.
    const { createRoot, createEffect } = await import("solid-js");
    const tuples: Array<[string, boolean]> = [];
    const stopObs = createRoot((dispose) => {
      createEffect(() => {
        const act = store.state.activity["s1"];
        const msg = store.state.messages["s1"]?.byId?.["m1"];
        const completed = !!msg?.info?.time?.completed;
        tuples.push([act, completed]);
      });
      return dispose;
    });

    // Fire activity=idle on the TREE stream (Stream 1). The listener reaches
    // applyMessageEvent synchronously via the coveredAwait fast path (no
    // pending tree-snapshot owner). The produce() draft clears activity AND
    // stamps completed together.
    treeES.fire("activity", { sessionID: "s1", state: "idle" }, "1");

    // (a) completed was stamped on the assistant message
    const completed = store.state.messages["s1"]?.byId?.["m1"]?.info?.time?.completed;
    expect(typeof completed).toBe("number");
    expect(completed).toBeGreaterThan(0);
    // (b) activity flipped to idle
    expect(store.state.activity["s1"]).toBe("idle");
    // (c) ATOMICITY: no observer tuple ever saw idle-without-completed. This
    // is the precise flake marker — the streaming view never outlives the
    // busy indicator because settled flips in the same flush as the unmount.
    const flakeTuples = tuples.filter(([a, c]) => a === "idle" && !c);
    expect(flakeTuples, `expected no idle-without-completed tuple, got ${JSON.stringify(flakeTuples)}`).toHaveLength(0);
    // And the post-bridge state IS observable: at least one tuple shows
    // idle-with-completed.
    expect(tuples.some(([a, c]) => a === "idle" && c)).toBe(true);

    stopObs();
  });

  it("does NOT stamp time.completed on activity=busy or activity=retry (bridge scoped to idle — mid-turn states must not be stamped)", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // Seed an assistant message that has ALREADY completed once (e.g. via a
    // prior idle, or via Stream 2's message.upsert). The scope guard must not
    // re-stamp / overwrite completed on a subsequent busy/retry, and must not
    // stamp at all when completed is absent (mid-turn).
    store.setState("sessions", "s1", { id: "s1" });
    store.setState("messages", "s1", buildMessages([
      { info: { id: "m1", sessionID: "s1", role: "assistant" }, parts: [] },
    ]));
    store.setState("activity", "s1", "idle");

    const completedBefore = store.state.messages["s1"]?.byId?.["m1"]?.info?.time?.completed;
    expect(completedBefore).toBeUndefined();

    // activity=busy: a mid-turn signal. The bridge is scoped to idle, so this
    // must NOT stamp completed (the last assistant is genuinely in-flight).
    treeES.fire("activity", { sessionID: "s1", state: "busy" }, "1");
    expect(store.state.messages["s1"]?.byId?.["m1"]?.info?.time?.completed).toBeUndefined();

    // activity=retry: another mid-turn signal. Same scope guard.
    treeES.fire("activity", { sessionID: "s1", state: "retry" }, "2");
    expect(store.state.messages["s1"]?.byId?.["m1"]?.info?.time?.completed).toBeUndefined();
    // activity facet itself DID update (proves the event was handled, not dropped).
    expect(store.state.activity["s1"]).toBe("retry");
  });
});

// ---------------------------------------------------------------------------
// Incident 2026-08-19 — the idle bridge vs keyless shadow placeholders.
//
// A part-only event for a NON-resident message (compaction burst / warm
// reconcile re-publish) used to fabricate a placeholder message and push it
// onto the END of sm.order. activity=idle then stamped time.completed on that
// BOGUS placeholder (role "assistant", nothing else), which both fabricated a
// completion AND suppressed the Inv-2 tail-incomplete re-snapshot — the stale
// rows after the final message stuck until reload.
//
// The fix makes such a placeholder a byId-only SHADOW (never in order), so the
// bridge and Inv-2 only ever see REAL (info-carrying) messages.
// ---------------------------------------------------------------------------
describe("idle bridge vs keyless shadows (incident 2026-08-19)", () => {
  // All session-stream EventSources ever created (CLOSED ones included, so a
  // force-reconnect is observable as a count increase).
  const sessionESes = (): MockEventSource[] =>
    instances.filter((e) => /sessions=[^&]/.test(e.url));

  it("idle stamps NOTHING on a phantom part-only message: render list stays clean, no fabricated completion", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // The incident shape: the session's REAL final message (completed
    // assistant) is resident; a compaction-burst part re-publish arrives for
    // an out-of-window OLD message (part-only, no message info).
    store.setState("sessions", "s1", { id: "s1" });
    store.setState("messages", "s1", buildMessages([
      { info: { id: "mFinal", sessionID: "s1", role: "assistant", time: { created: 20, completed: 21 } }, parts: [] },
    ]));
    reconcile.applyMessageEvent("part.upsert", 1, {
      id: "pOld", sessionID: "s1", messageID: "mOld", type: "tool", state: "completed",
    }, false);

    // idle arrives on the TREE stream (Stream 1):
    treeES.fire("activity", { sessionID: "s1", state: "idle" }, "2");

    const sm = store.state.messages["s1"];
    // (a) the render list (s.order → ChatView rows) stays clean — the phantom
    // never became a row after the final message.
    expect(sm.order).toEqual(["mFinal"]);
    // (b) the bridge did not fabricate time.completed on the phantom.
    expect(sm.byId["mOld"].info.time?.completed).toBeUndefined();
    // (c) the real final message keeps its authoritative completed stamp.
    expect(sm.byId["mFinal"].info.time?.completed).toBe(21);
    // (d) activity DID flip (the event was handled, not dropped).
    expect(store.state.activity["s1"]).toBe("idle");
  });

  it("a phantom tail no longer SUPPRESSES the Inv-2 tail-incomplete re-snapshot when the real tail is incomplete", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // The turn's terminal message.upsert was lost in transit: the real tail is
    // the USER message, and the turn's streamed parts sit in a phantom
    // (part-only) message. Pre-fix, the bridge stamped the phantom (role
    // "assistant") at the tail slot → Inv-2 saw a "completed assistant" → no
    // recovery → stuck until reload.
    store.setState("sessions", "s1", { id: "s1" });
    store.setState("messages", "s1", buildMessages([
      { info: { id: "mUser", sessionID: "s1", role: "user", time: { created: 10 } }, parts: [] },
    ]));
    reconcile.applyMessageEvent("part.upsert", 1, {
      id: "pTurn", sessionID: "s1", messageID: "mLost", type: "text", text: "streamed answer",
    }, false);

    // Open the session stream so the Inv-2 force-fetch has a target (s1 is
    // already the selected id; projectDir is set by setupFresh).
    sessionStream.openSessionStream("s1");
    expect(sessionESes()).toHaveLength(1);
    sessionESes()[0].simulateOpen();

    treeES.fire("activity", { sessionID: "s1", state: "idle" }, "2");

    // The bridge could not stamp (real tail is a user message) → Inv-2 fired:
    // a fresh-snapshot reconnect was forced (a SECOND session ES was created).
    expect(sessionESes()).toHaveLength(2);
    // The phantom still holds the streamed part (held, not dropped) for the
    // recovery snapshot's merge to pick up.
    expect(store.state.messages["s1"].byId["mLost"].parts["pTurn"].text).toBe("streamed answer");
  });
});

// ---------------------------------------------------------------------------
// Arrival-path #3 — the cold-load orphan tail (2026-08-20 dead-instance bug).
//
// The bridge's discrete-activity and snapshot paths both require the session's
// messages to be ALREADY resident when idle is observed. A cold load of a
// session whose opencode instance DIED mid-generation inverts that ordering:
// activity is idle in the boot snapshot (the daemon's status reconcile cleared
// it; no transition will ever fire again), and the transcript arrives only
// when the user opens the session — via messages.batch (cold upstream fetch)
// or the Stream-2 session snapshot (daemon-resident history). Without a stamp
// at those arrival moments, the orphaned last assistant message (no
// time.completed, reasoning part with no time.end) renders live forever:
// blinking stream-caret + ever-ticking ReasoningPart "Thinking…" timer on
// every fresh load of an idle session.
//
// The stamp is gated on s.epoch (a snapshot applied THIS boot ⇒ s.activity is
// server-refreshed, not the stale localStorage seed) and on the helper's own
// activity==="idle" guard — the same server-authoritative signal
// sessionWorking trusts. A genuinely busy session never stamps.
// ---------------------------------------------------------------------------
describe("arrival-path #3 — cold-load orphan tail (messages become resident while already idle)", () => {
  // The dead-instance shape: a user turn, then an assistant turn that died
  // mid-generation — no time.completed, and a reasoning part with time.start
  // but NO time.end (nothing will ever stamp either terminal).
  const orphanBatch = (sid: string) => ({
    sessionID: sid,
    messages: [
      {
        info: { id: "mUser", sessionID: sid, role: "user", time: { created: 10 } },
        parts: [{ id: "pu", sessionID: sid, messageID: "mUser", type: "text", text: "go" }],
      },
      {
        info: { id: "mOrphan", sessionID: sid, role: "assistant", time: { created: 20 } },
        parts: [
          { id: "pr", sessionID: sid, messageID: "mOrphan", type: "reasoning", text: "half a thought", time: { start: 21 } },
        ],
      },
    ],
  });

  // Seed everything EXCEPT the messages: session known, activity authoritative
  // (`act`), and a snapshot having landed this boot (epoch set) unless
  // `withEpoch` is false.
  function seedIdleScope(act: string, withEpoch = true): void {
    store.setState("sessions", "s1", { id: "s1" });
    store.setState("activity", "s1", act);
    store.setState("epoch", withEpoch ? "e1" : "");
  }

  it("messages.batch stamps the orphaned last assistant when a snapshot has landed and activity is idle", () => {
    seedIdleScope("idle");
    reconcile.applyMessageEvent("messages.batch", 1, orphanBatch("s1"), false);

    const sm = store.state.messages["s1"];
    // (a) the orphaned tail got a terminal — the transcript's FIRST render is
    // settled (no stream-caret, no ticking timer).
    const completed = sm.byId["mOrphan"].info.time?.completed;
    expect(typeof completed).toBe("number");
    expect(completed).toBeGreaterThan(0);
    // (b) the stamp is message-level ONLY — the reasoning part's missing
    // time.end is not fabricated (its true end is unknown).
    expect(sm.byId["mOrphan"].parts["pr"].time?.end).toBeUndefined();
    // (c) the user message is untouched.
    expect(sm.byId["mUser"].info.time?.completed).toBeUndefined();
    // (d) idempotent: a second batch does not re-stamp.
    const first = sm.byId["mOrphan"].info.time?.completed;
    reconcile.applyMessageEvent("messages.batch", 2, orphanBatch("s1"), false);
    expect(store.state.messages["s1"].byId["mOrphan"].info.time?.completed).toBe(first);
  });

  it("messages.batch does NOT stamp a busy session (genuinely streaming stays live)", () => {
    seedIdleScope("busy");
    reconcile.applyMessageEvent("messages.batch", 1, orphanBatch("s1"), false);
    expect(store.state.messages["s1"].byId["mOrphan"].info.time?.completed).toBeUndefined();
    // ...and retry equally (mid-turn retry must keep the live affordances).
    store.setState("activity", "s1", "retry");
    reconcile.applyMessageEvent("messages.batch", 2, orphanBatch("s1"), false);
    expect(store.state.messages["s1"].byId["mOrphan"].info.time?.completed).toBeUndefined();
  });

  it("messages.batch does NOT stamp before any snapshot landed (epoch empty — stale localStorage activity must not settle an in-flight turn)", () => {
    // The exact stale-seed race the epoch gate exists for: localStorage
    // hydrated activity=idle from a PREVIOUS tab session while the session is
    // actually mid-turn, and the batch somehow raced ahead of the boot
    // snapshot. Stamping here would mis-render a live turn as settled with no
    // un-stamp path; instead we keep today's live render and let the snapshot
    // heal (next test).
    seedIdleScope("idle", false);
    reconcile.applyMessageEvent("messages.batch", 1, orphanBatch("s1"), false);
    expect(store.state.messages["s1"].byId["mOrphan"].info.time?.completed).toBeUndefined();
  });

  it("batch-before-snapshot still heals via the EXISTING snapshot-path stamp (composition, no permanent miss)", () => {
    seedIdleScope("idle", false);
    reconcile.applyMessageEvent("messages.batch", 1, orphanBatch("s1"), false);
    expect(store.state.messages["s1"].byId["mOrphan"].info.time?.completed).toBeUndefined();

    // The boot snapshot lands after the batch: epoch arrives, activity is
    // wholesale-replaced (idle), and the messages are now resident — the
    // pre-existing projectSnapshot stamp (reducers.ts) fires without any new
    // code on that path.
    reconcile.applySnapshot({
      epoch: "e1",
      seq: 5,
      sessions: [{ id: "s1" }],
      activity: { s1: "idle" },
    } as never);
    expect(typeof store.state.messages["s1"].byId["mOrphan"].info.time?.completed).toBe("number");
  });

  it("applySessionSnapshot stamps the daemon-resident orphan tail (the real dead-instance cold-open path)", () => {
    // The daemon already held the full transcript when opencode died, so the
    // Stream-2 session snapshot — not a later messages.batch — is the moment
    // the orphan becomes resident.
    seedIdleScope("idle");
    sessionStream.applySessionSnapshot("s1", {
      sessions: [{ id: "s1" }],
      messages: { s1: orphanBatch("s1").messages },
      gate: { s1: { messagesLoaded: true } },
    } as never);

    const sm = store.state.messages["s1"];
    expect(typeof sm.byId["mOrphan"].info.time?.completed).toBe("number");
    expect(sm.byId["mOrphan"].parts["pr"].time?.end).toBeUndefined();
    expect(sm.byId["mUser"].info.time?.completed).toBeUndefined();
  });

  it("applySessionSnapshot does NOT stamp a busy session", () => {
    seedIdleScope("busy");
    sessionStream.applySessionSnapshot("s1", {
      sessions: [{ id: "s1" }],
      messages: { s1: orphanBatch("s1").messages },
      gate: { s1: { messagesLoaded: true } },
    } as never);
    expect(store.state.messages["s1"].byId["mOrphan"].info.time?.completed).toBeUndefined();
  });

  it("applySessionSnapshot does NOT stamp before any snapshot landed (epoch gate)", () => {
    seedIdleScope("idle", false);
    sessionStream.applySessionSnapshot("s1", {
      sessions: [{ id: "s1" }],
      messages: { s1: orphanBatch("s1").messages },
      gate: { s1: { messagesLoaded: true } },
    } as never);
    expect(store.state.messages["s1"].byId["mOrphan"].info.time?.completed).toBeUndefined();
  });
});

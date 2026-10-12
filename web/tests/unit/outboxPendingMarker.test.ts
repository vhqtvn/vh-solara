// Slice 2 — the pending-marker trust contract (concurrent-tab safety).
//
// `vh.outbox.pending.v1` (localStorage) is SHARED by every tab/pane and
// rewritten by each tab without coordination (host-shell panes are iframes
// over the same storage). The v2 design (see lib/outbox/index.ts
// hydrateOutbox) binds the marker's count to the store's transactional
// mutation epoch, so a marker whose count predates a later committed
// mutation is DETECTABLY stale: at hydrate it must repair silently, never
// fire the "Locally saved messages were cleared" warning. The two real-world
// races this file pins:
//   - stale-landing: a delayed writer's marker (snapshot taken mid-drain)
//     lands AFTER the drain's own zero-write — last-writer-wins leaves
//     count>0 over an empty store at rest. The literal spurious-warning bug.
//   - lost-final-write: the last draining tab dies between its delete commit
//     and its fire-and-forget marker persist — marker stays >0 with an empty
//     store because the persist never ran.
// Both must NOT warn. A GENUINE eviction (store wiped, epoch gone) still
// must — the false-negative direction is pinned too, as is the legacy
// bare-number marker repair (a stale counter from an old build must not keep
// the warning alive either).
//
// Harness conventions follow outbox.test.ts (node env; hand-rolled
// localStorage/sessionStorage stubs; "two tabs" are modeled as interleaved
// write chains over the SAME store + localStorage — marker writes carry no
// tab identity, so identity is irrelevant to the marker race; only the
// interleaving matters).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetOutboxForTests,
  dropGesture,
  evictionSuspected,
  hydrateOutbox,
  saveGesture,
  type OutboxContextHead,
} from "../../src/lib/outbox";
import { createMemoryOutboxStore, type OutboxSnapshot, type OutboxStore } from "../../src/lib/outbox/store";
import { __resetSendActionStatusForTests } from "../../src/lib/sendActionStatus";

const MARKER_KEY = "vh.outbox.pending.v1";

// localStorage stub (the pending marker lives here).
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => {
    mem[k] = v;
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
};

// sessionStorage stub (per-tab page identity — outbox.test.ts convention).
const ssMem: Record<string, string> = {};
(globalThis as any).sessionStorage = {
  getItem: (k: string) => (k in ssMem ? ssMem[k] : null),
  setItem: (k: string, v: string) => {
    ssMem[k] = v;
  },
  removeItem: (k: string) => {
    delete ssMem[k];
  },
};

function head(sessionId: string): OutboxContextHead {
  return { sessionId, lastMessageId: "m-0", count: 1 };
}

function gesture(intentId: string, sessionId = "s1", text = "hello"): Parameters<typeof saveGesture>[0] {
  return {
    intentId,
    sessionId,
    payload: { text, attachments: [], sendConfig: { agent: "build" } },
    capturedHead: head(sessionId),
  };
}

function readMarker(): { n: number; e: number } | null {
  const raw = mem[MARKER_KEY];
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { n: number; e: number };
  } catch {
    return null;
  }
}

let memoryStore: OutboxStore;

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  for (const k of Object.keys(ssMem)) delete ssMem[k];
  memoryStore = createMemoryOutboxStore();
  __resetOutboxForTests(memoryStore);
  __resetSendActionStatusForTests();
});

describe("pending marker across concurrent tabs", () => {
  it("a stale-landing marker (delayed writer) never fires the eviction warning at the next hydrate", async () => {
    // Tab A and tab B drain concurrently. Tab A's marker persist takes a
    // snapshot mid-drain (after ITS delete, before tab B's), then its
    // localStorage write is delayed past tab B's zero-write — last-writer
    // wins leaves count>0 over an empty store. The facade models exactly
    // that: snapshot reads the inner store FRESH, then holds its return
    // (the stale view) across the drain.
    let held: Promise<void> = Promise.resolve();
    let armed = false;
    let signalEntered!: () => void;
    const entered = new Promise<void>((r) => (signalEntered = r));
    const gated: OutboxStore = {
      put: (rec) => memoryStore.put(rec),
      get: (id) => memoryStore.get(id),
      all: () => memoryStore.all(),
      delete: (id) => memoryStore.delete(id),
      async snapshot(): Promise<OutboxSnapshot> {
        const snap = await memoryStore.snapshot(); // read FRESH (mid-drain)
        if (armed) {
          armed = false; // one-shot: only the first persist after arming is held
          signalEntered();
          await held; // ...the async gap before the delayed localStorage write
        }
        return snap; // the STALE view lands last
      },
    };
    __resetOutboxForTests(gated);

    // Two records saved (both tabs idle) — marker settles at {n:2}.
    await saveGesture(gesture("a", "s1", "one"));
    await saveGesture(gesture("b", "s1", "two"));
    await vi.waitFor(() => expect(readMarker()).toEqual({ n: 2, e: 2 }));

    // Arm the delayed writer, then interleave the drain.
    let release!: () => void;
    held = new Promise<void>((r) => (release = r));
    armed = true;
    const dropA = dropGesture("a"); // tab A: delete commits (e3), persist held
    await entered;
    await dropGesture("b"); // tab B: delete commits (e4), marker REMOVED
    await dropA;
    await vi.waitFor(() => expect(mem[MARKER_KEY]).toBeUndefined());
    release(); // ...and the stale {n:1,e:3} write lands LAST
    await vi.waitFor(() => expect(readMarker()).toEqual({ n: 1, e: 3 }));

    // The literal bug state at rest: marker claims 1 pending, store is empty.
    expect(await memoryStore.all()).toHaveLength(0);
    expect((await memoryStore.snapshot()).epoch).toBe(4);

    // Reload: a fresh page evaluation hydrates over that state. The warning
    // must NOT fire (the epoch moved past the marker's — provably stale),
    // and the marker repairs.
    const staleMarker = mem[MARKER_KEY];
    __resetOutboxForTests(memoryStore); // clears the marker (reload model)
    mem[MARKER_KEY] = staleMarker; // ...but the shared localStorage survives
    await hydrateOutbox();
    expect(evictionSuspected()).toBe(false);
    expect(mem[MARKER_KEY]).toBeUndefined(); // repaired to the empty truth
  });

  it("a lost final marker persist (draining tab killed) never fires the eviction warning", async () => {
    // The tab dies between the delete COMMIT and its fire-and-forget marker
    // persist — modeled by deleting directly through the store, bypassing
    // dropGesture's persist entirely. Old code: marker "1" + empty store ⇒
    // spurious warning on next reload. v2: the delete bumped the epoch, so
    // the marker is detectably stale.
    await saveGesture(gesture("a"));
    await vi.waitFor(() => expect(readMarker()?.n).toBe(1));
    await memoryStore.delete("a"); // committed mutation, persist lost
    const staleMarker = mem[MARKER_KEY];
    expect(staleMarker).toBeDefined();
    __resetOutboxForTests(memoryStore);
    mem[MARKER_KEY] = staleMarker!;
    await hydrateOutbox();
    expect(evictionSuspected()).toBe(false);
    expect(mem[MARKER_KEY]).toBeUndefined();
  });

  it("a legacy bare-number marker is repaired without ever warning (old-build stale counter)", async () => {
    // Pre-v2 builds wrote a bare number. Whatever it says, it carries no
    // epoch evidence — untrusted: repaired, never the basis for a warning.
    mem[MARKER_KEY] = "3"; // store is actually empty
    await hydrateOutbox();
    expect(evictionSuspected()).toBe(false);
    expect(mem[MARKER_KEY]).toBeUndefined();
  });

  it("a legacy marker over a non-empty store migrates to the v2 format", async () => {
    await memoryStore.put({
      intentId: "a",
      sessionId: "s1",
      createdAt: 1,
      payload: { text: "hi", attachments: [], sendConfig: { agent: "build" } },
      capturedHead: head("s1"),
      status: "saved",
      clientId: "tab-x",
    });
    mem[MARKER_KEY] = "1"; // legacy count that happens to be right
    await hydrateOutbox();
    expect(evictionSuspected()).toBe(false);
    const snap = await memoryStore.snapshot();
    expect(readMarker()).toEqual({ n: 1, e: snap.epoch }); // migrated, epoch-bound
  });

  it("a genuine eviction (store wiped WITH its epoch) still surfaces the honest warning", async () => {
    // Guards the false-negative direction: whole-DB eviction clears the
    // gesture store AND the meta epoch. Marker n>0 against a fresh
    // never-mutated store (epoch 0) is exactly that signature.
    await saveGesture(gesture("a"));
    await vi.waitFor(() => expect(readMarker()?.n).toBe(1));
    const markerAfterSave = mem[MARKER_KEY];
    const wiped = createMemoryOutboxStore(); // epoch 0, empty
    __resetOutboxForTests(wiped);
    mem[MARKER_KEY] = markerAfterSave!;
    await hydrateOutbox();
    expect(evictionSuspected()).toBe(true);
  });

  it("an external clear that leaves the epoch intact still surfaces the warning (epoch === marker.e)", async () => {
    // The other genuine-eviction shape: the gesture store is wiped but the
    // meta store survives (partial IDB clear / devtools store delete). No
    // tracked mutation committed — the epoch still equals the marker's, so
    // the marker's n>0 claim stands against an empty store: warn. Pins the
    // epoch-equality disjunct of the warn predicate (not just epoch===0).
    await saveGesture(gesture("a"));
    await vi.waitFor(() => expect(readMarker()?.n).toBe(1));
    const markerAfterSave = mem[MARKER_KEY];
    const persisted = await memoryStore.snapshot();
    // Gestures store emptied WITHOUT a tracked mutation (epoch frozen at the
    // marker's own value); meta survives — modeled at the snapshot seam,
    // which is the OutboxStore contract's honest level of abstraction.
    const externallyCleared: OutboxStore = {
      put: () => Promise.resolve({ ok: true } as const),
      get: () => Promise.resolve(undefined),
      all: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
      snapshot: () => Promise.resolve({ all: [], epoch: persisted.epoch }),
    };
    __resetOutboxForTests(externallyCleared);
    mem[MARKER_KEY] = markerAfterSave!;
    await hydrateOutbox();
    expect(evictionSuspected()).toBe(true);
  });

  it("an unreadable store earns no verdict at all (no warning, no repair)", async () => {
    // hydrate must distinguish "read the store, it is empty" from "could not
    // read the store". A rejecting snapshot must neither fire the warning
    // (emptiness is NOT established) nor rewrite the marker (there is no
    // truth to repair toward) — guarding against a future "simplification"
    // that would treat rejection as empty and resurrect the spurious-warn
    // bug class through the epoch===0 branch.
    const markerBefore = mem[MARKER_KEY] = JSON.stringify({ n: 2, e: 7 });
    const unreadable: OutboxStore = {
      put: () => Promise.resolve({ ok: false, code: "storage-unavailable", reason: "unreadable" } as const),
      get: () => Promise.resolve(undefined),
      all: () => Promise.resolve([]),
      delete: () => Promise.resolve(),
      snapshot: () => Promise.reject(new Error("snapshot transaction failed")),
    };
    __resetOutboxForTests(unreadable);
    mem[MARKER_KEY] = markerBefore; // reset clears it; the shared LS survives
    await hydrateOutbox();
    expect(evictionSuspected()).toBe(false);
    expect(mem[MARKER_KEY]).toBe(markerBefore); // untouched — no verdict
  });
});

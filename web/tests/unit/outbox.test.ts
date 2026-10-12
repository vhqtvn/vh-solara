// Send-net-resilience slice 3 — the IndexedDB outbox controller + store seam.
//
// BLK-A3 (debate-3, BINDING) and debate-4 finding 7 (amended 2026-10-09)
// contracts under test:
//   - "locally saved" only after the store transaction commits (ordering).
//   - storage-unavailable/quota/cleared-store failures arm the BLOCKING
//     persistent state with the retained payload — never a throw, never a
//     silent loss.
//   - capture-compare: the saved gesture's context-head is the comparison
//     basis; unknown heads never fabricate staleness.
//   - intentId semantics: a gesture's record is keyed by its intentId; a
//     same-text older `saved` record under a different id is superseded (the
//     operator's re-send replaces the obsolete unsent gesture).
//   - page identity (R-F2/b-F2): per-tab + reload-stable via sessionStorage
//     (NEVER localStorage — shared across tabs); same-tab same-text supersede
//     is newest-wins ACROSS the reload boundary, and cross-tab same-text
//     coexistence is resolved by reconcile's DESIGNED backstops.
//   - copied-storage clones (b-F1/b-F2 round 2): the platform COPIES
//     sessionStorage into opener-created/duplicated tabs, so a clone runs
//     under the SAME clientId — a per-eval bootNonce + the uncontested-claim
//     channel handshake keep a clone's supersede prune off a live sibling's
//     durable record (objection / no channel → conservative skip).
//   - reconcile: saved+present → admitted; saved+absent+fresh-head →
//     re-admit under the SAME intentId; saved+absent+stale-head → visible
//     row, NO auto-send; admitted+sent/absent → pruned; GC by age.
//   - replacement overlay: requestReplacement persists + flips the reactive
//     read (the chip's "Replacement requested" state).
//
// The IDB boundary is the OutboxStore interface: these tests run against the
// in-memory fake (the repo has no fake-indexeddb dependency; jsdom has no
// real IDB). The REAL IndexedDB path is proven by the Playwright e2e lane
// (send-outbox-resilience.spec.ts reads the real vh-solara-outbox database).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __outboxClientIdForTests,
  __resetOutboxForTests,
  capturedHeadFor,
  dropGesture,
  evictionSuspected,
  headIsStale,
  hydrateOutbox,
  markAdmitted,
  READMIT_MIN_AGE_MS,
  reconcileOutboxSession,
  replacementRequestedFor,
  requestReplacement,
  retryFailedSave,
  saveGesture,
  storageFailure,
  OUTBOX_GC_MS,
  type OutboxContextHead,
  type OutboxGestureRecord,
} from "../../src/lib/outbox";
import { createMemoryOutboxStore, type OutboxStore } from "../../src/lib/outbox/store";
import { __resetSendActionStatusForTests, sendActionsFor } from "../../src/lib/sendActionStatus";
import type { QueuedMessage } from "../../src/queue";

// localStorage stub (the pending-records marker).
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

// sessionStorage stub (the per-tab page-identity store — R-F2/b-F2). This
// file runs in the NODE vitest environment (the config default; no jsdom
// globals — same reason localStorage is stubbed above), so the outbox
// module's identity resolution needs a hand-rolled stub too. Cleared per
// test in beforeEach — every test starts as a FRESH TAB (a new tab's per-tab
// storage starts empty).
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

// The outbox module's sessionStorage key for the page (tab) identity. Tests
// seed it to simulate the SAME TAB across a reload and clear it to simulate
// a DIFFERENT TAB (see the b-F2 describe block).
const SS_OUTBOX_CLIENT_KEY = "vh-solara-outbox-client";

// --- b-F1/b-F2 round 2: the claim-channel test seam ----------------------------
// Deterministic BroadcastChannel stub: the node test environment must not
// depend on the platform API. Models the two things the handshake needs —
// outgoing posts (counted, for the fast-path/memoization pins) and incoming
// deliveries (a live sibling's 'mine' objection). Default behavior: no
// sibling answers (the reload shape).
class ClaimChannelStub {
  readonly posted: unknown[] = [];
  closed = false;
  private listeners: ((ev: { data: unknown }) => void)[] = [];
  /** Test-side hook fired on every outgoing who-has post. */
  onWhoHas?: (query: { type: string; id: string }) => void;
  postMessage(message: unknown): void {
    this.posted.push(message);
    const m = message as { type?: string; id?: string } | null;
    if (m && typeof m === "object" && m.type === "who-has" && typeof m.id === "string") {
      this.onWhoHas?.({ type: m.type, id: m.id });
    }
  }
  addEventListener(_type: "message", listener: (ev: { data: unknown }) => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: "message", listener: (ev: { data: unknown }) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  close(): void {
    this.closed = true;
  }
  /** A message ARRIVING at this channel (a sibling's answer). */
  deliver(data: unknown): void {
    for (const l of [...this.listeners]) l({ data });
  }
}

// The round-2 module seam, accessed through the namespace + optional call so
// this harness ALSO RUNS against pre-gate code (the copied-storage regression
// below must demonstrate the prune RED, not an import error).
import * as outboxMod from "../../src/lib/outbox";

type ClaimSetter = (factory: (() => ClaimChannelStub | null) | null) => void;
const setClaimChannelForTests: ClaimSetter | undefined = (outboxMod as any).__setOutboxClaimChannelForTests;
function installClaimChannel(factory: (() => ClaimChannelStub | null) | null): void {
  setClaimChannelForTests?.(factory);
}
const bootNonceForTests = (): string | undefined => (outboxMod as any).__outboxBootNonceForTests?.();

// The harness DEFAULT: a fresh no-objection stub per page evaluation (the
// reload shape's precondition — no live sibling objects). `latestStub` is the
// instance the CURRENT evaluation's channel was opened from (reset re-opens
// via the factory, assigning a fresh instance).
let latestStub: ClaimChannelStub;
function installNoObjectionDefault(): void {
  installClaimChannel(() => (latestStub = new ClaimChannelStub()));
}

function head(sessionId: string, lastMessageId: string | null, count: number): OutboxContextHead {
  return { sessionId, lastMessageId, count };
}

function gesture(intentId: string, sessionId = "s1", text = "hello"): Parameters<typeof saveGesture>[0] {
  return {
    intentId,
    sessionId,
    payload: { text, attachments: [], sendConfig: { agent: "build" } },
    capturedHead: head(sessionId, "m-0", 1),
  };
}

function qItem(id: string, o: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id,
    order: 1,
    state: "pending",
    text: "hello",
    attachments: [],
    createdAt: 1,
    ...o,
  } as QueuedMessage;
}

let memoryStore: OutboxStore;

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  for (const k of Object.keys(ssMem)) delete ssMem[k];
  memoryStore = createMemoryOutboxStore();
  // Round-2 harness default: a no-objection claim channel (the reload
  // shape — no live sibling answers the handshake). Tests that model an
  // objecting sibling / absent channel replace it via installClaimChannel.
  installNoObjectionDefault();
  __resetOutboxForTests(memoryStore);
  __resetSendActionStatusForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BLK-A3 durability contract", () => {
  it("saveGesture resolves ok only AFTER the store transaction commits (ordering)", async () => {
    let commit!: () => void;
    const deferred = new Promise<void>((r) => (commit = r));
    let putCalled = false;
    const slowStore: OutboxStore = {
      put: async (rec) => {
        putCalled = true;
        await deferred;
        await memoryStore.put(rec);
        return { ok: true };
      },
      get: (id) => memoryStore.get(id),
      all: () => memoryStore.all(),
      delete: (id) => memoryStore.delete(id),
      snapshot: () => memoryStore.snapshot(),
    };
    __resetOutboxForTests(slowStore);
    const p = saveGesture(gesture("i-1"));
    // The save is pending (transaction not committed) — the promise must not
    // have settled and no "saved" claim may exist yet. Flush enough microtasks
    // for the get/supersede pre-reads to complete so put() has been entered.
    await vi.waitFor(() => expect(putCalled).toBe(true));
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    commit();
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("a storage failure arms the blocking persistent state with the retained payload (never a throw, never silent)", async () => {
    // A RECOVERABLE failing store: quota now, freed later (same store instance
    // so the armed failure state survives the recovery).
    let quota = true;
    const failing = createMemoryOutboxStore({ failPuts: () => (quota ? "QuotaExceededError" : null) });
    __resetOutboxForTests(failing);
    const res = await saveGesture(gesture("i-q", "s1", "must not vanish"));
    expect(res).toEqual({ ok: false, code: "storage-unavailable", reason: "QuotaExceededError" });
    // The blocking surface carries the EXACT retained text (the copy affordance).
    expect(storageFailure()?.payload.text).toBe("must not vanish");
    expect(storageFailure()?.sessionId).toBe("s1");
    // A later successful save for the same gesture clears the blocking state.
    quota = false;
    const okRes = await retryFailedSave();
    expect(okRes).toBe(true);
    expect(storageFailure()).toBeNull();
  });

  it("a FAILED superseding put never destroys the prior saved record (put-confirm-then-prune, B-F1)", async () => {
    // The exact failure mode this slice exists for: the operator re-sends a
    // text whose older gesture is still durable `saved`, and the NEW put fails
    // (quota/storage-unavailable). The prior record must survive the failure —
    // reconcile can still recover the old gesture; deleting superseded records
    // BEFORE the replacement commits leaves NEITHER gesture durable.
    let quota = false;
    const failing = createMemoryOutboxStore({ failPuts: () => (quota ? "QuotaExceededError" : null) });
    __resetOutboxForTests(failing);
    await saveGesture(gesture("i-old", "s1", "hello"));
    expect(await failing.get("i-old")).toBeDefined();
    quota = true; // storage dies UNDER the superseding save
    const res = await saveGesture(gesture("i-new", "s1", "hello"));
    expect(res.ok).toBe(false);
    expect(storageFailure()?.payload.text).toBe("hello");
    // B-F1 ordering pin: the prior durable gesture is INTACT (a
    // delete-before-put implementation loses it here).
    expect(await failing.get("i-old")).toBeDefined();
    // Recovery: the retry commits the new gesture AND runs the supersede
    // prune (b-F1 round 3 — mirroring saveGesture's put-confirm-then-prune):
    // the failed save could not prune (nothing had committed), so the retry's
    // commit is where the obsolete same-text twin is pruned. WITHOUT this the
    // store deterministically keeps two same-text saved records under
    // different intentIds and reconcile would re-admit BOTH (the daemon
    // dedupes admission by intentId VALUE — distinct ids are NOT collapsed;
    // safety comes from the prune + reconcile suppression, not the daemon).
    quota = false;
    await expect(retryFailedSave()).resolves.toBe(true);
    expect(await failing.get("i-new")).toBeDefined();
    expect(await failing.get("i-old")).toBeUndefined();
  });

  it("a cleared/evicted store at hydrate surfaces the honest eviction notice (marker set, store empty)", async () => {
    // Simulate: records were saved (marker written), then the browser cleared IDB.
    await saveGesture(gesture("i-1"));
    expect(await memoryStore.all()).toHaveLength(1);
    const markerAfterSave = mem["vh.outbox.pending.v1"];
    // v2 marker: {"n":<count>,"e":<epoch>} — count AND the epoch it was taken at.
    const parsed = JSON.parse(markerAfterSave ?? "null") as { n: number; e: number } | null;
    expect(parsed).not.toBeNull();
    expect(parsed!.n).toBeGreaterThan(0);
    expect(parsed!.e).toBeGreaterThan(0);
    const cleared = createMemoryOutboxStore();
    __resetOutboxForTests(cleared);
    // keep the marker from the previous store life
    mem["vh.outbox.pending.v1"] = markerAfterSave;
    await hydrateOutbox();
    expect(evictionSuspected()).toBe(true);
    // And the next save into the fresh store works (no permanent wedging).
    const res = await saveGesture(gesture("i-2"));
    expect(res.ok).toBe(true);
  });
});

describe("intentID + capture semantics", () => {
  it("a gesture is keyed by intentId; re-saving the same gesture preserves createdAt and admits cleanly", async () => {
    const a = await saveGesture(gesture("i-1"));
    expect(a.ok).toBe(true);
    const first = (await memoryStore.all())[0];
    const b = await saveGesture({ ...gesture("i-1"), capturedHead: head("s1", "m-9", 9) });
    expect(b.ok).toBe(true);
    const recs = await memoryStore.all();
    expect(recs).toHaveLength(1);
    expect(recs[0].createdAt).toBe(first.createdAt);
    await expect(capturedHeadFor("i-1")).resolves.toEqual(head("s1", "m-9", 9)); // recaptured at tap
  });

  it("a NEW same-text gesture SUPERSEDES an older un-admitted one (no later re-admission double-send)", async () => {
    await saveGesture(gesture("i-old"));
    await saveGesture(gesture("i-new", "s1", "hello"));
    const recs = await memoryStore.all();
    expect(recs.map((r) => r.intentId)).toEqual(["i-new"]);
  });

  it("headIsStale: changed head is stale; unknown heads never fabricate staleness", () => {
    const cap = head("s1", "m-1", 1);
    expect(headIsStale(cap, head("s1", "m-1", 1))).toBe(false);
    expect(headIsStale(cap, head("s1", "m-2", 2))).toBe(true);
    expect(headIsStale(cap, null)).toBe(false);
    expect(headIsStale(null, head("s1", "m-2", 2))).toBe(false);
    expect(headIsStale(cap, head("s2", "m-1", 1))).toBe(true); // different session
  });
});

describe("reconcile (boot / session-open / focus)", () => {
  function deps(o: Partial<{
    list: QueuedMessage[];
    listNull: boolean;
    enqueueImpl: (sid: string, input: any) => QueuedMessage | never;
    current: OutboxContextHead | null;
  }> = {}) {
    return {
      fetchList: async () => (o.listNull ? null : (o.list ?? []).slice()),
      enqueue: o.enqueueImpl
        ? async (sid: string, input: any) => o.enqueueImpl!(sid, input)
        : async (sid: string, input: any) => qItem("q-new", { intentId: input.intentId }),
      currentHead: () => o.current ?? null,
    };
  }

  it("saved + item present (either alias) → admission confirmed, no second POST", async () => {
    await saveGesture(gesture("i-1"));
    const enq = vi.fn();
    await reconcileOutboxSession(
      "s1",
      deps({ list: [qItem("q-x", { intentId: "i-1" })], enqueueImpl: enq as any }),
    );
    expect(enq).not.toHaveBeenCalled();
    expect((await memoryStore.get("i-1"))?.status).toBe("admitted");
    expect((await memoryStore.get("i-1"))?.queueItemId).toBe("q-x");
  });

  it("saved + absent + UNCHANGED head + past the age guard → re-admit under the SAME intentId", async () => {
    await saveGesture(gesture("i-1"));
    // Age the record past READMIT_MIN_AGE_MS (backdate via direct store write).
    const rec = (await memoryStore.get("i-1"))!;
    await memoryStore.put({ ...rec, createdAt: Date.now() - READMIT_MIN_AGE_MS - 1000 });
    const enq = vi.fn(async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId }));
    await reconcileOutboxSession("s1", deps({ current: head("s1", "m-0", 1), enqueueImpl: enq as any }));
    expect(enq).toHaveBeenCalledTimes(1);
    expect(enq.mock.calls[0][1].intentId).toBe("i-1"); // SAME gesture identity
    expect((await memoryStore.get("i-1"))?.status).toBe("admitted");
  });

  it("saved + absent + STALE head → NEVER auto-sends; a visible stale-context row is surfaced", async () => {
    await saveGesture(gesture("i-1"));
    const rec = (await memoryStore.get("i-1"))!;
    await memoryStore.put({ ...rec, createdAt: Date.now() - READMIT_MIN_AGE_MS - 1000 });
    const enq = vi.fn();
    await reconcileOutboxSession(
      "s1",
      deps({ current: head("s1", "m-moved", 5), enqueueImpl: enq as any }),
    );
    expect(enq).not.toHaveBeenCalled();
    const rows = sendActionsFor("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe("blocked");
    expect(rows[0].reason).toBe("stale-context");
    expect(rows[0].payload?.text).toBe("hello");
  });

  it("a young saved record is never re-admitted (its own gesture may be mid-admission)", async () => {
    await saveGesture(gesture("i-young"));
    const enq = vi.fn();
    await reconcileOutboxSession("s1", deps({ current: head("s1", "m-0", 1), enqueueImpl: enq as any }));
    expect(enq).not.toHaveBeenCalled();
  });

  it("D-F1 pin: list===null is NO-ANSWER — the saved+present confirmation branch never fires; a young saved record is neither admitted nor pruned", async () => {
    // fetchQueue resolves null (never throws) when the list could not be
    // fetched (timeout/network) — "no-answer, never as an empty list". A null
    // list can never match an item: the saved+present → markAdmitted
    // confirmation is unreachable, and the young record stays owned by the
    // age guard — nothing admitted (no enqueue, no confirmation), nothing
    // pruned, the record retained verbatim.
    await saveGesture(gesture("i-1"));
    const enq = vi.fn();
    await reconcileOutboxSession("s1", deps({ listNull: true, current: head("s1", "m-0", 1), enqueueImpl: enq as any }));
    expect(enq).not.toHaveBeenCalled();
    const rec = await memoryStore.get("i-1");
    expect(rec).toBeDefined(); // nothing pruned
    expect(rec?.status).toBe("saved"); // not confirmed-admitted on a null list
  });

  it("admitted + delivered (sent) → pruned; admitted + absent → pruned", async () => {
    await saveGesture(gesture("i-1"));
    await markAdmitted("i-1", "q-x");
    await reconcileOutboxSession("s1", deps({ list: [qItem("q-x", { state: "sent", intentId: "i-1" })] }));
    expect(await memoryStore.get("i-1")).toBeUndefined();

    await saveGesture(gesture("i-2"));
    await markAdmitted("i-2", "q-y");
    await reconcileOutboxSession("s1", deps({ list: [] }));
    expect(await memoryStore.get("i-2")).toBeUndefined();
  });

  it("a definitive re-admission rejection surfaces a row and drops the record; an uncertain one keeps it", async () => {
    const err = Object.assign(new Error("enqueue failed (409 queue_admission_conflict)"), {
      code: "queue_admission_conflict",
    });
    await saveGesture(gesture("i-rej"));
    const rec = (await memoryStore.get("i-rej"))!;
    await memoryStore.put({ ...rec, createdAt: Date.now() - READMIT_MIN_AGE_MS - 1000 });
    await reconcileOutboxSession(
      "s1",
      deps({ current: head("s1", "m-0", 1), enqueueImpl: (() => { throw err; }) as any }),
    );
    expect(sendActionsFor("s1")[0].stage).toBe("blocked");
    expect(await memoryStore.get("i-rej")).toBeUndefined();

    const netErr = Object.assign(new Error("enqueue timed out"), { code: "timeout" });
    await saveGesture(gesture("i-unc"));
    const rec2 = (await memoryStore.get("i-unc"))!;
    await memoryStore.put({ ...rec2, createdAt: Date.now() - READMIT_MIN_AGE_MS - 1000 });
    await reconcileOutboxSession(
      "s1",
      deps({ current: head("s1", "m-0", 1), enqueueImpl: (() => { throw netErr; }) as any }),
    );
    expect(await memoryStore.get("i-unc")).toBeDefined(); // outcome unknown — retained
  });

  it("GC: records older than OUTBOX_GC_MS are pruned unconditionally", async () => {
    await saveGesture(gesture("i-old"));
    const rec = (await memoryStore.get("i-old"))!;
    await memoryStore.put({ ...rec, createdAt: Date.now() - OUTBOX_GC_MS - 1000 });
    await reconcileOutboxSession("s1", deps());
    expect(await memoryStore.get("i-old")).toBeUndefined();
  });
});

describe("retryFailedSave (c-F2 — the banner's retry never fail-opens)", () => {
  function retryDeps(o: Partial<{ current: OutboxContextHead | null; enqueueImpl: any }> = {}) {
    return {
      fetchList: async () => [] as QueuedMessage[],
      enqueue: o.enqueueImpl ?? (async (sid: string, input: any) => qItem("q-new", { intentId: input.intentId })),
      currentHead: () => o.current ?? null,
    };
  }

  it("branch 1 (head available): the tap-time head carried on the failure is re-committed — the stale gate is RESTORED (moved-on head blocks, never auto-sends)", async () => {
    let quota = true;
    const failing = createMemoryOutboxStore({ failPuts: () => (quota ? "QuotaExceededError" : null) });
    __resetOutboxForTests(failing);
    const res = await saveGesture({ ...gesture("i-retry"), capturedHead: head("s1", "m-0", 1) });
    expect(res.ok).toBe(false);
    // The blocking failure carries the TAP-TIME head (the retry's source).
    expect(storageFailure()?.capturedHead).toEqual(head("s1", "m-0", 1));
    // Storage recovers; the banner's retry commits.
    quota = false;
    await expect(retryFailedSave()).resolves.toBe(true);
    expect(storageFailure()).toBeNull();
    const rec = (await failing.get("i-retry"))!;
    // c-F2: the retry's record persists the TAP-TIME head (not null, not a
    // retry-time re-capture) and carries NO hold.
    expect(rec.capturedHead).toEqual(head("s1", "m-0", 1));
    expect(rec.reAdmitHold).toBeFalsy();
    // Age past the guard; the conversation moved on during the outage → the
    // stale gate now BLOCKS (the pre-fix null head fail-open auto-enqueued).
    await failing.put({ ...rec, createdAt: Date.now() - READMIT_MIN_AGE_MS - 1000 });
    const enq = vi.fn();
    await reconcileOutboxSession("s1", retryDeps({ current: head("s1", "m-moved", 5), enqueueImpl: enq }));
    expect(enq).not.toHaveBeenCalled();
    const rows = sendActionsFor("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe("blocked");
    expect(rows[0].reason).toBe("stale-context");
    expect(rows[0].payload?.text).toBe("hello");
  });

  it("branch 2 (head unavailable): the retry's record is marked reAdmitHold — reconcile NEVER auto-sends it (visible row, record kept)", async () => {
    let quota = true;
    const failing = createMemoryOutboxStore({ failPuts: () => (quota ? "QuotaExceededError" : null) });
    __resetOutboxForTests(failing);
    // The tap-time head was UNKNOWABLE (transcript not resident at tap).
    const res = await saveGesture({ ...gesture("i-nohead"), capturedHead: null });
    expect(res.ok).toBe(false);
    expect(storageFailure()?.capturedHead).toBeNull();
    quota = false;
    await expect(retryFailedSave()).resolves.toBe(true);
    const rec = (await failing.get("i-nohead"))!;
    expect(rec.capturedHead).toBeNull();
    expect(rec.reAdmitHold).toBe(true); // fail-closed, not fail-open
    // Age past the guard: ANY live head (even a knowable one) must not
    // re-admit a held record — the stale gate can never run for it.
    await failing.put({ ...rec, createdAt: Date.now() - READMIT_MIN_AGE_MS - 1000 });
    const enq = vi.fn();
    await reconcileOutboxSession("s1", retryDeps({ current: head("s1", "m-9", 9), enqueueImpl: enq }));
    expect(enq).not.toHaveBeenCalled();
    const rows = sendActionsFor("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe("blocked");
    expect(rows[0].reason).toBeUndefined(); // generic blocked row; detail carries the cause
    expect(rows[0].payload?.text).toBe("hello");
    // The record is RETAINED — the operator's explicit re-tap (a fresh
    // same-text gesture supersedes it) owns the recovery.
    expect(await failing.get("i-nohead")).toBeDefined();
  });
});

describe("b-F1 round 3 — duplicate re-admission in the residual two-record state", () => {
  // The defect: two same-text `saved` records under DIFFERENT intentIds
  // (reachable via the put-confirm-then-prune crash window AND
  // deterministically via retryFailedSave committing without the supersede
  // prune) made reconcile's saved-record loop enqueue BOTH — neither has a
  // matching queue item, both pass the age/head gates. The daemon dedupes
  // admission by intentId VALUE: distinct ids are two admissions = a
  // duplicate send. Safety comes from the prune (retryFailedSave) + the
  // reconcile same-text suppression, NOT from the daemon.
  function twoRecordDeps(enq: any, current: OutboxContextHead | null) {
    return {
      fetchList: async () => [] as QueuedMessage[],
      enqueue: enq,
      currentHead: () => current,
    };
  }

  it("deterministic path: retryFailedSave prunes the superseded twin — reconcile admits EXACTLY ONE", async () => {
    let quota = false;
    const failing = createMemoryOutboxStore({ failPuts: () => (quota ? "QuotaExceededError" : null) });
    __resetOutboxForTests(failing);
    await saveGesture(gesture("i-old", "s1", "hello"));
    quota = true; // storage dies under the superseding save
    await saveGesture(gesture("i-new", "s1", "hello")); // fails; banner armed
    quota = false;
    await expect(retryFailedSave()).resolves.toBe(true);
    // PRIMARY mechanism: the retry's commit runs the supersede prune — the
    // two-record state is closed at the source (pre-fix: BOTH records remain
    // and reconcile would admit both).
    expect(await failing.get("i-new")).toBeDefined();
    expect(await failing.get("i-old")).toBeUndefined();
    // Age past the guard with an unchanged head → reconcile admits EXACTLY
    // ONE (the committed gesture's identity).
    const rec = (await failing.get("i-new"))!;
    await failing.put({ ...rec, createdAt: Date.now() - READMIT_MIN_AGE_MS - 1000 });
    const enq = vi.fn(async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId }));
    await reconcileOutboxSession("s1", twoRecordDeps(enq, head("s1", "m-0", 1)));
    expect(enq).toHaveBeenCalledTimes(1);
    expect(enq.mock.calls[0][1].intentId).toBe("i-new");
    expect((await failing.get("i-new"))?.status).toBe("admitted");
  });

  it("crash-window path: two seeded same-text saved records (different intentIds) → reconcile admits EXACTLY ONE (oldest wins), the twin is pruned", async () => {
    // The put-confirm-then-prune crash residual, seeded directly: both
    // records durable `saved`, no queue item matches either.
    const t = Date.now() - READMIT_MIN_AGE_MS - 5000;
    const twin = (intentId: string, createdAt: number): OutboxGestureRecord => ({
      intentId,
      sessionId: "s1",
      createdAt,
      payload: { text: "hello", attachments: [], sendConfig: { agent: "build" } },
      capturedHead: head("s1", "m-0", 1),
      status: "saved",
    });
    await memoryStore.put(twin("i-old", t));
    await memoryStore.put(twin("i-new", t + 1000));
    const enq = vi.fn(async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId }));
    await reconcileOutboxSession("s1", twoRecordDeps(enq, head("s1", "m-0", 1)));
    // EXACTLY ONE admission — the OLDEST record's gesture identity
    // (deterministic pass order). Pre-fix RED: TWO admissions.
    expect(enq).toHaveBeenCalledTimes(1);
    expect(enq.mock.calls[0][1].intentId).toBe("i-old");
    // Durable end state: the winner is admitted and the twin is PRUNED (a
    // pure skip would let a later pass re-admit the twin once the winner
    // flips to admitted — exactly the duplicate this guard exists for).
    expect((await memoryStore.get("i-old"))?.status).toBe("admitted");
    expect(await memoryStore.get("i-new")).toBeUndefined();
  });
});

describe("A-F1 — exactly-one-admission under CONCURRENT reconcile passes", () => {
  // The defect: createQueueSync registers ONE handler on BOTH window focus AND
  // document visibilitychange, each firing an unserialized `void` reconcile —
  // an ordinary refocus runs two OVERLAPPING passes. reAdmitTexts is
  // pass-local, and the in-flight skip (`reAdmitting.has`) did NOT register
  // the skipped record's text: pass1 claims twin A and suspends in enqueue;
  // pass2 skips A (in-flight) with an EMPTY set, then admits same-text twin B
  // under its distinct intentId — the daemon dedupes admission by intentId
  // VALUE, so distinct ids are two admissions = a duplicate send.
  function deps(enq: any, current: OutboxContextHead | null) {
    return {
      fetchList: async () => [] as QueuedMessage[],
      enqueue: enq,
      currentHead: () => current,
    };
  }

  it("two OVERLAPPING passes with deferred enqueue → EXACTLY ONE admission (winner admitted, twin pruned)", async () => {
    // The residual: same-text saved twins, distinct intentIds, aged, non-stale.
    const t = Date.now() - READMIT_MIN_AGE_MS - 5000;
    const twin = (intentId: string, createdAt: number): OutboxGestureRecord => ({
      intentId,
      sessionId: "s1",
      createdAt,
      payload: { text: "hello", attachments: [], sendConfig: { agent: "build" } },
      capturedHead: head("s1", "m-0", 1),
      status: "saved",
    });
    await memoryStore.put(twin("i-old", t));
    await memoryStore.put(twin("i-new", t + 1000));

    // Deferred enqueue: the FIRST call (pass1's i-old) is HELD until pass2 has
    // run past its i-old skip — the deterministic focus+visibilitychange
    // overlap. Later calls (a pre-fix pass2 admitting the twin) resolve
    // immediately so the RED failure is not a deadlock.
    let firstEnqueueEntered!: () => void;
    const firstEnqueueEnteredP = new Promise<void>((r) => (firstEnqueueEntered = r));
    let releaseFirstEnqueue!: () => void;
    const releaseFirstEnqueueP = new Promise<void>((r) => (releaseFirstEnqueue = r));
    let calls = 0;
    const enq = vi.fn(async (_sid: string, input: any) => {
      calls += 1;
      if (calls === 1) {
        firstEnqueueEntered();
        await releaseFirstEnqueueP;
      }
      return qItem("q-new", { intentId: input.intentId });
    });

    const pass1 = reconcileOutboxSession("s1", deps(enq, head("s1", "m-0", 1)));
    await firstEnqueueEnteredP; // pass1 has claimed i-old and is suspended in enqueue
    const pass2 = reconcileOutboxSession("s1", deps(enq, head("s1", "m-0", 1)));
    await pass2; // the overlapping pass runs to completion while pass1 is held
    releaseFirstEnqueue();
    await pass1;

    // EXACTLY ONE admission total — pass1's i-old (oldest wins the pass
    // order). Pre-fix RED: pass2 skipped the in-flight i-old WITHOUT
    // registering its text, then admitted the same-text twin i-new → 2 calls.
    expect(enq).toHaveBeenCalledTimes(1);
    expect(enq.mock.calls[0][1].intentId).toBe("i-old");
    // Durable end state: the winner admitted, the twin PRUNED (pre-fix: i-new
    // also admitted — the duplicate send).
    expect((await memoryStore.get("i-old"))?.status).toBe("admitted");
    expect(await memoryStore.get("i-new")).toBeUndefined();
  });
});

describe("R-F2 — cross-tab mutual supersede prune (tab-scoped supersede)", () => {
  // The defect: saveGesture's supersede scan (and retryFailedSave's) matched
  // same-session + saved + same-text + different-intentId records regardless
  // of WHICH TAB wrote them. Two tabs saving the same text in the same session
  // could each prune the other's just-committed durable record in a narrow
  // interleave (A commits a1 → B's scan sees a1 → B commits b1 → B prunes a1)
  // — tab A's gesture then has NO durable recovery record while its UI said
  // "saved": a BLK-A3 void for that gesture. Fix: every record carries the
  // WRITING tab's clientId; supersede scans match only SAME-clientId (own-tab)
  // records. Cross-tab same-text duplicates are owned by the DESIGNED
  // backstops — reconcile's pass-local same-text suppression + the daemon's
  // intentId-VALUE admission dedupe (which does NOT collapse same-text
  // records under distinct intentIds — safety comes from the backstops, not
  // from cross-tab pruning).

  it("two tabs, same text: tab B's supersede scan MUST NOT prune tab A's just-committed record", async () => {
    // Tab A: a fresh page lifetime over the shared origin store commits a1.
    const shared = memoryStore; // beforeEach store = the shared origin's IDB
    await saveGesture(gesture("a1", "s1", "hello"));
    expect(await shared.get("a1")).toBeDefined();
    // Tab B: a NEW page lifetime over the SAME durable store, saving the SAME
    // text — the interleave under test. A different tab has EMPTY per-tab
    // storage: clear the sessionStorage identity first so the reset models a
    // genuinely fresh tab (b-F2: the identity is sessionStorage-backed and a
    // reset adopts whatever the per-tab storage holds).
    sessionStorage.removeItem(SS_OUTBOX_CLIENT_KEY);
    __resetOutboxForTests(shared);
    const resB = await saveGesture(gesture("b1", "s1", "hello"));
    expect(resB.ok).toBe(true);
    // The interleave invariant: BOTH durable records survive. Pre-fix RED:
    // tab B's scan pruned a1 — tab A's gesture lost its recovery record while
    // tab A's UI had said "saved" (the BLK-A3 void).
    expect(await shared.get("a1")).toBeDefined();
    expect(await shared.get("b1")).toBeDefined();
  });

  it("same-tab re-typed duplicates still supersede (the case the scan exists for), stamped with the page clientId", async () => {
    await saveGesture(gesture("i-old"));
    await saveGesture(gesture("i-new", "s1", "hello"));
    const recs = await memoryStore.all();
    expect(recs.map((r) => r.intentId)).toEqual(["i-new"]);
    // Both records were written by THIS tab's page lifetime: the survivor
    // carries the CURRENT page identity — the scan's match key (a-F1/d-F3
    // fold: assert the exact id, not mere presence).
    expect(recs[0].clientId).toBe(__outboxClientIdForTests());
  });

  it("retryFailedSave's scan is equally tab-scoped: tab B's retry never prunes tab A's record", async () => {
    const shared = createMemoryOutboxStore();
    __resetOutboxForTests(shared);
    await saveGesture(gesture("a1", "s1", "hello")); // tab A commits
    // Tab B: a new page lifetime whose first save fails once (transient),
    // arming the banner; the retry then commits through the SAME durable
    // store (the once-failing facade delegates to `shared` after the failure).
    let failNext = true;
    const onceFailing: OutboxStore = {
      put: (rec) => {
        if (failNext) {
          failNext = false;
          return Promise.resolve({ ok: false, code: "storage-unavailable", reason: "transient outage" });
        }
        return shared.put(rec);
      },
      get: (id) => shared.get(id),
      all: () => shared.all(),
      delete: (id) => shared.delete(id),
      snapshot: () => shared.snapshot(),
    };
    // Tab B = a DIFFERENT tab: empty per-tab storage (b-F2) → fresh identity
    // at the reset, so b1 is stamped with an id foreign to a1's.
    sessionStorage.removeItem(SS_OUTBOX_CLIENT_KEY);
    __resetOutboxForTests(onceFailing);
    await expect(saveGesture(gesture("b1", "s1", "hello"))).resolves.toMatchObject({ ok: false });
    await expect(retryFailedSave()).resolves.toBe(true);
    expect(await shared.get("b1")).toBeDefined();
    // Tab A's record survives tab B's retry-commit scan. Pre-fix RED: pruned.
    expect(await shared.get("a1")).toBeDefined();
  });

  it("records without a clientId (pre-upgrade) are FOREIGN — never pruned (errs toward retention)", async () => {
    const legacy: OutboxGestureRecord = {
      intentId: "i-legacy",
      sessionId: "s1",
      createdAt: Date.now() - 1000,
      payload: { text: "hello", attachments: [], sendConfig: { agent: "build" } },
      capturedHead: head("s1", "m-0", 1),
      status: "saved",
    };
    await memoryStore.put(legacy);
    await saveGesture(gesture("i-new", "s1", "hello"));
    expect(await memoryStore.get("i-legacy")).toBeDefined();
    expect(await memoryStore.get("i-new")).toBeDefined();
  });
});

describe("b-F2 round 1 — reload-stable tab identity (sessionStorage-backed)", () => {
  // The round-1 defect: pageClientId was minted per MODULE EVALUATION, so a
  // page reload minted a fresh id and a pre-reload saved same-text record
  // became FOREIGN to the post-reload supersede scan. Both records then aged
  // past the 60s guard; reconcile (oldest-first) admitted the STALE
  // pre-reload record while the R-F3 twin prune / same-text belt deleted the
  // FRESH gesture — the operator's newest gesture silently discarded: an
  // oldest-wins inversion of same-tab newest-wins. Fix: the identity is
  // sessionStorage-backed (per-tab + survives reload WITHIN the tab; NEVER
  // localStorage — it is shared across tabs).

  it("b-F1 regression: the SAME TAB across a reload keeps its identity — a post-reload same-text save prunes the pre-reload saved record (newest-wins at the reload boundary)", async () => {
    // The reload simulation: the pre-reload page lifetime had stored its id
    // in this tab's sessionStorage; the reload re-evaluates the module over
    // the SAME per-tab storage — the page identity IS that stored id.
    // b-F1/b-F2 round 2 precondition: the seeded record carries NO bootNonce
    // (an earlier eval's write), so the prune runs through the CROSS-EVAL
    // gate — uncontended (the harness default stub reports no objection:
    // the predecessor is this tab's dead former self) → the prune proceeds.
    sessionStorage.setItem(SS_OUTBOX_CLIENT_KEY, "pre-reload-tab-id");
    __resetOutboxForTests(memoryStore); // the reload: fresh module state, identity adopted
    expect(__outboxClientIdForTests()).toBe("pre-reload-tab-id");
    // What the pre-reload page saved (stamped with the SAME tab id — true
    // across a reload exactly because the identity lives in sessionStorage).
    await memoryStore.put({
      intentId: "i-pre",
      sessionId: "s1",
      createdAt: Date.now() - 30_000,
      payload: { text: "hello", attachments: [], sendConfig: { agent: "build" } },
      capturedHead: head("s1", "m-0", 1),
      status: "saved",
      clientId: "pre-reload-tab-id",
    });
    // Post-reload: the operator re-sends the identical text as a NEW gesture.
    await saveGesture(gesture("i-post", "s1", "hello"));
    // Same-tab newest-wins ACROSS the reload: the pre-reload record is pruned
    // at save time and the fresh gesture is the sole survivor. Pre-fix RED:
    // the module-var mint ignored sessionStorage → the post-reload page id
    // differed from any seeded record → the prune never fired → BOTH records
    // survived (and reconcile would then admit the STALE one — the blocker).
    const recs = await memoryStore.all();
    expect(recs.map((r) => r.intentId)).toEqual(["i-post"]);
    expect(recs[0].clientId).toBe("pre-reload-tab-id");
  });

  it("cross-tab stance pin: two DISTINCT identities, same text → saves COEXIST; the aged reconcile admits the OLDEST and prunes the newer same-text twin (the DESIGNED cross-tab duplicate suppression)", async () => {
    // Two tabs modeled by direct seeding with foreign clientIds (records
    // foreign to each other's supersede scans). The module's documented
    // stance (index.ts, page-identity block): cross-tab same-text duplicates
    // are NOT resolved by pruning — they coexist, and the DESIGNED backstops
    // (reconcile's oldest-wins pass + pass-local same-text suppression)
    // collapse them at re-admission to exactly one send.
    const t = Date.now() - READMIT_MIN_AGE_MS - 5000;
    await memoryStore.put({
      intentId: "i-a",
      sessionId: "s1",
      createdAt: t,
      payload: { text: "hello", attachments: [], sendConfig: { agent: "build" } },
      capturedHead: head("s1", "m-0", 1),
      status: "saved",
      clientId: "tab-a-id", // a DIFFERENT tab's identity
    });
    // This tab (its own identity) saves the SAME text: tab A's record is
    // FOREIGN — never pruned (R-F2); the two coexist by design.
    await saveGesture(gesture("i-b", "s1", "hello"));
    expect(await memoryStore.get("i-a")).toBeDefined();
    expect(await memoryStore.get("i-b")).toBeDefined();
    // Age this tab's record past the re-admission guard too (backdate in the
    // store, preserving its stamped clientId) — both now in the crash-window
    // class reconcile owns.
    const recB = (await memoryStore.get("i-b"))!;
    await memoryStore.put({ ...recB, createdAt: Date.now() - READMIT_MIN_AGE_MS - 1000 });
    // Aged reconcile (unchanged head, authoritative empty list): OLDEST wins
    // the pass's single re-admission; the newer same-text twin is pruned by
    // the pass-local same-text belt — exactly one admission, no duplicate.
    const enq = vi.fn(async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId }));
    await reconcileOutboxSession("s1", {
      fetchList: async () => [] as QueuedMessage[],
      enqueue: enq,
      currentHead: () => head("s1", "m-0", 1),
    });
    expect(enq).toHaveBeenCalledTimes(1);
    expect(enq.mock.calls[0][1].intentId).toBe("i-a"); // the OLDEST gesture
    expect((await memoryStore.get("i-a"))?.status).toBe("admitted");
    expect(await memoryStore.get("i-b")).toBeUndefined(); // twin pruned
  });
});

describe("b-F1/b-F2 round 2 — copied-storage clone (bootNonce + uncontested-claim gate)", () => {
  // The round-2 defect: sessionStorage identity is COPIED into opener-created
  // tabs (window.open / target=_blank) and duplicated tabs (platform
  // semantics), so a clone tab evaluates under the SAME clientId — the R-F2
  // clientId gate cannot see it. The clone's supersede scan treated the
  // ORIGINAL tab's just-saved same-text record as own-tab and DELETED it: a
  // cross-tab prune of a live tab's durable record (the BLK-A3-class void).
  // Fix: a per-page-eval bootNonce stamps every save/retry; a cross-eval
  // match (same clientId, different/absent nonce) prunes ONLY when the
  // BroadcastChannel claim handshake is uncontested — ANY objection from a
  // live sibling (or no channel / any handshake surprise) skips the prune:
  // degradation is to the SAFE direction (records coexist; the designed
  // backstops — reconcile oldest-wins belt + same-text suppression, R-F3
  // twin prune, daemon intentId-value admission dedupe — own them).

  /** A record written under THIS page's clientId by an arbitrary page
   *  evaluation (nonce chosen by the caller: this eval's, an earlier eval's,
   *  or absent). */
  function pageIdRecord(intentId: string, nonce: string | undefined): OutboxGestureRecord {
    return {
      intentId,
      sessionId: "s1",
      createdAt: Date.now() - 1000,
      payload: { text: "hello", attachments: [], sendConfig: { agent: "build" } },
      capturedHead: head("s1", "m-0", 1),
      status: "saved",
      clientId: __outboxClientIdForTests(),
      ...(nonce === undefined ? {} : { bootNonce: nonce }),
    };
  }

  it("copied-storage regression: an OBJECTING live sibling (same clientId, different bootNonce) blocks the cross-eval prune — rA survives", async () => {
    // rA is the ORIGINAL tab's just-saved record: same clientId as this page
    // (the platform copy), written by a DIFFERENT page evaluation. The
    // channel reports the sibling's 'mine' objection — it is live and holds
    // this id (arrives asynchronously, inside the ~120ms claim window).
    const objecting = new ClaimChannelStub();
    objecting.onWhoHas = (q) => setTimeout(() => objecting.deliver({ type: "mine", id: q.id }), 5);
    installClaimChannel(() => objecting);
    await memoryStore.put(pageIdRecord("rA", "original-tab-eval-nonce"));
    // The clone tab saves the same text as a NEW gesture — no throw.
    await expect(saveGesture(gesture("rB", "s1", "hello"))).resolves.toEqual({ ok: true });
    // The objection held: the cross-eval prune MUST be skipped — rA (a live
    // tab's durable record) survives and rB is the sole addition. Pre-fix
    // RED: rA is deleted (the cross-tab prune of a live tab's record — the
    // exact blocker this gate exists for).
    expect(await memoryStore.get("rA")).toBeDefined();
    expect(await memoryStore.get("rB")).toBeDefined();
    const recs = await memoryStore.all();
    expect(recs.map((r) => r.intentId).sort()).toEqual(["rA", "rB"]);
  });

  it("same-bootNonce fast path: THIS eval's record prunes with ZERO channel traffic", async () => {
    const nonce = bootNonceForTests();
    expect(nonce).toBeTruthy(); // the round-2 seam is present (precondition)
    await memoryStore.put(pageIdRecord("rA", nonce));
    await saveGesture(gesture("i-new", "s1", "hello"));
    expect(await memoryStore.get("rA")).toBeUndefined();
    // The common same-typing case never touches the channel (zero latency).
    expect(latestStub.posted).toHaveLength(0);
  });

  it("absent BroadcastChannel: cross-eval prunes are conservatively SKIPPED — no throw, both records survive", async () => {
    // Model an environment with NO BroadcastChannel global (old browser /
    // exotic embedding): restore the PRODUCTION default factory and hide the
    // global, then run a cross-eval prune shape through it.
    const g = globalThis as { BroadcastChannel?: unknown };
    const orig = g.BroadcastChannel;
    g.BroadcastChannel = undefined;
    installClaimChannel(null); // null restores the production default factory
    try {
      __resetOutboxForTests(memoryStore); // fresh eval: memo cleared, channel re-opened → none found
      await memoryStore.put(pageIdRecord("rA", "earlier-eval-nonce"));
      const res = await saveGesture(gesture("i-new", "s1", "hello"));
      expect(res).toEqual({ ok: true }); // never an error
      expect(await memoryStore.get("rA")).toBeDefined(); // prune skipped — safe direction
      expect(await memoryStore.get("i-new")).toBeDefined();
    } finally {
      g.BroadcastChannel = orig;
    }
  });

  it("objection memoization: the handshake runs ONCE per eval — a later cross-eval prune reuses the verdict (no second who-has)", async () => {
    await memoryStore.put(pageIdRecord("rX", "earlier-eval-nonce-a"));
    await memoryStore.put(pageIdRecord("rY", "earlier-eval-nonce-b"));
    // One save matching BOTH cross-eval records: the first match runs the
    // handshake; the second reuses the memoized verdict mid-save.
    await saveGesture(gesture("g1", "s1", "hello"));
    expect(await memoryStore.get("rX")).toBeUndefined();
    expect(await memoryStore.get("rY")).toBeUndefined();
    // A LATER cross-eval prune in the SAME eval: no second query.
    await memoryStore.put(pageIdRecord("rZ", "earlier-eval-nonce-c"));
    await saveGesture(gesture("g2", "s1", "hello"));
    expect(await memoryStore.get("rZ")).toBeUndefined();
    const whoHas = latestStub.posted.filter((m) => (m as { type?: string }).type === "who-has");
    expect(whoHas).toHaveLength(1);
  });
});

describe("R-F3 — admitted+saved crash-separated twin (time-scoped twin prune)", () => {
  // The defect: reconcile's admitted branch did not register the admitted
  // record's text, so a crash-separated SAVED same-text twin (created before
  // the admission but still `saved` when a later pass runs) flowed the
  // ordinary age/head gates in a later pass (~2-IDB-op window) and was
  // RE-ADMITTED — two admissions under distinct intentIds, which the daemon
  // does NOT collapse (it dedupes admission by intentId VALUE). Slice 3
  // deliberately did NOT naively register admitted text (that would prune a
  // fresh DELIBERATE same-text re-send created after the admission). Fix:
  // markAdmitted stamps admittedAt; a still-`saved` same-text record OLDER
  // than an admission's admittedAt is a pre-admission residual twin → pruned;
  // NEWER than admittedAt is a fresh gesture → kept. Legacy records without
  // admittedAt keep the current behavior (the time gate cannot run).
  function seed(o: Partial<OutboxGestureRecord> & { intentId: string }): OutboxGestureRecord {
    const r: OutboxGestureRecord = {
      sessionId: "s1",
      createdAt: Date.now(),
      payload: { text: "hello", attachments: [], sendConfig: { agent: "build" } },
      capturedHead: head("s1", "m-0", 1),
      status: "saved",
      ...o,
    };
    return r;
  }
  function twinDeps(enq: any) {
    return {
      fetchList: async () => [qItem("q-adm", { intentId: "i-adm" })],
      enqueue: enq,
      currentHead: () => head("s1", "m-0", 1),
    };
  }

  it("a saved twin OLDER than the admission's admittedAt is pruned — never re-admitted", async () => {
    const t = Date.now() - READMIT_MIN_AGE_MS - 60_000;
    await memoryStore.put(
      seed({ intentId: "i-adm", createdAt: t, status: "admitted", queueItemId: "q-adm", admittedAt: t + 2000 }),
    );
    // The twin: created BEFORE the admission completed (t+1000 < t+2000),
    // still `saved` when the pass runs (the crash-separated residual).
    await memoryStore.put(seed({ intentId: "i-twin", createdAt: t + 1000 }));
    const enq = vi.fn(async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId }));
    await reconcileOutboxSession("s1", twinDeps(enq));
    // The twin is pruned with NO re-admission attempt. Pre-fix RED: the twin
    // flowed the age/head gates (120s old, head unchanged) and was enqueued —
    // the duplicate send (the daemon does not collapse distinct intentIds).
    expect(enq).not.toHaveBeenCalled();
    expect(await memoryStore.get("i-twin")).toBeUndefined();
    // The admitted record itself is retained (its item is present + pending).
    expect(await memoryStore.get("i-adm")).toBeDefined();
  });

  it("negative: a same-text record NEWER than admittedAt is a fresh deliberate gesture — kept", async () => {
    const now = Date.now();
    await memoryStore.put(
      seed({ intentId: "i-adm", createdAt: now - 30_000, status: "admitted", queueItemId: "q-adm", admittedAt: now - 5000 }),
    );
    // Created AFTER the admission completed: a fresh gesture (young — the age
    // guard owns it; the twin prune must not fire on it).
    await memoryStore.put(seed({ intentId: "i-fresh", createdAt: now - 1000 }));
    const enq = vi.fn();
    await reconcileOutboxSession("s1", twinDeps(enq));
    expect(enq).not.toHaveBeenCalled();
    expect(await memoryStore.get("i-fresh")).toBeDefined();
  });

  it("negative (gate-reaching, d-F1): a saved twin PAST the age guard but NEWER than admittedAt is re-admitted under its OWN intentId — the time comparison's false branch discriminates", async () => {
    // d-F1: the young-twin negative above is turned away by the AGE guard
    // BEFORE the R-F3 map lookup runs — it cannot prove the time comparison
    // itself discriminates. This record REACHES the gate: past the 60s guard
    // (createdAt = now-61s) yet NEWER than admittedAt (now-180s). Map
    // presence alone must NOT prune it — `createdAt < admittedAt` is FALSE —
    // and the record flows the ordinary gates to re-admission under its OWN
    // intentId. Current code is already correct: a PIN, no red expected.
    const now = Date.now();
    await memoryStore.put(
      seed({ intentId: "i-adm", createdAt: now - 200_000, status: "admitted", queueItemId: "q-adm", admittedAt: now - 180_000 }),
    );
    await memoryStore.put(seed({ intentId: "i-late", createdAt: now - 61_000 }));
    const enq = vi.fn(async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId }));
    await reconcileOutboxSession("s1", twinDeps(enq));
    expect(enq).toHaveBeenCalledTimes(1);
    expect(enq.mock.calls[0][1].intentId).toBe("i-late"); // its OWN gesture identity
    expect((await memoryStore.get("i-late"))?.status).toBe("admitted");
  });

  it("legacy admitted record WITHOUT admittedAt: the time gate cannot run — current behavior kept (pin)", async () => {
    const t = Date.now() - READMIT_MIN_AGE_MS - 60_000;
    await memoryStore.put(
      seed({ intentId: "i-adm", createdAt: t, status: "admitted", queueItemId: "q-adm" /* admittedAt ABSENT */ }),
    );
    await memoryStore.put(seed({ intentId: "i-twin", createdAt: t + 1000 }));
    const enq = vi.fn(async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId }));
    await reconcileOutboxSession("s1", twinDeps(enq));
    // Current behavior: the aged non-stale twin IS re-admitted under its own
    // gesture identity (retention errs toward the existing path for records
    // the timestamps cannot classify).
    expect(enq).toHaveBeenCalledTimes(1);
    expect(enq.mock.calls[0][1].intentId).toBe("i-twin");
    expect(await memoryStore.get("i-twin")).toBeDefined();
  });
});

describe("null-vs-empty list nuances (fetch-failure ≠ authoritative empty)", () => {
  // fetchList resolves null when the queue list could not be fetched (never
  // throws) — a NO-ANSWER, distinct from [] (the server answered: empty).
  function ndeps(
    o: Partial<{ listNull: boolean; list: QueuedMessage[]; current: OutboxContextHead | null; enqueueImpl: any }> = {},
  ) {
    return {
      fetchList: async () => (o.listNull ? null : (o.list ?? []).slice()),
      enqueue: o.enqueueImpl ?? (async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId })),
      currentHead: () => o.current ?? null,
    };
  }

  it("pin (a): aged SAVED + list===null → the re-admission POST FIRES under the same intentId", async () => {
    // SAFE BY CONTRACT, pinned deliberately: the daemon dedupes admission by
    // intentId VALUE — a replay of the SAME gesture identity returns the
    // ORIGINAL receipt and creates no second queue item. That by-value dedupe
    // is precisely what makes a no-answer re-admission safe (the saved+absent
    // branch cannot distinguish "item never admitted" from "list unfetchable";
    // retaining would strand a genuinely-unadmitted gesture, while re-admitting
    // the same intentId is idempotent server-side).
    await saveGesture(gesture("i-1"));
    const r = (await memoryStore.get("i-1"))!;
    await memoryStore.put({ ...r, createdAt: Date.now() - READMIT_MIN_AGE_MS - 1000 });
    const enq = vi.fn(async (_sid: string, input: any) => qItem("q-new", { intentId: input.intentId }));
    await reconcileOutboxSession("s1", ndeps({ listNull: true, current: head("s1", "m-0", 1), enqueueImpl: enq }));
    expect(enq).toHaveBeenCalledTimes(1);
    expect(enq.mock.calls[0][1].intentId).toBe("i-1");
  });

  it("tighten (b): ADMITTED + list===null → RETAINED (absence is not established by a non-answer)", async () => {
    await saveGesture(gesture("i-1"));
    await markAdmitted("i-1", "q-x");
    await reconcileOutboxSession("s1", ndeps({ listNull: true }));
    // Pre-fix RED: the admitted branch pruned on !item even when the list was
    // null — a FETCH FAILURE destroyed the record. Retain + skip: absence is
    // not established; the next pass (with an authoritative list) re-evaluates.
    expect(await memoryStore.get("i-1")).toBeDefined();
  });

  it("pin (b): ADMITTED + list===[] (authoritative empty) → pruned", async () => {
    await saveGesture(gesture("i-2"));
    await markAdmitted("i-2", "q-y");
    await reconcileOutboxSession("s1", ndeps({ list: [] }));
    expect(await memoryStore.get("i-2")).toBeUndefined();
  });
});

describe("ambiguous replacement overlay", () => {
  it("requestReplacement persists + flips the reactive read (the chip's Replacement requested state)", async () => {
    await saveGesture(gesture("i-orig"));
    await markAdmitted("i-orig", "q-1");
    expect(replacementRequestedFor("i-orig")).toBeUndefined();
    await requestReplacement("i-orig", "i-new");
    expect(replacementRequestedFor("i-orig")).toBe("i-new");
    // Durable: a fresh hydrate (the reload/tab-kill path) restores the overlay.
    const secondLife = createMemoryOutboxStore();
    // copy records into the "new page's" store
    for (const r of await memoryStore.all()) await secondLife.put(r);
    __resetOutboxForTests(secondLife);
    await hydrateOutbox();
    expect(replacementRequestedFor("i-orig")).toBe("i-new");
  });

  it("dropGesture removes the record (a terminally-blocked gesture is never re-admitted)", async () => {
    await saveGesture(gesture("i-1"));
    await dropGesture("i-1");
    expect(await memoryStore.get("i-1")).toBeUndefined();
  });
});

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
  memoryStore = createMemoryOutboxStore();
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
    expect(Number(markerAfterSave)).toBeGreaterThan(0);
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

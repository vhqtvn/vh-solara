// @vitest-environment jsdom
//
// Send-reliability slice 2 — createSend attempt-safety unit tests.
//
// Pins the client-side half of the immutable-prepared-attempt contract at the
// createSend factory seam (fake deps, no ChatView):
//   - attachment-failure BLOCKING (inline-failed, flush-failed, still
//     uploading) halts the send pipeline BEFORE queue admission;
//   - typed uncertainty: a response-less enqueue failure reconciles FIRST
//     (list hit = custody confirmed) and otherwise records outcome-unknown
//     with retry-same recovery — never "failed, safe to resend";
//   - immutable retries: a re-tap of the retained uncertain attempt reuses
//     the SAME attemptId + byte-identical payload, with NO re-resolution /
//     re-upload / re-captured config;
//   - definitive rejections (429 admission_full) hard-stop: no reconcile,
//     no retry;
//   - draft→live ownership transfer of the attempt record;
//   - createSessionWithCertainty classification (502/timeout = unknown,
//     other statuses = definitive);
//   - dispatchQueuedItem DISPATCH classification (the queued prompt_async
//     POST — a DIFFERENT seam from session-create): proxy 502 →
//     outcome-unknown with the explicit "proxy 502 (outcome unknown)"
//     detail; a definitive non-2xx (500) → terminal failed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { createSend, type SendDependencies } from "../../src/components/chat/createSend";
import type { Attachment } from "../../src/components/chat/createAttachments";
import { EnqueueError, type QueuedMessage } from "../../src/queue";
import { __resetSendSingleFlightForTests } from "../../src/lib/sendSingleFlight";
import {
  __resetSendActionStatusForTests,
  getSendAction,
  markOwnerSessionCreateUnknown,
  sendActionsFor,
} from "../../src/lib/sendActionStatus";
import { createSessionWithCertainty } from "../../src/sync/actions";

// inlineAttachForced reads localStorage at module load — jsdom provides it.
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

interface Harness {
  send: ReturnType<typeof createSend>["send"];
  // The queued-dispatch seam (drainer → prompt_async POST + classification).
  // The send() tests never call it; the dispatch-path describe block does.
  dispatchQueuedItem: ReturnType<typeof createSend>["dispatchQueuedItem"];
  input: () => string;
  setInput: (v: string) => void;
  atts: () => Attachment[];
  setAtts: (v: Attachment[] | ((p: Attachment[]) => Attachment[])) => void;
  notes: { kind: string; title: string; detail: string; sessionID?: string }[];
  enqueueInputs: { id: string; input: any }[];
  uploadCalls: number;
  fetchQueueCalls: number;
  setUploadResult: (r: Attachment | null) => void;
  setDraft: (v: boolean) => void;
}

function harness(overrides: {
  enqueue?: (id: string, input: any) => Promise<unknown>;
  fetchQueue?: (id: string) => Promise<QueuedMessage[]>;
  uploading?: () => boolean;
  flush?: (id: string) => Promise<{ failed: Attachment[] }>;
  draft?: () => boolean;
  ensureSession?: () => Promise<string | null>;
  curModel?: () => { vision?: boolean } | undefined;
  inlineFiles?: Map<string, File>;
  /** Overrides the live-session id the deps report (F2: destination-session
   *  retry linkage is owner-scoped, so the second harness must report the id
   *  the first harness's draft materialized into). */
  sessionId?: string;
} = {}): Harness {
  const [input, setInput] = createSignal("");
  const [atts, setAtts] = createSignal<Attachment[]>([]);
  const [draft, setDraft] = createSignal(overrides.draft ? overrides.draft() : false);
  const notes: Harness["notes"] = [];
  const enqueueInputs: Harness["enqueueInputs"] = [];
  let uploadCalls = 0;
  let uploadResult: Attachment | null = null;
  let fetchQueueCalls = 0;
  const file = new File(["x"], "inl1.png", { type: "image/png" });
  const inlineFiles = overrides.inlineFiles ?? new Map([["inl1", file]]);
  void file;

  const deps: SendDependencies = {
    sessionId: () => overrides.sessionId ?? "ses-1",
    draft,
    ensureSession: overrides.ensureSession ?? (async () => "ses-1"),
    input,
    setInput,
    readyToSend: () => true,
    working: () => false,
    queueMode: () => true,
    selectionFor: () => ({ providerID: "p", modelID: "m" }),
    awaitAgent: async () => ({ ok: true, agent: "build" }),
    resolveAgent: () => ({ state: "agent", agent: "build" }),
    adoptDraftAgent: () => {},
    models: () => [{ name: "m" }],
    loadModels: async () => {},
    migrateModelPick: () => {},
    curModel: overrides.curModel ?? (() => ({ vision: true })),
    enqueue: overrides.enqueue
      ? (id, inp) => {
          enqueueInputs.push({ id, input: JSON.parse(JSON.stringify(inp)) });
          return overrides.enqueue!(id, inp);
        }
      : async (id, inp) => {
          enqueueInputs.push({ id, input: JSON.parse(JSON.stringify(inp)) });
          return { id: "q1" };
        },
    fetchQueue: overrides.fetchQueue
      ? (id) => {
          fetchQueueCalls++;
          return overrides.fetchQueue!(id);
        }
      : (id) => {
          fetchQueueCalls++;
          return Promise.resolve([]);
        },
    uploading: overrides.uploading ?? (() => false),
    isSending: () => false,
    setSending: () => {},
    userScrolledUp: () => false,
    jumpToLatest: () => {},
    pushHistory: () => {},
    resetHistory: () => {},
    pushNotification: (n) => {
      notes.push(n as Harness["notes"][number]);
    },
    undo: () => {},
    redo: () => {},
    attachments: atts,
    setAttachments: setAtts,
    flushPendingAttachments: overrides.flush ?? (async () => ({ failed: [] })),
    inlineFiles,
    uploadFile: async () => {
      uploadCalls++;
      return uploadResult;
    },
    draftKey: (sid) => `vh.draft.${sid}`,
  };
  const { send, dispatchQueuedItem } = createSend(deps);
  return {
    send,
    dispatchQueuedItem,
    input,
    setInput,
    atts,
    setAtts,
    notes,
    enqueueInputs,
    get uploadCalls() {
      return uploadCalls;
    },
    get fetchQueueCalls() {
      return fetchQueueCalls;
    },
    setUploadResult: (r) => {
      uploadResult = r;
    },
    setDraft,
  };
}

beforeEach(() => {
  __resetSendSingleFlightForTests();
  __resetSendActionStatusForTests();
});

afterEach(() => {
  __resetSendSingleFlightForTests();
  __resetSendActionStatusForTests();
  for (const k of Object.keys(mem)) delete mem[k];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Attachment-failure blocking — the send pipeline halts BEFORE admission.
// ---------------------------------------------------------------------------
describe("createSend slice 2 — attachment-failure blocking", () => {
  it("a FAILED INLINE attachment blocks admission: no enqueue, loud notification, text restored, action blocked", async () => {
    const h = harness({
      curModel: () => ({ vision: false }), // inline mode
    });
    const text = "see ![a](vh-attach:inl1) thanks";
    h.setInput(text);
    await h.send();
    // THE CRUX: admission halted before the queue — no partial send with a
    // dangling vh-attach: token.
    expect(h.enqueueInputs).toHaveLength(0);
    expect(h.notes.some((n) => n.title === "Not sent — attachment upload failed")).toBe(true);
    expect(h.input()).toBe(text); // restored for retry
    expect(sendActionsFor("ses-1").some((a) => a.stage === "blocked")).toBe(true);
  });

  it("a FAILED PENDING (flush) attachment blocks admission: no enqueue, chips retained", async () => {
    const chip: Attachment = { url: "pending:1", filename: "f.txt", mime: "text/plain", file: new File(["f"], "f.txt") };
    const h = harness({
      flush: async () => ({ failed: [chip] }),
    });
    h.setAtts([chip]);
    h.setInput("with a draft attachment");
    await h.send();
    expect(h.enqueueInputs).toHaveLength(0);
    expect(h.notes.some((n) => n.title === "Not sent — attachment upload failed")).toBe(true);
    expect(h.input()).toBe("with a draft attachment");
    // The failed chip is RETAINED (never silently dropped).
    expect(h.atts()).toHaveLength(1);
    expect(sendActionsFor("ses-1").some((a) => a.stage === "blocked")).toBe(true);
  });

  it("an in-flight upload (uploading()) blocks admission before the flush", async () => {
    const h = harness({ uploading: () => true });
    h.setInput("wait for the upload");
    await h.send();
    expect(h.enqueueInputs).toHaveLength(0);
    expect(h.notes.some((n) => n.title === "Not sent — attachment still uploading")).toBe(true);
    expect(h.input()).toBe("wait for the upload");
  });
});

// ---------------------------------------------------------------------------
// Typed uncertainty — response-less enqueue failures reconcile first.
// ---------------------------------------------------------------------------
describe("createSend slice 2 — typed uncertainty + reconcile-first", () => {
  it("response-less failure + reconcile MISS → outcome-unknown (retry-same), composer preserved", async () => {
    const h = harness({
      enqueue: async () => {
        throw new Error("offline"); // plain Error — no HTTP status = no response
      },
      fetchQueue: async () => [], // authoritative list does NOT show our attempt
    });
    h.setInput("maybe queued?");
    await h.send();
    expect(h.enqueueInputs).toHaveLength(1);
    expect(h.fetchQueueCalls).toBe(1); // reconcile-first ran
    expect(h.notes.some((n) => n.title === "Queue confirmation unknown")).toBe(true);
    expect(h.input()).toBe("maybe queued?"); // preserved for the retry-same path
    const action = sendActionsFor("ses-1").find((a) => a.stage === "uncertain");
    expect(action).toBeDefined();
    expect(action!.certainty).toBe("unknown");
    expect(action!.recovery).toBe("retry-same");
    expect(action!.payload?.tapText).toBe("maybe queued?");
  });

  it("response-less failure + reconcile HIT (list shows our attemptId) → custody confirmed, send reports success", async () => {
    let firstAttemptId = "";
    const h = harness({
      enqueue: async (_id, inp) => {
        firstAttemptId = inp.attemptId;
        throw new Error("timeout-ish");
      },
      fetchQueue: async () => [
        { id: "q-9", order: 1, state: "pending", text: "x", attachments: [], createdAt: 1, attemptId: firstAttemptId } as QueuedMessage,
      ],
    });
    h.setInput("made it after all");
    await h.send();
    // The reconcile matched the attempt the first POST carried.
    expect(firstAttemptId).toBeTruthy();
    expect(h.notes.some((n) => n.title === "Queue confirmation unknown")).toBe(false);
    // Success shape: composer cleared + a history write happened (custody
    // confirmed → normal success path).
    expect(h.input()).toBe("");
    // The action record is finished (admitted — the queue item is authority).
    expect(getSendAction(firstAttemptId)).toBeUndefined();
  });

  it("429 queue_admission_full → definitive rejection: NO reconcile, NO retry", async () => {
    const h = harness({
      enqueue: async () => {
        throw new EnqueueError("enqueue failed (429 queue_admission_full)", "queue_admission_full", 429);
      },
    });
    h.setInput("no room");
    await h.send();
    expect(h.enqueueInputs).toHaveLength(1);
    expect(h.fetchQueueCalls).toBe(0); // hard stop — 429 is definitive
    expect(h.notes.some((n) => n.title === "Message not queued — queue is full")).toBe(true);
    expect(h.input()).toBe("no room");
    const action = sendActionsFor("ses-1").find((a) => a.stage === "rejected");
    expect(action?.certainty).toBe("definitive");
    expect(action?.recovery).toBe("restore");
  });

  it("409 queue_admission_conflict → explicit conflict state (never retry-forever)", async () => {
    const h = harness({
      enqueue: async () => {
        throw new EnqueueError("enqueue failed (409 queue_admission_conflict)", "queue_admission_conflict", 409);
      },
    });
    h.setInput("conflicting");
    await h.send();
    expect(h.fetchQueueCalls).toBe(0);
    expect(h.notes.some((n) => n.title === "Message not queued — admission conflict")).toBe(true);
    expect(sendActionsFor("ses-1").some((a) => a.stage === "conflict")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Immutable prepared attempts — the retry reuses identity + payload verbatim.
// ---------------------------------------------------------------------------
describe("createSend slice 2 — immutable prepared attempts", () => {
  it("a re-tap after an outcome-unknown admission reuses the SAME attemptId + byte-identical payload, with NO re-upload", async () => {
    let fail = true;
    const h = harness({
      curModel: () => ({ vision: false }), // inline mode → uploadFile involved
      enqueue: async (_id, inp) => {
        if (fail) throw new Error("response lost");
        return { id: "q2", attemptId: inp.attemptId };
      },
      fetchQueue: async () => [], // reconcile miss → retained uncertain
    });
    h.setUploadResult({ url: "file://up/inl1.png", filename: "inl1.png", mime: "image/png", path: ".vh-solara/x.png" });
    const text = "retry me ![a](vh-attach:inl1)";
    h.setInput(text);

    await h.send(); // first attempt: upload resolved, enqueue response lost
    expect(h.uploadCalls).toBe(1);
    expect(h.enqueueInputs).toHaveLength(1);

    // Re-tap the SAME logical message (the retry the notification offers).
    h.setInput(text);
    fail = false;
    await h.send();

    // SECOND enqueue: same attemptId, byte-identical payload…
    expect(h.enqueueInputs).toHaveLength(2);
    expect(h.enqueueInputs[1].input.attemptId).toBe(h.enqueueInputs[0].input.attemptId);
    expect(h.enqueueInputs[1].input).toEqual(h.enqueueInputs[0].input);
    // …and NO re-resolution / re-upload of the inline file.
    expect(h.uploadCalls).toBe(1);
    // The retry succeeded → the retained action is finished.
    expect(getSendAction(h.enqueueInputs[0].input.attemptId)).toBeUndefined();
  });

  it("a re-tap with CHANGED text is a NEW attempt (different attemptId), not a reuse", async () => {
    const h = harness({
      enqueue: async () => {
        throw new Error("response lost");
      },
      fetchQueue: async () => [],
    });
    h.setInput("original");
    await h.send();
    h.setInput("edited before retry");
    await h.send();
    expect(h.enqueueInputs).toHaveLength(2);
    expect(h.enqueueInputs[1].input.attemptId).not.toBe(h.enqueueInputs[0].input.attemptId);
  });

  it("draft→live ownership transfer: the attempt mints under draft and transfers to the live id", async () => {
    const h = harness({
      draft: () => true,
      ensureSession: async () => "live-1",
      enqueue: async () => {
        throw new Error("response lost");
      },
      fetchQueue: async () => [],
    });
    h.setInput("from the draft");
    await h.send();
    expect(h.enqueueInputs).toHaveLength(1);
    expect(h.enqueueInputs[0].id).toBe("live-1"); // enqueued against the live id
    const attemptId = h.enqueueInputs[0].input.attemptId as string;
    expect(attemptId).toBeTruthy();
    // The retained uncertain action is now owned by the LIVE id (explicit
    // transfer — the single-flight keys are distinct).
    expect(getSendAction(attemptId)?.ownerKey).toBe("live-1");
    expect(sendActionsFor("draft")).toHaveLength(0);
    expect(sendActionsFor("live-1").map((a) => a.attemptId)).toContain(attemptId);
  });
});

// ---------------------------------------------------------------------------
// F2 (slice-3 review) — the draft→live transfer is an owner SWEEP: retained
// records from EARLIER draft taps must follow the user into the destination
// session too, and a retry there must reuse the ORIGINAL attemptId.
// ---------------------------------------------------------------------------
describe("createSend — F2 draft→session migration of retained draft-owned records", () => {
  it("a retained create-outcome-unknown record follows the draft's LATER materialization into the live session (owner sweep)", async () => {
    // Two-tap arc: tap 1's session create outcome is UNKNOWN (ChatView marks
    // the draft-owned record uncertain/check and restores the text); tap 2
    // materializes the session. Slice 2's per-attempt transfer moved only the
    // in-flight attempt — the tap-1 record stayed stranded under "draft",
    // invisible in the destination session (SendStatus reads ownerKey =
    // session id). The owner sweep re-keys EVERY still-draft-owned record.
    let createCalls = 0;
    const h = harness({
      draft: () => true,
      ensureSession: async () => {
        createCalls += 1;
        if (createCalls === 1) {
          markOwnerSessionCreateUnknown("draft", "session create timed out");
          return null;
        }
        return "live-1";
      },
      enqueue: async () => {
        throw new Error("response lost");
      },
      fetchQueue: async () => [],
    });
    h.setInput("two taps");
    await h.send(); // tap 1: create outcome unknown → retained uncertain/check

    const orphan = sendActionsFor("draft").find((a) => a.stage === "uncertain" && a.recovery === "check");
    expect(orphan).toBeDefined();
    expect(orphan!.detail).toContain("session create timed out");

    await h.send(); // tap 2 (text was restored by the tap-1 failure path)
    expect(h.enqueueInputs).toHaveLength(1);
    expect(h.enqueueInputs[0].id).toBe("live-1");

    // THE F2 CRUX: the retained tap-1 record followed the user into the
    // session — nothing remains under "draft", and the destination session's
    // status surface (sendActionsFor(sessionId)) sees BOTH the migrated
    // create-unknown record and the tap-2 enqueue-uncertain record.
    expect(sendActionsFor("draft")).toHaveLength(0);
    const live = sendActionsFor("live-1");
    expect(live.map((a) => a.attemptId)).toContain(orphan!.attemptId);
    expect(live.some((a) => a.stage === "uncertain" && a.recovery === "retry-same")).toBe(true);
  });

  it("a retry in the DESTINATION session reuses the draft-originated attemptId (owner-scoped linkage)", async () => {
    // Part 1: the draft send's enqueue response is lost → an uncertain
    // retry-same record transferred to live-1 (slice-2 linkage, now via the
    // owner sweep).
    const h1 = harness({
      draft: () => true,
      ensureSession: async () => "live-1",
      enqueue: async () => {
        throw new Error("response lost");
      },
      fetchQueue: async () => [],
    });
    h1.setInput("draft retry arc");
    await h1.send();
    const attemptId = h1.enqueueInputs[0].input.attemptId as string;
    expect(getSendAction(attemptId)?.ownerKey).toBe("live-1");
    expect(getSendAction(attemptId)?.recovery).toBe("retry-same");

    // Part 2: the DESTINATION session's composer re-taps the same text. The
    // retry linkage is owner-scoped — it MUST find the transferred record and
    // reuse the SAME attemptId, so the server's admission dedupe protects the
    // draft-originated arc (no fresh attemptId).
    const h2 = harness({ sessionId: "live-1" });
    h2.setInput("draft retry arc");
    await h2.send();
    expect(h2.enqueueInputs).toHaveLength(1);
    expect(h2.enqueueInputs[0].input.attemptId).toBe(attemptId);
    // Custody confirmed by the recorded enqueue → the action is finished.
    expect(getSendAction(attemptId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createSessionWithCertainty — 502/timeout are outcome-unknown, not proof of
// non-creation (the /oc proxy 502s on transport failure).
// ---------------------------------------------------------------------------
describe("createSessionWithCertainty — typed certainty classification", () => {
  const respond = (status: number, body: unknown = {}) =>
    vi.fn(() => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => "" }));

  it("proxy 502 → outcome UNKNOWN (the session may exist)", async () => {
    vi.stubGlobal("fetch", respond(502, { error: "upstream unreachable" }));
    const r = await createSessionWithCertainty();
    expect(r.id).toBeNull();
    expect(r.certainty).toBe("unknown");
  });

  it("definitive 4xx → NOT created (certainty definitive)", async () => {
    vi.stubGlobal("fetch", respond(400, { error: "bad request" }));
    const r = await createSessionWithCertainty();
    expect(r.id).toBeNull();
    expect(r.certainty).toBe("definitive");
  });

  it("2xx with an id → the id, definitive", async () => {
    vi.stubGlobal("fetch", respond(200, { id: "new-ses-1" }));
    const r = await createSessionWithCertainty();
    expect(r.id).toBe("new-ses-1");
    expect(r.certainty).toBe("definitive");
  });

  it("2xx with NO id → definitive malformed (not unknown)", async () => {
    vi.stubGlobal("fetch", respond(200, {}));
    const r = await createSessionWithCertainty();
    expect(r.id).toBeNull();
    expect(r.certainty).toBe("definitive");
  });

  it("network throw → outcome UNKNOWN (response may have been applied)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("fetch failed"))));
    const r = await createSessionWithCertainty();
    expect(r.id).toBeNull();
    expect(r.certainty).toBe("unknown");
  });

  it("timeout abort → outcome UNKNOWN", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: any) =>
        new Promise((_res, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      ),
    );
    vi.useFakeTimers();
    const p = createSessionWithCertainty();
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(12000);
    const r = await p;
    expect(r.id).toBeNull();
    expect(r.certainty).toBe("unknown");
    expect(r.detail).toContain("timed out");
  });

  it("carries the POST-armed client timestamp (A1 create-attempt window start) on every outcome", async () => {
    // A1 create-linkage (send-defers study): markOwnerSessionCreateUnknown
    // consumes startedAt as the create-attempt window START (end = the mark
    // time), so the draft-view affordance can correlate a session whose
    // worker-stamped time.created lands inside it.
    const before = Date.now();
    vi.stubGlobal("fetch", respond(502, { error: "upstream unreachable" }));
    const unknown = await createSessionWithCertainty();
    expect(unknown.startedAt).toBeGreaterThanOrEqual(before);
    expect(unknown.startedAt).toBeLessThanOrEqual(Date.now());

    vi.stubGlobal("fetch", respond(200, { id: "new-ses-1" }));
    const ok = await createSessionWithCertainty();
    expect(ok.id).toBe("new-ses-1");
    expect(ok.startedAt).toBeGreaterThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// dispatchQueuedItem — DISPATCH-path outcome classification. A DIFFERENT seam
// from createSessionWithCertainty above (session-create): this is the queued
// prompt_async POST the drainer hands off, classified inside createSend.ts
// dispatchQueuedItem. Mirrors the /oc catch-all proxy semantics
// (pkg/web/server.go): 502 = TRANSPORT failure to OpenCode, which does NOT
// prove the POST went undelivered → outcome-unknown, never failed; only a
// definitive non-2xx proves non-delivery → terminal failed.
// ---------------------------------------------------------------------------
describe("createSend — dispatchQueuedItem dispatch-path classification (queued prompt_async POST)", () => {
  const respondText = (status: number, body: string) =>
    vi.fn(() => Promise.resolve({ ok: status >= 200 && status < 300, status, text: async () => body }));
  const item = (): QueuedMessage => ({
    id: "q-dispatch-1",
    order: 1,
    state: "dispatching",
    text: "queued text",
    attachments: [],
    // Complete captured config (provider + model + agent) → the captured
    // branch; the agent gate never runs.
    sendConfig: { providerID: "p", modelID: "m", agent: "build" },
    createdAt: 1,
  });

  it("queued DISPATCH (prompt_async POST) proxy 502 → outcome UNKNOWN with the 'proxy 502 (outcome unknown)' detail — never failed", async () => {
    vi.stubGlobal("fetch", respondText(502, "upstream unreachable"));
    const h = harness();
    const out = await h.dispatchQueuedItem("ses-1", item(), new AbortController().signal);
    expect(out.state).toBe("unknown");
    expect(out.detail).toBe("proxy 502 (outcome unknown): upstream unreachable");
    // The operator-facing surface mirrors the classification: an
    // outcome-unknown notice, not a definitive failure notice.
    expect(h.notes.some((n) => n.title === "Queued message send outcome unknown")).toBe(true);
    expect(h.notes.some((n) => n.title === "Queued message failed to send")).toBe(false);
  });

  it("queued DISPATCH (prompt_async POST) definitive 500 → terminal failed — never unknown", async () => {
    vi.stubGlobal("fetch", respondText(500, "500 upstream"));
    const h = harness();
    const out = await h.dispatchQueuedItem("ses-1", item(), new AbortController().signal);
    expect(out.state).toBe("failed");
    expect(out.detail).toBe("500 upstream");
    expect(h.notes.some((n) => n.title === "Queued message failed to send")).toBe(true);
  });
});

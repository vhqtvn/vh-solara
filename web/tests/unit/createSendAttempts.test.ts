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
  finishSendAttempt,
  getSendAction,
  markOwnerSessionCreateUnknown,
  sendActionsFor,
  updateSendAction,
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
  // Guarded SendStatus row-retry entry (sending-UX O2 fix) — the
  // edited-composer retry-same cells exercise this seam.
  retrySameMessage: ReturnType<typeof createSend>["retrySameMessage"];
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
  /** Overrides the bounded agent evidence gate (guarded-retry cells: the
   *  defensive fallback when a stored payload lost its captured agent). */
  awaitAgent?: SendDependencies["awaitAgent"];
  /** Overrides the sync tap-time resolver (post-mint gate cells: "pending"
   *  forces the admission to wait on awaitAgent instead of a tap snapshot). */
  resolveAgent?: SendDependencies["resolveAgent"];
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
    awaitAgent: overrides.awaitAgent ?? (async () => ({ ok: true, agent: "build" })),
    resolveAgent: overrides.resolveAgent ?? (() => ({ state: "agent", agent: "build" })),
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
  const { send, retrySameMessage, dispatchQueuedItem } = createSend(deps);
  return {
    send,
    retrySameMessage,
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
  it("a FAILED INLINE attachment blocks admission: no enqueue, blocked row with the review advice (NO duplicate notification), text restored", async () => {
    const h = harness({
      curModel: () => ({ vision: false }), // inline mode
    });
    const text = "see ![a](vh-attach:inl1) thanks";
    h.setInput(text);
    await h.send();
    // THE CRUX: admission halted before the queue — no partial send with a
    // dangling vh-attach: token.
    expect(h.enqueueInputs).toHaveLength(0);
    // O2 single-owner: the blocked row owns the fact (reason-specific copy);
    // the covered notification-history entry is suppressed.
    expect(h.notes.some((n) => n.title === "Not sent — attachment upload failed")).toBe(false);
    expect(h.notes).toHaveLength(0);
    const row = sendActionsFor("ses-1").find((a) => a.stage === "blocked");
    expect(row).toBeDefined();
    expect(row!.reason).toBe("attachments-failed");
    expect(h.input()).toBe(text); // restored for retry
  });

  it("a FAILED PENDING (flush) attachment blocks admission: no enqueue, chips retained, blocked row owns the reason", async () => {
    const chip: Attachment = { url: "pending:1", filename: "f.txt", mime: "text/plain", file: new File(["f"], "f.txt") };
    const h = harness({
      flush: async () => ({ failed: [chip] }),
    });
    h.setAtts([chip]);
    h.setInput("with a draft attachment");
    await h.send();
    expect(h.enqueueInputs).toHaveLength(0);
    expect(h.notes.some((n) => n.title === "Not sent — attachment upload failed")).toBe(false);
    expect(h.notes).toHaveLength(0);
    expect(sendActionsFor("ses-1").some((a) => a.stage === "blocked" && a.reason === "attachments-failed")).toBe(true);
    expect(h.input()).toBe("with a draft attachment");
    // The failed chip is RETAINED (never silently dropped).
    expect(h.atts()).toHaveLength(1);
  });

  it("an in-flight upload (uploading()) blocks admission before the flush; the blocked row owns the wait instruction", async () => {
    const h = harness({ uploading: () => true });
    h.setInput("wait for the upload");
    await h.send();
    expect(h.enqueueInputs).toHaveLength(0);
    expect(h.notes.some((n) => n.title === "Not sent — attachment still uploading")).toBe(false);
    expect(h.notes).toHaveLength(0);
    expect(sendActionsFor("ses-1").some((a) => a.stage === "blocked" && a.reason === "attachments-uploading")).toBe(true);
    expect(h.input()).toBe("wait for the upload");
  });

  // C-F1 (O2 slice-1 review): the attachment gates write the owning row only
  // when an attempt record exists — shell sends ("!") carry NO attempt, so
  // their blocked facts were suppressed with ZERO surface. The agent-gate
  // pattern (if(attempt) row else notify) is mirrored at all four sites; this
  // cell pins the reachable one (flush-failed shell send).
  it("SHELL send ('!') with a failed upload chip: no attempt row exists, so the blocked gate surfaces a NOTIFICATION (never homeless)", async () => {
    const chip: Attachment = { url: "pending:1", filename: "f.txt", mime: "text/plain", file: new File(["f"], "f.txt") };
    const h = harness({ flush: async () => ({ failed: [chip] }) });
    h.setAtts([chip]);
    h.setInput("!deploy");
    await h.send();
    expect(h.enqueueInputs).toHaveLength(0);
    // Shell owns no attempt record — the notification is the one honest
    // surface for the blocked fact.
    expect(h.notes.some((n) => n.title === "Not sent — attachment upload failed")).toBe(true);
    expect(sendActionsFor("ses-1")).toHaveLength(0);
    // The shell text is preserved for retry.
    expect(h.input()).toBe("!deploy");
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
    // O2 single-owner: the uncertain ROW owns the fact (retry-same + the
    // guarded Retry-same-message affordance) — no duplicate notification.
    expect(h.notes.some((n) => n.title === "Queue confirmation unknown")).toBe(false);
    expect(h.notes).toHaveLength(0);
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

  it("429 queue_admission_full → definitive rejection: NO reconcile, NO retry; the row owns the capacity advice", async () => {
    const h = harness({
      enqueue: async () => {
        throw new EnqueueError("enqueue failed (429 queue_admission_full)", "queue_admission_full", 429);
      },
    });
    h.setInput("no room");
    await h.send();
    expect(h.enqueueInputs).toHaveLength(1);
    expect(h.fetchQueueCalls).toBe(0); // hard stop — 429 is definitive
    // O2 single-owner: the rejected row's queue-full reason copy carries the
    // removal advice the notification used to own — no duplicate entry.
    expect(h.notes.some((n) => n.title === "Message not queued — queue is full")).toBe(false);
    expect(h.notes).toHaveLength(0);
    expect(h.input()).toBe("no room");
    const action = sendActionsFor("ses-1").find((a) => a.stage === "rejected");
    expect(action?.certainty).toBe("definitive");
    expect(action?.recovery).toBe("restore");
    expect(action?.reason).toBe("queue-full");
  });

  it("409 queue_admission_conflict → explicit conflict state (never retry-forever); the row owns the check-queue advice", async () => {
    const h = harness({
      enqueue: async () => {
        throw new EnqueueError("enqueue failed (409 queue_admission_conflict)", "queue_admission_conflict", 409);
      },
    });
    h.setInput("conflicting");
    await h.send();
    expect(h.fetchQueueCalls).toBe(0);
    expect(h.notes.some((n) => n.title === "Message not queued — admission conflict")).toBe(false);
    expect(h.notes).toHaveLength(0);
    const row = sendActionsFor("ses-1").find((a) => a.stage === "conflict");
    expect(row).toBeDefined();
    expect(row!.conflictSource).toBe("admission");
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
// Guarded row-retry (sending-UX O2 defect fix; RECORD-ADDRESSED since the
// slice-1 review A-F1) — the SendStatus "Queue confirmation unknown." row's
// Retry button routes through the guarded controller entry
// (retrySameMessage) WITH the displayed record's attemptId, NOT the raw
// composer send. The row's contract is VERBATIM same-attempt replay of the
// CLICKED record; the original defects were that an operator who EDITED the
// composer got the edit silently enqueued as a fresh message, and that with
// two retained uncertain records the composer-text-matched selection could
// replay the WRONG record from a row.
// ---------------------------------------------------------------------------
describe("createSend — guarded row-retry (retrySameMessage, record-addressed)", () => {
  it("EDITED composer text: row retry replays the STORED verbatim payload under the SAME attemptId; the edit stays in the composer", async () => {
    let fail = true;
    const h = harness({
      enqueue: async () => {
        if (fail) throw new Error("response lost");
        return { id: "q-r1" };
      },
      fetchQueue: async () => [],
    });
    h.setInput("original message");
    await h.send(); // first attempt: enqueue response lost → uncertain/retry-same
    const attemptId = h.enqueueInputs[0].input.attemptId as string;
    expect(getSendAction(attemptId)?.recovery).toBe("retry-same");

    h.setInput("edited draft — not what the row previews");
    fail = false;
    await h.retrySameMessage(attemptId); // the ROW's Retry entry, record-addressed

    // THE CRUX: the replay enqueued the STORED payload (byte-identical to the
    // first attempt, same attemptId) — NOT the edited composer text.
    expect(h.enqueueInputs).toHaveLength(2);
    expect(h.enqueueInputs[1].input.attemptId).toBe(attemptId);
    expect(h.enqueueInputs[1].input).toEqual(h.enqueueInputs[0].input);
    expect(h.enqueueInputs[1].input.text).toBe("original message");
    // The operator's edit survives untouched in the composer (for a fresh
    // send under a fresh attemptId) — nothing was silently overwritten.
    expect(h.input()).toBe("edited draft — not what the row previews");
    // Custody confirmed → the retained action is finished (row disappears).
    expect(getSendAction(attemptId)).toBeUndefined();
  });

  it("TWO retained uncertain records: retry-by-attemptId on A enqueues ONLY A's payload under A's attemptId; B is untouched (the A-F1 crux)", async () => {
    let fail = true;
    const h = harness({
      enqueue: async () => {
        if (fail) throw new Error("response lost");
        return { id: "q-r-multi" };
      },
      fetchQueue: async () => [],
    });
    h.setInput("message A");
    await h.send(); // A: response lost → uncertain/retry-same
    const idA = h.enqueueInputs[0].input.attemptId as string;
    h.setInput("message B");
    await h.send(); // B: response lost → uncertain/retry-same
    const idB = h.enqueueInputs[1].input.attemptId as string;
    expect(idA).not.toBe(idB);
    expect(sendActionsFor("ses-1").filter((a) => a.stage === "uncertain" && a.recovery === "retry-same")).toHaveLength(2);

    // The composer holds B's text — the OLD live-text-matched defect replayed
    // B from A's row. The record-addressed entry replays the CLICKED record.
    h.setInput("message B");
    fail = false;
    await h.retrySameMessage(idA);

    expect(h.enqueueInputs).toHaveLength(3);
    expect(h.enqueueInputs[2].input.attemptId).toBe(idA);
    expect(h.enqueueInputs[2].input.text).toBe("message A");
    // A's replay succeeded → A finished; B stays retained + untouched.
    expect(getSendAction(idA)).toBeUndefined();
    const recB = getSendAction(idB);
    expect(recB?.stage).toBe("uncertain");
    expect(recB?.recovery).toBe("retry-same");
    expect(recB?.payload?.text).toBe("message B");
    // A row retry never modifies the composer.
    expect(h.input()).toBe("message B");
  });

  it("GONE record (unknown id): refuses loudly — no enqueue, notification, composer untouched", async () => {
    const h = harness();
    h.setInput("some draft text");
    await h.retrySameMessage("att-does-not-exist");
    expect(h.enqueueInputs).toHaveLength(0);
    expect(h.notes.some((n) => n.title === "Retry unavailable — status changed")).toBe(true);
    expect(h.input()).toBe("some draft text");
  });

  it("FINISHED record (custody confirmed / dismissed): refuses loudly — no enqueue, notification", async () => {
    let fail = true;
    const h = harness({
      enqueue: async () => {
        if (fail) throw new Error("response lost");
        return { id: "q-r-fin" };
      },
      fetchQueue: async () => [],
    });
    h.setInput("will be confirmed");
    await h.send();
    const attemptId = h.enqueueInputs[0].input.attemptId as string;
    finishSendAttempt(attemptId); // e.g. a reconcile confirmed custody, or the row was dismissed

    fail = false;
    await h.retrySameMessage(attemptId);

    expect(h.enqueueInputs).toHaveLength(1); // no replay
    expect(h.notes.some((n) => n.title === "Retry unavailable — status changed")).toBe(true);
    expect(h.input()).toBe("will be confirmed");
  });

  it("ADDED attachment after the attempt (text unchanged): replay sends the stored payload WITHOUT the added chip; the composer keeps it", async () => {
    let fail = true;
    const a1: Attachment = { url: "file://up/a.png", filename: "a.png", mime: "image/png" };
    const a2: Attachment = { url: "file://up/b.png", filename: "b.png", mime: "image/png" };
    const h = harness({
      enqueue: async () => {
        if (fail) throw new Error("response lost");
        return { id: "q-r2" };
      },
      fetchQueue: async () => [],
    });
    h.setAtts([a1]);
    h.setInput("with one file");
    await h.send(); // payload captured with [a1]; response lost
    const attemptId = h.enqueueInputs[0].input.attemptId as string;

    h.setAtts([a1, a2]); // operator ADDS a chip after the attempt
    fail = false;
    await h.retrySameMessage(attemptId);

    expect(h.enqueueInputs).toHaveLength(2);
    expect(h.enqueueInputs[1].input.attemptId).toBe(attemptId);
    // Verbatim replay: exactly the stored chip set — the ADDED chip never
    // silently rides along.
    expect(h.enqueueInputs[1].input.attachments).toEqual([
      { url: "file://up/a.png", filename: "a.png", mime: "image/png" },
    ]);
    // The composer keeps both chips (the addition is the operator's next
    // message, untouched — a row retry never modifies the composer).
    expect(h.atts()).toEqual([a1, a2]);
    expect(h.input()).toBe("with one file");
  });

  it("UNCHANGED composer: row retry replays VERBATIM under the SAME attemptId and never modifies the composer", async () => {
    let fail = true;
    const h = harness({
      enqueue: async () => {
        if (fail) throw new Error("response lost");
        return { id: "q-r3" };
      },
      fetchQueue: async () => [],
    });
    h.setInput("retry me unchanged");
    await h.send(); // response lost → uncertain retained; text restored
    const attemptId = h.enqueueInputs[0].input.attemptId as string;

    fail = false;
    await h.retrySameMessage(attemptId); // composer still holds the exact tap text

    // Record-addressed replay: same attemptId, verbatim payload…
    expect(h.enqueueInputs).toHaveLength(2);
    expect(h.enqueueInputs[1].input.attemptId).toBe(attemptId);
    expect(h.enqueueInputs[1].input).toEqual(h.enqueueInputs[0].input);
    // …and a row retry NEVER modifies the composer — even a matching one is
    // left as-is for the operator to clear (no send()-delegation clear).
    expect(h.input()).toBe("retry me unchanged");
    expect(getSendAction(attemptId)).toBeUndefined();
  });

  it("REMOVED attachment after the attempt: verbatim replay re-includes the removed chip (slice-2 advisory, coherent)", async () => {
    let fail = true;
    const a1: Attachment = { url: "file://up/a.png", filename: "a.png", mime: "image/png" };
    const a2: Attachment = { url: "file://up/b.png", filename: "b.png", mime: "image/png" };
    const h = harness({
      enqueue: async () => {
        if (fail) throw new Error("response lost");
        return { id: "q-r4" };
      },
      fetchQueue: async () => [],
    });
    h.setAtts([a1, a2]);
    h.setInput("two files originally");
    await h.send(); // payload captured with [a1, a2]; response lost
    const attemptId = h.enqueueInputs[0].input.attemptId as string;

    h.setAtts([a1]); // operator REMOVES b.png after the attempt
    fail = false;
    await h.retrySameMessage(attemptId);

    expect(h.enqueueInputs).toHaveLength(2);
    expect(h.enqueueInputs[1].input.attemptId).toBe(attemptId);
    // Deliberate verbatim replay: the removed chip is re-included (the row's
    // payload preview advertises exactly this).
    expect(h.enqueueInputs[1].input.attachments).toHaveLength(2);
    expect(h.enqueueInputs[1].input.attachments.map((a: any) => a.filename)).toEqual(["a.png", "b.png"]);
    // The composer is untouched: the still-present chip stays, the removed
    // one is not resurrected into the composer.
    expect(h.atts()).toEqual([a1]);
    expect(h.input()).toBe("two files originally");
  });

  it("a replay whose response is lost AGAIN stays uncertain + retryable (reconcile-first re-runs); the edit is still preserved", async () => {
    const h = harness({
      enqueue: async () => {
        throw new Error("response lost");
      },
      fetchQueue: async () => [],
    });
    h.setInput("flaky admission");
    await h.send();
    const attemptId = h.enqueueInputs[0].input.attemptId as string;

    h.setInput("edited while uncertain");
    await h.retrySameMessage(attemptId); // replay — response lost again

    expect(h.enqueueInputs).toHaveLength(2);
    expect(h.enqueueInputs[1].input.attemptId).toBe(attemptId);
    expect(h.fetchQueueCalls).toBe(2); // reconcile-first ran for both attempts
    const rec = getSendAction(attemptId);
    expect(rec?.stage).toBe("uncertain");
    expect(rec?.recovery).toBe("retry-same");
    expect(h.input()).toBe("edited while uncertain");
  });

  it("DEFENSIVE: a payload whose captured config lost its agent falls back to the evidence gate; a gate refusal sends nothing", async () => {
    const h = harness({
      awaitAgent: async () => ({ ok: false, reason: "timeout" }),
      enqueue: async () => {
        throw new Error("response lost");
      },
      fetchQueue: async () => [],
    });
    h.setInput("gate fallback arc");
    await h.send(); // resolveAgent supplies the tap-time agent → enqueue attempted, response lost
    const attemptId = h.enqueueInputs[0].input.attemptId as string;
    const rec = getSendAction(attemptId);
    expect(rec?.recovery).toBe("retry-same");

    // Strip the captured agent (a state that should not occur — captureConfig
    // is total — but the guard must fail closed, never send without an agent).
    updateSendAction(attemptId, { payload: { ...rec!.payload!, sendConfig: {} } });
    h.setInput("edited before the gate refusal");
    await h.retrySameMessage(attemptId);

    expect(h.enqueueInputs).toHaveLength(1); // no second enqueue
    // PRESERVED notification (O2 dedup exception): the uncertain row cannot
    // own the replay-refusal event without misrepresenting the admission
    // state — this is the one honest surface for it.
    expect(h.notes.some((n) => n.title === "Not sent — agent unresolved")).toBe(true);
    expect(h.input()).toBe("edited before the gate refusal");
    expect(getSendAction(attemptId)?.recovery).toBe("retry-same"); // still retryable
  });

  // -------------------------------------------------------------------------
  // O2 deferred C-F1/D-F1 — attachments-only replay silent no-op fix. The
  // row-retry threads an EMPTY ownership set (it owns none of the composer
  // state), so sendText's admission guard decides emptiness against THE
  // PAYLOAD's attachments — an attachment-only stored payload (empty text)
  // must not trip it: the Retry was silently inert (no enqueue, no
  // notification) before the fix.
  // -------------------------------------------------------------------------
  it("ATTACHMENT-ONLY payload + diverged composer: row retry enqueues the STORED attachments under the SAME attemptId (was a silent no-op)", async () => {
    let fail = true;
    const a1: Attachment = { url: "file://up/only.png", filename: "only.png", mime: "image/png" };
    const h = harness({
      enqueue: async () => {
        if (fail) throw new Error("response lost");
        return { id: "q-ao" };
      },
      fetchQueue: async () => [],
    });
    h.setAtts([a1]);
    h.setInput(""); // attachment-only: no text
    await h.send(); // payload captured {text:"", attachments:[a1]}; response lost
    const attemptId = h.enqueueInputs[0].input.attemptId as string;
    expect(getSendAction(attemptId)?.recovery).toBe("retry-same");

    // Diverge the composer (text edited, chip removed) — verbatim replay.
    h.setInput("meanwhile I typed something else");
    h.setAtts([]);
    fail = false;
    await h.retrySameMessage(attemptId);

    // THE CRUX: the retry is NOT a silent no-op — the STORED attachment set
    // replays verbatim under the SAME attemptId.
    expect(h.enqueueInputs).toHaveLength(2);
    expect(h.enqueueInputs[1].input.attemptId).toBe(attemptId);
    expect(h.enqueueInputs[1].input.text).toBe("");
    expect(h.enqueueInputs[1].input.attachments).toEqual([
      { url: "file://up/only.png", filename: "only.png", mime: "image/png" },
    ]);
    // The diverged composer is untouched; custody confirmed → row finished.
    expect(h.input()).toBe("meanwhile I typed something else");
    expect(h.atts()).toEqual([]);
    expect(getSendAction(attemptId)).toBeUndefined();
  });

  it("ATTACHMENT-ONLY payload + emptied composer: record-addressed replay still enqueues the STORED attachments (no silent no-op)", async () => {
    let fail = true;
    const a1: Attachment = { url: "file://up/solo.png", filename: "solo.png", mime: "image/png" };
    const h = harness({
      enqueue: async () => {
        if (fail) throw new Error("response lost");
        return { id: "q-ao2" };
      },
      fetchQueue: async () => [],
    });
    h.setAtts([a1]);
    h.setInput("");
    await h.send();
    const attemptId = h.enqueueInputs[0].input.attemptId as string;

    // Composer text is "" and the live chip set was emptied — the replay is
    // decided against the STORED payload, never the live composer read.
    h.setAtts([]);
    fail = false;
    await h.retrySameMessage(attemptId);

    expect(h.enqueueInputs).toHaveLength(2);
    expect(h.enqueueInputs[1].input.attemptId).toBe(attemptId);
    expect(h.enqueueInputs[1].input.attachments).toEqual([
      { url: "file://up/solo.png", filename: "solo.png", mime: "image/png" },
    ]);
    expect(getSendAction(attemptId)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // O2 slice 1 — post-mint agent-gate refusals get a TERMINAL row disposition
  // (no stale "Sending…" row) and the row owns the fact (notification
  // suppressed; reason copy "Not sent — choose an agent.").
  // -------------------------------------------------------------------------
  it("post-mint agent-gate refusal (admission awaitAgent timeout) → terminal rejected row with reason agent-unresolved, NO notification, no stale preparing row", async () => {
    const h = harness({
      resolveAgent: () => ({ state: "pending" }), // no tap-time agent
      awaitAgent: async () => ({ ok: false, reason: "timeout" }),
    });
    h.setInput("gate me");
    await h.send();
    expect(h.enqueueInputs).toHaveLength(0);
    expect(h.notes).toHaveLength(0); // the row owns the refusal (O2 dedup)
    const row = sendActionsFor("ses-1").find((a) => a.stage === "rejected");
    expect(row).toBeDefined();
    expect(row!.reason).toBe("agent-unresolved");
    expect(row!.recovery).toBe("restore");
    // No stale preparing row remains (the brief's contradiction-list fix).
    expect(sendActionsFor("ses-1").some((a) => a.stage === "preparing")).toBe(false);
    expect(h.input()).toBe("gate me"); // preserved
  });

  it("post-mint DRAFT agent-gate refusal (no tapAgent) → same terminal row disposition, no notification", async () => {
    const h = harness({
      draft: () => true,
      ensureSession: async () => "live-draft-gate",
      resolveAgent: () => ({ state: "pending" }),
      awaitAgent: async () => ({ ok: false, reason: "timeout" }),
    });
    h.setInput("draft with no agent");
    await h.send();
    expect(h.enqueueInputs).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
    expect(sendActionsFor("live-draft-gate").some((a) => a.stage === "rejected" && a.reason === "agent-unresolved")).toBe(true);
    expect(sendActionsFor("draft")).toHaveLength(0); // swept to the live id first
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

  it("queued DISPATCH (prompt_async POST) proxy 502 → outcome UNKNOWN with the 'proxy 502 (outcome unknown)' detail — never failed; the unknown chip owns it (no notification)", async () => {
    vi.stubGlobal("fetch", respondText(502, "upstream unreachable"));
    const h = harness();
    const out = await h.dispatchQueuedItem("ses-1", item(), new AbortController().signal);
    expect(out.state).toBe("unknown");
    expect(out.detail).toBe("proxy 502 (outcome unknown): upstream unreachable");
    // O2 single-owner: the queue item's unknown chip visibly carries the
    // detail + the check-transcript instruction — the covered notification-
    // history entry is suppressed (the classification lives in DrainOutcome).
    expect(h.notes).toHaveLength(0);
  });

  it("queued DISPATCH (prompt_async POST) definitive 500 → terminal failed — never unknown; the failed chip owns the cause (no notification)", async () => {
    vi.stubGlobal("fetch", respondText(500, "500 upstream"));
    const h = harness();
    const out = await h.dispatchQueuedItem("ses-1", item(), new AbortController().signal);
    expect(out.state).toBe("failed");
    expect(out.detail).toBe("500 upstream");
    expect(h.notes).toHaveLength(0);
  });
});

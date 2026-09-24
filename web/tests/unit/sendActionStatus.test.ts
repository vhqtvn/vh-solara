// Send-reliability slice 2 — sendActionStatus store unit tests (node env:
// solid-js/store only, no DOM).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetSendActionStatusForTests,
  CREATE_LINK_CLOCK_SKEW_MS,
  createLinkCandidates,
  finishSendAttempt,
  findReusableSendAttempt,
  getSendAction,
  markOwnerSessionCreateUnknown,
  markSendAttemptResolveConflict,
  markSendAttemptStatusUnsaved,
  mintSendAttempt,
  sendActionsFor,
  transferOwnerSendAttempts,
  updateSendAction,
  type PreparedSendPayload,
} from "../../src/lib/sendActionStatus";

afterEach(() => {
  __resetSendActionStatusForTests();
});

const att = (url: string) => ({ url, filename: url, mime: "text/plain" });
const payload = (tapText: string, urls: string[] = []): PreparedSendPayload => ({
  tapText,
  text: tapText,
  attachments: urls.map(att),
  sendConfig: { agent: "build" },
  files: urls,
});

describe("sendActionStatus — mint/transfer/update/finish lifecycle", () => {
  it("mints a preparing action with unknown certainty and no recovery", () => {
    const a = mintSendAttempt("draft");
    expect(a.attemptId).toBeTruthy();
    expect(a.ownerKey).toBe("draft");
    expect(a.stage).toBe("preparing");
    expect(a.certainty).toBe("unknown");
    expect(a.recovery).toBe("none");
    expect(getSendAction(a.attemptId)).toBeDefined();
  });

  it("attempt ids are unique per mint", () => {
    const a = mintSendAttempt("s1");
    const b = mintSendAttempt("s1");
    expect(a.attemptId).not.toBe(b.attemptId);
  });

  it("minting finishes superseded same-owner preparing/blocked/rejected records", () => {
    const a1 = mintSendAttempt("s1");
    updateSendAction(a1.attemptId, { stage: "blocked", certainty: "definitive", recovery: "restore" });
    const a2 = mintSendAttempt("s1"); // supersedes the blocked record
    expect(getSendAction(a1.attemptId)).toBeUndefined();
    expect(getSendAction(a2.attemptId)).toBeDefined();
    // …but retained UNCERTAIN records survive (they are retry candidates):
    const a3 = mintSendAttempt("s1");
    updateSendAction(a3.attemptId, { stage: "uncertain", recovery: "retry-same", payload: payload("x") });
    const a4 = mintSendAttempt("s1");
    expect(getSendAction(a3.attemptId)).toBeDefined();
    expect(getSendAction(a4.attemptId)).toBeDefined();
  });

  it("updateSendAction patches stage/certainty/recovery/detail/payload; unknown id is a no-op", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, {
      stage: "uncertain", certainty: "unknown", recovery: "retry-same",
      detail: "enqueue timed out", payload: payload("hello"),
    });
    const got = getSendAction(a.attemptId)!;
    expect(got.stage).toBe("uncertain");
    expect(got.detail).toBe("enqueue timed out");
    expect(got.payload?.tapText).toBe("hello");
    expect(() => updateSendAction("att-nope", { stage: "rejected" })).not.toThrow();
  });

  it("finishSendAttempt removes the record (admitted — queue item is the authority)", () => {
    const a = mintSendAttempt("s1");
    finishSendAttempt(a.attemptId);
    expect(getSendAction(a.attemptId)).toBeUndefined();
  });

  it("sendActionsFor returns newest-first for the owner only (retained records)", () => {
    // A mint supersedes same-owner PREPARING records, so ordering is observed
    // over RETAINED records: an uncertain one (survives) + a fresh mint.
    const a1 = mintSendAttempt("s1");
    updateSendAction(a1.attemptId, { stage: "uncertain", recovery: "retry-same", payload: payload("x") });
    const a2 = mintSendAttempt("s1");
    const other = mintSendAttempt("s2");
    const list = sendActionsFor("s1");
    expect(list.map((x) => x.attemptId)).toEqual([a2.attemptId, a1.attemptId]);
    expect(sendActionsFor("s2").map((x) => x.attemptId)).toEqual([other.attemptId]);
  });
});

describe("sendActionStatus — findReusableSendAttempt (retry-same linkage)", () => {
  it("matches uncertain + retry-same + verbatim tapText", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, { stage: "uncertain", recovery: "retry-same", payload: payload("retry me") });
    expect(findReusableSendAttempt("s1", "retry me")?.attemptId).toBe(a.attemptId);
  });

  it("does not match a different tapText, a non-uncertain stage, or another owner", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, { stage: "uncertain", recovery: "retry-same", payload: payload("retry me") });
    expect(findReusableSendAttempt("s1", "other text")).toBeUndefined();
    expect(findReusableSendAttempt("s2", "retry me")).toBeUndefined();

    const b = mintSendAttempt("s1");
    updateSendAction(b.attemptId, { stage: "rejected", recovery: "restore", payload: payload("retry me") });
    expect(findReusableSendAttempt("s1", "retry me")?.attemptId).toBe(a.attemptId); // only the uncertain one
  });

  it("does not match uncertain records lacking a payload", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, { stage: "uncertain", recovery: "retry-same" }); // no payload recorded
    expect(findReusableSendAttempt("s1", "any")).toBeUndefined();
  });
});

describe("sendActionStatus — session-create unknown marking", () => {
  it("marks the owner's PREPARING action uncertain/check with the detail", () => {
    const a = mintSendAttempt("draft");
    markOwnerSessionCreateUnknown("draft", "session create timed out");
    const got = getSendAction(a.attemptId)!;
    expect(got.stage).toBe("uncertain");
    expect(got.certainty).toBe("unknown");
    expect(got.recovery).toBe("check"); // NOT retry-same: session-create has no idempotency
    expect(got.detail).toBe("session create timed out");
  });

  it("leaves non-preparing actions (e.g. blocked) alone", () => {
    const a = mintSendAttempt("draft");
    updateSendAction(a.attemptId, { stage: "blocked", certainty: "definitive" });
    markOwnerSessionCreateUnknown("draft", "x");
    expect(getSendAction(a.attemptId)?.stage).toBe("blocked");
  });
});

describe("sendActionStatus — resolve-conflict marking", () => {
  it("marks a retained attempt conflict/definitive/check — and CLEARS a stale retrySave payload (D3)", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, { stage: "admitting" });
    markSendAttemptResolveConflict(a.attemptId, "s1", "server holds sent for item q1");
    const got = getSendAction(a.attemptId)!;
    expect(got.stage).toBe("conflict");
    expect(got.certainty).toBe("definitive");
    expect(got.recovery).toBe("check");
    expect(got.detail).toBe("server holds sent for item q1");

    // D3 hygiene: the reachable re-mark arc is an UNSAVED record (retrySave
    // set) whose status-save retry itself hit a 409 (SendStatus.retrySave's
    // conflict branch). The re-marked conflict record must NOT keep the stale
    // retry-save payload — inert before (the affordance is gated on
    // stage === "unsaved"), but the retained payload would misdescribe it.
    const b = mintSendAttempt("s1"); // "conflict" is not superseded — a survives
    markSendAttemptStatusUnsaved(b.attemptId, "s1", { itemId: "q1", state: "sent", detail: "ok" });
    expect(getSendAction(b.attemptId)?.retrySave).toEqual({ itemId: "q1", state: "sent", detail: "ok" });
    markSendAttemptResolveConflict(b.attemptId, "s1", "server holds failed for item q1");
    const reGot = getSendAction(b.attemptId)!;
    expect(reGot.stage).toBe("conflict");
    expect(reGot.conflictSource).toBe("resolve");
    expect(reGot.retrySave).toBeNull(); // THE D3 CRUX: stale payload cleared
  });

  it("UPSERTs a minimal conflict record for an un-minted attempt id (admitted attempts are finished before resolve)", () => {
    // Production shape: createSend finishes the attempt on confirmed custody;
    // the drainer's resolve-conflict arrives AFTER the record is gone.
    expect(getSendAction("att-server-echoed")).toBeUndefined();
    markSendAttemptResolveConflict("att-server-echoed", "s-live", "server holds sent for item q2");
    const got = getSendAction("att-server-echoed")!;
    expect(got.stage).toBe("conflict");
    expect(got.certainty).toBe("definitive");
    expect(got.recovery).toBe("check");
    expect(got.ownerKey).toBe("s-live");
    expect(sendActionsFor("s-live").map((x) => x.attemptId)).toContain("att-server-echoed");
  });
});

// ---------------------------------------------------------------------------
// A1 create-linkage (send-defers study) — the create-attempt window on
// create-outcome-unknown records, and the timing-window candidate matcher the
// draft-view affordance consumes.
// ---------------------------------------------------------------------------
describe("sendActionStatus — A1 create-attempt window recording", () => {
  it("markOwnerSessionCreateUnknown records the [start, end] window when handed the POST-armed timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const a = mintSendAttempt("draft");
    vi.setSystemTime(10_500); // the unknown lands 500ms after the POST fired
    markOwnerSessionCreateUnknown("draft", "session create timed out", 10_000);
    const got = getSendAction(a.attemptId)!;
    expect(got.stage).toBe("uncertain");
    expect(got.recovery).toBe("check");
    expect(got.createAttempt).toEqual({ start: 10_000, end: 10_500 });
    vi.useRealTimers();
  });

  it("legacy call shape (no timestamp) still marks uncertain — with NO window", () => {
    const a = mintSendAttempt("draft");
    markOwnerSessionCreateUnknown("draft", "x");
    const got = getSendAction(a.attemptId)!;
    expect(got.stage).toBe("uncertain");
    expect(got.createAttempt).toBeFalsy();
  });
});

describe("sendActionStatus — A1 createLinkCandidates (timing-window correlation)", () => {
  it("matches sessions created inside the window ± skew; refuses out-of-window, time-less, and window-less sources", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    mintSendAttempt("draft");
    vi.setSystemTime(2_000);
    markOwnerSessionCreateUnknown("draft", "timeout", 1_000); // window [1000, 2000]
    const records = () => sendActionsFor("draft");

    const sessions = [
      { id: "in-win", title: "New session", time: { created: 1_500 } },
      { id: "skew-early", title: "New session", time: { created: 1_000 - CREATE_LINK_CLOCK_SKEW_MS + 1 } },
      { id: "skew-late", title: "New session", time: { created: 2_000 + CREATE_LINK_CLOCK_SKEW_MS - 1 } },
      { id: "too-early", title: "New session", time: { created: 1_000 - CREATE_LINK_CLOCK_SKEW_MS - 1 } },
      { id: "too-late", title: "New session", time: { created: 2_000 + CREATE_LINK_CLOCK_SKEW_MS + 1 } },
      { id: "no-time", title: "New session" },
    ];
    // Default generous skew: both skew-edge sessions are candidates; the
    // out-of-window and time-less ones are not. Newest created first.
    expect(createLinkCandidates(sessions, records()).map((c) => c.id)).toEqual([
      "skew-late",
      "in-win",
      "skew-early",
    ]);
    // The skew margin is a parameter — tests (and only tests) tighten it.
    expect(createLinkCandidates(sessions, records(), 0).map((c) => c.id)).toEqual(["in-win"]);
    vi.useRealTimers();
  });

  it("a session matching SEVERAL draft-unknown windows is listed once (newest-created ordering kept)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    mintSendAttempt("draft");
    vi.setSystemTime(1_200);
    markOwnerSessionCreateUnknown("draft", "timeout one", 1_000);
    vi.setSystemTime(2_000);
    const b = mintSendAttempt("draft"); // supersedes nothing (uncertain exempt)
    void b;
    vi.setSystemTime(2_500);
    markOwnerSessionCreateUnknown("draft", "timeout two", 2_000); // window [2000, 2500]
    const out = createLinkCandidates(
      [
        { id: "both", title: "New session", time: { created: 2_100 } }, // inside BOTH windows
        { id: "other", title: "Elsewhere", time: { created: 9_999_999 } }, // inside neither
      ],
      sendActionsFor("draft"),
    );
    expect(out.map((c) => c.id)).toEqual(["both"]);
    vi.useRealTimers();
  });

  it("considers only uncertain/check records — an enqueue-uncertain (retry-same) record is not a create-link source", () => {
    const a = mintSendAttempt("draft");
    updateSendAction(a.attemptId, { stage: "uncertain", recovery: "retry-same", payload: payload("x") });
    expect(createLinkCandidates([{ id: "s", title: "New session", time: { created: Date.now() } }], sendActionsFor("draft"))).toEqual([]);
  });

  it("a DISMISSED create-unknown record yields no candidates (the affordance dies with the row)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const a = mintSendAttempt("draft");
    vi.setSystemTime(2_000);
    markOwnerSessionCreateUnknown("draft", "timeout", 1_000);
    const sessions = [{ id: "in-win", title: "New session", time: { created: 1_500 } }];
    expect(createLinkCandidates(sessions, sendActionsFor("draft")).map((c) => c.id)).toEqual(["in-win"]);
    finishSendAttempt(a.attemptId);
    expect(createLinkCandidates(sessions, sendActionsFor("draft"))).toEqual([]);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// A2 (send-defers study) — transferOwnerSendAttempts is a STAGE-AGNOSTIC owner
// sweep with no direct unit coverage. This locks the contract.
// ---------------------------------------------------------------------------
describe("sendActionStatus — transferOwnerSendAttempts stage-agnostic owner sweep (A2)", () => {
  it("re-keys EVERY draft-owned record regardless of stage: ids preserved, stages untouched, updatedAt bumped, count returned", () => {
    // UNREACHABILITY NOTE (send-defers study §A2, mint-site trace —
    // tmp/agent-runs/send-defers-study/report.md): draft-owned conflict/unsaved
    // records CANNOT occur via any current call path. Every mint/patch site
    // that sets those stages runs under a LIVE session id: queue.ts's resolve
    // paths (queue items exist only for live sessions), SendStatus's
    // retry-save button (renders only for a non-draft owner), the drainer
    // (canDrain excludes drafts), and createSend's admission classification
    // (runs only AFTER the draft→live transfer). This test LOCKS the sweep's
    // stage-agnostic CONTRACT against future mint sites (e.g. a resolve path
    // reachable from a draft context) — it does NOT prove those draft-owned
    // shapes are reachable today. They are not.
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    // Mint the supersede-vulnerable stages one at a time, parking each OFF
    // "draft" so the next mint cannot finish it (mint-supersede clears
    // same-owner preparing/blocked/rejected records). Parking uses the sweep
    // itself (transferOwnerSendAttempts) — the per-attempt transferSendAttempt
    // helper was removed as consumer-free (D2 hygiene).
    const parked: string[] = [];
    for (const stage of ["blocked", "rejected", "uncertain"] as const) {
      const a = mintSendAttempt("draft");
      updateSendAction(
        a.attemptId,
        stage === "uncertain"
          ? { stage, certainty: "unknown", recovery: "check" }
          : { stage, certainty: "definitive", recovery: "restore" },
      );
      expect(transferOwnerSendAttempts("draft", "park")).toBe(1);
      parked.push(a.attemptId);
    }
    // The upsert-shaped mint sites for conflict/unsaved (their REAL mint shape
    // — in production the ownerKey here is always a live session id; "draft"
    // is exactly the unreachable shape this contract lock guards).
    markSendAttemptResolveConflict("att-conflict-draft", "draft", "server holds sent");
    markSendAttemptStatusUnsaved("att-unsaved-draft", "draft", { itemId: "q1", state: "sent", detail: "ok" });
    // The preparing record is minted LAST (a later mint would supersede it).
    const prep = mintSendAttempt("draft");
    // Bring the parked records home.
    expect(transferOwnerSendAttempts("park", "draft")).toBe(3);

    const ids = [prep.attemptId, ...parked, "att-conflict-draft", "att-unsaved-draft"];
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) expect(getSendAction(id)?.ownerKey, `${id} starts draft-owned`).toBe("draft");
    const stagesBefore = ids.map((id) => getSendAction(id)!.stage);
    const updatedAtBefore = ids.map((id) => getSendAction(id)!.updatedAt);

    vi.setSystemTime(5_000); // the sweep's Date.now() must advance past mint time
    const n = transferOwnerSendAttempts("draft", "live-9");

    expect(n).toBe(6);
    expect(sendActionsFor("draft")).toHaveLength(0);
    expect(sendActionsFor("live-9").map((a) => a.attemptId).sort()).toEqual([...ids].sort());
    for (let i = 0; i < ids.length; i++) {
      const got = getSendAction(ids[i])!;
      expect(got.ownerKey, `${ids[i]} re-keyed`).toBe("live-9");
      expect(got.stage, `${ids[i]} stage untouched by the sweep`).toBe(stagesBefore[i]);
      expect(got.updatedAt, `${ids[i]} updatedAt bumped`).toBeGreaterThan(updatedAtBefore[i]);
    }
    vi.useRealTimers();
  });

  it("returns 0 and moves nothing when the source owner holds no records", () => {
    expect(transferOwnerSendAttempts("draft", "live-9")).toBe(0);
  });
});

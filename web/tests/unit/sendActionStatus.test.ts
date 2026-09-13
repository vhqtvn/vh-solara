// Send-reliability slice 2 — sendActionStatus store unit tests (node env:
// solid-js/store only, no DOM).
import { afterEach, describe, expect, it } from "vitest";
import {
  __resetSendActionStatusForTests,
  finishSendAttempt,
  findReusableSendAttempt,
  getSendAction,
  markOwnerSessionCreateUnknown,
  markSendAttemptResolveConflict,
  mintSendAttempt,
  sendActionsFor,
  transferSendAttempt,
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

  it("transferSendAttempt moves the record to the live owner (draft→live)", () => {
    const a = mintSendAttempt("draft");
    transferSendAttempt(a.attemptId, "live-1");
    expect(getSendAction(a.attemptId)?.ownerKey).toBe("live-1");
    expect(sendActionsFor("draft")).toHaveLength(0);
    expect(sendActionsFor("live-1")).toHaveLength(1);
    // transfer of an unknown/finished id is a no-op (no throw)
    transferSendAttempt("att-does-not-exist", "live-1");
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
  it("marks a retained attempt conflict/definitive/check", () => {
    const a = mintSendAttempt("s1");
    updateSendAction(a.attemptId, { stage: "admitting" });
    markSendAttemptResolveConflict(a.attemptId, "s1", "server holds sent for item q1");
    const got = getSendAction(a.attemptId)!;
    expect(got.stage).toBe("conflict");
    expect(got.certainty).toBe("definitive");
    expect(got.recovery).toBe("check");
    expect(got.detail).toBe("server holds sent for item q1");
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

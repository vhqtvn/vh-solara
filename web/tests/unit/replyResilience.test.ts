// @vitest-environment jsdom
//
// Reply resilience (send-net-resilience slice 4a) — the human reply path
// through the daemon verbs, at the sync/actions seam.
//
// The contract under test (debate-2 Q1, CLOSE-NOW):
//   - respondPermission/respondQuestion POST the DAEMON verbs
//     (/vh/reply-permission, /vh/answer-question) with an idempotency key —
//     NOT the bare /oc passthrough. The daemon owns canonical→legacy fallback
//     (pkg/opencode/client.go) and maps upstream "not pending" 404 → 410.
//   - A reply NEVER optimistically destroys the card. The permission card is
//     deleted only AFTER a confirmed 2xx; the question card is left to the
//     server's question.delete event (as before).
//   - timeout / network / 5xx / 409 → outcome-unknown: the card stays, an
//     honest notification fires (never a "failed" claim — the reply may have
//     been applied).
//   - 410 (and a defensive bare 404) → gone: the request is no longer pending
//     upstream; the outcome was NOT confirmed and must never look like
//     success. No notification — the card's terminal state is the surface.
//   - other 4xx → rejected: a definitive non-apply; the card stays actionable
//     (the request is still pending) and an error notification fires.
//   - Retry safety: each ATTEMPT mints a fresh idempotency key (upstream is
//     single-shot, so a fresh key cannot double-apply; the same key would
//     forever replay the 502 the FE abort cached server-side).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import {
  dismissPermission,
  dismissQuestion,
  respondPermission,
  respondQuestion,
} from "../../src/sync/actions";
import { state, setState } from "../../src/sync/store";
import { clearNotifications, notifications } from "../../src/notify";

// Minimal Response shape postBounded reads (res.ok / res.status — no body).
function statusResponse(status: number): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

// A fetch mock that hangs until the caller aborts (mirrors native fetch).
function hangingFetch() {
  return vi.fn((_url: string, init?: any) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  );
}

// Body of the Nth POST, parsed — for asserting the verb payload shape.
function postedBody(fetchMock: ReturnType<typeof vi.fn>, call = 0): any {
  return JSON.parse(fetchMock.mock.calls[call][1].body);
}

beforeEach(() => {
  clearNotifications();
  setState("permissions", reconcile({}));
  setState("questions", reconcile({}));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("respondPermission — daemon verb routing", () => {
  it("POSTs /vh/reply-permission with {permissionID, sessionID, reply, idempotency_key}", async () => {
    setState("permissions", "s1", { p1: { id: "p1" } as any });
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(200)));
    vi.stubGlobal("fetch", fetchMock);
    const out = await respondPermission("s1", "p1", "once");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/vh/reply-permission");
    expect(init.method).toBe("POST");
    expect(postedBody(fetchMock)).toEqual({
      permissionID: "p1",
      sessionID: "s1",
      reply: "once",
      idempotency_key: expect.any(String),
    });
    expect(postedBody(fetchMock).idempotency_key.length).toBeGreaterThan(8);
    expect(out).toEqual({ kind: "confirmed" });
  });

  it("mints a FRESH idempotency key per attempt (retry must not replay the abort-cached 502)", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(410)));
    vi.stubGlobal("fetch", fetchMock);
    await respondPermission("s1", "p1", "once");
    await respondPermission("s1", "p1", "once"); // the Retry tap
    const k1 = postedBody(fetchMock, 0).idempotency_key;
    const k2 = postedBody(fetchMock, 1).idempotency_key;
    expect(k2).not.toBe(k1);
  });

  it("confirmed 2xx: card deleted only AFTER the response (never optimistically)", async () => {
    setState("permissions", "s1", { p1: { id: "p1" } as any });
    let release!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((res) => (release = res))),
    );
    const p = respondPermission("s1", "p1", "always");
    // Give the microtask queue a few ticks — the card must SURVIVE the flight.
    await new Promise((r) => setTimeout(r, 5));
    expect(state.permissions["s1"]?.["p1"]).toBeTruthy();
    release(statusResponse(200));
    expect(await p).toEqual({ kind: "confirmed" });
    expect(state.permissions["s1"]?.["p1"]).toBeUndefined();
    expect(notifications.items).toHaveLength(0);
  });
});

describe("respondPermission — failure shapes keep the card", () => {
  it("TIMEOUT: outcome unknown, card STAYS, honest notification (retry-safe wording, no 'failed')", async () => {
    setState("permissions", "s1", { p1: { id: "p1" } as any });
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const p = respondPermission("s1", "p1", "once");
      await vi.advanceTimersByTimeAsync(9999);
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toEqual({ kind: "unknown", detail: expect.any(String) });
      // Exactly ONE POST — no legacy fallback hop from the FE.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // THE dead-end fix: the card is NOT destroyed while unconfirmed.
      expect(state.permissions["s1"]?.["p1"]).toBeTruthy();
      expect(notifications.items).toHaveLength(1);
      const n = notifications.items[0];
      expect(n.kind).toBe("error");
      expect(n.sessionID).toBe("s1");
      expect(n.title).toBe("Permission reply not confirmed");
      expect(n.detail).toContain("may still have been applied");
      expect(n.detail).toContain("Retry");
      expect(n.title + n.detail).not.toContain("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("NETWORK error: outcome unknown, card stays, notification", async () => {
    // Distinct session id from the timeout cell above: pushNotification
    // dedupes identical (kind, sessionID, title) keys within 4 REAL seconds,
    // and these tests run faster than that window.
    setState("permissions", "s2", { p1: { id: "p1" } as any });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const out = await respondPermission("s2", "p1", "once");
    expect(out.kind).toBe("unknown");
    expect(state.permissions["s2"]?.["p1"]).toBeTruthy();
    expect(notifications.items).toHaveLength(1);
  });

  it("410 GONE: outcome gone, card stays, NO notification (card terminal is the surface)", async () => {
    setState("permissions", "s1", { p1: { id: "p1" } as any });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(410))));
    const out = await respondPermission("s1", "p1", "once");
    expect(out).toEqual({ kind: "gone" });
    expect(state.permissions["s1"]?.["p1"]).toBeTruthy();
    expect(notifications.items).toHaveLength(0);
  });

  it("bare 404 from the verb is treated as gone too (defensive: pre-goneOn404 daemons)", async () => {
    setState("permissions", "s1", { p1: { id: "p1" } as any });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(404))));
    const out = await respondPermission("s1", "p1", "once");
    expect(out).toEqual({ kind: "gone" });
    expect(state.permissions["s1"]?.["p1"]).toBeTruthy();
  });

  it("409 in-flight duplicate: outcome unknown, card stays", async () => {
    setState("permissions", "s1", { p1: { id: "p1" } as any });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(409))));
    const out = await respondPermission("s1", "p1", "once");
    expect(out.kind).toBe("unknown");
    expect(state.permissions["s1"]?.["p1"]).toBeTruthy();
  });

  it("502 (daemon→upstream transport): outcome unknown, card stays, notification", async () => {
    // Distinct session id again — same dedup-window rationale as the network cell.
    setState("permissions", "s3", { p1: { id: "p1" } as any });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(502))));
    const out = await respondPermission("s3", "p1", "once");
    expect(out.kind).toBe("unknown");
    expect(state.permissions["s3"]?.["p1"]).toBeTruthy();
    expect(notifications.items).toHaveLength(1);
  });

  it("other 4xx (definitive non-apply): outcome rejected, card stays actionable, error notification", async () => {
    setState("permissions", "s1", { p1: { id: "p1" } as any });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(400))));
    const out = await respondPermission("s1", "p1", "once");
    expect(out).toEqual({ kind: "rejected", status: 400 });
    expect(state.permissions["s1"]?.["p1"]).toBeTruthy();
    expect(notifications.items).toHaveLength(1);
    const n = notifications.items[0];
    expect(n.kind).toBe("error");
    expect(n.title + n.detail).not.toContain("confirmed");
  });
});

describe("respondQuestion — daemon verb routing", () => {
  it("POSTs /vh/answer-question with {questionID, answers, idempotency_key}", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(200)));
    vi.stubGlobal("fetch", fetchMock);
    const out = await respondQuestion("q1", [["Refactor"]], "s1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/vh/answer-question");
    expect(postedBody(fetchMock)).toEqual({
      questionID: "q1",
      answers: [["Refactor"]],
      idempotency_key: expect.any(String),
    });
    expect(out).toEqual({ kind: "confirmed" });
  });

  it("confirmed 2xx does NOT delete the question card (the server's question.delete event owns it)", async () => {
    setState("questions", "s1", { q1: { id: "q1" } as any });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200))));
    await respondQuestion("q1", [["Rewrite"]], "s1");
    expect(state.questions["s1"]?.["q1"]).toBeTruthy();
  });

  it("TIMEOUT: outcome unknown, session-scoped notification with retry wording", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    vi.useFakeTimers();
    try {
      const p = respondQuestion("q1", [["yes"]], "s1");
      await vi.advanceTimersByTimeAsync(10000);
      await expect(p).resolves.toEqual({ kind: "unknown", detail: expect.any(String) });
      const n = notifications.items[0];
      expect(n.title).toBe("Question reply not confirmed");
      expect(n.sessionID).toBe("s1");
      expect(n.detail).toContain("may still have been applied");
      expect(n.title + n.detail).not.toContain("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("410: gone — question stays, no success claim, no notification", async () => {
    setState("questions", "s1", { q1: { id: "q1" } as any });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(410))));
    const out = await respondQuestion("q1", [["yes"]], "s1");
    expect(out).toEqual({ kind: "gone" });
    expect(state.questions["s1"]?.["q1"]).toBeTruthy();
    expect(notifications.items).toHaveLength(0);
  });
});

describe("dismiss helpers — gone-terminal cleanup", () => {
  it("dismissPermission removes the card from the store", () => {
    setState("permissions", "s1", { p1: { id: "p1" } as any });
    dismissPermission("s1", "p1");
    expect(state.permissions["s1"]?.["p1"]).toBeUndefined();
  });

  it("dismissQuestion removes the card from the store", () => {
    setState("questions", "s1", { q1: { id: "q1" } as any });
    dismissQuestion("s1", "q1");
    expect(state.questions["s1"]?.["q1"]).toBeUndefined();
  });
});

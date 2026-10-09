// @vitest-environment jsdom
//
// Fork FE guard (send-net-resilience slice 4c, DEC-A8 "guard only") — the
// honesty path for a non-idempotent, no-caller-id upstream mutation
// (research-packet-2 §A3/B7: a retried fork = a full duplicate session
// "(fork #N)"; the FE action used to be an UNBOUNDED fetch with a silent
// no-op on failure).
//
// The crux contract under test:
//   - SINGLE-FLIGHT: a second fork gesture while one POST is in flight is a
//     no-op (exactly ONE POST);
//   - BOUND: a hung socket settles at FORK_TIMEOUT_MS (15s) via abort;
//   - HONEST OUTCOME-UNKNOWN: timeout / network / 5xx / 2xx-without-id all
//     surface the outcome-unknown notification carrying the inspect-tree
//     guidance ("a retry may create a duplicate session that cannot be
//     automatically cancelled") — never a "failed" claim;
//   - NEVER AUTO-RETRY: after the outcome, no further POST fires;
//   - DEFINITIVE 4xx: honest "not created" wording WITHOUT the duplicate
//     warning (no manufactured ambiguity);
//   - SUCCESS: the pre-guard behavior is unchanged (select + open, silent).
//
// Test hygiene: notify.ts dedupes (kind:sessionID:title) within a 4s REAL
// window and exposes no reset — every test uses its OWN sessionId so the
// dedup key differs and each notification lands.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageActions } from "../../src/components/chat/createMessageActions";
import { selectedId, setSelectedIdRaw } from "../../src/sync/store";
import { clearNotifications, notifications } from "../../src/notify";

// Minimal Response shapes fork() reads (res.ok / res.status / res.json).
function statusResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

// A fetch mock that hangs until the caller aborts (mirrors native fetch —
// the abort-listener pattern from syncActionsReplyTimeout.test.ts).
function hangingFetch() {
  return vi.fn((_url: string, init?: any) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  );
}

// Per-test unique session id (see the hygiene note in the header).
let sid = "";
const makeActions = () =>
  createMessageActions({
    sessionId: () => sid,
    resendText: vi.fn(async () => true),
  });

beforeEach(() => {
  clearNotifications();
  setSelectedIdRaw(null);
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllTimers();
});

describe("fork guard — timeout (the crux honesty path)", () => {
  it("HUNG fork POST: settles at 15s, ONE POST, outcome-unknown + inspect-tree guidance, NEVER auto-retries", async () => {
    sid = "s-timeout";
    const actions = makeActions();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const p = actions.fork("m1");
      // Pre-bound: nothing settled yet, no notification.
      await vi.advanceTimersByTimeAsync(14999);
      expect(notifications.items).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await p;

      // Exactly ONE POST, to the /oc fork route, carrying the messageID.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("/oc/session/s-timeout/fork");
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ messageID: "m1" });
      // The POST was armed with an AbortController signal (the FE bound is
      // the ONLY bound — the /oc reverse proxy has no total timeout).
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

      // The honest outcome-unknown surface, scoped to the session.
      expect(notifications.items).toHaveLength(1);
      const n = notifications.items[0];
      expect(n.kind).toBe("error");
      expect(n.sessionID).toBe("s-timeout");
      expect(n.title).toBe("Fork outcome unknown");
      expect(n.detail).toContain("may still have been created");
      expect(n.detail).toContain("Inspect the session tree before retrying");
      expect(n.detail).toContain("duplicate session");
      expect(n.detail).toContain("cannot be automatically cancelled");
      expect(n.detail).toContain("no confirmation within 15s");
      // Honesty discipline (replyOutcomeUnknown pattern): never a "failed"
      // claim for an outcome-unknown, and never a false "not created".
      expect(n.title + n.detail).not.toContain("not created");
      expect(n.title + n.detail).not.toContain("failed");

      // NEVER auto-retry: nothing further fires after the outcome.
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The guard RELEASED: a manual retry gesture is possible again (it is
      // always the operator's decision, never ours). Do NOT await the call
      // before advancing — the promise settles only at the fake 15s mark.
      const p2 = actions.fork("m1");
      await vi.advanceTimersByTimeAsync(15000);
      await p2;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fork guard — single-flight (no double-fire)", () => {
  it("a second fork gesture while one POST is in flight is a no-op (ONE POST)", async () => {
    sid = "s-single";
    const actions = makeActions();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const p1 = actions.fork("m1");
      const p2 = actions.fork("m1"); // double-tap racing the in-flight POST
      await p2;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15000);
      await p1;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(notifications.items).toHaveLength(1); // one outcome surface, not two
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fork guard — failure classes", () => {
  it("network error: outcome unknown with the inspect-tree guidance", async () => {
    sid = "s-net";
    const actions = makeActions();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    await actions.fork("m1");
    expect(notifications.items).toHaveLength(1);
    const n = notifications.items[0];
    expect(n.title).toBe("Fork outcome unknown");
    expect(n.detail).toContain("Inspect the session tree before retrying");
    expect(n.detail).toContain("request failed");
  });

  it("5xx (proxy 502 transport failure): outcome unknown (the POST may have been applied)", async () => {
    sid = "s-5xx";
    const actions = makeActions();
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(502)));
    vi.stubGlobal("fetch", fetchMock);
    await actions.fork("m1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(notifications.items).toHaveLength(1);
    const n = notifications.items[0];
    expect(n.title).toBe("Fork outcome unknown");
    expect(n.detail).toContain("HTTP 502");
    expect(n.detail).toContain("Inspect the session tree");
  });

  it("2xx whose body carries no session id: outcome unknown (not a silent no-op)", async () => {
    sid = "s-noid";
    const actions = makeActions();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, {}))));
    await actions.fork("m1");
    expect(notifications.items).toHaveLength(1);
    const n = notifications.items[0];
    expect(n.title).toBe("Fork outcome unknown");
    expect(n.detail).toContain("response carried no session id");
    // The OLD behavior was a silent no-op — pinned here as gone.
    expect(n.detail).toContain("Inspect the session tree");
  });

  it("definitive 4xx: honest not-created wording WITHOUT the duplicate warning", async () => {
    sid = "s-4xx";
    const actions = makeActions();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(404))));
    await actions.fork("m1");
    expect(notifications.items).toHaveLength(1);
    const n = notifications.items[0];
    expect(n.title).toBe("Fork not created");
    expect(n.detail).toContain("HTTP 404");
    expect(n.detail).toContain("no fork was created");
    // No manufactured ambiguity: a 404 IS a definitive answer.
    expect(n.title + n.detail).not.toContain("Inspect the session tree");
    expect(n.title + n.detail).not.toContain("may still have been created");
  });
});

describe("fork guard — success path unchanged", () => {
  it("2xx with id: selects and opens the fork, silent (pre-guard behavior)", async () => {
    sid = "s-ok";
    const actions = makeActions();
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(200, { id: "ses_fork1" })));
    vi.stubGlobal("fetch", fetchMock);
    await actions.fork("m1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(selectedId()).toBe("ses_fork1");
    expect(notifications.items).toHaveLength(0);
  });
});

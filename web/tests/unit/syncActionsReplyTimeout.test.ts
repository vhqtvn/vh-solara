// @vitest-environment jsdom
//
// Bounded permission/question/abort POSTs (send-reliability hygiene
// micro-slice, §8 item 6b) — the hung-socket cells for sync/actions.
//
// Rewritten in send-net-resilience slice 4a for the daemon-verb contract:
//   - the human replies now POST the DAEMON verbs (/vh/reply-permission,
//     /vh/answer-question) — the canonical→legacy upstream fallback moved
//     INTO the daemon (pkg/opencode/client.go), so the FE fires exactly ONE
//     POST per attempt and never hops to a legacy /oc route (a second reply
//     for the same request would only double the ambiguity — upstream is
//     single-shot, so it can never double-apply, but it also can't help);
//   - a hung socket settles at 10s (fake timers + the abort-listener hang
//     mock, mirroring queue.test.ts's landed pattern) to an OUTCOME-UNKNOWN
//     result: honest notification, never a "failed" claim, and the CARD
//     STAYS (slice 4a's core fix — the card used to be optimistically
//     cleared, which made manual re-reply structurally impossible);
//   - /vh/abort stays warn-only (no notification) — the optimistic idle is
//     already applied, so the timeout is benign.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import { abortSession, respondPermission, respondQuestion } from "../../src/sync/actions";
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

beforeEach(() => {
  clearNotifications();
  setState("permissions", reconcile({}));
  setState("questions", reconcile({}));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("respondPermission — bounded daemon verb", () => {
  it("HUNG verb reply: settles at the bound, ONE POST, card STAYS, outcome-unknown notification", async () => {
    setState("permissions", "s1", { p1: { id: "p1" } as any });
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const p = respondPermission("s1", "p1", "once");
      await vi.advanceTimersByTimeAsync(9999);
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toEqual({ kind: "unknown", detail: "timeout" });
      // Exactly ONE POST: the FE never re-answers on another route — the
      // daemon owns the canonical→legacy fallback, and a second reply for
      // the same request could only double the ambiguity.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("/vh/reply-permission");
      // Slice 4a's core fix: an unconfirmed reply KEEPS the card (it used to
      // be optimistically cleared, making manual re-reply impossible).
      expect(state.permissions["s1"]?.["p1"]).toBeTruthy();
      // Honest surface: outcome-unknown wording, scoped to the session, with
      // the retry-safety note — and explicitly NOT a "failed" claim.
      expect(notifications.items).toHaveLength(1);
      const n = notifications.items[0];
      expect(n.kind).toBe("error");
      expect(n.sessionID).toBe("s1");
      expect(n.title).toBe("Permission reply not confirmed");
      expect(n.detail).toContain("may still have been applied");
      expect(n.title + n.detail).not.toContain("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("definitive non-2xx (410) fires NO second POST — no FE legacy hop", async () => {
    setState("permissions", "s2", { p1: { id: "p1" } as any });
    const fetchMock = vi.fn(() => Promise.resolve(statusResponse(410)));
    vi.stubGlobal("fetch", fetchMock);
    const out = await respondPermission("s2", "p1", "once");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ kind: "gone" });
    // Gone is the card-terminal surface — no notification, no card removal.
    expect(notifications.items).toHaveLength(0);
    expect(state.permissions["s2"]?.["p1"]).toBeTruthy();
  });

  it("network error: single POST, outcome unknown, card stays (no legacy route)", async () => {
    setState("permissions", "s3", { p1: { id: "p1" } as any });
    const fetchMock = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetchMock);
    const out = await respondPermission("s3", "p1", "once");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.kind).toBe("unknown");
    expect(state.permissions["s3"]?.["p1"]).toBeTruthy();
    expect(notifications.items).toHaveLength(1);
  });
});

describe("respondQuestion — bounded daemon verb", () => {
  it("HUNG question reply: outcome-unknown notification (no 'failed' claim)", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const p = respondQuestion("q1", [["yes"]]);
      await vi.advanceTimersByTimeAsync(10000);
      await expect(p).resolves.toEqual({ kind: "unknown", detail: "timeout" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("/vh/answer-question");
      expect(notifications.items).toHaveLength(1);
      const n = notifications.items[0];
      expect(n.title).toBe("Question reply not confirmed");
      expect(n.detail).toContain("may still have been applied");
      expect(n.title + n.detail).not.toContain("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("definitive non-2xx stays log-only unless it is a failure class with a surface (410 → gone, no notification)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(410))));
    const out = await respondQuestion("q1", [["no"]]);
    expect(out).toEqual({ kind: "gone" });
    expect(notifications.items).toHaveLength(0);
  });
});

describe("abortSession — bounded /vh/abort (benign, warn-only)", () => {
  it("HUNG abort POST settles without throwing and surfaces NO notification", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const p = abortSession("s1");
      await vi.advanceTimersByTimeAsync(10000);
      await expect(p).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("/vh/abort");
      // The optimistic idle is applied synchronously — the timeout adds no UI.
      expect(notifications.items).toHaveLength(0);
      expect(state.activity["s1"]).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });
});

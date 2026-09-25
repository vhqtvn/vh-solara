// @vitest-environment jsdom
//
// Bounded permission/question/abort POSTs (send-reliability hygiene
// micro-slice, §8 item 6b) — the hung-socket cells for sync/actions.
//
// Pre-bound, a hung canonical permission reply left the legacy fallback
// unreachable and the reply silently never landed while the card was already
// optimistically cleared (turn stuck pending input). The bounds must:
//   - settle at 10s (fake timers + the abort-listener hang mock, mirroring
//     queue.test.ts's landed pattern);
//   - surface an OUTCOME-UNKNOWN notification for a timed-out reply (the POST
//     may have been applied) — never a "failed" claim, never a card restore
//     (a restored card invites a second reply for an answered request);
//   - NOT fire the legacy route after a canonical TIMEOUT (a second reply
//     doubles the ambiguity) while PRESERVING the legacy fallback for a
//     definitive non-2xx (old servers) and a network error;
//   - keep /vh/abort warn-only (no notification) — the optimistic idle is
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

describe("respondPermission — bounded canonical + legacy routes", () => {
  it("HUNG canonical reply: no legacy fallback, outcome-unknown notification, card NOT restored", async () => {
    setState("permissions", "s1", { p1: { id: "p1" } as any });
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const p = respondPermission("s1", "p1", "once");
      await vi.advanceTimersByTimeAsync(9999);
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toBeUndefined();
      // Exactly ONE POST: the timed-out canonical reply must NOT be retried on
      // the legacy route (the reply may have landed — a second one doubles
      // the ambiguity).
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("/oc/permission/p1/reply");
      // The card stays cleared — a restore would invite a second answer.
      expect(state.permissions["s1"]?.["p1"]).toBeUndefined();
      // Honest surface: outcome-unknown wording, scoped to the session, and
      // explicitly NOT a "failed" claim.
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

  it("canonical 404 (old server) still falls back to the legacy route — no notification on success", async () => {
    const fetchMock = vi.fn((url: string) =>
      url === "/oc/permission/p1/reply"
        ? Promise.resolve(statusResponse(404))
        : Promise.resolve(statusResponse(200)),
    );
    vi.stubGlobal("fetch", fetchMock);
    await respondPermission("s1", "p1", "always");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/oc/session/s1/permissions/p1");
    expect(notifications.items).toHaveLength(0);
  });

  it("canonical NETWORK error still falls back to the legacy route (pre-bound behavior preserved)", async () => {
    const fetchMock = vi.fn((url: string) =>
      url === "/oc/permission/p1/reply"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(statusResponse(200)),
    );
    vi.stubGlobal("fetch", fetchMock);
    await respondPermission("s1", "p1", "reject");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(notifications.items).toHaveLength(0);
  });

  it("HUNG legacy reply (canonical 404 first): outcome-unknown notification, exactly two POSTs", async () => {
    // Distinct session id from the canonical-hang cell above: pushNotification
    // dedupes identical (kind, sessionID, title) keys within 4 REAL seconds,
    // and these tests run faster than that window.
    const hang = hangingFetch();
    const fetchMock = vi.fn((url: string, init?: any) =>
      url === "/oc/permission/p1/reply" ? Promise.resolve(statusResponse(404)) : hang(url, init),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const p = respondPermission("s2", "p1", "once");
      await vi.advanceTimersByTimeAsync(10000);
      await expect(p).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe("/oc/session/s2/permissions/p1");
      expect(notifications.items).toHaveLength(1);
      expect(notifications.items[0].title).toBe("Permission reply not confirmed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("respondQuestion — bounded reply", () => {
  it("HUNG question reply: outcome-unknown notification (no 'failed' claim)", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const p = respondQuestion("q1", [["yes"]]);
      await vi.advanceTimersByTimeAsync(10000);
      await expect(p).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe("/oc/question/q1/reply");
      expect(notifications.items).toHaveLength(1);
      const n = notifications.items[0];
      expect(n.title).toBe("Question reply not confirmed");
      expect(n.detail).toContain("may still have been applied");
      expect(n.title + n.detail).not.toContain("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("definitive non-2xx stays log-only (no notification) — unchanged behavior", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(500))));
    await respondQuestion("q1", [["no"]]);
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

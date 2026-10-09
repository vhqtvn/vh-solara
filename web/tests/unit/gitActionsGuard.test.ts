// @vitest-environment jsdom
//
// Git commit/push FE guards (send-net-resilience slice 6, debate-2 Q3 — the
// honesty path for the daemon's argv-only, receipt-less git endpoints).
// research-packet-2 §B3: commit retry self-protects ONLY while the index is
// empty (restage between a landed-but-unconfirmed commit and a retry = a
// SECOND distinct commit); push retry is benign ("up-to-date"); the FE post()
// was a bare unbounded fetch whose catch shape read as "failed" — a false
// error for a mutation that may have landed.
//
// The crux contract under test (mirrors createMessageActionsFork.test.ts):
//   - SINGLE-FLIGHT per repo: a second commit gesture while one POST is in
//     flight resolves {outcome:"busy"} (exactly ONE POST); commit and push
//     SHARE the per-repo latch (the risky pair, never concurrent);
//   - PER-REPO: a different project dir has its own latch;
//   - BOUND: a hung commit POST settles at 45s (daemon caps commit at 30s;
//     the FE grace lets the daemon's classified answer win), a hung push at
//     the 630s ceiling above the daemon's default 300s push bound;
//   - HONEST OUTCOME-UNKNOWN: timeout / network / 5xx → {outcome:"uncertain"}
//     (the mutation may have landed) — NEVER a "failed" claim, NEVER
//     auto-retried;
//   - DEFINITIVE 4xx → {outcome:"error"} (the server answered; no mutation
//     happened) — no manufactured ambiguity;
//   - 2xx → {outcome:"ok", output};
//   - LATCH RELEASED in finally: a later manual gesture fires a new POST.
import { afterEach, describe, expect, it, vi } from "vitest";

// projectDir is mutable so the per-repo latch can be proven per-REPO, not
// merely per-module. The factory only closes over the binding (called later,
// inside the tests), so hoisting is safe.
const repoState = { dir: "/repoA" };
vi.mock("../../src/sync", () => ({ projectDir: () => repoState.dir }));

import { gitCommit, gitLog, gitPush, gitStatus } from "../../src/git-actions";

// Minimal Response shapes (res.ok / res.status / res.text / res.json).
function statusResponse(status: number, body?: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body ?? {}),
  } as Response;
}

// A fetch mock whose FIRST call hangs until the caller aborts (mirrors native
// fetch — the abort-listener pattern from createMessageActionsFork.test.ts);
// subsequent calls serve the queued responses in order.
function hangingFetch(...then: Response[]) {
  const queue = [...then];
  let first = true;
  return vi.fn((_url: string, init?: any) => {
    if (first) {
      first = false;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (queue.length) return Promise.resolve(queue.shift()!);
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllTimers();
  repoState.dir = "/repoA";
});

describe("git commit guard — single-flight (no double-fire)", () => {
  it("a second commit gesture while one POST is in flight resolves busy (ONE POST)", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const p1 = gitCommit("m");
    const r2 = await gitCommit("m"); // double-tap racing the in-flight POST
    expect(r2).toEqual({ outcome: "busy" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(45_000);
    await p1;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("commit and push SHARE the per-repo latch (the risky pair is never concurrent)", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const p1 = gitCommit("m");
    const rp = await gitPush();
    expect(rp).toEqual({ outcome: "busy" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(45_000);
    await p1;
  });

  it("per-repo: a different project dir has its own latch", async () => {
    const ok = statusResponse(200, { ok: true, output: "[main abc123] done" });
    const fetchMock = hangingFetch(ok);
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const p1 = gitCommit("m"); // hangs on /repoA
    repoState.dir = "/repoB";
    const r2 = await gitCommit("m"); // /repoB → own latch → fires
    expect(r2).toEqual({ outcome: "ok", output: "[main abc123] done" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    repoState.dir = "/repoA";
    await vi.advanceTimersByTimeAsync(45_000);
    await p1;
  });
});

describe("git commit guard — failure classes", () => {
  it("HUNG commit POST: settles at 45s → uncertain (never a 'failed' claim), ONE POST, never auto-retries, latch released", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const p = gitCommit("m");
      await vi.advanceTimersByTimeAsync(44_999);
      // Pre-bound: nothing settled yet.
      await vi.advanceTimersByTimeAsync(1);
      const r = await p;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The POST was armed with an AbortController signal (the FE bound).
      expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(r.outcome).toBe("uncertain");
      if (r.outcome === "uncertain") {
        expect(r.detail).toContain("no confirmation within 45s");
        expect(r.detail).toContain("commit");
      }
      // NEVER auto-retry: nothing further fires after the outcome.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // Latch RELEASED (finally): a manual retry gesture fires a new POST.
      const p2 = gitCommit("m");
      await vi.advanceTimersByTimeAsync(45_000);
      await p2;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("network error: uncertain — the POST may have been applied", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const r = await gitCommit("m");
    expect(r.outcome).toBe("uncertain");
    if (r.outcome === "uncertain") expect(r.detail).toContain("request failed");
  });

  it("5xx (daemon 502 / bound-kill 504): uncertain, carrying the daemon's own output", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(502, "error: push declined"))));
    const r = await gitCommit("m");
    expect(r.outcome).toBe("uncertain");
    if (r.outcome === "uncertain") {
      expect(r.detail).toContain("HTTP 502");
      expect(r.detail).toContain("push declined");
    }
  });

  it("definitive 4xx: {outcome:'error'} — the server answered, no mutation happened", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(400, "commit message required"))));
    const r = await gitCommit("m");
    expect(r).toEqual({ outcome: "error", error: "commit message required" });
  });

  it("2xx: ok with the daemon's output", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, { ok: true, output: "[main abc] m" }))));
    const r = await gitCommit("m");
    expect(r).toEqual({ outcome: "ok", output: "[main abc] m" });
  });
});

describe("git push guard", () => {
  it("2xx: ok (pre-guard behavior shape)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, { ok: true, output: "" }))));
    const r = await gitPush();
    expect(r.outcome).toBe("ok");
  });

  it("network error: uncertain naming the push", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const r = await gitPush();
    expect(r.outcome).toBe("uncertain");
    if (r.outcome === "uncertain") expect(r.detail).toContain("push");
  });

  it("HUNG push POST: settles at the 630s FE ceiling (above the daemon's 300s push bound) → uncertain", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      const p = gitPush();
      await vi.advanceTimersByTimeAsync(629_999);
      await vi.advanceTimersByTimeAsync(1);
      const r = await p;
      expect(r.outcome).toBe("uncertain");
      if (r.outcome === "uncertain") {
        expect(r.detail).toContain("no confirmation within 630s");
        expect(r.detail).toContain("push");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("single-flight: a commit while a push is in flight resolves busy", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const p1 = gitPush();
    const r2 = await gitCommit("m");
    expect(r2).toEqual({ outcome: "busy" });
    await vi.advanceTimersByTimeAsync(630_000);
    await p1;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("gitLog — the reconciliation read", () => {
  it("GETs /vh/git/log with n + dir and returns the entries", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(statusResponse(200, { commits: [{ hash: "abc1234", subject: "did land", date: "2026-10-09" }] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const entries = await gitLog(5);
    expect(entries).toHaveLength(1);
    expect(entries![0].subject).toBe("did land");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url).toContain("/vh/git/log");
    expect(url).toContain("n=5");
    expect(url).toContain(encodeURIComponent("/repoA"));
  });

  // Read-failure discrimination (review tier1_b-F1/F2): the uncertain-commit
  // ward keys off "BOTH reads succeeded", so a failed read MUST be
  // distinguishable from a genuine result — and gitLog's genuine result
  // includes the empty list (an unborn repo), so [] vs failure needs an
  // explicit discriminator: null. STRICT shape check: only an explicitly
  // present ARRAY is a healthy result — a 200 whose body lacks (or mis-shapes)
  // the commits member is unreadable (null), never a fabricated empty log.
  it("healthy read of an EMPTY log (unborn repo): [] — a genuine result, NOT a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, { commits: [] }))));
    expect(await gitLog(5)).toEqual([]);
  });

  it("200 with a MISSING commits member (schema-malformed body) → null — a read the ward treats as failed", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, {}))));
    expect(await gitLog(5)).toBeNull();
  });

  it("read failure (fetch reject) → null — distinguishable from a healthy empty log", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await gitLog(5)).toBeNull();
  });

  it("non-OK read → null (never fabricated emptiness)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(502, "daemon git kill"))));
    expect(await gitLog(5)).toBeNull();
  });

  // ELEMENT-level strict shape (gate round 4, tier1_b:F1 — contract_drift):
  // the container gate above lets a schema-malformed 200 whose commits ARRAY
  // carries garbage ELEMENTS ({commits:[{}]}, {commits:[{hash:"x"}]}) read
  // as "successful" — reconciliation evidence never actually read. Any
  // malformed element ANYWHERE in the array → the whole read is null
  // (unreadable), same semantics as the container gate: this closes the
  // discriminator theme at the element level (no further layer to peel).
  it("200 with a malformed commits ELEMENT ({commits:[{}]}) → null — unreadable, never a successful read", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, { commits: [{}] }))));
    expect(await gitLog(5)).toBeNull();
  });

  it("200 with a partially-shaped commits ELEMENT ({commits:[{hash:\"x\"}]} missing subject/date) → null", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, { commits: [{ hash: "x" }] }))));
    expect(await gitLog(5)).toBeNull();
  });

  it("a malformed commits ELEMENT after healthy ones → null (EVERY element is gated, position irrelevant)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(statusResponse(200, { commits: [{ hash: "a", subject: "s", date: "d" }, {}, { hash: "b", subject: "s", date: "d" }] })),
      ),
    );
    expect(await gitLog(5)).toBeNull();
  });

  it("healthy element shapes still parse (the element gate admits well-formed rows)", async () => {
    const body = { commits: [{ hash: "abc1234", subject: "did land", date: "2026-10-09" }, { hash: "def5678", subject: "another", date: "2026-10-08" }] };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, body))));
    expect(await gitLog(5)).toEqual(body.commits);
  });
});

// gitStatus's null-on-failure is now LOAD-BEARING the same way (reconcile
// counts only a non-null status read) — pin it so the contract cannot
// silently regress.
describe("gitStatus — null-on-failure is load-bearing", () => {
  it("healthy read returns the status", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, { branch: "main", files: [] }))));
    expect(await gitStatus()).toEqual({ branch: "main", files: [] });
  });

  it("fetch reject → null; non-OK → null — reconcile must not count these", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await gitStatus()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(503, "unavailable"))));
    expect(await gitStatus()).toBeNull();
  });

  // Malformed-200 discrimination (gate-round-2 B-F1/B-F2 — the symmetric
  // hole to gitLog's pins above): reconcile's ward clears on st !== null, so
  // a 200 whose body lacks the STRICT status shape (string branch + array
  // files — the required members of the GitStatus type) MUST read as null
  // (unreadable), never as a "successful" status read. Otherwise a junk body
  // would lift the uncertain-commit ward without a valid reconciliation and
  // a paired restage would put the retained message one click from a
  // duplicate commit.
  it("200 with a schema-malformed body ({}) → null — never a 'successful' status read", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, {}))));
    expect(await gitStatus()).toBeNull();
  });

  it("200 with a wrong-typed branch ({branch: 5}) → null", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, { branch: 5, files: [] }))));
    expect(await gitStatus()).toBeNull();
  });

  it("200 with a non-array files ({files: \"x\"}) → null", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, { branch: "main", files: "x" }))));
    expect(await gitStatus()).toBeNull();
  });

  // ELEMENT-level strict shape (gate round 4, tier1_b:F1 — the symmetric
  // hole to gitLog's element pins): the container gate (string branch +
  // array files) lets a 200 whose files array carries garbage ELEMENTS read
  // as a "successful" status read → the reconcile ward would lift on
  // evidence never actually read → retained message restaged/retried after
  // an unconfirmed commit (the no-blind-retry violation). Any malformed
  // element anywhere in the array → null.
  it("200 with a malformed files ELEMENT ({files:[{}]}) → null — never a 'successful' status read", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, { branch: "main", files: [{}] }))));
    expect(await gitStatus()).toBeNull();
  });

  it("200 with a partially-shaped files ELEMENT ({files:[{file:\"a\"}]} missing index/worktree) → null", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, { branch: "main", files: [{ file: "a" }] }))));
    expect(await gitStatus()).toBeNull();
  });

  it("a malformed files ELEMENT after healthy ones → null (EVERY element is gated)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          statusResponse(200, {
            branch: "main",
            files: [{ file: "a.txt", index: "M", worktree: " " }, { file: "b.txt", index: "?", worktree: "?" }, { index: "M", worktree: " " }],
          }),
        )),
    );
    expect(await gitStatus()).toBeNull();
  });

  it("healthy element shapes still parse (all-string members, multiple rows)", async () => {
    const body = { branch: "main", files: [{ file: "a.txt", index: "M", worktree: " " }, { file: "b.txt", index: "?", worktree: "?" }] };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(statusResponse(200, body))));
    expect(await gitStatus()).toEqual(body);
  });
});

// @vitest-environment jsdom
//
// Create-certainty Slice 2 — the modern /vh/session/create CLIENT lifecycle
// (lib/sessionCreateStatus) unit tests. Pins, per the accepted brief §3.2–3.5:
//   - the capability feature-detect UNCERTAINTY LADDER (modern / legacy via
//     404/405/SPA-shell HTML / uncertain for everything else — and uncertain
//     is never cached);
//   - create-operation identity: one high-entropy key per project dir + draft
//     generation, dir captured at mint, stable across re-taps;
//   - the failure envelope: created / rejected-before-upstream (new key) /
//     unknown (retain key) / in_flight / protocol anomalies;
//   - NEVER re-POST after an ambiguous outcome — re-taps and recovery are
//     receipt-GET-only;
//   - the bounded recovery budget: ≤3 non-overlapping lookups, 3s bounds,
//     0/4/8s schedule inside the 12s window, exhaustion retains state, a
//     manual Check-again gets a fresh budget — and none of it ever POSTs;
//   - the certainty upgrade: a receipt resolution re-keys exactly the
//     operation's draft records (unrelated untouched, finished not
//     resurrected) with no operator confirmation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_SHELL_TITLE_MARK,
  CAPABILITY_TIMEOUT_MS,
  RECOVERY_BACKOFF_MS,
  __resetSessionCreateForTests,
  abandonCreateOp,
  beginDraftGeneration,
  checkCreateOpAgain,
  detectCreateSupport,
  draftResolvedCreateOp,
  getCreateOp,
  isCurrentCreateOp,
  modernCreateSession,
} from "../../src/lib/sessionCreateStatus";
import {
  __resetSendActionStatusForTests,
  finishSendAttempt,
  getSendAction,
  markOwnerSessionCreateRejected,
  markOwnerSessionCreateUnknown,
  mintSendAttempt,
  sendActionsFor,
  stampDraftPreparingCreateOp,
  updateSendAction,
} from "../../src/lib/sendActionStatus";
import { setProjectDirRaw } from "../../src/sync/store";

// ── fetch stub ──────────────────────────────────────────────────────────────

interface StubResp {
  status: number;
  body?: unknown;
  text?: string; // when set, json() throws (malformed) and text() returns it
  contentType?: string;
}

type RouteResult = StubResp | { throw: true };

const CAP_URL = "/vh/session/create/capabilities";
const POST_URL = "/vh/session/create";
const RECEIPT_URL = "/vh/session/create/receipt";

const CAP_MODERN: StubResp = {
  status: 200,
  body: { protocol: "vh-session-create", version: 1, recovery_only: true },
};

/** A protocol receipt envelope at its canonical status (session_create.go). */
function receipt(state: string, extra: Record<string, unknown> = {}): StubResp {
  const status =
    state === "created" ? 200 : state === "unknown" ? 202 : state === "in_flight" ? 409 : state === "unavailable" ? 404 : 400;
  return { status, body: { protocol: "vh-session-create", version: 1, state, ...extra } };
}

function stubFetch(fn: (url: string, init?: RequestInit & { method?: string }) => RouteResult) {
  const calls: { url: string; method: string; body?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: any) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? "GET", body: init?.body });
      const r = await fn(u, init);
      if ("throw" in r) throw new TypeError("fetch failed");
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? r.contentType ?? "application/json" : null) },
        json: async () => {
          if (r.text !== undefined) throw new SyntaxError("Unexpected token in JSON");
          return r.body ?? {};
        },
        text: async () => r.text ?? JSON.stringify(r.body ?? {}),
      };
    }),
  );
  return {
    calls,
    posts: () => calls.filter((c) => c.method === "POST" && c.url.startsWith(POST_URL)),
    gets: () => calls.filter((c) => c.method === "GET" && c.url.startsWith(RECEIPT_URL)),
    postKeys: () =>
      calls
        .filter((c) => c.method === "POST" && c.url.startsWith(POST_URL))
        .map((c) => (c.body ? (JSON.parse(c.body).idempotency_key as string) : "")),
  };
}

/** Capability-modern router with pluggable POST + receipt answers. */
function modernRouter(opts: { post?: () => StubResp; receipt?: () => StubResp } = {}) {
  return (url: string, init?: any): RouteResult => {
    if (url === CAP_URL) return CAP_MODERN;
    if (url.startsWith(POST_URL) && (init?.method ?? "GET") === "POST") return opts.post?.() ?? receipt("created", { sessionID: "ses_m1" });
    if (url.startsWith(RECEIPT_URL)) return opts.receipt?.() ?? receipt("unknown");
    return { status: 404, body: {} };
  };
}

beforeEach(() => {
  __resetSessionCreateForTests();
  __resetSendActionStatusForTests();
  setProjectDirRaw("/proj-cc");
});

afterEach(() => {
  __resetSessionCreateForTests();
  __resetSendActionStatusForTests();
  setProjectDirRaw("");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── capability ladder ───────────────────────────────────────────────────────

describe("detectCreateSupport — the uncertainty ladder", () => {
  it("recognized v1 body ⇒ modern, cached for the page lifetime", async () => {
    const f = stubFetch(() => CAP_MODERN);
    expect(await detectCreateSupport()).toBe("modern");
    expect(await detectCreateSupport()).toBe("modern");
    expect(f.calls).toHaveLength(1); // cached — no re-probe
  });

  it("404 ⇒ legacy (route-unsupported), cached", async () => {
    const f = stubFetch((url) => (url === CAP_URL ? { status: 404, body: {} } : CAP_MODERN));
    expect(await detectCreateSupport()).toBe("legacy");
    expect(await detectCreateSupport()).toBe("legacy");
    expect(f.calls).toHaveLength(1);
  });

  it("405 ⇒ legacy", async () => {
    stubFetch((url) => (url === CAP_URL ? { status: 405, body: {} } : CAP_MODERN));
    expect(await detectCreateSupport()).toBe("legacy");
  });

  it("200 text/html carrying OUR shell signature ⇒ legacy (the SPA-shell fallback branch)", async () => {
    stubFetch((url) =>
      url === CAP_URL
        ? { status: 200, contentType: "text/html; charset=utf-8", text: `<!doctype html><html><head><title>VHSolara</title></head><body><div id="root"></div></body></html>` }
        : CAP_MODERN,
    );
    expect(await detectCreateSupport()).toBe("legacy");
  });

  it("200 text/html with ARBITRARY html ⇒ uncertain (not shell evidence), and NOT cached", async () => {
    const f = stubFetch((url) =>
      url === CAP_URL
        ? { status: 200, contentType: "text/html; charset=utf-8", text: `<html><head><title>Sign in</title></head></html>` }
        : CAP_MODERN,
    );
    expect(await detectCreateSupport()).toBe("uncertain");
    expect(await detectCreateSupport()).toBe("uncertain");
    expect(f.calls).toHaveLength(2); // uncertain re-probes
  });

  it.each([401, 403, 502, 500])("HTTP %i ⇒ uncertain", async (st) => {
    stubFetch((url) => (url === CAP_URL ? { status: st, body: {} } : CAP_MODERN));
    expect(await detectCreateSupport()).toBe("uncertain");
  });

  it("malformed JSON 200 ⇒ uncertain", async () => {
    stubFetch((url) => (url === CAP_URL ? { status: 200, text: "not json{" } : CAP_MODERN));
    expect(await detectCreateSupport()).toBe("uncertain");
  });

  it("wrong protocol/version body ⇒ uncertain (never legacy, never modern)", async () => {
    stubFetch((url) => (url === CAP_URL ? { status: 200, body: { protocol: "vh-session-create", version: 2, recovery_only: true } } : CAP_MODERN));
    expect(await detectCreateSupport()).toBe("uncertain");
  });

  it("network throw ⇒ uncertain", async () => {
    stubFetch(() => ({ throw: true }));
    expect(await detectCreateSupport()).toBe("uncertain");
  });

  it("capability read timeout (5s bound) ⇒ uncertain", async () => {
    // A hung socket: the fetch only settles via the abort signal.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: any) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
        }),
      ),
    );
    vi.useFakeTimers();
    const p = detectCreateSupport();
    await vi.advanceTimersByTimeAsync(CAPABILITY_TIMEOUT_MS);
    expect(await p).toBe("uncertain");
  });
});

// ── operation identity + the modern flow ────────────────────────────────────

describe("modernCreateSession — identity, dir capture, wire shape", () => {
  it("fresh created: POSTs the minted key with ?dir=, returns the id, links the op", async () => {
    const f = stubFetch(modernRouter());
    const out = await modernCreateSession(1000);
    expect(out).toMatchObject({ id: "ses_m1", certainty: "definitive" });
    expect(f.posts()).toHaveLength(1);
    expect(f.posts()[0].url).toBe(`${POST_URL}?dir=${encodeURIComponent("/proj-cc")}`);
    const key = f.postKeys()[0];
    expect(key).toBeTruthy();
    expect(draftResolvedCreateOp()?.sessionId).toBe("ses_m1");
  });

  it("keys are high-entropy and unique per operation", async () => {
    const f = stubFetch(
      modernRouter({
        post: () => receipt("rejected", { error: "validation" }),
      }),
    );
    await modernCreateSession(1000); // rejected → pointer cleared
    await modernCreateSession(1001); // fresh op, new key
    const [k1, k2] = f.postKeys();
    expect(k1).not.toBe(k2);
    expect(k1.length).toBeGreaterThanOrEqual(32); // randomUUID-class entropy
  });

  it("the dir is captured at mint: recovery lookups keep it after a project switch", async () => {
    const f = stubFetch(
      modernRouter({
        post: () => receipt("unknown"),
        receipt: () => receipt("unknown"),
      }),
    );
    const out = await modernCreateSession(1000);
    expect(out.certainty).toBe("unknown");
    setProjectDirRaw("/proj-OTHER");
    await vi.waitFor(() => expect(f.gets().length).toBeGreaterThanOrEqual(1));
    expect(f.gets()[0].url).toContain(`key=${encodeURIComponent(f.postKeys()[0])}`);
    expect(f.gets()[0].url).toContain(`dir=${encodeURIComponent("/proj-cc")}`); // CAPTURED dir
  });
});

describe("modernCreateSession — the failure envelope", () => {
  it("202 unknown ⇒ outcome unknown; the record carries the op id + attempt window", async () => {
    stubFetch(modernRouter({ post: () => receipt("unknown"), receipt: () => receipt("unknown") }));
    const a = mintSendAttempt("draft");
    const out = await modernCreateSession(Date.now());
    expect(out).toMatchObject({ id: null, certainty: "unknown" });
    const rec = getSendAction(a.attemptId)!;
    expect(rec.stage).toBe("uncertain");
    expect(rec.reason).toBe("session-create-unknown");
    expect(rec.createOpId).toBeTruthy();
    expect(rec.createAttempt).toBeDefined();
  });

  it("NEVER re-POSTs after an ambiguous outcome: the re-tap is lookup-only", async () => {
    const f = stubFetch(modernRouter({ post: () => receipt("unknown"), receipt: () => receipt("unknown") }));
    await modernCreateSession(1000);
    expect(f.posts()).toHaveLength(1);
    vi.useFakeTimers();
    const second = modernCreateSession(2000);
    await vi.advanceTimersByTimeAsync(0);
    const out = await second;
    expect(out.certainty).toBe("unknown");
    expect(f.posts()).toHaveLength(1); // STILL one POST total
    expect(f.gets().length).toBeGreaterThanOrEqual(1); // lookup-only reuse
  });

  it("409 in_flight ⇒ unknown + lookup-only (never a second POST)", async () => {
    const f = stubFetch(modernRouter({ post: () => receipt("in_flight", { code: "in_flight" }), receipt: () => receipt("in_flight", { code: "in_flight" }) }));
    const out = await modernCreateSession(1000);
    expect(out.certainty).toBe("unknown");
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(0);
    const out2 = await modernCreateSession(2000);
    expect(out2.certainty).toBe("unknown");
    expect(f.posts()).toHaveLength(1);
  });

  it("proven pre-upstream rejection (400) ⇒ definitive; a corrected attempt mints a NEW key", async () => {
    let n = 0;
    const f = stubFetch(
      modernRouter({
        post: () => (++n === 1 ? receipt("rejected", { error: "unsupported create parameter" }) : receipt("created", { sessionID: "ses_m2" })),
      }),
    );
    const out = await modernCreateSession(1000);
    expect(out).toMatchObject({ id: null, certainty: "definitive" });
    expect(f.posts()).toHaveLength(1);
    // Corrected attempt: a NEW key, and it really executes (created).
    const out2 = await modernCreateSession(2000);
    expect(out2.id).toBe("ses_m2");
    expect(f.postKeys()[0]).not.toBe(f.postKeys()[1]);
  });

  it("identity conflict (409 idempotency_conflict) ⇒ definitive, no execution", async () => {
    stubFetch(modernRouter({ post: () => receipt("rejected", { code: "idempotency_conflict" }) }));
    const out = await modernCreateSession(1000);
    expect(out).toMatchObject({ id: null, certainty: "definitive" });
    expect(out.detail).toContain("different create payload");
  });

  it("network throw on the POST ⇒ unknown (the POST may have been applied)", async () => {
    stubFetch((url, init) => {
      if (url === CAP_URL) return CAP_MODERN;
      if (url.startsWith(POST_URL) && init?.method === "POST") return { throw: true };
      return receipt("unknown");
    });
    const out = await modernCreateSession(1000);
    expect(out).toMatchObject({ id: null, certainty: "unknown" });
  });

  it("malformed 2xx POST body ⇒ unknown (protocol anomaly), never definitive", async () => {
    stubFetch(
      modernRouter({
        post: () => ({ status: 200, text: "<html>proxy page</html>", contentType: "text/html" }),
        receipt: () => receipt("unknown"),
      }),
    );
    const out = await modernCreateSession(1000);
    expect(out.certainty).toBe("unknown");
  });

  it("wrong-version POST envelope ⇒ unknown (never act on a foreign body)", async () => {
    stubFetch(
      modernRouter({
        post: () => ({ status: 200, body: { protocol: "vh-session-create", version: 2, state: "created", sessionID: "ses_x" } }),
        receipt: () => receipt("unknown"),
      }),
    );
    const out = await modernCreateSession(1000);
    expect(out.certainty).toBe("unknown");
    expect(out.id).toBeNull();
  });
});

// ── the bounded recovery budget ─────────────────────────────────────────────

describe("runLookupBudget — ≤3 lookups, 3s bounds, 12s window, never a create", () => {
  it("runs exactly 3 lookups on the 0/4/8s schedule then STOPS (no infinite polling)", async () => {
    const f = stubFetch(modernRouter({ post: () => receipt("unknown"), receipt: () => receipt("unknown") }));
    vi.useFakeTimers();
    const p = modernCreateSession(1000);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    await vi.advanceTimersByTimeAsync(0); // immediate first lookup
    expect(f.gets()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS);
    expect(f.gets()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS);
    expect(f.gets()).toHaveLength(3);
    // Long past the 12s window: nothing more — exhaustion retains state.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.gets()).toHaveLength(3);
    expect(f.posts()).toHaveLength(1); // the ONE execute, ever
  });

  it("resolution mid-budget: the lookup resolves the EXACT id, records follow, probing stops", async () => {
    let n = 0;
    const f = stubFetch(
      modernRouter({
        post: () => receipt("unknown"),
        receipt: () => (++n < 2 ? receipt("unknown") : receipt("created", { sessionID: "ses_exact", replayed: true })),
      }),
    );
    const a = mintSendAttempt("draft");
    vi.useFakeTimers();
    const p = modernCreateSession(1000);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.gets()).toHaveLength(1); // still unknown
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS);
    expect(f.gets()).toHaveLength(2);
    // Resolved: record patched + transferred with NO operator confirmation.
    const rec = getSendAction(a.attemptId)!;
    expect(rec.ownerKey).toBe("ses_exact");
    expect(rec.stage).toBe("rejected");
    expect(rec.reason).toBe("session-create-resolved");
    expect(getCreateOp(rec.createOpId)?.state).toBe("linked");
    expect(draftResolvedCreateOp()?.sessionId).toBe("ses_exact");
    // No further probing after resolution.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.gets()).toHaveLength(2);
  });

  it("exhaustion then explicit Check again ⇒ a FRESH bounded budget, still never a create", async () => {
    const f = stubFetch(modernRouter({ post: () => receipt("unknown"), receipt: () => receipt("unknown") }));
    const a = mintSendAttempt("draft"); // the tap's record (stamped by the flow)
    vi.useFakeTimers();
    const p = modernCreateSession(1000);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS * 2);
    expect(f.gets()).toHaveLength(3); // budget exhausted
    const rec = getSendAction(a.attemptId)!;
    expect(rec.reason).toBe("session-create-unknown");
    checkCreateOpAgain(rec.createOpId!);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.gets()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS * 2);
    expect(f.gets()).toHaveLength(6); // 3 fresh lookups, then stop
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.gets()).toHaveLength(6);
    expect(f.posts()).toHaveLength(1);
  });

  it("a receipt MISS (404 unavailable) stays honestly unresolved — never re-create", async () => {
    const f = stubFetch(modernRouter({ post: () => receipt("unknown"), receipt: () => receipt("unavailable") }));
    const a = mintSendAttempt("draft");
    vi.useFakeTimers();
    const p = modernCreateSession(1000);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS * 2);
    expect(f.gets()).toHaveLength(3);
    expect(f.posts()).toHaveLength(1); // the miss never executes
    const rec = getSendAction(a.attemptId)!;
    expect(rec.stage).toBe("uncertain");
  });

  it("re-tap while the budget's lookup is PENDING piggybacks: zero overlapping GETs, total within the active budget (T1B-F1)", async () => {
    // The receipt GET PARKS until the test releases it — the deliberately
    // pending window the operator re-taps into.
    const releasers: Array<(r: StubResp) => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const f = stubFetch((url, init) => {
      if (url === CAP_URL) return CAP_MODERN;
      if (url.startsWith(POST_URL) && init?.method === "POST") return receipt("unknown");
      // A receipt GET: park it and track overlap.
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<RouteResult>((res) => {
        releasers.push((r: StubResp) => {
          inFlight--;
          res(r);
        });
      });
    });
    vi.useFakeTimers();
    // Tap 1: POST unknown → the budget's first lookup goes out and PENDS.
    const p1 = modernCreateSession(1000);
    await vi.advanceTimersByTimeAsync(0);
    await p1;
    await vi.advanceTimersByTimeAsync(0);
    expect(f.gets()).toHaveLength(1);
    expect(releasers).toHaveLength(1);

    // TWO operator re-taps INTO the pending window. Before the fix each
    // issued its own direct GET (concurrent with the budget's — unbounded
    // extra GETs per re-tap); now both must piggyback on the pending one.
    const t2 = mintSendAttempt("draft");
    const p2 = modernCreateSession(2000);
    const t3 = mintSendAttempt("draft");
    const p3 = modernCreateSession(3000);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.gets()).toHaveLength(1); // ZERO additional GETs from the re-taps

    // Release the pending lookup as still-unknown: the budget proceeds to
    // its backoff and both re-taps return honestly unknown.
    releasers[0](receipt("unknown"));
    await vi.advanceTimersByTimeAsync(0);
    const [out2, out3] = await Promise.all([p2, p3]);
    expect(out2.certainty).toBe("unknown");
    expect(out3.certainty).toBe("unknown");

    // The ONE budget's remaining 0/4/8s schedule runs to exhaustion — the
    // re-taps added nothing to it, before or after their awaits.
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS);
    expect(f.gets()).toHaveLength(2);
    releasers[1](receipt("unknown"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS);
    expect(f.gets()).toHaveLength(3);
    releasers[2](receipt("unknown"));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.gets()).toHaveLength(3); // exactly the budget's three lookups
    expect(maxInFlight).toBe(1); // ZERO overlapping GETs, ever
    expect(f.posts()).toHaveLength(1); // still the ONE execute
    // The surviving re-tap's record (minting t3 finished t2's still-
    // preparing record first — mintSendAttempt's supersede contract) was
    // marked through the module-level mark and carries the operation id.
    expect(getSendAction(t2.attemptId)).toBeUndefined(); // superseded by the t3 mint
    expect(getSendAction(t3.attemptId)!.createOpId).toBeTruthy();
  });
});

// ── certainty upgrade: scoping, linked reuse, abandon, generations ──────────

describe("certainty upgrade — scoped transfer + lifecycle", () => {
  it("transfer is OPERATION-scoped: the op's records move, unrelated drafts untouched, finished not resurrected", async () => {
    // Tap 1 of the REAL operation: its record is stamped + marked by the flow.
    const a1 = mintSendAttempt("draft");
    let lookups = 0;
    stubFetch(
      modernRouter({
        post: () => receipt("unknown"),
        receipt: () => (++lookups < 2 ? receipt("unknown") : receipt("created", { sessionID: "ses_scope" })),
      }),
    );
    vi.useFakeTimers();
    const p1 = modernCreateSession(1000);
    await vi.advanceTimersByTimeAsync(0);
    await p1;
    await vi.advanceTimersByTimeAsync(0); // budget lookup #1: still unknown
    const opId = getSendAction(a1.attemptId)!.createOpId!;
    expect(opId).toBeTruthy();

    // An earlier tap of the SAME operation went unknown too (same op id)…
    const a1b = mintSendAttempt("draft");
    markOwnerSessionCreateUnknown("draft", "op1 first tap unknown", 100, opId);
    // …then got finished (admitted elsewhere) — removed from the store.
    finishSendAttempt(a1b.attemptId);
    // An UNRELATED draft record (no createOpId — another draft's leftover).
    const other = mintSendAttempt("draft");
    updateSendAction(other.attemptId, { stage: "uncertain", recovery: "check" });
    // Another operation's uncertain record.
    const a2 = mintSendAttempt("draft");
    markOwnerSessionCreateUnknown("draft", "op2 unknown", 111, "create-op-OTHER");

    // Budget lookup #2 resolves the REAL operation.
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS);
    expect(lookups).toBe(2);

    expect(getSendAction(a1.attemptId)!.ownerKey).toBe("ses_scope");
    expect(getSendAction(a1.attemptId)!.stage).toBe("rejected"); // resolved presentation
    expect(getSendAction(a1b.attemptId)).toBeUndefined(); // finished stays finished
    expect(getSendAction(other.attemptId)!.ownerKey).toBe("draft"); // unrelated untouched
    expect(getSendAction(a2.attemptId)!.ownerKey).toBe("draft"); // other op untouched
  });

  it("a re-tap of a LINKED operation returns the same id with ZERO new POSTs and carries the new record", async () => {
    const f = stubFetch(modernRouter());
    await modernCreateSession(1000); // created ses_m1
    expect(f.posts()).toHaveLength(1);
    const tap2 = mintSendAttempt("draft");
    const out = await modernCreateSession(2000);
    expect(out).toMatchObject({ id: "ses_m1", certainty: "definitive" });
    expect(f.posts()).toHaveLength(1); // linked reuse never re-POSTs
    expect(getSendAction(tap2.attemptId)!.createOpId).toBeTruthy();
    expect(getSendAction(tap2.attemptId)!.ownerKey).toBe("ses_m1"); // followed via the scoped transfer
  });

  it("re-tap unknown KEEPS the createOpId stamp through ChatView's legacy mark and follows the op's later resolution (T1D-F1)", async () => {
    let lookups = 0;
    const f = stubFetch(
      modernRouter({
        post: () => receipt("unknown"),
        receipt: () => (++lookups < 3 ? receipt("unknown") : receipt("created", { sessionID: "ses_retap", replayed: true })),
      }),
    );
    // Tap 1: unknown; the budget's lookup #1 answered still-unknown.
    const a1 = mintSendAttempt("draft");
    vi.useFakeTimers();
    const p1 = modernCreateSession(1000);
    await vi.advanceTimersByTimeAsync(0);
    await p1;
    await vi.advanceTimersByTimeAsync(0);
    expect(lookups).toBe(1);
    const opId = getSendAction(a1.attemptId)!.createOpId!;
    expect(opId).toBeTruthy();

    // SECOND tap through the unknown re-tap path. The budget is mid-backoff
    // (recoveryActive, no in-flight lookup), so the re-tap returns honestly
    // unknown with ZERO extra GETs — and must mark its fresh record through
    // the module-level mark WITH the op id.
    const a2 = mintSendAttempt("draft");
    const p2 = modernCreateSession(2000);
    await vi.advanceTimersByTimeAsync(0);
    const out2 = await p2;
    expect(out2.certainty).toBe("unknown");
    expect(lookups).toBe(1); // no new GET for the re-tap
    // ChatView.ensureSession's legacy-shaped mark (NO createOpId argument)
    // — the exact call whose bare Object.assign patch used to overwrite the
    // stamped op id with undefined, stranding the record legacy.
    markOwnerSessionCreateUnknown("draft", out2.detail || "session create outcome unknown", out2.startedAt);
    // THE STAMP SURVIVED: the module-level mark (with opId) ran before the
    // return, so the record was already uncertain and the legacy mark's
    // preparing-only filter skipped it.
    const rec2 = getSendAction(a2.attemptId)!;
    expect(rec2.stage).toBe("uncertain");
    expect(rec2.reason).toBe("session-create-unknown");
    expect(rec2.createOpId).toBe(opId);

    // The op later resolves (budget lookup #3 — the exact replayed receipt):
    // the re-tapped record follows — resolved presentation + transferred
    // onto the exact session id (not stranded in the next draft view).
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS); // lookup #2: unknown
    expect(lookups).toBe(2);
    await vi.advanceTimersByTimeAsync(RECOVERY_BACKOFF_MS); // lookup #3: created
    expect(lookups).toBe(3);
    expect(getCreateOp(opId)?.state).toBe("linked");
    const rec2b = getSendAction(a2.attemptId)!;
    expect(rec2b.stage).toBe("rejected");
    expect(rec2b.reason).toBe("session-create-resolved");
    expect(rec2b.ownerKey).toBe("ses_retap");
    expect(draftResolvedCreateOp()?.sessionId).toBe("ses_retap");
    expect(f.posts()).toHaveLength(1); // never a second execute
  });

  it("abandon (duplicate-risk acknowledged in the UI) ⇒ next send mints a fresh key", async () => {
    const f = stubFetch(modernRouter({ post: () => receipt("unknown"), receipt: () => receipt("unknown") }));
    const a = mintSendAttempt("draft"); // the tap's record (stamped by the flow)
    vi.useFakeTimers();
    const p = modernCreateSession(1000);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    await vi.advanceTimersByTimeAsync(0);
    const rec = getSendAction(a.attemptId)!;
    expect(rec.reason).toBe("session-create-unknown");
    expect(isCurrentCreateOp(rec.createOpId!)).toBe(true);
    abandonCreateOp(rec.createOpId!);
    expect(isCurrentCreateOp(rec.createOpId!)).toBe(false);
    expect(getCreateOp(rec.createOpId)!.state).toBe("abandoned");
    // Next send: fresh operation + key. Swap the router to the created
    // answer (the abandon is what UNBLOCKS a fresh POST — that is the crux).
    const key1 = f.postKeys()[0];
    const f2 = stubFetch(modernRouter());
    const out = await modernCreateSession(3000);
    expect(out.id).toBe("ses_m1");
    expect(f2.postKeys()).toHaveLength(1);
    expect(f2.postKeys()[0]).not.toBe(key1);
  });

  it("beginDraftGeneration (newSession) retires the current operation pointer", async () => {
    stubFetch(modernRouter({ post: () => receipt("unknown"), receipt: () => receipt("unknown") }));
    await modernCreateSession(1000);
    expect(draftResolvedCreateOp()).toBeUndefined(); // not linked — unknown
    beginDraftGeneration("/proj-cc");
    // The old op is no longer current: the next create mints fresh.
    const f2 = stubFetch(modernRouter());
    const out = await modernCreateSession(2000);
    expect(out.id).toBe("ses_m1");
    expect(f2.postKeys()).toHaveLength(1);
  });
});

// ── sendActionStatus helpers (direct contracts) ─────────────────────────────

describe("sendActionStatus create-op helpers", () => {
  it("stampDraftPreparingCreateOp stamps only unstamped preparing records of the owner", () => {
    const a = mintSendAttempt("draft");
    const live = mintSendAttempt("ses-live");
    stampDraftPreparingCreateOp("draft", "op-1");
    expect(getSendAction(a.attemptId)!.createOpId).toBe("op-1");
    expect(getSendAction(live.attemptId)!.createOpId).toBeUndefined(); // different owner
    stampDraftPreparingCreateOp("draft", "op-2");
    expect(getSendAction(a.attemptId)!.createOpId).toBe("op-1"); // not restamped
  });

  it("markOwnerSessionCreateRejected pre-marks preparing records terminally (capability-unavailable)", () => {
    const a = mintSendAttempt("draft");
    markOwnerSessionCreateRejected("draft", "capability check unavailable", "capability-unavailable");
    const rec = getSendAction(a.attemptId)!;
    expect(rec.stage).toBe("rejected");
    expect(rec.certainty).toBe("definitive");
    expect(rec.reason).toBe("capability-unavailable");
  });

  it("the shell-signature mark matches both served shells (app + host)", () => {
    expect(`<title>VHSolara</title>`).toContain(APP_SHELL_TITLE_MARK);
    expect(`<title>VHSolara · Host</title>`).toContain(APP_SHELL_TITLE_MARK);
    expect(`<title>Sign in</title>`).not.toContain(APP_SHELL_TITLE_MARK);
  });
});

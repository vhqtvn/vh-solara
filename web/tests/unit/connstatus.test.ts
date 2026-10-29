// @vitest-environment jsdom
//
// Slice B (send-net-resilience) — the graded ConnStatus reduction test.
// BINDING CONTRACT: researches/decisions/2026-10-10-send-convergence-cascade-
// and-connstatus.md (debate-1 Q5 observational-only policy + debate-3 A6
// precedence).
//
// Coverage:
//   1. The PURE precedence matrix (reduceConnStatus): every dominance rule —
//      tunnel-down dominates (incl. over navigator-offline), navigator-offline
//      → offline, unknown-tunnel ≠ down (does NOT block live), socket phases
//      preserved, cascadePending blocks live, degraded honesty (stale
//      outranks the fetch-failure spike), defensive fallback.
//   2. Consumer mapping tables (statusMarkState / statusMarkTip /
//      railConnFromModel) — behavior-equivalent with the pre-Slice-B
//      3-state ladders plus the new "offline" addressable state.
//   3. The REACTIVE wiring (fresh module graph per test): the tunnel header
//      sampler (X-VH-Tunnel-State off /vh/* fetch responses, freshness decay
//      to unknown), initConnStatus navigator listeners, the cascade
//      convergence-pending subscription, and the weaklink fetch-failure
//      spike (incl. the abort exclusion).
//
// Harness: stream1Registration.test.ts / treeConvergedGate.test.ts shape
// (vi.resetModules + dynamic imports per test → fresh signal + store state).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
// Type-only: the runtime diaglog handle is per-test (resetModules in
// setupFresh); this import is erased at runtime and only names the entry
// type for the stamps describe below.
import type { ConnGradeEntry } from "../../src/sync/diaglog";
import type { ConnStatusInput } from "../../src/sync/connstatus";

let conn: typeof import("../../src/sync/connstatus") = null as unknown as typeof import("../../src/sync/connstatus");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let cascade: typeof import("../../src/sync/cascade") = null as unknown as typeof import("../../src/sync/cascade");
let weaklink: typeof import("../../src/sync/weaklink") = null as unknown as typeof import("../../src/sync/weaklink");
let health: typeof import("../../src/sync/health") = null as unknown as typeof import("../../src/sync/health");
let diaglog: typeof import("../../src/sync/diaglog") = null as unknown as typeof import("../../src/sync/diaglog");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  conn = await import("../../src/sync/connstatus");
  store = await import("../../src/sync/store");
  cascade = await import("../../src/sync/cascade");
  weaklink = await import("../../src/sync/weaklink");
  health = await import("../../src/sync/health");
  diaglog = await import("../../src/sync/diaglog");
  store.setProjectDirRaw("/test");
}

// The header value the stubbed fetch returns on /vh/* responses (mutable so
// individual tests can flip the observed tunnel state).
let tunnelHeader: string | null = null;
// Count of non-/vh/ vs /vh/ fetches the stub saw (for URL discrimination).
let sawUrl = "";

async function setupLive(): Promise<void> {
  await setupFresh();
  store.setState("status", "live");
}

beforeEach(async () => {
  tunnelHeader = null;
  sawUrl = "";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      sawUrl = url;
      const headers: Record<string, string> = {};
      if (tunnelHeader) headers["X-VH-Tunnel-State"] = tunnelHeader;
      return new Response("{}", { status: 200, headers });
    }),
  );
  window.localStorage.clear();
  vi.useFakeTimers();
  // Fresh module graph per test (also resets the sampler latch's module
  // state); the global latch is cleared so installTunnelSampler can wrap.
  delete (globalThis as unknown as { __vhTunnelSampled?: boolean }).__vhTunnelSampled;
  await setupLive();
  // Neutral cascade surface: a noop queue trigger so pass completions never
  // hit an unregistered surface.
  cascade.setQueueReconcileTrigger(() => {});
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { __vhTunnelSampled?: boolean }).__vhTunnelSampled;
});

// A clean live input baseline for the pure matrix.
const cleanInput = (over: Partial<ConnStatusInput> = {}): ConnStatusInput => ({
  status: "live",
  navigatorOnline: true,
  tunnel: "unknown",
  cascadePending: false,
  stale: false,
  syncing: false,
  fetchFailureSpike: false,
  ...over,
});

describe("reduceConnStatus — the precedence matrix (pure)", () => {
  it("(1) a fresh daemon tunnel-down observation DOMINATES: reconnecting [tunnel-down]", () => {
    const m = conn.reduceConnStatus(cleanInput({ tunnel: "disconnected" }));
    expect(m.grade).toBe("reconnecting");
    expect(m.reasons).toEqual(["tunnel-down"]);
    expect(m.phase).toBe("reconnecting");
    expect(m.tunnel).toBe("disconnected");
  });

  it("(1a) tunnel-down outranks navigator-offline (debate-3 A6 order)", () => {
    const m = conn.reduceConnStatus(cleanInput({ tunnel: "disconnected", navigatorOnline: false }));
    expect(m.grade).toBe("reconnecting");
    expect(m.reasons).toEqual(["tunnel-down"]);
  });

  it("(2) navigator-offline → offline [navigator-offline]", () => {
    const m = conn.reduceConnStatus(cleanInput({ navigatorOnline: false }));
    expect(m.grade).toBe("offline");
    expect(m.reasons).toEqual(["navigator-offline"]);
    expect(m.phase).toBeNull();
  });

  it("(2a) unknown tunnel is NOT down: absence of the header never blocks live (external/local-server topology honesty)", () => {
    const m = conn.reduceConnStatus(cleanInput({ tunnel: "unknown" }));
    expect(m.grade).toBe("live");
    expect(m.reasons).toEqual([]);
    expect(m.tunnel).toBe("unknown");
  });

  it("(2b) a connected tunnel with everything clean stays live", () => {
    const m = conn.reduceConnStatus(cleanInput({ tunnel: "connected" }));
    expect(m.grade).toBe("live");
  });

  it("(3) client hard-socket observations govern browser reachability, phase preserved", () => {
    const connecting = conn.reduceConnStatus(cleanInput({ status: "connecting" }));
    expect(connecting.grade).toBe("reconnecting");
    expect(connecting.phase).toBe("connecting");
    expect(connecting.reasons).toEqual(["socket-connecting"]);

    const reconnecting = conn.reduceConnStatus(cleanInput({ status: "reconnecting" }));
    expect(reconnecting.grade).toBe("reconnecting");
    expect(reconnecting.phase).toBe("reconnecting");
    expect(reconnecting.reasons).toEqual(["socket-reconnecting"]);
  });

  it("(4) live requires converged: cascadePending blocks live → reconnecting [convergence-pending]", () => {
    const m = conn.reduceConnStatus(cleanInput({ cascadePending: true }));
    expect(m.grade).toBe("reconnecting");
    expect(m.reasons).toEqual(["convergence-pending"]);
    expect(m.phase).toBe("reconnecting");
  });

  it("(4a) tree-stale while otherwise live → degraded [tree-stale]", () => {
    const m = conn.reduceConnStatus(cleanInput({ stale: true }));
    expect(m.grade).toBe("degraded");
    expect(m.reasons).toEqual(["tree-stale"]);
    expect(m.stale).toBe(true);
  });

  it("(4b) an FE fetch-failure spike while otherwise live → degraded [fetch-failure-spike]", () => {
    const m = conn.reduceConnStatus(cleanInput({ fetchFailureSpike: true }));
    expect(m.grade).toBe("degraded");
    expect(m.reasons).toEqual(["fetch-failure-spike"]);
  });

  it("(4c) degraded honesty: stale outranks the fetch spike (one reason, the stronger one)", () => {
    const m = conn.reduceConnStatus(cleanInput({ stale: true, fetchFailureSpike: true }));
    expect(m.grade).toBe("degraded");
    expect(m.reasons).toEqual(["tree-stale"]);
  });

  it("(4d) the syncing facet rides on live (and degraded) without changing the grade", () => {
    expect(conn.reduceConnStatus(cleanInput({ syncing: true })).grade).toBe("live");
    const d = conn.reduceConnStatus(cleanInput({ syncing: true, stale: true }));
    expect(d.grade).toBe("degraded");
    expect(d.syncing).toBe(true);
  });

  it("(def) an out-of-vocabulary status fails honest: reconnecting [unknown-status]", () => {
    const m = conn.reduceConnStatus(cleanInput({ status: "garbage" as ConnStatusInput["status"] }));
    expect(m.grade).toBe("reconnecting");
    expect(m.reasons).toEqual(["unknown-status"]);
  });
});

describe("consumer mapping tables", () => {
  it("statusMarkState — grade → the Sidebar StatusMark state vocabulary (+new offline)", () => {
    const M = (over: Partial<ConnStatusInput> = {}) => conn.reduceConnStatus(cleanInput(over));
    expect(conn.statusMarkState(M({ navigatorOnline: false }))).toBe("offline");
    expect(conn.statusMarkState(M({ status: "connecting" }))).toBe("connecting");
    expect(conn.statusMarkState(M({ status: "reconnecting" }))).toBe("reconnecting");
    expect(conn.statusMarkState(M({ tunnel: "disconnected" }))).toBe("reconnecting");
    expect(conn.statusMarkState(M({ cascadePending: true }))).toBe("reconnecting");
    expect(conn.statusMarkState(M({ stale: true }))).toBe("stale");
    expect(conn.statusMarkState(M({ fetchFailureSpike: true }))).toBe("stale");
    expect(conn.statusMarkState(M())).toBe("live");
    expect(conn.statusMarkState(M({ syncing: true }))).toBe("syncing");
  });

  it("statusMarkTip — grade-honest wording for every grade/facet", () => {
    const M = (over: Partial<ConnStatusInput> = {}) => conn.reduceConnStatus(cleanInput(over));
    expect(conn.statusMarkTip(M({ navigatorOnline: false }))).toContain("offline");
    expect(conn.statusMarkTip(M({ status: "connecting" }))).toContain("connecting");
    expect(conn.statusMarkTip(M({ status: "reconnecting" }))).toContain("reconnecting");
    expect(conn.statusMarkTip(M({ stale: true }))).toContain("stale");
    expect(conn.statusMarkTip(M({ fetchFailureSpike: true }))).toContain("degraded");
    expect(conn.statusMarkTip(M({ syncing: true }))).toContain("syncing");
    expect(conn.statusMarkTip(M())).toContain("connected");
  });

  it("railConnFromModel — the SessionRail dot vocabulary mirrors the grade mapping", () => {
    const M = (over: Partial<ConnStatusInput> = {}) => conn.reduceConnStatus(cleanInput(over));
    expect(conn.railConnFromModel(M({ navigatorOnline: false }))).toBe("offline");
    expect(conn.railConnFromModel(M({ status: "connecting" }))).toBe("connecting");
    expect(conn.railConnFromModel(M({ tunnel: "disconnected" }))).toBe("reconnecting");
    expect(conn.railConnFromModel(M({ stale: true }))).toBe("stale");
    expect(conn.railConnFromModel(M())).toBe("live");
    expect(conn.railConnFromModel(M({ syncing: true }))).toBe("syncing");
  });
});

describe("tunnel header sampler (reactive)", () => {
  it("reads X-VH-Tunnel-State off /vh/* responses into the reduction", async () => {
    conn.installTunnelSampler();
    // Baseline: unknown tunnel, live status → live.
    expect(conn.connModel().grade).toBe("live");
    expect(conn.connModel().tunnel).toBe("unknown");

    tunnelHeader = "disconnected";
    await globalThis.fetch("/vh/queue?dir=/test");
    expect(sawUrl).toContain("/vh/");
    const m = conn.connModel();
    expect(m.tunnel).toBe("disconnected");
    expect(m.grade).toBe("reconnecting");
    expect(m.reasons).toEqual(["tunnel-down"]);

    // Recovery: the next /vh/* response says connected.
    tunnelHeader = "connected";
    await globalThis.fetch("/vh/queue?dir=/test");
    expect(conn.connModel().tunnel).toBe("connected");
    expect(conn.connModel().grade).toBe("live");
  });

  it("ignores non-/vh/ URLs and responses without the header", async () => {
    conn.installTunnelSampler();
    tunnelHeader = "connected";
    await globalThis.fetch("/api/other");
    expect(sawUrl).not.toContain("/vh/");
    expect(conn.connModel().tunnel).toBe("unknown");

    tunnelHeader = null;
    await globalThis.fetch("/vh/queue");
    expect(conn.connModel().tunnel).toBe("unknown");
    expect(conn.connModel().grade).toBe("live");
  });

  it("a stale observation decays back to unknown after TUNNEL_FRESH_MS (absence ≠ down)", async () => {
    conn.installTunnelSampler();
    tunnelHeader = "disconnected";
    await globalThis.fetch("/vh/queue");
    expect(conn.connModel().grade).toBe("reconnecting");

    // Advance past the freshness bound + bump the coarse health tick (the
    // decay re-evaluates on the ~5s tick — same pattern as isStale).
    vi.setSystemTime(Date.now() + conn.TUNNEL_FRESH_MS + 1_000);
    health.tickHealth();
    const m = conn.connModel();
    expect(m.tunnel).toBe("unknown");
    expect(m.grade).toBe("live");
  });
});

describe("initConnStatus — navigator wiring (reactive)", () => {
  it("online/offline events drive the offline grade", () => {
    conn.initConnStatus();
    expect(conn.connModel().grade).toBe("live");

    window.dispatchEvent(new Event("offline"));
    const m = conn.connModel();
    expect(m.grade).toBe("offline");
    expect(m.reasons).toEqual(["navigator-offline"]);

    window.dispatchEvent(new Event("online"));
    expect(conn.connModel().grade).toBe("live");
  });
});

describe("cascade convergence-pending subscription (reactive)", () => {
  it("an armed pass blocks live; noteTreeConverged restores it at CONVERGENCE", async () => {
    conn.initConnStatus();
    expect(conn.connModel().grade).toBe("live");

    // Arm a pass with an unconverged tree step (the noteServerRingGap shape).
    cascade.requestRecovery("tree-seq-gap", undefined, { tree: "await" });
    const blocked = conn.connModel();
    expect(blocked.grade).toBe("reconnecting");
    expect(blocked.reasons).toEqual(["convergence-pending"]);

    // Truthful convergence (the F3-gated path) clears the block.
    cascade.noteTreeConverged();
    await Promise.resolve();
    await Promise.resolve();
    expect(conn.connModel().grade).toBe("live");
  });
});

describe("FE fetch-failure spike → degraded (reactive, weaklink counters)", () => {
  it("≥2 network/http_5xx failures inside the window degrade an otherwise-live grade", () => {
    weaklink._resetWeakLinkForTest();
    // First evaluation seeds the window base.
    expect(conn.connModel().grade).toBe("live");

    weaklink.recordFetchFailure("network");
    health.tickHealth();
    expect(conn.connModel().grade).toBe("live");

    weaklink.recordFetchFailure("http_5xx");
    health.tickHealth();
    const m = conn.connModel();
    expect(m.grade).toBe("degraded");
    expect(m.reasons).toEqual(["fetch-failure-spike"]);

    // Window decay: past DEGRADED_FETCH_WINDOW_MS the base resets → live.
    vi.setSystemTime(Date.now() + conn.DEGRADED_FETCH_WINDOW_MS + 1_000);
    health.tickHealth();
    expect(conn.connModel().grade).toBe("live");
  });

  it("abort-class failures are EXCLUDED (client-initiated, outcome-unknown)", () => {
    weaklink._resetWeakLinkForTest();
    expect(conn.connModel().grade).toBe("live");
    for (let i = 0; i < 5; i++) weaklink.recordFetchFailure("abort");
    health.tickHealth();
    expect(conn.connModel().grade).toBe("live");
  });
});

// ── Grade-transition diag stamps (capture-2, card ───────────────────────────
// task-2026-10-29t06-06-05): the observer wired in initConnStatus records
// every genuine grade transition into the SAME ring as the stream-open
// stamps, with from/to + the landing grade's reasons — so a future capture
// reads exactly when/why the ConnectionToast cleared relative to the
// tree/session applied@ stamps. Default-off ring posture asserted too.
describe("grade-transition diag stamps (capture-2)", () => {
  // Solid effects (the observer lives in its own app-lifetime root) flush on
  // microtasks; with fake timers, two 0-advances flush the whole chain
  // (signal → memo → effect → helper).
  const flushEffects = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  };
  const gradeEntries = (): ConnGradeEntry[] =>
    diaglog.diagEntries().filter((e): e is ConnGradeEntry => e.kind === "conn-grade");

  it("capture OFF (default): transitions stamp nothing into the ring", async () => {
    conn.initConnStatus();
    await flushEffects(); // the baseline evaluation records no entry
    store.setState("status", "reconnecting");
    await flushEffects();
    store.setState("status", "live");
    await flushEffects();
    expect(gradeEntries()).toEqual([]);
  });

  it("capture ON: every transition lands with from/to + the landing reasons, in order; the baseline stamps nothing", async () => {
    diaglog.setDiagLogOn(true);
    conn.initConnStatus();
    await flushEffects();
    expect(gradeEntries()).toEqual([]); // baseline (live) — not a transition

    store.setState("status", "reconnecting");
    await flushEffects();
    store.setState("status", "live");
    await flushEffects();
    // The convergence-pending transition: status live + an armed pass.
    cascade.requestRecovery("tree-seq-gap", undefined, { tree: "await" });
    await flushEffects();
    expect(conn.connModel().grade).toBe("reconnecting");
    cascade.noteTreeConverged();
    await flushEffects();

    expect(gradeEntries().map((e) => [e.from, e.to, e.reasons])).toEqual([
      ["live", "reconnecting", ["socket-reconnecting"]],
      ["reconnecting", "live", []],
      ["live", "reconnecting", ["convergence-pending"]],
      ["reconnecting", "live", []],
    ]);
    // The rendered line is capture-readable (the "Copy all" surface).
    const first = gradeEntries()[0];
    expect(diaglog.entryLine(first)).toContain("conn-grade live→reconnecting reason=socket-reconnecting");
  });

  // LIVE-GATE PIN (hard constraint of the 2026-10-29 card): grade=live on
  // healthy paths still requires the FULL post-reconnect convergence
  // cascade — this slice's stale-side toast lifecycle changes must not let
  // anything reach live EARLIER than today. The reduction is untouched by
  // the slice; this pins the reactive composition at the resume shape.
  it("LIVE-GATE PIN: live requires the full post-reconnect convergence cascade (unchanged by the toast lifecycle slice)", async () => {
    conn.initConnStatus();
    await flushEffects();
    expect(conn.connModel().grade).toBe("live");

    // Hard down, then recovery: the socket REOPENS (status live) while the
    // cascade pass still awaits its baseline → the grade MUST stay down…
    store.setState("status", "reconnecting");
    await flushEffects();
    cascade.requestRecovery("tree-seq-gap", undefined, { tree: "fresh" });
    store.setState("status", "live"); // socket open, snapshot NOT yet applied
    await flushEffects();
    const blocked = conn.connModel();
    expect(blocked.grade).toBe("reconnecting");
    expect(blocked.reasons).toEqual(["convergence-pending"]);
    // …and ONLY the truthful convergence note (an APPLIED baseline) restores live.
    cascade.noteTreeConverged();
    await flushEffects();
    expect(conn.connModel().grade).toBe("live");
  });
});

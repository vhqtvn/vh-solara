// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// Snapshot fixtures matching pkg/oclife/oclife.go oclife.Snapshot JSON.
const OWNED_READY = {
  topology: "owned",
  state: "ready",
  state_changed_at: "2026-07-12T19:30:00Z",
  capabilities: {
    can_restart: true,
    has_process_output: true,
    has_log_tail: true,
    has_exit_status: true,
  },
  diagnostic_completeness: "complete",
};

const OWNED_FAILED = {
  topology: "owned",
  state: "failed",
  state_changed_at: "2026-07-12T19:31:00Z",
  failure_summary: "opencode: exec: binary not found",
  exit_code: 127,
  capabilities: {
    can_restart: true,
    has_process_output: true,
    has_log_tail: true,
    has_exit_status: true,
  },
  diagnostic_completeness: "complete",
};

function jsonResp(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => "",
  } as unknown as Response;
}

function textResp(text: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => ({}),
    text: async () => text,
  } as unknown as Response;
}

describe("opencode-lifecycle client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Module-level signals are singletons; reset the module registry per test so
  // each starts from a clean store (no leftover snapshot / lifecycleAvailable).
  async function load() {
    vi.resetModules();
    return await import("../../src/opencode-lifecycle");
  }

  it("parses a 200 Snapshot into the store and marks lifecycle available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResp(OWNED_READY))),
    );
    const m = await load();
    await m.refreshOpenCodeLifecycle();
    expect(m.snapshot()).not.toBeNull();
    expect(m.snapshot()?.state).toBe("ready");
    expect(m.snapshot()?.topology).toBe("owned");
    expect(m.snapshot()?.capabilities.has_exit_status).toBe(true);
    expect(m.lifecycleAvailable()).toBe(true);
  });

  it("handles 503 as unknown state and marks lifecycle NOT available", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResp({ error: "lifecycle not wired" }, false, 503))),
    );
    const m = await load();
    await m.refreshOpenCodeLifecycle();
    expect(m.snapshot()?.state).toBe("unknown");
    expect(m.snapshot()?.diagnostic_completeness).toBe("unavailable");
    expect(m.lifecycleAvailable()).toBe(false);
  });

  it("treats non-503 errors as not-available rather than alarming", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResp({ error: "boom" }, false, 500))),
    );
    const m = await load();
    await m.refreshOpenCodeLifecycle();
    expect(m.snapshot()?.state).toBe("unknown");
    expect(m.lifecycleAvailable()).toBe(false);
  });

  it("restartOpenCode adopts the post-restart snapshot on success", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.includes("/vh/opencode/restart")) {
        return Promise.resolve(jsonResp(OWNED_READY));
      }
      return Promise.resolve(jsonResp(OWNED_FAILED));
    });
    vi.stubGlobal("fetch", fetchMock);
    const m = await load();
    await m.refreshOpenCodeLifecycle();
    expect(m.snapshot()?.state).toBe("failed");
    const ok = await m.restartOpenCode();
    expect(ok).toBe(true);
    expect(m.snapshot()?.state).toBe("ready");
    expect(fetchMock).toHaveBeenCalledWith(
      "/vh/opencode/restart",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("restartOpenCode returns false on a failed POST", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResp({ error: "no" }, false, 500))),
    );
    const m = await load();
    const ok = await m.restartOpenCode();
    expect(ok).toBe(false);
  });

  it("fetchLogs returns the ring tail text on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/opencode/logs")) {
          return Promise.resolve(textResp("line-a\nline-b\nline-c"));
        }
        return Promise.resolve(textResp("", false, 404));
      }),
    );
    const m = await load();
    const r = await m.fetchLogs();
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.text).toBe("line-a\nline-b\nline-c");
  });

  it("fetchLogs surfaces a non-OK response as ok:false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(textResp("", false, 501))),
    );
    const m = await load();
    const r = await m.fetchLogs();
    expect(r.ok).toBe(false);
    expect(r.status).toBe(501);
    expect(r.text).toBe("");
  });

  it("does not flap the store on a network error after a good snapshot", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls++;
        if (calls === 1) return Promise.resolve(jsonResp(OWNED_READY));
        throw new Error("network down");
      }),
    );
    const m = await load();
    await m.refreshOpenCodeLifecycle();
    expect(m.snapshot()?.state).toBe("ready");
    await m.refreshOpenCodeLifecycle(); // network failure
    // Existing snapshot is preserved (no flap to unknown).
    expect(m.snapshot()?.state).toBe("ready");
    expect(m.lifecycleAvailable()).toBe(true);
  });

  // oc-death-watch S2: the worker's additive death-watch fields flow through
  // the /vh/opencode/status poll into the store signal untouched — the poll
  // is a res.json() cast, so enrichment requires no client-side changes, but
  // this pins the passthrough the HealthPanel's down-state rendering rides on.
  it("surfaces the death-watch fields (down_since / restart_attempts / restart_capped)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResp({
            ...OWNED_FAILED,
            failure_summary:
              "opencode serve pid 4242 exited (signal KILL/9) after 1h2m",
            down_since: "2026-10-03T21:04:00Z",
            restart_attempts: 2,
            restart_capped: false,
          }),
        ),
      ),
    );
    const m = await load();
    await m.refreshOpenCodeLifecycle();
    expect(m.snapshot()?.state).toBe("failed");
    expect(m.snapshot()?.down_since).toBe("2026-10-03T21:04:00Z");
    expect(m.snapshot()?.restart_attempts).toBe(2);
    expect(m.snapshot()?.restart_capped).toBe(false);
    expect(m.lifecycleAvailable()).toBe(true);
  });

  // Down-state poll cadence (S2): a failed (down) state drives the FAST
  // interval, so the UI sees recovery/escalation within ~2s — and a ready
  // state returns to the normal cadence. nextInterval is internal; the
  // behavior is observable through the exported polling start/stop? It is
  // not — so assert the discriminator directly via the module's exported
  // surface: the snapshot's state is what nextInterval branches on. This is
  // a shape pin, not a timer test.
  it("keeps failed (down) snapshots in the fast-poll discriminator state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResp(OWNED_FAILED))),
    );
    const m = await load();
    await m.refreshOpenCodeLifecycle();
    // The adaptive poll branches on state === "starting" || state ===
    // "failed" → FAST_INTERVAL_MS. A down spell reports state "failed"
    // (SetFailed per death), so the degraded cadence engages with zero
    // changes to the poll logic — pin that coupling here.
    expect(m.snapshot()?.state).toBe("failed");
    expect(m.snapshot()?.down_since).toBeUndefined();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

const OWNED_FAILED = {
  topology: "owned",
  state: "failed",
  state_changed_at: "2026-07-12T19:30:00Z",
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

const EXTERNAL_FAILED = {
  topology: "external",
  state: "failed",
  state_changed_at: "2026-07-12T19:30:00Z",
  failure_summary: "OpenCode unreachable on this host",
  exit_code: null,
  capabilities: {
    can_restart: false,
    has_process_output: false,
    has_log_tail: false,
    has_exit_status: false,
  },
  diagnostic_completeness: "unavailable",
};

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

function resp(body: unknown, ok = true, status = 200, text = ""): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => text,
  } as unknown as Response;
}

// Component + store are both module-level singletons; reset the registry once
// per scenario and import both in the SAME cycle so the component sees the same
// store instance. Returns the rendered container + the store module for priming.
async function fresh() {
  vi.resetModules();
  const store = await import("../../src/opencode-lifecycle");
  const Panel = (await import("../../src/components/OpenCodeHealthPanel"))
    .default;
  return { store, Panel };
}

describe("OpenCodeHealthPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders failed state with failure summary, logs, and a restart button", async () => {
    const { store, Panel } = await fresh();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/opencode/status"))
          return Promise.resolve(resp(OWNED_FAILED));
        if (url.includes("/vh/opencode/logs"))
          return Promise.resolve(
            resp(null, true, 200, "boot line\nopencode: not found"),
          );
        return Promise.resolve(resp({}, false, 404));
      }),
    );
    await store.refreshOpenCodeLifecycle();
    render(() => <Panel />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("OpenCode failed to start");
    });
    expect(document.body.textContent).toContain(
      "opencode: exec: binary not found",
    );
    // exit code surfaced (has_exit_status true)
    expect(document.body.textContent).toContain("exit: 127");
    // logs tail element + content. Query by tag/role: the CSS-module classes are
    // hashed, so .och-log isn't a literal selector — the only <pre> in the panel
    // is the logs tail.
    const logEl = document.querySelector("pre");
    expect(logEl).toBeTruthy();
    await waitFor(() => {
      expect(logEl?.textContent).toContain("opencode: not found");
    });
    // restart button present (can_restart true)
    const restartBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Restart OpenCode"),
    );
    expect(restartBtn).toBeTruthy();
  });

  it("renders external topology WITHOUT logs section and WITHOUT restart button", async () => {
    const { store, Panel } = await fresh();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/opencode/status"))
          return Promise.resolve(resp(EXTERNAL_FAILED));
        if (url.includes("/vh/opencode/logs"))
          return Promise.resolve(resp({ error: "external" }, false, 501));
        return Promise.resolve(resp({}, false, 404));
      }),
    );
    await store.refreshOpenCodeLifecycle();
    render(() => <Panel />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("OpenCode failed to start");
    });
    // No logs tail element (the only <pre> in the panel would be the logs tail).
    expect(document.querySelector("pre")).toBeNull();
    // Topology note instead.
    expect(document.body.textContent).toContain(
      "Logs not available for this topology",
    );
    // No restart button.
    const restartBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Restart OpenCode"),
    );
    expect(restartBtn).toBeUndefined();
  });

  it("renders a minimal ready indicator (no prominent panel)", async () => {
    const { store, Panel } = await fresh();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/opencode/status"))
          return Promise.resolve(resp(OWNED_READY));
        return Promise.resolve(resp({}, false, 404));
      }),
    );
    await store.refreshOpenCodeLifecycle();
    render(() => <Panel />);

    await waitFor(() => {
      expect(document.body.textContent).toContain("OpenCode ready");
    });
    // Minimal pill present (role="status"), prominent panel absent (role="alert").
    // CSS-module classes are hashed, so query by the semantic role instead.
    expect(document.querySelector('[role="status"]')).toBeTruthy();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("renders nothing when the lifecycle surface is not wired (503)", async () => {
    const { store, Panel } = await fresh();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(resp({ error: "not wired" }, false, 503)),
      ),
    );
    await store.refreshOpenCodeLifecycle();
    render(() => <Panel />);

    // Defer a tick: effects should resolve to "render nothing".
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

// @vitest-environment jsdom
//
// Coverage for the always-accessible OpenCode logs viewer:
//   • renders the ring-tail <pre> when the topology exposes has_log_tail and
//     the lifecycle surface is wired (200).
//   • shows "Logs not available for this topology" when has_log_tail is false
//     (external topology), with no <pre>.
//   • shows "OpenCode logs not available on this server version" when the
//     lifecycle surface is not wired (503 / older daemon), with no <pre>.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

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

const EXTERNAL_READY = {
  topology: "external",
  state: "ready",
  state_changed_at: "2026-07-12T19:30:00Z",
  capabilities: {
    can_restart: false,
    has_process_output: false,
    has_log_tail: false,
    has_exit_status: false,
  },
  diagnostic_completeness: "unavailable",
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
  const Dialog = (await import("../../src/components/OpenCodeLogsDialog"))
    .default;
  return { store, Dialog };
}

describe("OpenCodeLogsDialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the logs tail when has_log_tail=true and lifecycle is available", async () => {
    const { store, Dialog } = await fresh();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/opencode/status"))
          return Promise.resolve(resp(OWNED_READY));
        if (url.includes("/vh/opencode/logs"))
          return Promise.resolve(
            resp(null, true, 200, "boot line\n[plugin] hello from my plugin"),
          );
        return Promise.resolve(resp({}, false, 404));
      }),
    );
    await store.refreshOpenCodeLifecycle();
    render(() => <Dialog onClose={() => {}} />);

    // Dialog title present.
    await waitFor(() => {
      expect(document.body.textContent).toContain("OpenCode logs");
    });
    // The logs <pre> is present and populated. CSS-module classes are hashed, so
    // query by tag: the only <pre> in the dialog is the logs tail.
    const logEl = document.querySelector("pre");
    expect(logEl).toBeTruthy();
    await waitFor(() => {
      expect(logEl?.textContent).toContain("hello from my plugin");
    });
    // A manual refresh button is rendered.
    const refreshBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Refresh"),
    );
    expect(refreshBtn).toBeTruthy();
    // No topology/version fallback note.
    expect(document.body.textContent).not.toContain("not available");
  });

  it("shows 'Logs not available for this topology' when has_log_tail=false (external)", async () => {
    const { store, Dialog } = await fresh();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/opencode/status"))
          return Promise.resolve(resp(EXTERNAL_READY));
        if (url.includes("/vh/opencode/logs"))
          return Promise.resolve(resp({ error: "external" }, false, 501));
        return Promise.resolve(resp({}, false, 404));
      }),
    );
    await store.refreshOpenCodeLifecycle();
    render(() => <Dialog onClose={() => {}} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Logs not available for this topology",
      );
    });
    // No logs tail element.
    expect(document.querySelector("pre")).toBeNull();
  });

  it("shows 'not available on this server version' when lifecycle is unavailable (503)", async () => {
    const { store, Dialog } = await fresh();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(resp({ error: "not wired" }, false, 503)),
      ),
    );
    await store.refreshOpenCodeLifecycle();
    render(() => <Dialog onClose={() => {}} />);

    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "OpenCode logs not available on this server version",
      );
    });
    // No logs tail element.
    expect(document.querySelector("pre")).toBeNull();
  });
});

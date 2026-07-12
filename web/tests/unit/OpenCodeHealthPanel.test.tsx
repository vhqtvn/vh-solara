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

  // ─────────────────────────────────────────────────────────────────────
  // F2 — restart-confirm gate
  // The health panel's restart button must NOT POST /vh/opencode/restart
  // immediately. It enters an inline confirm step that fetches
  // /vh/running-sessions and shows a session-interrupt warning; the POST fires
  // only on Confirm. Fail-closed disables Restart while the count is unknown.
  // ─────────────────────────────────────────────────────────────────────

  // Locate the restart affordance by its button label. After entering the
  // confirm step the entry button is replaced by a confirm button with the
  // same label, so this always returns the currently-visible one.
  function findRestartBtn(): HTMLButtonElement {
    const b = Array.from(document.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Restart OpenCode"),
    ) as HTMLButtonElement | undefined;
    if (!b) throw new Error("no visible Restart OpenCode button");
    return b;
  }

  it("F2: clicking restart shows a session-interrupt warning and does NOT POST until Confirm", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes("/vh/opencode/status"))
        return Promise.resolve(resp(OWNED_FAILED));
      if (url.includes("/vh/opencode/logs"))
        return Promise.resolve(resp(null, true, 200, ""));
      if (url.includes("/vh/running-sessions"))
        return Promise.resolve(
          resp({ count: 2, workspaces: [{ dir: "/a", count: 2 }] }),
        );
      if (
        url.includes("/vh/opencode/restart") &&
        (init as RequestInit | undefined)?.method === "POST"
      )
        return Promise.resolve(resp(OWNED_READY));
      return Promise.resolve(resp({}, false, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { store, Panel } = await fresh();
    await store.refreshOpenCodeLifecycle();
    render(() => <Panel />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("OpenCode failed to start"),
    );

    // Entry click → enters confirm, fetches sessions, shows the warning.
    findRestartBtn().click();
    await waitFor(() =>
      expect(document.body.textContent).toContain("2 running sessions"),
    );
    expect(document.body.textContent).toContain("will be interrupted");

    // No restart POST yet — the gate holds.
    expect(
      fetchMock.mock.calls.find(
        ([u, i]) =>
          (u as string).includes("/vh/opencode/restart") &&
          (i as RequestInit | undefined)?.method === "POST",
      ),
    ).toBeUndefined();

    // Confirm → exactly one POST to /vh/opencode/restart.
    findRestartBtn().click();
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([u, i]) =>
          (u as string).includes("/vh/opencode/restart") &&
          (i as RequestInit | undefined)?.method === "POST",
      );
      expect(posts.length).toBe(1);
    });
  });

  it("F2: Cancel does NOT POST and returns to the entry button", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/vh/opencode/status"))
        return Promise.resolve(resp(OWNED_FAILED));
      if (url.includes("/vh/opencode/logs"))
        return Promise.resolve(resp(null, true, 200, ""));
      if (url.includes("/vh/running-sessions"))
        return Promise.resolve(resp({ count: 2, workspaces: [] }));
      return Promise.resolve(resp({}, false, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { store, Panel } = await fresh();
    await store.refreshOpenCodeLifecycle();
    render(() => <Panel />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("OpenCode failed to start"),
    );
    findRestartBtn().click();
    await waitFor(() =>
      expect(document.body.textContent).toContain("2 running sessions"),
    );

    // Cancel is the second button in the confirm actions row.
    const cancelBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel",
    ) as HTMLButtonElement;
    cancelBtn.click();

    // Back to the entry button (the confirm warning is gone), no POST made.
    await waitFor(() =>
      expect(document.body.textContent).toContain("Restart OpenCode"),
    );
    expect(document.body.textContent).not.toContain("will be interrupted");
    expect(
      fetchMock.mock.calls.find(([u, i]) =>
        (u as string).includes("/vh/opencode/restart"),
      ),
    ).toBeUndefined();
  });

  it("F2: fail-closed — unknown session count disables Restart (Cancel still works)", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/vh/opencode/status"))
        return Promise.resolve(resp(OWNED_FAILED));
      if (url.includes("/vh/opencode/logs"))
        return Promise.resolve(resp(null, true, 200, ""));
      if (url.includes("/vh/running-sessions"))
        return Promise.resolve(resp(null, false, 500));
      return Promise.resolve(resp({}, false, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { store, Panel } = await fresh();
    await store.refreshOpenCodeLifecycle();
    render(() => <Panel />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("OpenCode failed to start"),
    );
    findRestartBtn().click();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Couldn't verify active sessions",
      ),
    );

    // Fail-closed: Restart disabled, Cancel enabled.
    expect(findRestartBtn().disabled).toBe(true);
    const cancelBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel",
    ) as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(false);

    // No POST possible (disabled), and none was attempted.
    expect(
      fetchMock.mock.calls.find(([u]) =>
        (u as string).includes("/vh/opencode/restart"),
      ),
    ).toBeUndefined();
  });

  it("F2: 0 running sessions shows 'safe to restart' with Restart enabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/opencode/status"))
          return Promise.resolve(resp(OWNED_FAILED));
        if (url.includes("/vh/opencode/logs"))
          return Promise.resolve(resp(null, true, 200, ""));
        if (url.includes("/vh/running-sessions"))
          return Promise.resolve(resp({ count: 0, workspaces: [] }));
        return Promise.resolve(resp({}, false, 404));
      }),
    );
    const { store, Panel } = await fresh();
    await store.refreshOpenCodeLifecycle();
    render(() => <Panel />);

    await waitFor(() =>
      expect(document.body.textContent).toContain("OpenCode failed to start"),
    );
    findRestartBtn().click();
    await waitFor(() =>
      expect(document.body.textContent).toContain("0 running sessions"),
    );
    expect(document.body.textContent).toContain("safe to restart");
    expect(findRestartBtn().disabled).toBe(false);
  });
});

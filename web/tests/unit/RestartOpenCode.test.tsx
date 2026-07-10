// @vitest-environment jsdom
//
// RestartOpenCode OWNS the complete OpenCode-restart operation. These tests pin
// the ownership contract: it is the SOLE client-side caller of
// /vh/restart-opencode, every activation traverses RestartConfirm (the
// session-interrupt gate fetched from /vh/running-sessions), and the optional
// onRestarted callback fires only on a successful request.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

import RestartOpenCode from "../../src/components/RestartOpenCode";

// Minimal Response-like object: the component only consumes .ok / .status / .json().
function jsonResp(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => "" };
}

// 3 running sessions across 2 workspaces — exercises the pluralization + the
// "across N workspaces" branch of the warning copy.
const RUNNING = {
  count: 3,
  workspaces: [
    { dir: "/a", count: 1 },
    { dir: "/b", count: 2 },
  ],
};

describe("RestartOpenCode — owns the restart operation", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows RestartConfirm BEFORE any POST when the entry is activated", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/vh/running-sessions")) return Promise.resolve(jsonResp(RUNNING));
      return Promise.resolve(jsonResp(null, false, 500));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(() => <RestartOpenCode />);

    // The entry button is present and no restart POST has happened yet.
    const entry = await waitFor(() => {
      const b = document.querySelector("button.admin-btn") as HTMLButtonElement;
      expect(b).toBeTruthy();
      return b;
    });
    expect(entry.textContent).toContain("Restart OpenCode");
    expect(
      fetchMock.mock.calls.find((c) => (c[0] as string).includes("/vh/restart-opencode")),
    ).toBeUndefined();

    // Activating the entry swaps in RestartConfirm — still no POST.
    entry.click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeTruthy());
    expect(
      fetchMock.mock.calls.find((c) => (c[0] as string).includes("/vh/restart-opencode")),
    ).toBeUndefined();
  });

  it("fetches running-session data and renders the interruption warning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/running-sessions")) return Promise.resolve(jsonResp(RUNNING));
        return Promise.resolve(jsonResp(null, false, 500));
      }),
    );

    render(() => <RestartOpenCode />);
    (document.querySelector("button.admin-btn") as HTMLButtonElement).click();

    const confirm = await waitFor(() => {
      const el = document.querySelector(".ocu-confirm") as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    // Count + workspace-count copy both surface (fetched on RestartConfirm mount).
    await waitFor(() => expect(confirm.textContent).toContain("3 running sessions"));
    expect(confirm.textContent).toContain("across 2 workspaces");
  });

  it("Cancel does NOT call /vh/restart-opencode", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/vh/running-sessions")) return Promise.resolve(jsonResp(RUNNING));
      return Promise.resolve(jsonResp(null, false, 500));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(() => <RestartOpenCode />);
    (document.querySelector("button.admin-btn") as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeTruthy());

    // Cancel is the second button inside the confirm actions.
    const btns = document.querySelectorAll(".admin-confirm-btns button");
    expect(btns.length).toBe(2);
    (btns[1] as HTMLButtonElement).click(); // Cancel

    // Confirm panel is replaced by the entry; no restart POST was made.
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeNull());
    expect(
      fetchMock.mock.calls.find((c) => (c[0] as string).includes("/vh/restart-opencode")),
    ).toBeUndefined();
  });

  it("Confirm performs exactly ONE POST to /vh/restart-opencode", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/vh/running-sessions")) return Promise.resolve(jsonResp(RUNNING));
      if (url.includes("/vh/restart-opencode")) return Promise.resolve(jsonResp({}));
      return Promise.resolve(jsonResp(null, false, 500));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(() => <RestartOpenCode />);
    (document.querySelector("button.admin-btn") as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeTruthy());

    (document.querySelectorAll(".admin-confirm-btns button")[0] as HTMLButtonElement).click();

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) =>
        (c[0] as string).includes("/vh/restart-opencode"),
      );
      expect(calls.length).toBe(1);
    });
  });

  it("pending/disabled state prevents duplicate requests", async () => {
    // The restart POST never resolves → restarting() stays true for the test,
    // pinning the confirm button in its disabled "Restarting…" state.
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/vh/running-sessions")) return Promise.resolve(jsonResp(RUNNING));
      if (url.includes("/vh/restart-opencode")) return new Promise(() => {});
      return Promise.resolve(jsonResp(null, false, 500));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(() => <RestartOpenCode />);
    (document.querySelector("button.admin-btn") as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeTruthy());

    const confirmBtn = document.querySelectorAll(".admin-confirm-btns button")[0] as HTMLButtonElement;
    confirmBtn.click(); // begins the (never-resolving) POST

    // While pending the confirm button is disabled and reads "Restarting…".
    await waitFor(() => expect(confirmBtn.textContent).toContain("Restarting"));
    expect(confirmBtn.disabled).toBe(true);

    // A second activation must NOT start another POST — disabled buttons don't
    // dispatch click, and even a direct programmatic .click() is suppressed.
    confirmBtn.click();
    await Promise.resolve().then(() => Promise.resolve());
    const calls = fetchMock.mock.calls.filter((c) =>
      (c[0] as string).includes("/vh/restart-opencode"),
    );
    expect(calls.length).toBe(1);
  });

  it("renders the success result after a successful request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/running-sessions")) return Promise.resolve(jsonResp(RUNNING));
        if (url.includes("/vh/restart-opencode")) return Promise.resolve(jsonResp({}));
        return Promise.resolve(jsonResp(null, false, 500));
      }),
    );

    render(() => <RestartOpenCode />);
    (document.querySelector("button.admin-btn") as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeTruthy());
    (document.querySelectorAll(".admin-confirm-btns button")[0] as HTMLButtonElement).click();

    const result = await waitFor(() => {
      const el = document.querySelector(".ocu-restart-result") as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(result.textContent).toContain("OpenCode restarted");
  });

  it("renders the failure result when the POST is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/running-sessions")) return Promise.resolve(jsonResp(RUNNING));
        if (url.includes("/vh/restart-opencode")) return Promise.resolve(jsonResp(null, false, 500));
        return Promise.resolve(jsonResp(null, false, 500));
      }),
    );

    render(() => <RestartOpenCode />);
    (document.querySelector("button.admin-btn") as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeTruthy());
    (document.querySelectorAll(".admin-confirm-btns button")[0] as HTMLButtonElement).click();

    const result = await waitFor(() => {
      const el = document.querySelector(".ocu-restart-result") as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(result.textContent).toContain("Restart failed");
  });

  it("onRestarted fires after success; NOT on cancel or failure", async () => {
    const onRestarted = vi.fn();

    // --- Cancel: must NOT fire onRestarted. ---
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/running-sessions")) return Promise.resolve(jsonResp(RUNNING));
        return Promise.resolve(jsonResp({})); // would-be success (never reached)
      }),
    );
    const { unmount: u1 } = render(() => <RestartOpenCode onRestarted={onRestarted} />);
    (document.querySelector("button.admin-btn") as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeTruthy());
    (document.querySelectorAll(".admin-confirm-btns button")[1] as HTMLButtonElement).click(); // Cancel
    await Promise.resolve().then(() => Promise.resolve());
    expect(onRestarted).not.toHaveBeenCalled();
    u1();
    cleanup();

    // --- Failure: must NOT fire onRestarted. ---
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/running-sessions")) return Promise.resolve(jsonResp(RUNNING));
        if (url.includes("/vh/restart-opencode")) return Promise.resolve(jsonResp(null, false, 500));
        return Promise.resolve(jsonResp(null, false, 500));
      }),
    );
    render(() => <RestartOpenCode onRestarted={onRestarted} />);
    (document.querySelector("button.admin-btn") as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeTruthy());
    (document.querySelectorAll(".admin-confirm-btns button")[0] as HTMLButtonElement).click(); // Confirm (fails)
    await waitFor(() => expect(document.querySelector(".ocu-restart-result")).toBeTruthy());
    expect(onRestarted).not.toHaveBeenCalled();
    cleanup();

    // --- Success: fires onRestarted exactly once. ---
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/running-sessions")) return Promise.resolve(jsonResp(RUNNING));
        if (url.includes("/vh/restart-opencode")) return Promise.resolve(jsonResp({}));
        return Promise.resolve(jsonResp(null, false, 500));
      }),
    );
    render(() => <RestartOpenCode onRestarted={onRestarted} />);
    (document.querySelector("button.admin-btn") as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeTruthy());
    (document.querySelectorAll(".admin-confirm-btns button")[0] as HTMLButtonElement).click(); // Confirm (ok)
    await waitFor(() => expect(onRestarted).toHaveBeenCalledTimes(1));
  });

  it("onActiveChange emits true when confirm opens and false when it closes (no initial emit)", async () => {
    const onActiveChange = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/running-sessions")) return Promise.resolve(jsonResp(RUNNING));
        return Promise.resolve(jsonResp(null, false, 500));
      }),
    );

    render(() => <RestartOpenCode onActiveChange={onActiveChange} />);

    // Idle on mount: the effect is deferred (defer: true) so the initial idle
    // (false) state does NOT fire the callback — no spurious parent churn.
    await waitFor(() => expect(document.querySelector("button.admin-btn")).toBeTruthy());
    expect(onActiveChange).not.toHaveBeenCalled();

    // Open confirm → active becomes true.
    (document.querySelector("button.admin-btn") as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeTruthy());
    expect(onActiveChange).toHaveBeenLastCalledWith(true);

    // Cancel → active becomes false.
    (document.querySelectorAll(".admin-confirm-btns button")[1] as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeNull());
    expect(onActiveChange).toHaveBeenLastCalledWith(false);
  });

  it("applies the accent class to the entry button when accent is passed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResp(RUNNING))),
    );

    render(() => <RestartOpenCode accent />);
    const entry = document.querySelector("button.admin-btn") as HTMLButtonElement;
    expect(entry).toBeTruthy();
    expect(entry.classList.contains("accent")).toBe(true);
  });

  it("does NOT apply the accent class when accent is omitted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResp(RUNNING))),
    );

    render(() => <RestartOpenCode />);
    const entry = document.querySelector("button.admin-btn") as HTMLButtonElement;
    expect(entry).toBeTruthy();
    expect(entry.classList.contains("accent")).toBe(false);
  });
});

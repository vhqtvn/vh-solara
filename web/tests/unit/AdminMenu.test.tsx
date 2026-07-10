// @vitest-environment jsdom
//
// Menu-wiring assertions for the admin popup: "Restart OpenCode…" is a PERMANENT
// entry (the standalone restart affordance — present even at idle with no
// restartNeeded), and "Update OpenCode…" stays a STABLE, state-independent
// label that never flips with version state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

import AdminMenu from "../../src/components/AdminMenu";

const OC_VER_IDLE = {
  installed: "0.2.0",
  running: "0.2.0",
  latest: "0.2.0",
  updateAvailable: false,
  restartNeeded: false,
};

// Stub fetch for the menu's two version probes (/vh/version, /vh/opencode-version).
// Anything else (e.g. a stray running-sessions fetch) resolves harmlessly.
function stubVersions(oc = OC_VER_IDLE) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () =>
          url.includes("/vh/version") ? { version: "v1" } : url.includes("/vh/opencode-version") ? oc : null,
        text: async () => "",
      }),
    ),
  );
}

function menuBtn(label: string): HTMLButtonElement | undefined {
  const menu = document.querySelector(".admin-menu");
  if (!menu) return undefined;
  return Array.from(menu.querySelectorAll("button")).find((b) =>
    (b.textContent || "").trim() === label,
  ) as HTMLButtonElement | undefined;
}

describe("AdminMenu — permanent restart entry + stable update entry", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("permanently renders 'Restart OpenCode…' even at idle (no restartNeeded)", async () => {
    stubVersions(OC_VER_IDLE);
    render(() => <AdminMenu onClose={() => {}} />);

    const restart = await waitFor(() => {
      const b = menuBtn("Restart OpenCode…");
      expect(b).toBeTruthy();
      return b!;
    });
    expect(restart).toBeTruthy();
    // A conventional full-width .admin-btn row (no split/two-up pattern).
    expect(restart.classList.contains("admin-btn")).toBe(true);
  });

  it("keeps 'Update OpenCode…' as a stable, state-independent label", async () => {
    stubVersions(OC_VER_IDLE);
    render(() => <AdminMenu onClose={() => {}} />);

    const update = await waitFor(() => {
      const b = menuBtn("Update OpenCode…");
      expect(b).toBeTruthy();
      return b!;
    });
    // Stable: once version data resolves, the label is exactly "Update OpenCode…"
    // (it is "Checking…" only while unresolved — never version-dependent otherwise).
    expect(update.textContent).toBe("Update OpenCode…");
  });
});

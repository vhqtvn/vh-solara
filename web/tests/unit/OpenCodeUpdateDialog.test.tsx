// @vitest-environment jsdom
//
// Regression coverage for the OpenCode update dialog redesign:
//   • D2 — the install action lives in a STABLE slot: while npm version data is
//     unresolved the slot shows a loading indicator, NEVER a button whose label
//     would later flip (that was the flicker root cause). Once resolved, the
//     same slot holds the update/reinstall button — no layout shift.
//   • D4 — on completion the install log collapses to a compact result line and
//     is exposed on demand via a toggle.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

// Mock the install stream so runUpdate completes deterministically without a
// real HTTP stream. Each test overrides streamOpenCodeUpdate.mockImplementation.
const streamOpenCodeUpdate = vi.fn();
vi.mock("../../src/admin", () => ({
  streamOpenCodeUpdate: (...args: unknown[]) => streamOpenCodeUpdate(...args),
}));

import OpenCodeUpdateDialog from "../../src/components/OpenCodeUpdateDialog";

// Minimal Response-like object: the dialog only consumes .ok and .json().
function jsonResp(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => "" };
}
function withFetch(map: Record<string, unknown>) {
  return vi.fn((url: string) => {
    for (const key of Object.keys(map)) {
      if (url.includes(key)) return Promise.resolve(jsonResp(map[key]));
    }
    return Promise.resolve(jsonResp(null, false));
  });
}

const VER_UPDATE = { installed: "0.1.0", running: "0.1.0", latest: "0.2.0", updateAvailable: true, restartNeeded: false };
const VER_LATEST = { installed: "0.2.0", running: "0.2.0", latest: "0.2.0", updateAvailable: false, restartNeeded: false };
// Installed differs from running → restartNeeded. At idle this is the only
// state that offers Restart in the footer (offerRestart's idle branch).
const VER_RESTART = { installed: "0.2.0", running: "0.1.0", latest: "0.2.0", updateAvailable: false, restartNeeded: true };

// A footer restart entry is rendered by RestartOpenCode (the entry button reads
// "Restart OpenCode…"). Collected from the portaled dialog's footer so it does
// not match the install-area button or the Close button.
function footerRestartBtns(): HTMLButtonElement[] {
  const foot = document.querySelector(".ocu-foot");
  if (!foot) return [];
  return Array.from(foot.querySelectorAll("button")).filter((b) =>
    (b.textContent || "").includes("Restart OpenCode"),
  );
}

// The footer Close button (text exactly "Close"). Hidden (not rendered) while an
// install runs OR while the footer restart flow is active (confirm open / POST
// in-flight) — the focus-lock restored by M3.
function footerCloseBtn(): HTMLButtonElement | null {
  const foot = document.querySelector(".ocu-foot");
  if (!foot) return null;
  return (
    (Array.from(foot.querySelectorAll("button")).find(
      (b) => (b.textContent || "").trim() === "Close",
    ) as HTMLButtonElement | undefined) ?? null
  );
}

describe("OpenCodeUpdateDialog — stable action slot (D2) + collapsed log (D4)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    streamOpenCodeUpdate.mockReset();
  });

  it("shows a loading indicator (not a button) while version data is unresolved", async () => {
    // fetch never resolves → ver() stays pending.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector(".ocu-action-loading")).toBeTruthy();
    });
    // No action button is rendered in the slot while loading — the flicker bug
    // was a button that read "Reinstall latest" then flipped to "Update to …".
    expect(document.querySelector(".ocu-action-slot button")).toBeNull();
  });

  it("renders 'Update to {latest}' in the stable slot once an update is available", async () => {
    vi.stubGlobal("fetch", withFetch({ "/vh/opencode-version": VER_UPDATE }));
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    const btn = await waitFor(() => {
      const b = document.querySelector(".ocu-action-slot button") as HTMLButtonElement;
      expect(b).toBeTruthy();
      return b;
    });
    expect(btn.textContent).toContain("Update to 0.2.0");
    expect(btn.classList.contains("accent")).toBe(true);
  });

  it("renders 'Reinstall latest' (no accent) when already on the latest version", async () => {
    vi.stubGlobal("fetch", withFetch({ "/vh/opencode-version": VER_LATEST }));
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    const btn = await waitFor(() => {
      const b = document.querySelector(".ocu-action-slot button") as HTMLButtonElement;
      expect(b).toBeTruthy();
      return b;
    });
    expect(btn.textContent).toContain("Reinstall latest");
    expect(btn.classList.contains("accent")).toBe(false);
  });

  it("collapses the install log on completion and exposes it on demand", async () => {
    vi.stubGlobal("fetch", withFetch({ "/vh/opencode-version": VER_UPDATE }));
    streamOpenCodeUpdate.mockImplementation(async (append: (s: string) => void) => {
      append("[vh] update complete\n");
    });
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    const btn = await waitFor(() => {
      const b = document.querySelector(".ocu-action-slot button") as HTMLButtonElement;
      expect(b).toBeTruthy();
      return b;
    });
    btn.click();

    // Done: compact result line present, log collapsed by default.
    await waitFor(() => expect(document.querySelector(".ocu-ok")).toBeTruthy());
    expect(document.querySelector(".ocu-ok")!.textContent).toContain("Installed");
    expect(document.querySelector(".ocu-log")).toBeNull(); // collapsed by default
    expect(document.querySelector(".ocu-log-toggle")).toBeTruthy();

    // Reveal the log on demand.
    (document.querySelector(".ocu-log-toggle") as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelector(".ocu-log")).toBeTruthy());
    expect(document.querySelector(".ocu-log")!.textContent).toContain("update complete");
  });
});

describe("OpenCodeUpdateDialog — restart-offer gating + extracted RestartConfirm flow", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    streamOpenCodeUpdate.mockReset();
  });

  it("does NOT offer restart at idle when restartNeeded is false", async () => {
    vi.stubGlobal("fetch", withFetch({ "/vh/opencode-version": VER_LATEST }));
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    // Wait for the version readout to resolve (so offerRestart has stable input).
    await waitFor(() =>
      expect(document.querySelector(".ocu-install-vers")).toBeTruthy(),
    );
    // No restart entry in the footer at idle without restartNeeded.
    expect(footerRestartBtns().length).toBe(0);
  });

  it("offers restart at idle when restartNeeded is true", async () => {
    vi.stubGlobal("fetch", withFetch({ "/vh/opencode-version": VER_RESTART }));
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    const btn = await waitFor(() => {
      const b = footerRestartBtns()[0];
      expect(b).toBeTruthy();
      return b;
    });
    expect(btn.textContent).toContain("Restart OpenCode");
  });

  it("offers restart after a completed install (done) regardless of restartNeeded", async () => {
    vi.stubGlobal("fetch", withFetch({ "/vh/opencode-version": VER_UPDATE }));
    streamOpenCodeUpdate.mockImplementation(async (append: (s: string) => void) => {
      append("[vh] update complete\n");
    });
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    const installBtn = await waitFor(() => {
      const b = document.querySelector(".ocu-action-slot button") as HTMLButtonElement;
      expect(b).toBeTruthy();
      return b;
    });
    installBtn.click();
    // Done → offerRestart() is true (done branch) → footer restart entry shows.
    await waitFor(() => expect(document.querySelector(".ocu-ok")).toBeTruthy());
    expect(footerRestartBtns().length).toBe(1);
  });

  it("offers restart after a FAILED install (failed branch of offerRestart)", async () => {
    vi.stubGlobal("fetch", withFetch({ "/vh/opencode-version": VER_UPDATE }));
    // The server marks a failed install with the trailing sentinel line; the
    // dialog detects it and flips phase to "failed". offerRestart's failed
    // branch must still surface the restart entry so the operator can retry.
    streamOpenCodeUpdate.mockImplementation(async (append: (s: string) => void) => {
      append("[vh] update failed\n");
    });
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    const installBtn = await waitFor(() => {
      const b = document.querySelector(".ocu-action-slot button") as HTMLButtonElement;
      expect(b).toBeTruthy();
      return b;
    });
    installBtn.click();

    // Failed: the error result line renders AND offerRestart() is true (failed
    // branch) — the footer restart entry shows despite the install failing.
    await waitFor(() => expect(document.querySelector(".ocu-err")).toBeTruthy());
    expect(footerRestartBtns().length).toBe(1);
  });

  it("does NOT offer restart while an install is mid-flight (updating)", async () => {
    vi.stubGlobal("fetch", withFetch({ "/vh/opencode-version": VER_UPDATE }));
    // Stream appends a progress line then NEVER completes — phase stays
    // "updating" (runUpdate is blocked awaiting the stream).
    streamOpenCodeUpdate.mockImplementation(async (append: (s: string) => void) => {
      append("[vh] installing…\n");
      await new Promise(() => {});
    });
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    const installBtn = await waitFor(() => {
      const b = document.querySelector(".ocu-action-slot button") as HTMLButtonElement;
      expect(b).toBeTruthy();
      return b;
    });
    installBtn.click();

    // Updating: the live log streams AND the install button is disabled, but
    // offerRestart() excludes the updating phase — no footer restart entry.
    await waitFor(() =>
      expect(document.querySelector(".ocu-log")?.textContent).toContain("installing"),
    );
    expect(
      (document.querySelector(".ocu-action-slot button") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(footerRestartBtns().length).toBe(0);
    // Close is also hidden during updating (focus-lock invariant).
    expect(footerCloseBtn()).toBeNull();
  });

  it("activating the footer restart entry traverses RestartConfirm before any POST", async () => {
    // /vh/running-sessions is fetched by RestartConfirm on mount; wire it so the
    // warning resolves. The restart POST itself is left unreachable (Cancel).
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/opencode-version"))
          return Promise.resolve(jsonResp(VER_RESTART));
        if (url.includes("/vh/running-sessions"))
          return Promise.resolve(jsonResp({ count: 2, workspaces: [{ dir: "/w", count: 2 }] }));
        return Promise.resolve(jsonResp(null, false));
      }),
    );
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    const entry = await waitFor(() => {
      const b = footerRestartBtns()[0];
      expect(b).toBeTruthy();
      return b;
    });
    entry.click();

    // The extracted flow still surfaces RestartConfirm (session-interrupt gate).
    const confirm = await waitFor(() => {
      const el = document.querySelector(".ocu-confirm") as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    await waitFor(() => expect(confirm.textContent).toContain("2 running sessions"));
  });

  it("install/reinstall behavior does not regress (reinstall label still resolves)", async () => {
    vi.stubGlobal("fetch", withFetch({ "/vh/opencode-version": VER_LATEST }));
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    const btn = await waitFor(() => {
      const b = document.querySelector(".ocu-action-slot button") as HTMLButtonElement;
      expect(b).toBeTruthy();
      return b;
    });
    expect(btn.textContent).toContain("Reinstall latest");
  });

  it("M3: hides the footer Close button while RestartConfirm is open and restores it on cancel (no POST)", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("/vh/opencode-version"))
        return Promise.resolve(jsonResp(VER_RESTART));
      if (url.includes("/vh/running-sessions"))
        return Promise.resolve(jsonResp({ count: 0, workspaces: [] }));
      return Promise.resolve(jsonResp(null, false));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    // Footer restart entry is offered (idle + restartNeeded via VER_RESTART).
    const entry = await waitFor(() => {
      const b = footerRestartBtns()[0];
      expect(b).toBeTruthy();
      return b;
    });
    // Close is visible before activating the restart flow.
    expect(footerCloseBtn()).not.toBeNull();

    // Activate the restart entry → RestartConfirm opens → Close is hidden
    // (focus-lock so the confirm owns the footer).
    entry.click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeTruthy());
    expect(footerCloseBtn()).toBeNull();

    // Cancel the confirm → Close reappears.
    (document.querySelectorAll(".admin-confirm-btns button")[1] as HTMLButtonElement).click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeNull());
    expect(footerCloseBtn()).not.toBeNull();

    // No restart POST occurred on this cancel path.
    expect(
      fetchMock.mock.calls.find((c) => (c[0] as string).includes("/vh/restart-opencode")),
    ).toBeUndefined();
  });
});

// Changelog ("What's new") panel — a collapsible, lazily-fetched aid that must
// NEVER block the update button. CSS-module classes are hashed, so we query by
// semantic text (the repo convention; see OpenCodeHealthPanel.test.tsx).
const CL_DATA = {
  available: true,
  from: "0.1.0",
  to: "0.2.0",
  releases: [
    {
      tag: "v0.2.0",
      name: "v0.2.0",
      date: "2026-07-10T00:00:00Z",
      url: "https://example.com/v0.2.0",
      highlights: [],
      // Desktop deliberately BEFORE Core in source order: the CLIENT must
      // re-sort so Core/SDK/Extensions render first (section-priority grouping).
      sections: [
        {
          title: "Desktop",
          // A Desktop item whose text matches a migration token: the SERVER
          // must NOT flag it (heuristic is gated to Core/SDK/Extensions), so
          // mayAffectYou is false here — no badge should render.
          items: [{ text: "Migration of the settings folder layout", mayAffectYou: false }],
        },
        {
          title: "Core",
          items: [
            { text: "Removed the legacy --old-flag config switch", mayAffectYou: true },
            { text: "Added a model-specific temperature override", mayAffectYou: false },
          ],
        },
      ],
    },
  ],
};

// The "What's new" toggle button (text contains "new (since"). The panel is
// collapsed by default; clicking it lazily fetches the changelog.
function changelogToggle(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    /new \(since/.test(b.textContent || ""),
  ) as HTMLButtonElement | undefined;
}

// The panel container is the toggle button's parent (the .panel div). Used to
// scope text-order assertions (Core before Desktop) without depending on the
// hashed CSS-module class.
function changelogPanel(): HTMLElement | null {
  const t = changelogToggle();
  return t ? t.parentElement : null;
}

describe("OpenCodeUpdateDialog — changelog (What's new) panel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    streamOpenCodeUpdate.mockReset();
  });

  it("is collapsed by default, opens on toggle, and closes on toggle again", async () => {
    vi.stubGlobal(
      "fetch",
      withFetch({
        "/vh/opencode-version": VER_UPDATE,
        "/vh/opencode-changelog": CL_DATA,
      }),
    );
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    // Wait for the version readout to resolve so the panel toggle renders.
    const toggle = await waitFor(() => {
      const t = changelogToggle();
      expect(t).toBeTruthy();
      return t!;
    });
    // Collapsed by default: no changelog body content (no release tag, no
    // loading line) is present, and no changelog fetch has fired yet.
    expect(document.body.textContent).not.toContain("Loading changelog");
    expect(document.body.textContent).not.toContain("v0.2.0");

    // Open the panel → lazy fetch fires → release content appears.
    toggle.click();
    await waitFor(() => expect(document.body.textContent).toContain("v0.2.0"));

    // Close the panel → body content is removed again.
    toggle.click();
    await waitFor(() => expect(document.body.textContent).not.toContain("v0.2.0"));
  });

  it("groups Core/SDK/Extensions BEFORE Desktop/TUI (section priority)", async () => {
    vi.stubGlobal(
      "fetch",
      withFetch({
        "/vh/opencode-version": VER_UPDATE,
        "/vh/opencode-changelog": CL_DATA,
      }),
    );
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    const toggle = await waitFor(() => {
      const t = changelogToggle();
      expect(t).toBeTruthy();
      return t!;
    });
    toggle.click();

    // Wait for the Core section title to render, then assert document order:
    // Core (high priority) renders BEFORE Desktop (de-emphasized) even though
    // the source fixture lists Desktop first.
    await waitFor(() => expect(changelogPanel()?.textContent).toContain("Core"));
    const txt = changelogPanel()!.textContent || "";
    expect(txt.indexOf("Core")).toBeGreaterThanOrEqual(0);
    expect(txt.indexOf("Desktop")).toBeGreaterThanOrEqual(0);
    expect(txt.indexOf("Core")).toBeLessThan(txt.indexOf("Desktop"));
  });

  it("renders the '⚠ may affect you' badge only on flagged Core items, not on Desktop items", async () => {
    vi.stubGlobal(
      "fetch",
      withFetch({
        "/vh/opencode-version": VER_UPDATE,
        "/vh/opencode-changelog": CL_DATA,
      }),
    );
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    const toggle = await waitFor(() => {
      const t = changelogToggle();
      expect(t).toBeTruthy();
      return t!;
    });
    toggle.click();
    await waitFor(() => expect(changelogPanel()?.textContent).toContain("Core"));

    // Exactly one badge overall (the Core "Removed …" item). The Desktop item,
    // despite matching a migration token, is NOT flagged by the server.
    const badgeMatches = (document.body.textContent || "").match(/may affect you/g) || [];
    expect(badgeMatches.length).toBe(1);

    // Per-item precision: inspect each <li> in the panel (highlights are empty
    // in this fixture, so every <li> is a section item).
    const items = Array.from(changelogPanel()!.querySelectorAll("li"));
    const desktopItem = items.find((li) => /Migration of the settings folder/.test(li.textContent || ""));
    const coreFlagged = items.find((li) => /Removed the legacy/.test(li.textContent || ""));
    expect(desktopItem).toBeTruthy();
    expect(coreFlagged).toBeTruthy();
    expect(desktopItem!.textContent).not.toMatch(/may affect you/);
    expect(coreFlagged!.textContent).toMatch(/may affect you/);
  });

  it("degrades to a quiet 'Changelog unavailable' line on fetch failure and leaves the update button usable", async () => {
    // Changelog fetch returns unavailable; version still resolves normally.
    vi.stubGlobal(
      "fetch",
      withFetch({
        "/vh/opencode-version": VER_UPDATE,
        "/vh/opencode-changelog": { available: false, error: "changelog unavailable" },
      }),
    );
    render(() => <OpenCodeUpdateDialog onClose={() => {}} />);

    const toggle = await waitFor(() => {
      const t = changelogToggle();
      expect(t).toBeTruthy();
      return t!;
    });
    toggle.click();
    await waitFor(() => expect(document.body.textContent).toContain("Changelog unavailable"));

    // The update button is STILL rendered and usable — the changelog failure is
    // NOT a gate. (Confirms the core "never block the update button" invariant.)
    const actionBtn = document.querySelector(".ocu-action-slot button") as HTMLButtonElement;
    expect(actionBtn).toBeTruthy();
    expect(actionBtn.textContent).toContain("Update to 0.2.0");
    expect(actionBtn.disabled).toBe(false);
  });
});

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

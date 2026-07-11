// @vitest-environment jsdom
//
// Menu-wiring assertions for the restructured admin popup: only the Diagnostics
// section carries an .admin-section-head; OpenCode and VH Solara are labeled via
// their .admin-ver rows. "Update" is a STABLE, state-independent label, and
// "Restart" is a PERMANENT entry that
// opens a centered portaled dialog hosting the shared RestartOpenCode in
// autoConfirm mode — so the session-aware confirmation (.ocu-confirm) shows
// immediately, with no redundant entry-button click.
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

describe("AdminMenu — three sections, stable Update, centered Restart dialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("Diagnostics section-head remains; OpenCode/VH Solara labeled via version rows", async () => {
    stubVersions(OC_VER_IDLE);
    render(() => <AdminMenu onClose={() => {}} />);

    await waitFor(() => expect(menuBtn("Update")).toBeTruthy());
    // Only the Diagnostics section-head remains; the OpenCode and VH Solara
    // sections are now labeled by their .admin-ver first-span.
    const heads = Array.from(document.querySelectorAll(".admin-section-head")).map(
      (h) => (h.textContent || "").trim(),
    );
    expect(heads).toEqual(["Diagnostics"]);
    const verLabels = Array.from(document.querySelectorAll(".admin-ver")).map((row) => {
      const first = row.querySelector("span");
      return (first?.textContent || "").trim();
    });
    expect(verLabels).toEqual(expect.arrayContaining(["OpenCode", "VH Solara"]));
  });

  it("keeps 'Update' as a stable, state-independent label", async () => {
    stubVersions(OC_VER_IDLE);
    render(() => <AdminMenu onClose={() => {}} />);

    const update = await waitFor(() => {
      const b = menuBtn("Update");
      expect(b).toBeTruthy();
      return b!;
    });
    // Stable: once version data resolves, the label is exactly "Update" (it is
    // "Checking…" only while unresolved — never version-dependent otherwise).
    expect(update.textContent).toBe("Update");
  });

  it("permanently renders 'Restart' even at idle and opens the session-aware confirm on click", async () => {
    stubVersions(OC_VER_IDLE);
    render(() => <AdminMenu onClose={() => {}} />);

    const restart = await waitFor(() => {
      const b = menuBtn("Restart");
      expect(b).toBeTruthy();
      return b!;
    });
    expect(restart).toBeTruthy();
    expect(restart.classList.contains("admin-btn")).toBe(true);

    // No restart confirm before activation.
    expect(document.querySelector(".ocu-confirm")).toBeNull();

    // Activating the entry opens the centered portaled dialog, which mounts
    // RestartOpenCode in autoConfirm mode → RestartConfirm shows immediately,
    // with no second entry-button click inside the dialog.
    restart.click();
    await waitFor(() => expect(document.querySelector(".ocu-confirm")).toBeTruthy());
  });
});

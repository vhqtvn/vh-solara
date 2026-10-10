// @vitest-environment jsdom
//
// TerminalDock tab-kill disposal (send-net-resilience cluster D, defer
// D-4b-3 + d-F5): the dock tab's × KILLS the server shell (/vh/term/kill +
// removeTermTab). Killing a shell must also dispose that tab's compose-store
// entry — held text can never reach a dead shell, and a same-id shell
// spawned later is a NEW shell that must not inherit stale holds. Without
// the disposal, killed/closed tabs leaked their (dir, termId) store entry
// for the whole SPA session (the d-F5 "kill-hook cleanup" requirement).
//
// Mirrors TerminalDock.zoom.test.tsx's harness (matchMedia hoisted stub,
// TerminalPane stubbed inert); sync + termApi are mocked so the kill lands
// on known state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";

vi.hoisted(() => {
  const w = globalThis as unknown as { matchMedia?: unknown };
  w.matchMedia = (query: string) => ({
    matches: /721/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
});

vi.mock("../../src/sync", async () => {
  const { createSignal } = await import("solid-js");
  const [projectDir] = createSignal("/repo");
  return { projectDir, selectedId: () => null, state: { sessions: {} } };
});

vi.mock("../../src/components/TerminalPane", () => ({
  default: () => <div class="term-pane-stub" />,
}));

vi.mock("../../src/termApi", () => ({
  killTerm: vi.fn(async () => true),
}));

import TerminalDock from "../../src/components/TerminalDock";
import { setTermOpen } from "../../src/ui";
import { newAdHocTab, termTabs } from "../../src/termTabs";
import { killTerm } from "../../src/termApi";
import { disposeTermCompose, loadTermCompose, saveTermCompose } from "../../src/lib/termCompose";

beforeEach(() => {
  localStorage.clear();
  setTermOpen(true);
});

afterEach(() => {
  cleanup();
  setTermOpen(false);
  vi.clearAllMocks();
});

// The kill button for the tab whose label text is `title` (the strip also
// has a shared tab whose kill button must NOT be hit by these tests).
function killButtonFor(container: HTMLElement, title: string): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const tab = Array.from(container.querySelectorAll<HTMLElement>(".term-tab")).find((t) =>
      t.querySelector(".term-tab-label")?.textContent === title,
    );
    const b = tab?.querySelector<HTMLButtonElement>(".term-tab-kill");
    if (!b) throw new Error(`kill button for ${title} not mounted`);
    return b;
  });
}

describe("TerminalDock.killTab disposes the compose store entry (D-4b-3 kill hook)", () => {
  it("killing a tab kills the server shell AND drops its held text; sibling tabs keep theirs", async () => {
    // Seed an ad-hoc tab (beyond shared) with held compose text.
    newAdHocTab("/repo");
    const adhocTabs = termTabs("/repo").filter((t) => t.id.startsWith("t:"));
    const adhoc = adhocTabs[adhocTabs.length - 1];
    expect(adhoc).toBeDefined();
    saveTermCompose("/repo", adhoc.id, "held on the killed tab");
    saveTermCompose("/repo", "shared", "held on the shared shell");

    const { container } = render(() => <TerminalDock />);
    // Activate shared so the killed tab is a BACKGROUND tab (the leak shape:
    // no pane is mounted for it, so only the kill hook can dispose).
    const sharedLabel = Array.from(container.querySelectorAll<HTMLButtonElement>(".term-tab-label"))
      .find((b) => b.textContent === "Shell")!;
    fireEvent.click(sharedLabel);
    const killBtn = await killButtonFor(container, adhoc.title);

    fireEvent.click(killBtn);

    // The server shell kill was issued for the dead tab…
    await waitFor(() => {
      expect(killTerm).toHaveBeenCalledWith("/repo", adhoc.id);
    });
    // …the tab is gone from the strip…
    await waitFor(() => {
      expect(container.textContent).not.toContain("Shell 2");
    });
    // …and its compose entry is DISPOSED while the shared shell's survives.
    expect(loadTermCompose("/repo", adhoc.id)).toBe("");
    expect(loadTermCompose("/repo", "shared")).toBe("held on the shared shell");
  });

  it("kill disposal holds even when the kill POST fails (gesture decided: the text is dead)", async () => {
    vi.mocked(killTerm).mockResolvedValue(false);
    newAdHocTab("/repo");
    const adhocTabs = termTabs("/repo").filter((t) => t.id.startsWith("t:"));
    const adhoc = adhocTabs[adhocTabs.length - 1];
    saveTermCompose("/repo", adhoc.id, "held while offline");

    const { container } = render(() => <TerminalDock />);
    const killBtn = await killButtonFor(container, adhoc.title);
    fireEvent.click(killBtn);
    await waitFor(() => {
      expect(loadTermCompose("/repo", adhoc.id)).toBe("");
    });
    expect(killTerm).toHaveBeenCalledWith("/repo", adhoc.id);
  });
});

// Direct API corroboration for the same lifecycle (the dock sites above call
// this under the hood; this pins the exported seam itself in a dock context).
describe("disposeTermCompose seam", () => {
  it("is exported and keyed identically to save/load", () => {
    saveTermCompose("/repo", "shared", "x");
    disposeTermCompose("/repo", "shared");
    expect(loadTermCompose("/repo", "shared")).toBe("");
  });
});

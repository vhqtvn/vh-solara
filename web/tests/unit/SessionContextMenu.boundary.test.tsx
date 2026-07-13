// @vitest-environment jsdom
// Targeted display/raw boundary tests for the session context menu. The tree's
// boundary test (SessionTree.test.tsx) covers visible/tooltip transform +
// search-by-raw vs search-by-display. This file pins the three OPERATIONAL
// boundaries the unit test didn't reach: the Copy Title payload, the rename
// input seed, and the export call — all must keep the RAW title even when a
// nameReplacement display rule is active. The menu is opened with the raw
// title (as it is in production) and each action is asserted to receive raw.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { setState, setSelectedIdRaw } from "../../src/sync/store";
import type { Session } from "../../src/types";
import SessionContextMenu from "../../src/components/SessionContextMenu";
import {
  closeArchiveConfirm,
  closeSessionMenu,
  openSessionMenu,
} from "../../src/sessionMenu";
import { __resetPinnedForTest } from "../../src/sidebar";
import { setNameReplacements } from "../../src/projectSettings";
import { exportSessionMarkdown } from "../../src/export";

// Mock the export module so we can assert the RAW title reaches it without
// triggering a real fetch + download. Scoped to this file (the Move up/down
// test file is untouched).
vi.mock("../../src/export", () => ({
  exportSessionMarkdown: vi.fn().mockResolvedValue(true),
}));
const exportMock = vi.mocked(exportSessionMarkdown);

const RAW_TITLE = "[[X]] work";
const SESSION_ID = "sx";

beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("activity", reconcile({}));
  setState("unread", reconcile({}));
  setSelectedIdRaw(null);
  localStorage.clear();
  __resetPinnedForTest();
  closeSessionMenu();
  closeArchiveConfirm();
  // A display rule IS active during these tests — the point is that the
  // operational boundaries stay raw regardless. Reset after each test so the
  // rule never leaks into a sibling file's module state.
  setNameReplacements([{ pattern: "\\[\\[X\\]\\]", replacement: "Y", flags: "g" }]);
  exportMock.mockClear();
});

afterEach(() => {
  setNameReplacements([]);
  cleanup();
});

function putSession(s: Session): void {
  setState("sessions", s.id, s);
}

// Open the positioned (mouse) menu for a session and resolve once Items render.
async function openMenu(container: HTMLElement) {
  openSessionMenu(SESSION_ID, RAW_TITLE, 10, 10);
  await waitFor(() => {
    expect(container.querySelector(".ctxm-menu")).not.toBeNull();
  });
}

// Find a menu item button by exact trimmed text (avoids the /Title/ regex
// matching both "Title" and "Title + id").
function itemByText(container: HTMLElement, text: string): HTMLButtonElement {
  const btn = (
    Array.from(container.querySelectorAll("button.ctxm-item")) as HTMLButtonElement[]
  ).find((b) => (b.textContent ?? "").trim() === text);
  if (!btn) throw new Error(`no .ctxm-item with text "${text}"`);
  return btn;
}

describe("SessionContextMenu display/raw boundary", () => {
  it("Copy Title writes the RAW title to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    putSession({ id: SESSION_ID, title: RAW_TITLE, time: { updated: 1 } } as Session);
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement);

    fireEvent.click(itemByText(container as unknown as HTMLElement, "Title"));

    expect(writeText).toHaveBeenCalledTimes(1);
    // RAW — the display rule ([[X]]→Y) must NOT reach the clipboard.
    expect(writeText).toHaveBeenCalledWith(RAW_TITLE);
    expect(writeText).not.toHaveBeenCalledWith("Y work");
  });

  it("Rename seeds the input with the RAW title", async () => {
    putSession({ id: SESSION_ID, title: RAW_TITLE, time: { updated: 1 } } as Session);
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement);

    fireEvent.click(itemByText(container as unknown as HTMLElement, "Rename…"));

    // The prompt dialog mounts with the input seeded from the raw title.
    const input = (await waitFor(() => {
      const el = container.querySelector(".vh-prompt-input") as HTMLInputElement | null;
      expect(el).toBeTruthy();
      return el!;
    })) as HTMLInputElement;
    // RAW — the input shows the canonical title, not the display form.
    expect(input.value).toBe(RAW_TITLE);
    expect(input.value).not.toBe("Y work");
  });

  it("Export receives the RAW title (heading + filename derive from raw)", async () => {
    putSession({ id: SESSION_ID, title: RAW_TITLE, time: { updated: 1 } } as Session);
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement);

    fireEvent.click(itemByText(container as unknown as HTMLElement, "Export .md"));

    await waitFor(() => {
      expect(exportMock).toHaveBeenCalledTimes(1);
    });
    // RAW — exportSessionMarkdown(id, title); the title drives both the
    // `# <title>` heading and the slug filename, so it must stay canonical.
    expect(exportMock).toHaveBeenCalledWith(SESSION_ID, RAW_TITLE);
    expect(exportMock).not.toHaveBeenCalledWith(SESSION_ID, "Y work");
  });
});

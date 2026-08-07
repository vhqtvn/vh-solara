// @vitest-environment jsdom
//
// Component test for the Archive menu button's tap-vs-hold wiring in
// SessionContextMenu.tsx. The standalone Delete menu item was REMOVED; a
// long-press (hold) on the Archive button is now the only entry to the
// irreversible Delete confirm. The wiring mirrors the Copy button's hold
// pattern (MessageRow.tsx → classifyHold in ../lib/copyHold):
//
//   onPointerDown -> records Date.now() as archiveDownAt.
//   onClick       -> classifyHold(archiveDownAt, now):
//                     - "tap"  (< HOLD_THRESHOLD_MS, OR downAt===0 keyboard
//                                sentinel) -> openArchiveConfirm (safe default)
//                     - "hold" (>= HOLD_THRESHOLD_MS)             -> openDeleteConfirm
//   onContextMenu -> preventDefault only (suppress the native menu on Android
//                    touch long-press); it performs no action, so — unlike the
//                    Copy button, whose contextmenu itself copies thinking —
//                    there is no contextmenu/click double-fire to dedupe.
//
// jsdom fires events synchronously, so the elapsed gap between pointerdown and
// click is microseconds (< 450ms) -> "tap" by default; the hold case drives a
// controlled Date.now to cross the 450ms threshold. Mirrors ChatViewCopyHold.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { setState, setSelectedIdRaw } from "../../src/sync/store";
import type { Session } from "../../src/types";
import SessionContextMenu from "../../src/components/SessionContextMenu";
import {
  closeArchiveConfirm,
  closeDeleteConfirm,
  closeSessionMenu,
  openSessionMenu,
} from "../../src/sessionMenu";
import { __resetPinnedForTest } from "../../src/pins";
import { HOLD_THRESHOLD_MS } from "../../src/lib/copyHold";

// Controlled, bumpable clock — a hold is elapsed >= HOLD_THRESHOLD_MS (450).
// Mirrors ChatViewCopyHold: spy Date.now so the pointerdown→click gap can cross
// the classifier threshold deterministically.
let clock: number;

beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("activity", reconcile({}));
  setState("unread", reconcile({}));
  setSelectedIdRaw(null);
  localStorage.clear();
  __resetPinnedForTest();
  closeSessionMenu();
  closeArchiveConfirm();
  closeDeleteConfirm();
  clock = 1_700_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function putSession(s: Session): void {
  setState("sessions", s.id, s);
}

// Open the positioned (mouse) menu for a session and resolve once Items render.
async function openMenu(container: HTMLElement, id: string, title: string) {
  openSessionMenu(id, title, 10, 10);
  await waitFor(() => {
    expect(container.querySelector(".ctxm-menu")).not.toBeNull();
  });
}

// The Archive button is the single .ctxm-item.danger now (the standalone Delete
// menu item was removed). Located by its visible "Archive…" text so the test
// stays accurate even if the .danger class is shared with a future item.
function archiveButton(container: HTMLElement): HTMLButtonElement {
  const btn = (
    Array.from(container.querySelectorAll("button.ctxm-item.danger")) as HTMLButtonElement[]
  ).find((b) => /Archive/.test(b.textContent ?? ""));
  if (!btn) throw new Error("Archive button (.ctxm-item.danger /Archive/) not rendered");
  return btn;
}

function archiveDialog(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.dialog.confirm[aria-label="Confirm archive"]');
}
function deleteDialog(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.dialog.confirm[aria-label="Confirm delete"]');
}

describe("SessionContextMenu Archive button — tap/hold (long-press → delete)", () => {
  it("tap (elapsed < HOLD_THRESHOLD_MS) opens the Archive confirm, not Delete", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    const btn = archiveButton(container as unknown as HTMLElement);
    fireEvent.pointerDown(btn);
    // No clock advance -> elapsed ~0 -> classifyHold returns "tap".
    fireEvent.click(btn);

    await waitFor(() => expect(archiveDialog(container as unknown as HTMLElement)).not.toBeNull());
    // A tap MUST NOT open the destructive Delete confirm.
    expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
  });

  it("hold (elapsed >= HOLD_THRESHOLD_MS) opens the Delete confirm with the destructive .danger class", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    const btn = archiveButton(container as unknown as HTMLElement);
    fireEvent.pointerDown(btn);
    clock += HOLD_THRESHOLD_MS; // cross the 450ms threshold -> classifyHold "hold".
    fireEvent.click(btn);

    // The Delete confirm carries the destructive .danger modifier.
    await waitFor(() =>
      expect(
        container.querySelector('.dialog.confirm.danger[aria-label="Confirm delete"]'),
      ).not.toBeNull(),
    );
    // A hold MUST NOT open the recoverable Archive confirm.
    expect(archiveDialog(container as unknown as HTMLElement)).toBeNull();
  });

  it("keyboard activation (no pointerdown → downAt===0 sentinel) opens Archive (safe default)", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    const btn = archiveButton(container as unknown as HTMLElement);
    // No pointerdown -> archiveDownAt stays at its initial 0 -> classifyHold(0,
    // now) returns "tap" (the keyboard/programmatic-activation sentinel). This
    // is the load-bearing safe-default: Enter/Space can never accidentally open
    // the destructive Delete confirm.
    fireEvent.click(btn);

    await waitFor(() => expect(archiveDialog(container as unknown as HTMLElement)).not.toBeNull());
    expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
  });

  it("the standalone Delete menu button is no longer rendered (long-press is the only delete entry)", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    const items = Array.from(
      container.querySelectorAll("button.ctxm-item"),
    ) as HTMLButtonElement[];
    const deleteItem = items.find((b) => /Delete/.test(b.textContent ?? ""));
    expect(deleteItem).toBeUndefined();
    // Sanity: Archive is still present as a menu item.
    const archiveItem = items.find((b) => /Archive/.test(b.textContent ?? ""));
    expect(archiveItem).toBeTruthy();
  });

  it("the Archive confirm does NOT carry the destructive .danger class (only Delete does)", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    // Tap -> Archive confirm (the recoverable caution variant).
    const btn = archiveButton(container as unknown as HTMLElement);
    fireEvent.pointerDown(btn);
    fireEvent.click(btn);

    await waitFor(() => expect(archiveDialog(container as unknown as HTMLElement)).not.toBeNull());
    const ad = archiveDialog(container as unknown as HTMLElement) as HTMLElement;
    expect(ad.classList.contains("danger")).toBe(false);
  });
});

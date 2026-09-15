// @vitest-environment jsdom
//
// Component test for the Archive menu button's tap-vs-hold wiring in
// SessionContextMenu.tsx. The standalone Delete menu item was REMOVED; a
// long-press (hold) on the Archive button is now the only entry to the
// irreversible Delete confirm — and it opens the MOMENT the hold reaches
// HOLD_THRESHOLD_MS (timer early-trigger) while the button is still pressed:
//
//   onPointerDown -> records Date.now() as archiveDownAt AND arms a
//                    HOLD_THRESHOLD_MS window.setTimeout that opens the Delete
//                    confirm early (no release needed).
//   timer fires   -> openDeleteConfirm(...) + archiveHoldFired = true (the
//                    gesture is consumed; the release click opens nothing
//                    extra). openDeleteConfirm also closes the menu, so the
//                    button unmounts under the still-pressed pointer.
//   onClick       -> cancels any pending timer; consumes the moved flag
//                    FIRST (a dragged-off gesture opens NOTHING — not even
//                    Archive); no-op if archiveHoldFired; otherwise
//                    classifyHold(archiveDownAt, now):
//                      - "tap"  (< HOLD_THRESHOLD_MS, OR downAt===0 keyboard
//                                 sentinel) -> openArchiveConfirm (safe default)
//                      - "hold" (>= HOLD_THRESHOLD_MS) -> openDeleteConfirm
//                    This click-time classification STAYS as the deterministic
//                    jank fallback: if the timer stalls past the click, elapsed
//                    wall-clock still classifies the hold. This is NOT the
//                    abandoned timer-race classification scheme (copyHold.ts):
//                    whichever path runs first consumes the gesture, so the two
//                    paths agree and exactly one dialog opens.
//   cleanup       -> pointerup / pointercancel / pointerleave (drag-off) /
//                    blur cancel the timer; pointerleave, pointercancel, and
//                    blur ALSO reset archiveDownAt (an abandoned gesture must
//                    not leave a stale timestamp behind — otherwise a
//                    re-entry + release, or a later keyboard Enter, would
//                    classify off it as "hold" → Delete); pointermove beyond
//                    ARCHIVE_HOLD_SLOP_PX mid-gesture does the same and sets
//                    the moved flag (touch implicit capture suppresses
//                    pointerleave entirely, so the slop path IS the touch
//                    drag-off half — jsdom cannot emulate implicit capture,
//                    which is why these pointermove tests are the real-touch
//                    coverage); pointerup clears ONLY the timer (the
//                    timestamp must survive until click classification —
//                    the jank fallback depends on it); menu close unmounts
//                    <Items> and onCleanup cancels the timer (no Delete
//                    confirm pops after the menu is gone).
//   onContextMenu -> preventDefault only (suppress the native menu on Android
//                    touch long-press); it performs no action, so — unlike the
//                    Copy button, whose contextmenu itself copies thinking —
//                    there is no contextmenu/click double-fire to dedupe.
//
// Two clock regimes, chosen per test:
//   - Controlled Date.now (beforeEach spy, real timers): tap, hold-at-click
//     (jank fallback), and keyboard cases. jsdom fires events synchronously, so
//     the pointerdown→click gap is microseconds and the real 450ms timer armed
//     at pointerdown never fires mid-test — the click handler must cancel it,
//     which these tests exercise implicitly (a stray timer would pop the
//     Delete confirm during a later test's real-time window).
//   - vi.useFakeTimers({ now: clock }): fakes setTimeout AND Date.now on one
//     shared timeline for the timer-path cases — hold-without-release, and the
//     cancellation cases (drag-off, pointercancel, blur, menu close).
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
// the classifier threshold deterministically. Tests that call
// vi.useFakeTimers({ now: clock }) supersede this spy with the fake clock.
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

// jsdom (as of v25) does not implement window.PointerEvent, so
// @testing-library's fireEvent.pointer* silently falls back to the generic
// Event constructor and DROPS coordinate init — e.clientX reads undefined
// and the slop math NaNs out. The slop-cancel tests need real coordinates,
// so coord-carrying pointer events are dispatched as MouseEvent with the
// pointer* type string (dispatch/listener matching is type-based, and
// MouseEvent carries clientX/clientY). Real browsers always provide both
// on PointerEvent; this shim only exists for the fake environment.
function firePointerWithCoords(el: Element, type: string, x: number, y: number) {
  el.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  );
}

describe("SessionContextMenu Archive button — tap/hold (long-press → delete)", () => {
  it("tap (elapsed < HOLD_THRESHOLD_MS) opens the Archive confirm, not Delete", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    const btn = archiveButton(container as unknown as HTMLElement);
    fireEvent.pointerDown(btn); // arms the real 450ms early-trigger timer…
    // No clock advance -> elapsed ~0 -> classifyHold returns "tap"; the click
    // handler must also CANCEL the timer armed above (a stray timer would pop
    // the Delete confirm ~450ms later).
    fireEvent.click(btn);

    await waitFor(() => expect(archiveDialog(container as unknown as HTMLElement)).not.toBeNull());
    // A tap MUST NOT open the destructive Delete confirm.
    expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
  });

  it("hold WITHOUT release: crossing HOLD_THRESHOLD_MS opens the Delete confirm immediately (timer early-trigger)", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    // Fake timers take over BOTH setTimeout and Date.now so the early-trigger
    // timer and the gesture clock share one timeline.
    vi.useFakeTimers({ now: clock });
    try {
      const btn = archiveButton(container as unknown as HTMLElement);
      fireEvent.pointerDown(btn);
      // Still pressed — advance past the threshold with NO pointerup/click.
      await vi.advanceTimersByTimeAsync(HOLD_THRESHOLD_MS);
      // The Delete confirm carries the destructive .danger modifier and is
      // already open while the button is (conceptually) still pressed.
      expect(
        container.querySelector('.dialog.confirm.danger[aria-label="Confirm delete"]'),
      ).not.toBeNull();
      // The hold MUST NOT open the recoverable Archive confirm.
      expect(archiveDialog(container as unknown as HTMLElement)).toBeNull();
      // openDeleteConfirm closed the menu, so the button unmounted under the
      // press — the release click cannot re-enter via event delegation.
      expect(container.querySelector(".ctxm-menu")).toBeNull();

      // The release click (here: on the detached button, the touch
      // implicit-capture shape) must open NOTHING extra — the fired flag
      // consumes it, and exactly one Delete dialog remains.
      fireEvent.click(btn);
      expect(
        container.querySelectorAll('.dialog.confirm[aria-label="Confirm delete"]').length,
      ).toBe(1);
      expect(archiveDialog(container as unknown as HTMLElement)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hold classified AT CLICK (jank fallback: timer pending, elapsed >= HOLD_THRESHOLD_MS) opens the Delete confirm exactly once", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    const btn = archiveButton(container as unknown as HTMLElement);
    fireEvent.pointerDown(btn); // arms the real 450ms timer (still pending…)
    clock += HOLD_THRESHOLD_MS; // …but the controlled clock crosses 450ms.
    // The click runs BEFORE the (real) timer could fire — the exact jank shape
    // the fallback exists for: click-time classifyHold sees elapsed >= 450 ->
    // "hold" -> Delete, and the click CANCELS the pending timer so it cannot
    // double-fire afterwards. (Order-insensitive by design: had the timer won
    // the race, the fired flag would have consumed this click instead.)
    fireEvent.click(btn);

    await waitFor(() =>
      expect(
        container.querySelector('.dialog.confirm.danger[aria-label="Confirm delete"]'),
      ).not.toBeNull(),
    );
    // Exactly ONE Delete dialog (timer path + click path are idempotent
    // together), and a hold MUST NOT open the recoverable Archive confirm.
    expect(
      (container as unknown as HTMLElement).querySelectorAll(
        '.dialog.confirm[aria-label="Confirm delete"]',
      ).length,
    ).toBe(1);
    expect(archiveDialog(container as unknown as HTMLElement)).toBeNull();
  });

  it("keyboard activation (no pointerdown → downAt===0 sentinel) opens Archive (safe default)", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    const btn = archiveButton(container as unknown as HTMLElement);
    // No pointerdown -> archiveDownAt stays at its initial 0 (and NO early-
    // trigger timer is armed) -> classifyHold(0, now) returns "tap" (the
    // keyboard/programmatic-activation sentinel). This is the load-bearing
    // safe-default: Enter/Space can never accidentally open the destructive
    // Delete confirm.
    fireEvent.click(btn);

    await waitFor(() => expect(archiveDialog(container as unknown as HTMLElement)).not.toBeNull());
    expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
  });

  it("drag-off (pointerLeave before the threshold) cancels the hold timer — nothing opens", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    vi.useFakeTimers({ now: clock });
    try {
      const btn = archiveButton(container as unknown as HTMLElement);
      fireEvent.pointerDown(btn);
      fireEvent.pointerLeave(btn); // finger/pointer slid off the button
      await vi.advanceTimersByTimeAsync(HOLD_THRESHOLD_MS * 2);
      // Drag-off must NOT trigger Delete mid-hold — and produces no click on
      // the button either, so nothing at all opens.
      expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
      expect(archiveDialog(container as unknown as HTMLElement)).toBeNull();
      expect(container.querySelector(".ctxm-menu")).not.toBeNull(); // menu intact
    } finally {
      vi.useRealTimers();
    }
  });

  it("pointercancel cancels the hold timer — nothing opens", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    vi.useFakeTimers({ now: clock });
    try {
      const btn = archiveButton(container as unknown as HTMLElement);
      fireEvent.pointerDown(btn);
      fireEvent.pointerCancel(btn); // e.g. browser takes over (scroll/native UI)
      await vi.advanceTimersByTimeAsync(HOLD_THRESHOLD_MS * 2);
      expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
      expect(archiveDialog(container as unknown as HTMLElement)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blur mid-hold cancels the timer — nothing opens", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    vi.useFakeTimers({ now: clock });
    try {
      const btn = archiveButton(container as unknown as HTMLElement);
      fireEvent.pointerDown(btn);
      fireEvent.blur(btn); // focus leaves the button mid-hold
      await vi.advanceTimersByTimeAsync(HOLD_THRESHOLD_MS * 2);
      expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
      expect(archiveDialog(container as unknown as HTMLElement)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closing the menu mid-hold cancels the timer — no Delete confirm pops after the fact", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    vi.useFakeTimers({ now: clock });
    try {
      const btn = archiveButton(container as unknown as HTMLElement);
      fireEvent.pointerDown(btn);
      closeSessionMenu(); // Escape / scrim tap / back-dismiss — unmounts <Items>
      await vi.advanceTimersByTimeAsync(HOLD_THRESHOLD_MS * 2);
      // A pending timer must never outlive the menu: the onCleanup in <Items>
      // cancels it, so the Delete confirm cannot pop out of nowhere afterwards.
      expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
      expect(archiveDialog(container as unknown as HTMLElement)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── F2: an abandoned gesture must never open Delete via a STALE timestamp.
  // pointerleave/pointercancel clear the timer but (pre-fix) left
  // archiveDownAt set, so a completed click much later classified as "hold". ──

  it("F2 mouse re-entry: pointerdown → pointerleave → past threshold → click (no new pointerdown) opens Archive, never Delete", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    vi.useFakeTimers({ now: clock });
    try {
      const btn = archiveButton(container as unknown as HTMLElement);
      fireEvent.pointerDown(btn);
      fireEvent.pointerLeave(btn); // dragged off before the threshold
      await vi.advanceTimersByTimeAsync(HOLD_THRESHOLD_MS + 50);
      // Re-enter while still pressed and release: NO new pointerdown fires,
      // so the pre-fix bug classified this click off the STALE archiveDownAt
      // (elapsed >= 450 -> "hold" -> Delete). pointerleave must have reset
      // the timestamp: the downAt===0 sentinel -> "tap" -> Archive — the
      // chosen safe default for a completed click.
      fireEvent.click(btn);
      expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
      expect(archiveDialog(container as unknown as HTMLElement)).not.toBeNull();
      // Exactly one dialog total.
      expect(
        (container as unknown as HTMLElement).querySelectorAll(".dialog.confirm").length,
      ).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("F2 via pointercancel: pointerdown → pointercancel → past threshold → click opens Archive, never Delete", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    vi.useFakeTimers({ now: clock });
    try {
      const btn = archiveButton(container as unknown as HTMLElement);
      fireEvent.pointerDown(btn);
      fireEvent.pointerCancel(btn); // e.g. browser takes over the gesture
      await vi.advanceTimersByTimeAsync(HOLD_THRESHOLD_MS + 50);
      // Same stale-timestamp shape as the re-entry case above: the cancel
      // must reset archiveDownAt, so the late click classifies via the
      // downAt===0 sentinel -> "tap" -> Archive, never Delete.
      fireEvent.click(btn);
      expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
      expect(archiveDialog(container as unknown as HTMLElement)).not.toBeNull();
      expect(
        (container as unknown as HTMLElement).querySelectorAll(".dialog.confirm").length,
      ).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── F5: touch drag-off. Implicit pointer capture suppresses pointerleave
  // for touch, so the finger can be visibly off the button with no leave
  // event — the pointermove slop-cancel is the touch half. jsdom cannot
  // emulate implicit capture; these pointermove tests ARE the coverage. ──

  it("F5 slop: pointermove beyond ARCHIVE_HOLD_SLOP_PX cancels the hold — nothing opens past the threshold (touch drag-off shape)", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    vi.useFakeTimers({ now: clock });
    try {
      const btn = archiveButton(container as unknown as HTMLElement);
      firePointerWithCoords(btn, "pointerdown", 100, 100);
      // Captured pointermove: 40px from the start — beyond the 10px slop
      // radius — while the finger is (conceptually) off the button.
      firePointerWithCoords(btn, "pointermove", 140, 100);
      await vi.advanceTimersByTimeAsync(HOLD_THRESHOLD_MS * 2);
      // The drag must NOT pop the Delete confirm at 450ms with the finger
      // visibly off the button — and nothing else opens either.
      expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
      expect(archiveDialog(container as unknown as HTMLElement)).toBeNull();
      expect(container.querySelector(".ctxm-menu")).not.toBeNull(); // menu intact
    } finally {
      vi.useRealTimers();
    }
  });

  it("F5 slop tolerance: within-slop micro-jitter does NOT cancel — the timer still fires Delete at the threshold", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    vi.useFakeTimers({ now: clock });
    try {
      const btn = archiveButton(container as unknown as HTMLElement);
      firePointerWithCoords(btn, "pointerdown", 100, 100);
      // 5px (3,4) from the start — within the 10px slop radius: an honest
      // hold with micro-jitter must still reach the Delete confirm.
      firePointerWithCoords(btn, "pointermove", 104, 103);
      await vi.advanceTimersByTimeAsync(HOLD_THRESHOLD_MS);
      expect(
        container.querySelector('.dialog.confirm.danger[aria-label="Confirm delete"]'),
      ).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("F5 moved-consumption: beyond-slop move then click opens NOTHING (not even Archive)", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    vi.useFakeTimers({ now: clock });
    try {
      const btn = archiveButton(container as unknown as HTMLElement);
      firePointerWithCoords(btn, "pointerdown", 100, 100);
      firePointerWithCoords(btn, "pointermove", 100, 130); // 30px > slop
      // Release click on the (still-captured) button: the moved flag must
      // be consumed FIRST — without it, elapsed ~0 would classify "tap"
      // and wrongly open the Archive confirm.
      fireEvent.click(btn);
      await vi.advanceTimersByTimeAsync(HOLD_THRESHOLD_MS * 2);
      expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
      expect(archiveDialog(container as unknown as HTMLElement)).toBeNull();
      expect(container.querySelector(".ctxm-menu")).not.toBeNull(); // menu intact
    } finally {
      vi.useRealTimers();
    }
  });

  it("F1 isolation: pointerdown → pointerup alone (no click/leave) opens nothing even at 2× the threshold", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    vi.useFakeTimers({ now: clock });
    try {
      const btn = archiveButton(container as unknown as HTMLElement);
      fireEvent.pointerDown(btn);
      // pointerup clears ONLY the timer (the timestamp deliberately
      // survives for the click's jank classification — but no click ever
      // comes in this shape), so nothing may open afterwards.
      fireEvent.pointerUp(btn);
      await vi.advanceTimersByTimeAsync(HOLD_THRESHOLD_MS * 2);
      expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
      expect(archiveDialog(container as unknown as HTMLElement)).toBeNull();
      expect(container.querySelector(".ctxm-menu")).not.toBeNull(); // menu intact
    } finally {
      vi.useRealTimers();
    }
  });

  it("F7 closure: abandoned gesture (leave) then keyboard activation opens Archive, never Delete", async () => {
    putSession({ id: "s1", title: "Session One", time: { updated: 1 } });
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "s1", "Session One");

    vi.useFakeTimers({ now: clock });
    try {
      const btn = archiveButton(container as unknown as HTMLElement);
      fireEvent.pointerDown(btn);
      fireEvent.pointerLeave(btn); // abandon — must reset the timestamp
      await vi.advanceTimersByTimeAsync(HOLD_THRESHOLD_MS + 50);
      // Keyboard Enter on the still-focused button: a click with NO
      // pointerdown of its own (jsdom does not synthesize clicks from
      // keydown, so the activation click is fired directly — same shape as
      // the keyboard-sentinel test above). Pre-fix, the stale archiveDownAt
      // classified this as "hold" -> Delete; with the leave reset, the
      // downAt===0 sentinel applies -> "tap" -> Archive.
      fireEvent.click(btn);
      expect(archiveDialog(container as unknown as HTMLElement)).not.toBeNull();
      expect(deleteDialog(container as unknown as HTMLElement)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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

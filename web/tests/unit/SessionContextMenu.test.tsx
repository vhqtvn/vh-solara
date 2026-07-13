// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
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

// The "Move up / Move down" context-menu items (keyboard/a11y reorder for
// pinned ROOT sessions) must appear only under the drag feature's scope fence
// — pinned AND a root (no parentID) — and disable at the order's ends.

beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("activity", reconcile({}));
  setState("unread", reconcile({}));
  setSelectedIdRaw(null);
  localStorage.clear();
  __resetPinnedForTest();
  closeSessionMenu();
  closeArchiveConfirm();
});

afterEach(() => cleanup());

function putSession(s: Session): void {
  setState("sessions", s.id, s);
}

function seedVersioned(key: string, data: unknown) {
  localStorage.setItem(key, JSON.stringify({ v: 1, data }));
}

// Open the positioned (mouse) menu for a session and resolve once Items render.
async function openMenu(container: HTMLElement, id: string, title: string) {
  openSessionMenu(id, title, 10, 10);
  await waitFor(() => {
    expect(container.querySelector(".ctxm-menu")).not.toBeNull();
  });
}

function ctxmItem(container: HTMLElement, label: RegExp): HTMLButtonElement | undefined {
  return (Array.from(container.querySelectorAll("button.ctxm-item")) as HTMLButtonElement[]).find((b) =>
    label.test(b.textContent ?? ""),
  );
}

describe("SessionContextMenu Move up/down (keyboard reorder)", () => {
  it("shows Move up/down for a pinned root, disabled at the ends", async () => {
    putSession({ id: "a", title: "A", time: { updated: 1 } });
    putSession({ id: "b", title: "B", time: { updated: 2 } });
    seedVersioned("vh.pinned.v1", ["a", "b"]);
    seedVersioned("vh.pinned-order.v1", ["a", "b"]);
    __resetPinnedForTest();

    const { container } = render(() => <SessionContextMenu />);

    // a is FIRST in the order → Move up disabled, Move down enabled.
    await openMenu(container as unknown as HTMLElement, "a", "A");
    const upOnA = ctxmItem(container as unknown as HTMLElement, /Move up/);
    const downOnA = ctxmItem(container as unknown as HTMLElement, /Move down/);
    expect(upOnA).toBeTruthy();
    expect(downOnA).toBeTruthy();
    expect(upOnA!.disabled).toBe(true);
    expect(downOnA!.disabled).toBe(false);

    // b is LAST in the order → Move up enabled, Move down disabled.
    closeSessionMenu();
    await openMenu(container as unknown as HTMLElement, "b", "B");
    const upOnB = ctxmItem(container as unknown as HTMLElement, /Move up/);
    const downOnB = ctxmItem(container as unknown as HTMLElement, /Move down/);
    expect(upOnB!.disabled).toBe(false);
    expect(downOnB!.disabled).toBe(true);
  });

  it("does not show Move up/down for a pinned SUBsession (scope fence)", async () => {
    putSession({ id: "root", title: "Root", time: { updated: 1 } });
    putSession({ id: "child", title: "Child", parentID: "root", time: { updated: 2 } });
    seedVersioned("vh.pinned.v1", ["child"]);
    seedVersioned("vh.pinned-order.v1", ["child"]);
    __resetPinnedForTest();

    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "child", "Child");

    expect(ctxmItem(container as unknown as HTMLElement, /Move up/)).toBeUndefined();
    expect(ctxmItem(container as unknown as HTMLElement, /Move down/)).toBeUndefined();
  });

  it("does not show Move up/down for an unpinned root", async () => {
    putSession({ id: "a", title: "A", time: { updated: 1 } });
    // a is NOT pinned → the menu's Pin item reads "Pin to top", and Move up/down
    // must be absent.
    const { container } = render(() => <SessionContextMenu />);
    await openMenu(container as unknown as HTMLElement, "a", "A");

    expect(ctxmItem(container as unknown as HTMLElement, /Move up/)).toBeUndefined();
    expect(ctxmItem(container as unknown as HTMLElement, /Move down/)).toBeUndefined();
  });
});

// @vitest-environment jsdom
// SessionContextMenu anchor under UI zoom (fc2ef59d): openSessionMenu stores
// the pointer's client coords (viewport px), and the menu memo converts them
// — together with the innerWidth/innerHeight-based clamps — via layoutPx
// before the fixed-position menu's left/top styles (zoomed-layout px; UI zoom
// = CSS `zoom` on :root; see lib/zoom). Coordinates are chosen inside the
// clamp envelope so the pure conversion is observable. jsdom cannot apply
// CSS zoom — these tests pin the arithmetic of the applied style, not live
// rendering.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { setState } from "../../src/sync/store";
import type { Session } from "../../src/types";
import SessionContextMenu from "../../src/components/SessionContextMenu";
import { closeArchiveConfirm, closeSessionMenu, openSessionMenu } from "../../src/sessionMenu";
import { __resetPinnedForTest } from "../../src/pins";

function setUiZoom(v: string) {
  document.documentElement.style.setProperty("--ui-zoom", v);
}

function putSession(s: Session): void {
  setState("sessions", s.id, s);
}

beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("activity", reconcile({}));
  setState("unread", reconcile({}));
  localStorage.clear();
  __resetPinnedForTest();
  closeSessionMenu();
  closeArchiveConfirm();
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--ui-zoom");
});

// Open the positioned menu at (x, y) for session "a" and resolve the menu el.
async function openAt(x: number, y: number): Promise<HTMLElement> {
  expect([window.innerWidth, window.innerHeight]).toEqual([1024, 768]);
  putSession({ id: "a", title: "A", time: { updated: 1 } });
  const { container } = render(() => <SessionContextMenu />);
  openSessionMenu("a", "A", x, y);
  return waitFor(() => {
    const m = container.querySelector<HTMLElement>(".ctxm-menu");
    expect(m).not.toBeNull();
    return m!;
  });
}

describe("SessionContextMenu anchor under UI zoom", () => {
  it("zoom 1 is the identity: 300px / 200px", async () => {
    const menu = await openAt(300, 200);
    expect(parseFloat(menu.style.left)).toBeCloseTo(300, 3);
    expect(parseFloat(menu.style.top)).toBeCloseTo(200, 3);
  });

  it("125%: converts to layout px (300/1.25 = 240, 200/1.25 = 160)", async () => {
    setUiZoom("1.25");
    const menu = await openAt(300, 200);
    expect(parseFloat(menu.style.left)).toBeCloseTo(240, 3);
    expect(parseFloat(menu.style.top)).toBeCloseTo(160, 3);
  });

  it("80%: scales up (300/0.8 = 375, 200/0.8 = 250)", async () => {
    setUiZoom("0.8");
    const menu = await openAt(300, 200);
    expect(parseFloat(menu.style.left)).toBeCloseTo(375, 3);
    expect(parseFloat(menu.style.top)).toBeCloseTo(250, 3);
  });
});

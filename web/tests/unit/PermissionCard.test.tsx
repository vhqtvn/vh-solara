// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

// PermissionCard has NO markdown path (permissions keep a plain <pre>), so —
// unlike QuestionCard.test.tsx — there is no renderMarkdown mock to wire.

// Mock respondPermission so the three fast actions do not POST. Capture calls
// to assert the (sessionID, permissionID, response) payload.
const respondPermission = vi.fn(() => Promise.resolve());
vi.mock("../../src/sync", () => ({
  respondPermission: (...args: unknown[]) => respondPermission(...args),
}));

import PermissionCard from "../../src/components/PermissionCard";
import {
  PendingInputHoldContext,
  type PendingInputHoldReport,
} from "../../src/components/PendingInput";

// Representative permission: a bash tool call. `permission` → permLabel;
// `metadata.command` → permDetail (the <pre> body). The sessionID lives on the
// PROPS (not the perm payload) — PermissionCard forwards both to
// respondPermission(sessionID, perm.id, resp).
const sessionID = "s1";
const perm = {
  id: "p1",
  sessionID,
  permission: "bash",
  metadata: { command: "rm -rf /tmp/scratch" },
};

// Permission carrying an "Always" grant-set (OpenCode stamps arity-prefix
// wildcards here). Exercises the eye-toggle reveal + hold notification.
const permWithAlways = {
  ...perm,
  always: ["git diff *", "npm run build *"],
};

describe("PermissionCard — inline fast actions + shared-state popup", () => {
  afterEach(() => {
    cleanup();
    respondPermission.mockClear();
  });

  it("renders the permLabel title and the permDetail <pre> body", () => {
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    // Title carries the category (permLabel: permission || type || title).
    expect(container.textContent).toContain("Permission requested");
    expect(container.textContent).toContain("bash");
    // Detail <pre> carries the structured command (permDetail: metadata.command).
    const pre = container.querySelector(".perm-detail") as HTMLElement;
    expect(pre).toBeTruthy();
    expect(pre.textContent).toBe("rm -rf /tmp/scratch");
    // All three fast actions are present.
    const actions = container.querySelectorAll(".perm-actions button");
    expect(actions.length).toBe(3);
    expect(actions[0].textContent!.trim()).toBe("Allow once");
    expect(actions[1].textContent!.trim()).toBe("Always");
    expect(actions[2].textContent!.trim()).toBe("Reject");
  });

  it("Allow once calls respondPermission with (sessionID, id, 'once')", () => {
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    const once = container.querySelectorAll(".perm-actions button")[0];
    once.click();
    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission.mock.calls[0]).toEqual([sessionID, "p1", "once"]);
  });

  it("Always calls respondPermission with (sessionID, id, 'always')", () => {
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    container.querySelectorAll(".perm-actions button")[1].click();
    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission.mock.calls[0]).toEqual([sessionID, "p1", "always"]);
  });

  it("Reject calls respondPermission with (sessionID, id, 'reject')", () => {
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    container.querySelectorAll(".perm-actions button")[2].click();
    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission.mock.calls[0]).toEqual([sessionID, "p1", "reject"]);
  });

  it("popup mirrors + shared action: Reject inside popup fires respondPermission (popup stays mounted in mocked context; closes in production via store unmount)", async () => {
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    const card = container.querySelector(".perm-card") as HTMLElement;
    expect(card.querySelectorAll(".perm-actions button").length).toBe(3);

    // Open the popup (Portaled to document.body, outside `container`).
    (
      card.querySelector(
        '[aria-label="Open permission in popup"]',
      ) as HTMLButtonElement
    ).click();
    const pop = await waitFor(
      () => document.querySelector(".card-pop") as HTMLElement,
    );
    expect(pop).toBeTruthy();
    // The popup body mirrors the inline surface: same three fast actions.
    expect(pop.querySelectorAll(".perm-actions button").length).toBe(3);

    // Click Reject INSIDE the popup → respondPermission fires with 'reject'.
    (
      pop.querySelectorAll(".perm-actions button")[2] as HTMLButtonElement
    ).click();
    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission.mock.calls[0]).toEqual([sessionID, "p1", "reject"]);
    // (The popup stays mounted — PermissionCard's actions do not auto-close it;
    // the card is removed from state by the parent once the reply lands. This
    // mirrors QuestionCard, where the Reply action does not close the popup.)
    expect(document.querySelector(".card-pop")).not.toBeNull();
  });

  it("ESC closes the popup", async () => {
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    const card = container.querySelector(".perm-card") as HTMLElement;
    (
      card.querySelector(
        '[aria-label="Open permission in popup"]',
      ) as HTMLButtonElement
    ).click();
    await waitFor(() =>
      expect(document.querySelector(".card-pop")).not.toBeNull(),
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await waitFor(() =>
      expect(document.querySelector(".card-pop")).toBeNull(),
    );
  });
});

describe("PermissionCard — 'Always' grant-set pinned reveal + hold notification", () => {
  afterEach(() => {
    cleanup();
    respondPermission.mockClear();
  });

  it("eye toggle pins the grant-set reveal open (click toggles alwaysPinned)", () => {
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={permWithAlways} />
    ));
    // The reveal region is hidden by default (no pin, no hover).
    expect(container.querySelector(".perm-always")).toBeNull();
    // The eye toggle button is present (only when always list exists, inline).
    const eye = container.querySelector(".perm-eye") as HTMLButtonElement;
    expect(eye).toBeTruthy();
    // Click → pins the reveal open.
    eye.click();
    const region = container.querySelector(".perm-always") as HTMLElement;
    expect(region).toBeTruthy();
    expect(region.querySelectorAll(".perm-always-list li").length).toBe(2);
    // Click again → unpins.
    eye.click();
    expect(container.querySelector(".perm-always")).toBeNull();
  });

  it("reports pinned reveal up to PendingInput hold context", () => {
    const setPinnedReveal = vi.fn();
    const setPopupOpen = vi.fn();
    const report: PendingInputHoldReport = { setPopupOpen, setPinnedReveal };
    const { container } = render(() => (
      <PendingInputHoldContext.Provider value={report}>
        <PermissionCard sessionID={sessionID} perm={permWithAlways} />
      </PendingInputHoldContext.Provider>
    ));
    // Initial mount: createEffect reports pinned=false.
    expect(setPinnedReveal).toHaveBeenCalledWith(false);
    // Pin the reveal.
    (container.querySelector(".perm-eye") as HTMLButtonElement).click();
    expect(setPinnedReveal).toHaveBeenCalledWith(true);
  });

  it("reports popup open up to PendingInput hold context", async () => {
    const setPinnedReveal = vi.fn();
    const setPopupOpen = vi.fn();
    const report: PendingInputHoldReport = { setPopupOpen, setPinnedReveal };
    const { container } = render(() => (
      <PendingInputHoldContext.Provider value={report}>
        <PermissionCard sessionID={sessionID} perm={permWithAlways} />
      </PendingInputHoldContext.Provider>
    ));
    // Initial mount: popup closed.
    expect(setPopupOpen).toHaveBeenCalledWith(false);
    setPopupOpen.mockClear();
    // Open the popup.
    (
      container.querySelector(
        '[aria-label="Open permission in popup"]',
      ) as HTMLButtonElement
    ).click();
    await waitFor(() =>
      expect(setPopupOpen).toHaveBeenCalledWith(true),
    );
  });

  it("standalone card (no PendingInput context) does not throw — hold report is optional", () => {
    // usePendingInputHold returns undefined when no Provider is above the card.
    // The card's createEffect uses optional chaining, so this is a safe no-op.
    expect(() =>
      render(() => <PermissionCard sessionID={sessionID} perm={permWithAlways} />),
    ).not.toThrow();
  });
});

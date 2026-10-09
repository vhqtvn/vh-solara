// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

// PermissionCard has NO markdown path (permissions keep a plain <pre>), so —
// unlike QuestionCard.test.tsx — there is no renderMarkdown mock to wire.

// Mock the sync barrel's reply surface so the fast actions do not POST.
// respondPermission defaults to a confirmed outcome (the happy path the
// pre-resilience tests pin); the resilience describe overrides the return
// value per-test to drive unknown/gone/rejected states.
const respondPermission = vi.fn(
  (_sessionID: string, _permID: string, _verb: string) =>
    Promise.resolve({ kind: "confirmed" }),
);
const dismissPermission = vi.fn();
vi.mock("../../src/sync", () => ({
  respondPermission:
    (...args: [string, string, string]) => respondPermission(...args),
  dismissPermission: (...args: []) => dismissPermission(...args),
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
    const actions = container.querySelectorAll<HTMLButtonElement>(".perm-actions button");
    expect(actions.length).toBe(3);
    expect(actions[0].textContent!.trim()).toBe("Allow once");
    expect(actions[1].textContent!.trim()).toBe("Always");
    expect(actions[2].textContent!.trim()).toBe("Reject");
  });

  it("Allow once calls respondPermission with (sessionID, id, 'once')", () => {
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    const once = container.querySelectorAll<HTMLButtonElement>(".perm-actions button")[0];
    once.click();
    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission.mock.calls[0]).toEqual([sessionID, "p1", "once"]);
  });

  it("Always calls respondPermission with (sessionID, id, 'always')", () => {
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    container.querySelectorAll<HTMLButtonElement>(".perm-actions button")[1].click();
    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission.mock.calls[0]).toEqual([sessionID, "p1", "always"]);
  });

  it("Reject calls respondPermission with (sessionID, id, 'reject')", () => {
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    container.querySelectorAll<HTMLButtonElement>(".perm-actions button")[2].click();
    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission.mock.calls[0]).toEqual([sessionID, "p1", "reject"]);
  });

  it("popup mirrors + shared action: Reject inside popup fires respondPermission (popup stays mounted in mocked context; closes in production via store unmount)", async () => {
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    const card = container.querySelector(".perm-card") as HTMLElement;
    expect(card.querySelectorAll<HTMLButtonElement>(".perm-actions button").length).toBe(3);

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
    expect(pop.querySelectorAll<HTMLButtonElement>(".perm-actions button").length).toBe(3);

    // Click Reject INSIDE the popup → respondPermission fires with 'reject'.
    (
      pop.querySelectorAll<HTMLButtonElement>(".perm-actions button")[2] as HTMLButtonElement
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

// Send-net-resilience slice 4a — the reply lifecycle states. The card is the
// surface that makes a failed/unconfirmed reply RECOVERABLE: it never
// optimistically destroys itself, it shows an honest outcome-unknown banner
// with an explicit Retry (safe: upstream replies are single-shot), and a
// gone-pending reply lands as a visible terminal that is never styled or
// worded as success.
describe("PermissionCard — reply resilience lifecycle", () => {
  afterEach(() => {
    cleanup();
    respondPermission.mockClear();
    dismissPermission.mockClear();
    respondPermission.mockImplementation(() => Promise.resolve({ kind: "confirmed" }));
  });

  it("sending disables all three actions and shows a Sending indicator until the verb answers", async () => {
    let release!: (v: { kind: string }) => void;
    respondPermission.mockImplementation(
      () => new Promise((res) => (release = res)),
    );
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    container.querySelectorAll<HTMLButtonElement>(".perm-actions button")[0].click();
    await waitFor(() =>
      expect(container.querySelector(".reply-status.sending")).toBeTruthy(),
    );
    // Single-flight: every action button is disabled while the reply is away.
    for (const b of container.querySelectorAll<HTMLButtonElement>(".perm-actions button"))
      expect((b as HTMLButtonElement).disabled).toBe(true);
    release({ kind: "confirmed" });
    await waitFor(() =>
      expect(container.querySelector(".reply-status")).toBeNull(),
    );
    for (const b of container.querySelectorAll<HTMLButtonElement>(".perm-actions button"))
      expect((b as HTMLButtonElement).disabled).toBe(false);
  });

  it("outcome-unknown keeps the card actionable with an explicit Retry that re-sends the SAME answer", async () => {
    respondPermission.mockImplementation(() =>
      Promise.resolve({ kind: "unknown", detail: "timeout" }),
    );
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    container.querySelectorAll<HTMLButtonElement>(".perm-actions button")[0].click(); // Allow once
    await waitFor(() =>
      expect(container.querySelector(".reply-status.unknown")).not.toBeNull(),
    );
    const banner = container.querySelector(".reply-status.unknown") as HTMLElement;
    expect(banner.textContent).toContain("not confirmed");
    expect(banner.textContent).toContain("may still have been applied");
    // The normal actions stay enabled — choosing a different answer is also
    // safe (upstream is single-shot; a stale request just 410s).
    for (const b of container.querySelectorAll<HTMLButtonElement>(".perm-actions button"))
      expect((b as HTMLButtonElement).disabled).toBe(false);
    // Retry re-sends the attempted answer.
    (banner.querySelector(".reply-retry") as HTMLButtonElement).click();
    await waitFor(() => expect(respondPermission).toHaveBeenCalledTimes(2));
    expect(respondPermission.mock.calls[1]).toEqual([sessionID, "p1", "once"]);
  });

  it("gone-pending is a visible honest terminal: never success, actions disabled, Dismiss clears the card", async () => {
    respondPermission.mockImplementation(() => Promise.resolve({ kind: "gone" }));
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    container.querySelectorAll<HTMLButtonElement>(".perm-actions button")[0].click();
    await waitFor(() =>
      expect(container.querySelector(".reply-status.gone")).not.toBeNull(),
    );
    const banner = container.querySelector(".reply-status.gone") as HTMLElement;
    expect(banner.textContent).toContain("no longer pending");
    expect(banner.textContent).toContain("not confirmed");
    expect(banner.textContent).not.toContain("success");
    // The request is dead upstream — answering again cannot work.
    for (const b of container.querySelectorAll<HTMLButtonElement>(".perm-actions button"))
      expect((b as HTMLButtonElement).disabled).toBe(true);
    (banner.querySelector(".reply-dismiss") as HTMLButtonElement).click();
    expect(dismissPermission).toHaveBeenCalledWith(sessionID, "p1");
  });

  it("a definitive rejection returns the card to idle (still pending upstream, re-answerable)", async () => {
    respondPermission.mockImplementation(() =>
      Promise.resolve({ kind: "rejected", status: 400 }),
    );
    const { container } = render(() => (
      <PermissionCard sessionID={sessionID} perm={perm} />
    ));
    container.querySelectorAll<HTMLButtonElement>(".perm-actions button")[2].click(); // Reject
    await waitFor(() => expect(respondPermission).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector(".reply-status")).toBeNull();
    for (const b of container.querySelectorAll<HTMLButtonElement>(".perm-actions button"))
      expect((b as HTMLButtonElement).disabled).toBe(false);
  });
});

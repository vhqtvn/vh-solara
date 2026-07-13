// @vitest-environment jsdom
// Unit test for the alerts notice headline: the session name in the headline
// must flow through the injected `displayOf` resolver so a nameReplacement
// rule transforms it the same way the visible tree does. This covers the
// injection-seam wiring (bindAlertsContext.displayOf ← sync ← projectSettings);
// alerts.ts must NOT import projectSettings directly (that would reopen the
// sync↔alerts cycle), so the test drives the seam by hand instead.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindAlertsContext, handleNotice, type Notice } from "../../src/alerts";
import { clearNotifications, notifications } from "../../src/notify";

beforeEach(() => {
  clearNotifications();
});

afterEach(() => {
  // Restore the identity resolver so a later test in this file starts clean.
  bindAlertsContext({
    selectedId: () => null,
    rootOf: (id) => id,
    sessionTitle: () => undefined,
    displayOf: (s) => s,
  });
});

describe("handleNotice headline — displayOf injection seam", () => {
  it("transforms the session name in the headline when a rule is active", () => {
    // Wire the seam exactly like sync.ts does, but with an inline resolver so
    // the test is independent of projectSettings signal state. The rule maps
    // `[[IMPORTANT]]` → `❗` (global), mirroring the canonical example.
    bindAlertsContext({
      // Focus matches the notice's session so it is deliverable under the
      // default "current" scope (no need to flip scope → no heartbeat fetch).
      selectedId: () => "s1",
      rootOf: (id) => id,
      sessionTitle: () => undefined,
      displayOf: (raw) => raw.replace(/\[\[IMPORTANT\]\]/g, "❗"),
    });

    const notice = {
      type: "waiting",
      sessionID: "s1",
      root: "s1",
      project: "demo",
      title: "[[IMPORTANT]] deploy",
      detail: "needs review",
      ts: Date.now(),
    } as Notice;

    handleNotice(notice);

    // The in-app notification was pushed (waiting → in-app, not just OS).
    expect(notifications.items.length).toBe(1);
    const headline = notifications.items[0]!.title;
    // The headline's session name is the DISPLAY form: the glyph replaced the
    // raw `[[IMPORTANT]]` marker, and the verb came from the waiting label.
    expect(headline).toBe("⏳ ❗ deploy needs your input");
    // The RAW marker must NOT leak into the rendered headline.
    expect(headline).not.toContain("[[IMPORTANT]]");
  });

  it("also transforms the title when it falls back to the session store", () => {
    // n.title absent → name resolves through the injected sessionTitle accessor
    // before displayOf, proving the whole chain (title ?? getTitle ?? slice)
    // is piped through the resolver, not just the n.title branch.
    bindAlertsContext({
      selectedId: () => "s2",
      rootOf: (id) => id,
      sessionTitle: () => "[[IMPORTANT]] plan",
      displayOf: (raw) => raw.replace(/\[\[IMPORTANT\]\]/g, "❗"),
    });

    const notice = {
      type: "stalled",
      sessionID: "s2",
      root: "s2",
      project: "demo",
      ts: Date.now(),
    } as Notice;

    handleNotice(notice);

    expect(notifications.items.length).toBe(1);
    expect(notifications.items[0]!.title).toBe("💤 ❗ plan has stalled");
  });
});

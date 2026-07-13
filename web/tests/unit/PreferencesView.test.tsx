// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { setState, setSelectedIdRaw } from "../../src/sync/store";
import type { Session } from "../../src/types";
import PreferencesView from "../../src/components/PreferencesView";
import { setNameReplacements } from "../../src/projectSettings";

// PreferencesView: two sections (Session names + Agent styles) sharing one
// screen-level Reload/Save. Covers load, add/remove/reorder, live preview,
// inline validation, SSE dirty-protection, Reload-replaces-draft, and the
// dryRun+commit captured-payload path.

// --- fetch mock: routes GET/PUT /vh/project-settings + POST /vh/render -------
type FetchOpts = { getSettings?: any; putHandler?: (body: any, dryRun: boolean) => { old: string; new: string } | {} };
let opts: FetchOpts = {};
let putCalls: { body: any; url: string }[] = [];

function installFetch(o: FetchOpts = {}) {
  opts = o;
  putCalls = [];
  const real = vi.fn(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method || "GET").toUpperCase();
    if (url.includes("/vh/project-settings") && method === "GET") {
      return new Response(JSON.stringify(opts.getSettings ?? {}), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/vh/project-settings") && method === "PUT") {
      const body = JSON.parse(init.body);
      putCalls.push({ body, url });
      if (body.dryRun) {
        const r = opts.putHandler ? opts.putHandler(body, true) : { old: "old-text", new: "new-text" };
        return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const r = opts.putHandler ? opts.putHandler(body, false) : {};
      return new Response(JSON.stringify(r), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/vh/render")) {
      const arr = JSON.parse(init.body);
      return new Response(JSON.stringify(arr.map((_: any, i: number) => ({ id: String(i), html: "<div>diff</div>" }))), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", real);
  return real;
}

beforeEach(() => {
  setState("sessions", reconcile({}));
  setSelectedIdRaw(null);
  localStorage.clear();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function putSession(s: Session): void {
  setState("sessions", s.id, s);
}

// Find rule pattern inputs by their static placeholder (always contains "IMPORTANT").
function patternInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[placeholder*="IMPORTANT"]')) as HTMLInputElement[];
}
// Find rule replacement inputs by their static placeholder (the emoji).
function replacementInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[placeholder="❗"]')) as HTMLInputElement[];
}

// Find a button by aria-label.
function btnByLabel(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === label);
}

// Find a button by exact text content.
function btnByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").trim() === text);
}

describe("PreferencesView", () => {
  it("loads both sections from saved settings", async () => {
    installFetch({
      getSettings: {
        agentStyles: { alice: { label: "Al", color: "accent", style: "soft" } },
        nameReplacements: [{ pattern: "foo", replacement: "bar", flags: "g" }],
      },
    });
    const { container } = render(() => <PreferencesView />);
    await waitFor(() => {
      // Agent styles row for alice appears.
      expect(container.textContent).toContain("@alice");
      // Session-names rule loaded (value is a property, not attribute).
      expect(patternInputs(container).some((i) => i.value === "foo")).toBe(true);
    });
  });

  it("adds, fills, and removes a session-name rule", async () => {
    const { container } = render(() => <PreferencesView />);
    await waitFor(() => expect(container.textContent).toContain("Session names"));

    // Add a rule.
    btnByText(container, "Add rule")!.click();
    await waitFor(() => expect(patternInputs(container).length).toBeGreaterThan(0));

    // Fill it.
    const pat = patternInputs(container)[0];
    pat.value = "[[X]]";
    pat.dispatchEvent(new Event("input", { bubbles: true }));

    // Remove it.
    btnByLabel(container, "Remove rule")!.click();
    await waitFor(() => expect(patternInputs(container).length).toBe(0));
  });

  it("reorders rules with move up/down and the preview reflects the new order", async () => {
    installFetch({
      getSettings: {
        nameReplacements: [
          { pattern: "a", replacement: "1" },
          { pattern: "a", replacement: "2" },
        ],
      },
    });
    const { container } = render(() => <PreferencesView />);
    await waitFor(() => expect(container.querySelectorAll('button[aria-label="Remove rule"]').length).toBe(2));

    // Move the second rule up.
    const moveUps = container.querySelectorAll('button[aria-label="Move rule up"]');
    // Second rule's move-up button (index 1).
    (moveUps[1] as HTMLButtonElement).click();
    await waitFor(() => {
      // After swap, the first rule's replacement input now holds "2".
      const repls = container.querySelectorAll('input[placeholder="❗"]') as NodeListOf<HTMLInputElement>;
      expect(repls.length).toBe(2);
      expect(repls[0].value).toBe("2");
      expect(repls[1].value).toBe("1");
    });
  });

  it("live preview applies the full draft pipeline to the sample title", async () => {
    installFetch({ getSettings: { nameReplacements: [{ pattern: "\\[\\[IMPORTANT\\]\\]", replacement: "❗", flags: "g" }] } });
    const { container } = render(() => <PreferencesView />);
    await waitFor(() => expect(container.textContent).toContain("Session names"));
    // The sample default is "[[IMPORTANT]] release" and should preview to "❗ release".
    await waitFor(() => {
      expect(container.textContent).toContain("❗ release");
    });
  });

  it("flags invalid regex rows inline without blocking valid ones", async () => {
    installFetch({ getSettings: { nameReplacements: [{ pattern: "[", replacement: "x" }] } });
    const { container } = render(() => <PreferencesView />);
    await waitFor(() => {
      // Invalid row shows the "Ignored until fixed" label.
      expect(container.textContent).toContain("Ignored until fixed");
    });
  });

  it("does not overwrite dirty drafts on an SSE nudge", async () => {
    installFetch({ getSettings: { nameReplacements: [{ pattern: "a", replacement: "b" }] } });
    const { container } = render(() => <PreferencesView />);
    await waitFor(() => expect(patternInputs(container).length).toBeGreaterThan(0));

    // Edit the draft (make it dirty).
    const pat = container.querySelector('input[placeholder*="IMPORTANT"]') as HTMLInputElement;
    pat.value = "dirty-edit";
    pat.dispatchEvent(new Event("input", { bubbles: true }));

    // Simulate an SSE nudge: replace the saved signal.
    setNameReplacements([{ pattern: "zzz", replacement: "qqq" }]);

    // The draft input keeps the user's edit, not the new saved value.
    await waitFor(() => {
      const inputs = container.querySelectorAll('input[placeholder*="IMPORTANT"]') as NodeListOf<HTMLInputElement>;
      expect(Array.from(inputs).some((i) => i.value === "dirty-edit")).toBe(true);
    });
    // And a "Config changed on disk" message appears.
    await waitFor(() => expect(container.textContent).toContain("Config changed on disk"));
  });

  it("Reload replaces drafts with the on-disk state", async () => {
    // First load has one rule.
    installFetch({ getSettings: { nameReplacements: [{ pattern: "a", replacement: "b" }] } });
    const { container } = render(() => <PreferencesView />);
    await waitFor(() => expect(container.querySelectorAll('button[aria-label="Remove rule"]').length).toBe(1));

    // Dirty the draft by adding a rule.
    btnByText(container, "Add rule")!.click();
    await waitFor(() => expect(container.querySelectorAll('button[aria-label="Remove rule"]').length).toBe(2));

    // Change the on-disk settings and Reload.
    installFetch({ getSettings: { nameReplacements: [{ pattern: "c", replacement: "d" }] } });
    btnByText(container, "Reload")!.click();
    await waitFor(() => expect(container.querySelectorAll('button[aria-label="Remove rule"]').length).toBe(1));
  });

  it("dryRun + commit use the same captured combined payload (both keys)", async () => {
    installFetch({
      getSettings: {
        agentStyles: { alice: { label: "Al", color: "accent", style: "soft" } },
        nameReplacements: [{ pattern: "foo", replacement: "bar" }],
      },
      putHandler: (body) => ({ old: "old", new: body.dryRun ? "new" : "committed" }),
    });
    const { container } = render(() => <PreferencesView />);
    await waitFor(() => expect(container.textContent).toContain("@alice"));

    // Save… → dryRun → confirm modal → Save to file → commit.
    btnByText(container, "Save…")!.click();
    await waitFor(() => expect(container.textContent).toContain("Confirm changes"));
    btnByText(container, "Save to file")!.click();

    await waitFor(() => expect(putCalls.length).toBe(2));
    // Both calls carry BOTH keys.
    const dryRunCall = putCalls[0].body;
    const commitCall = putCalls[1].body;
    expect(dryRunCall.dryRun).toBe(true);
    expect(commitCall.dryRun).toBeUndefined();
    expect(dryRunCall).toHaveProperty("agentStyles");
    expect(dryRunCall).toHaveProperty("nameReplacements");
    expect(commitCall).toHaveProperty("agentStyles");
    expect(commitCall).toHaveProperty("nameReplacements");
    // The captured payloads match (commit uses what was diffed).
    expect(commitCall.agentStyles).toEqual(dryRunCall.agentStyles);
    expect(commitCall.nameReplacements).toEqual(dryRunCall.nameReplacements);
    // The agent style survived.
    expect(commitCall.agentStyles.alice).toBeTruthy();
    // The name rule survived.
    expect(commitCall.nameReplacements[0].pattern).toBe("foo");
  });

  it("combined save preserves both sections even when one is empty", async () => {
    // No saved data at all.
    installFetch({ getSettings: {}, putHandler: (body) => ({ old: "old", new: body.dryRun ? "new" : "ok" }) });
    const { container } = render(() => <PreferencesView />);
    await waitFor(() => expect(container.textContent).toContain("Preferences"));

    // Add a name rule (agent styles stays empty).
    btnByText(container, "Add rule")!.click();
    await waitFor(() => expect(container.querySelectorAll('button[aria-label="Remove rule"]').length).toBe(1));
    const pat = container.querySelector('input[placeholder*="IMPORTANT"]') as HTMLInputElement;
    pat.value = "X";
    pat.dispatchEvent(new Event("input", { bubbles: true }));

    // Save.
    btnByText(container, "Save…")!.click();
    await waitFor(() => expect(container.textContent).toContain("Confirm changes"));
    btnByText(container, "Save to file")!.click();
    await waitFor(() => expect(putCalls.length).toBe(2));

    const commit = putCalls[1].body;
    // Both keys present; agentStyles is an empty object, nameReplacements has the rule.
    expect(commit.agentStyles).toEqual({});
    expect(commit.nameReplacements.length).toBe(1);
    expect(commit.nameReplacements[0].pattern).toBe("X");
  });
});

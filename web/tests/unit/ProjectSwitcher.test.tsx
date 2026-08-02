// @vitest-environment jsdom
//
// Render coverage for the unread-idle badge in ProjectSwitcher. Closes the
// DEFER B-F1 gap from the unread-idle slice (commit 3ff52d79): the data layer
// is already unit-covered (projects-merge.test.ts pins unreadIdle ⊆ idle and
// the empty-ActivityMaps fallback; Go TestProjectsReportsUnreadCount pins the
// /vh/projects unreadRoots wire field), but no test asserted the VISIBLE DOM
// text a user sees. This file pins that outcome: when /vh/projects carries
// unreadRoots > 0, the "(N unread)" subset renders inside the idle badge —
// both in the pinned-row path (mergeProjectActivity-derived) and the recents-
// row path (rootsKnown-gated inline derivation).
//
// Vitest render seam (not Playwright e2e): no fixture knob for unread exists
// (pkg/fixtures/opencode.go registers only /fixture/reset|busy|delete), so
// arming unread e2e would mean driving a real prompt_async busy→idle turn
// through the live store — high cost + serial-shared-state contamination,
// with nil marginal value over the already-covered store/wire path.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

// Versioned localStorage envelope, per loadVersioned/saveVersioned in
// src/lib/store.ts: every persisted value is wrapped {v, data}. The projects
// key is "vh.projects.v1" at version 1 (src/projects.ts).
function seedProjects(list: { directory: string; name: string }[]): void {
  localStorage.setItem("vh.projects.v1", JSON.stringify({ v: 1, data: list }));
}

function resp(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => "",
  } as unknown as Response;
}

// projSwitcherOpen/setProjSwitcherOpen (src/ui.ts) and projects/setProjects
// (src/projects.ts) are MODULE-SCOPED SINGLETONS. If a test statically imports
// one but dynamically imports the component (or vice-versa) they resolve to
// DIFFERENT module instances and setProjSwitcherOpen(true) will not open the
// rendered dialog. resetModules + dynamic import of BOTH ui and the component
// in the SAME cycle aligns them (the OpenCodeLogsDialog.test.tsx precedent).
async function fresh() {
  vi.resetModules();
  const ui = await import("../../src/ui");
  const Switcher = (await import("../../src/components/ProjectSwitcher")).default;
  return { ui, Switcher };
}

// Scope assertions to the row for a specific directory so a synthesized active
// row or an empty recents section can't shadow the target.
function rowFor(dir: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll(".proj-item")).find((el) =>
    (el.textContent || "").includes(dir),
  ) as HTMLElement | undefined;
}

describe("ProjectSwitcher — unread-idle badge", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("renders the '(N unread)' subset in a PINNED row's idle badge", async () => {
    seedProjects([{ directory: "/work/alpha", name: "alpha" }]);
    const { ui, Switcher } = await fresh();
    // /vh/projects: alpha has 5 roots, 1 running → idle 4; 2 finished-unread
    // → unreadIdle 2 (a subset of idle). /oc/project: no recents (so the
    // recents section can't shadow the pinned row).
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/projects"))
          return Promise.resolve(
            resp([
              { dir: "/work/alpha", roots: 5, running: 1, runningRoots: 1, unreadRoots: 2 },
            ]),
          );
        if (url.includes("/oc/project")) return Promise.resolve(resp([]));
        return Promise.resolve(resp({}, false, 404));
      }),
    );

    render(() => <Switcher />);
    ui.setProjSwitcherOpen(true);

    await waitFor(() => {
      const row = rowFor("/work/alpha");
      expect(row).toBeTruthy();
      // The "(2 unread)" subset is inside a .proj-unread-count span.
      expect(row!.querySelector(".proj-unread-count")?.textContent).toBe("(2 unread)");
      // ...and it sits inside a row whose badge shows the idle count.
      expect(row!.textContent).toContain("4 idle");
    });
  });

  it("renders the '(N unread)' subset in a RECENTS row (rootsKnown-gated)", async () => {
    // No pinned projects; beta arrives via /oc/project (unpinned, not active),
    // so it lands in the recents section where idle/unreadIdle are derived
    // inline and gated on rootsKnown() (the dir is bridged in /vh/projects).
    seedProjects([]);
    const { ui, Switcher } = await fresh();
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url.includes("/vh/projects"))
          return Promise.resolve(
            resp([
              { dir: "/work/beta", roots: 3, running: 0, runningRoots: 0, unreadRoots: 1 },
            ]),
          );
        if (url.includes("/oc/project"))
          return Promise.resolve(resp([{ worktree: "/work/beta", name: "beta" }]));
        return Promise.resolve(resp({}, false, 404));
      }),
    );

    render(() => <Switcher />);
    ui.setProjSwitcherOpen(true);

    await waitFor(() => {
      const row = rowFor("/work/beta");
      expect(row).toBeTruthy();
      expect(row!.querySelector(".proj-unread-count")?.textContent).toBe("(1 unread)");
      expect(row!.textContent).toContain("3 idle");
    });
  });
});

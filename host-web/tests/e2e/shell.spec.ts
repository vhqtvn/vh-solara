import { test, expect } from "@playwright/test";
import * as H from "./util";

// Shell wiring: drives the REAL UI (workspace tabstrip, the AddServer trigger,
// the P3 NEXT hero button, tray chip) — not the bridge — to prove the host
// chrome is wired end-to-end. Survival is covered by survival.spec.ts; this
// covers the affordances a human would use. Chromium only (Firefox runs
// survival.spec.ts; this is chrome-only UI smoke).
//
// The bottom statusbar was REMOVED in its entirety (operator directive). The
// statusbar's layout control cluster (split/close/zoom/tabbed/stacked), the
// focus line, the Q1-C liveness dot/label, the server count, the renderer
// badge, and the "N need you · M running" hub counts are all GONE. The ONLY
// statusbar element that survived is the P3 NEXT hero button, moved into the
// top tabstrip next to "Add server". Split/close/zoom/mode-switch are still
// exercisable via the DEV bridge (hostOps) + the gesture-triggered layout
// overlay; their detailed coverage lives in i3.spec.ts + interaction-overlay.
// spec.ts. The top tabstrip is the WORKSPACE tabstrip (ws-tab/ws-add present).

test.describe("host shell UI wiring", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  test("workspace tabstrip + Add server are present", async ({ page }) => {
    // The brand + one ws-tab per workspace + the add-workspace "+" + the
    // "Add server" trigger are present in the primary nav.
    const wsTabs = page.locator('[data-testid="ws-tab"]');
    await expect(wsTabs).toHaveCount(1); // the seeded default workspace
    await expect(page.locator('[data-testid="ws-add"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="add-server-btn"]')).toHaveCount(1);
  });

  test("no statusbar chrome remains in the DOM", async ({ page }) => {
    // The bottom statusbar was deleted entirely. None of its testids render.
    await expect(page.locator('[data-testid="statusbar"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="attention-hub"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="i3-controls"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="layout-overlay-btn"]')).toHaveCount(0);
    for (const tid of ["i3-split-h", "i3-split-v", "i3-tabbed", "i3-stacked", "i3-zoom", "i3-close"]) {
      await expect(page.locator(`[data-testid="${tid}"]`)).toHaveCount(0);
    }
  });

  test("NEXT hero button lives in the tabstrip: absent at N=0, appears + routes on a need", async ({ page }) => {
    const ids = await H.panes(page);
    const needy = ids[0];
    const other = ids[1];

    // Before any needs-you status, N=0 → no NEXT button.
    await expect(page.locator('[data-testid="attention-next"]')).toHaveCount(0);

    // Drive a needs-permission status on `needy` + focus the OTHER pane so the
    // needy one is not already focused.
    await H.focusPane(page, other);
    await expect.poll(async () => H.focused(page)).toBe(other);
    await H.probeStatus(page, {
      sourcePaneId: needy,
      origin: H.MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "a", title: "A", attention: "needs_permission", activity: "idle", following: true, runningCount: 0, unreadCount: 0 },
    });
    await expect.poll(async () => H.needsYou(page)).toBe(1);

    // The NEXT button now renders in the tabstrip (the attention-loop trigger).
    const next = page.locator('[data-testid="attention-next"]');
    await expect(next).toBeVisible();
    await expect(next).toBeEnabled();
    // Clicking it (production wiring — NOT the DEV bridge) routes to the needy pane.
    await next.click();
    await expect.poll(async () => H.focused(page), { timeout: 5000 }).toBe(needy);
  });

  test("collapse (bridge) parks a pane in the tray chip rail; chip restores it", async ({ page }) => {
    // No statusbar collapse button exists anymore; drive collapse via the DEV
    // bridge to prove the tray-chip restore wiring still works (the tray rail +
    // restore chip live in App.tsx, a sibling of <main>, not the statusbar).
    const ids = await H.panes(page);
    const first = ids[0];
    await H.collapse(page, first);
    // a tray chip appears
    const chip = page.locator('[data-testid="tray-chip"]');
    await expect(chip).toHaveCount(1);
    await expect.poll(async () => H.trayIds(page)).toContainEqual(first);
    // restore via the chip
    await chip.click();
    await expect.poll(async () => (await H.trayIds(page)).includes(first)).toBe(false);
    await expect(page.locator('[data-testid="tray-chip"]')).toHaveCount(0);
  });
});

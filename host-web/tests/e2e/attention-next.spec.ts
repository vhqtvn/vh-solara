import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// P3 ATTENTION LOOP — the NEXT hero button (moved from the deleted bottom
// statusbar into the top tabstrip).
//
// Proves the NEXT hero button appears only when the active workspace has a
// needs-you pane, and clicking it routes to the highest-priority needy pane
// system-wide: rank (needs_permission > needs_reply) → oldest firstNeedsYouAt
// → stable paneId; restoring a trayed pane survival-safely (moveTo/addGroup,
// NEVER removePanel); crossing workspaces when the target lives in a background
// workspace; and composing with the host-owned keyboard focus-mode (exit on a
// cross-pane target, keep on a same-pane target).
//
// The statusbar's "N need you · M running" attention-hub text was REMOVED with
// the statusbar (operator directive); only the conditional NEXT button survived
// (relocated to the tabstrip). The status messages are driven through the
// DEV-only probeStatus bridge (source-bound to a real pane's contentWindow —
// the sanctioned seam, same model as session-attention.spec.ts). The NEXT
// action is driven BOTH by clicking the real DOM button
// ([data-testid="attention-next"], now in the tabstrip) AND via the bridge
// next() helper, which routes through the SAME attentionNext.ts path the button
// uses. Runs on Chromium + Firefox + WebKit.
//
// SURVIVAL GATE: the negative controls (naiveReload / jsonReswap) stay covered
// by tests/e2e/survival.spec.ts (unmodified). This spec adds the complementary
// guarantee: a NEXT-driven restore-from-tray is survival-SAFE (iframe identity
// unchanged).
// =============================================================================

const MOCK_ORIGIN = "http://127.0.0.1:5174"; // mock content origin (:5174)

test.describe("P3 attention loop + NEXT hero button", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  // ---- button visibility -----------------------------------------------------

  test("NEXT button lives in the tabstrip; hidden when N=0", async ({ page }) => {
    // The statusbar attention-hub text is gone; only the conditional NEXT button
    // remains as the attention surface. N=0 before any status → no NEXT button.
    await expect.poll(async () => H.needsYou(page)).toBe(0);
    await expect(page.locator('[data-testid="attention-next"]')).toHaveCount(0);
  });

  test("NEXT button appears when the active workspace has a needs-you pane", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    const b = ids[1];

    // a needs permission (running), b needs reply (idle).
    await H.probeStatus(page, {
      sourcePaneId: a,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "a", title: "A", attention: "needs_permission", activity: "running" },
    });
    await H.probeStatus(page, {
      sourcePaneId: b,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "b", title: "B", attention: "needs_reply", activity: "idle" },
    });

    // N=2 need you (the underlying aggregate drives the tabstrip NEXT button's
    // visibility). The "M running" display is gone with the statusbar; only
    // needsYou is observable here.
    await expect.poll(async () => H.needsYou(page), { timeout: 5000 }).toBe(2);

    // NEXT button now visible in the tabstrip (active-ws N>0).
    await expect(page.locator('[data-testid="attention-next"]')).toBeVisible();
  });

  // ---- N=1: button focuses the needy pane -----------------------------------

  test("N=1: clicking NEXT focuses the single needy pane", async ({ page }) => {
    const ids = await H.panes(page);
    const needy = ids[0];
    const other = ids[1];

    await H.probeStatus(page, {
      sourcePaneId: needy,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "a", title: "A", attention: "needs_permission", activity: "idle" },
    });
    // Focus the OTHER pane first so the needy one is not already focused.
    await H.focusPane(page, other);
    await expect.poll(async () => H.focused(page)).toBe(other);
    await expect.poll(async () => H.needsYou(page)).toBe(1);

    // nextTarget resolves to the needy pane.
    const t = await H.nextTarget(page);
    expect(t!.paneId, "ranking picks the needy pane").toBe(needy);

    // Click the real DOM button (production wiring).
    await page.locator('[data-testid="attention-next"]').click();

    await expect.poll(async () => H.focused(page), { timeout: 5000 }).toBe(needy);
  });

  // ---- N=2 ranking: permission beats reply; older firstNeedsYouAt beats newer

  test("N=2 ranking: needs_permission outranks needs_reply", async ({ page }) => {
    const ids = await H.panes(page);
    const reply = ids[0];
    const perm = ids[1];

    // reply first (older firstNeedsYouAt), permission second (newer). Permission
    // must still win because attention rank dominates the tiebreak.
    await H.probeStatus(page, {
      sourcePaneId: reply,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "r", title: "R", attention: "needs_reply", activity: "idle" },
    });
    await page.waitForTimeout(15);
    await H.probeStatus(page, {
      sourcePaneId: perm,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "p", title: "P", attention: "needs_permission", activity: "idle" },
    });
    await expect.poll(async () => H.needsYou(page)).toBe(2);

    const t = await H.nextTarget(page);
    expect(t!.paneId, "permission outranks reply even when reply is older").toBe(perm);
  });

  test("N=2 ranking: older firstNeedsYouAt wins within the same attention level", async ({ page }) => {
    const ids = await H.panes(page);
    const older = ids[0];
    const newer = ids[1];

    // Both needs_reply; older latched first via a real delay between probes.
    await H.probeStatus(page, {
      sourcePaneId: older,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "o", title: "O", attention: "needs_reply", activity: "idle" },
    });
    await page.waitForTimeout(20);
    await H.probeStatus(page, {
      sourcePaneId: newer,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "n", title: "N", attention: "needs_reply", activity: "idle" },
    });
    await expect.poll(async () => H.needsYou(page)).toBe(2);

    // Confirm the host-latched tiebreak timestamps actually differ (oldest first).
    const to = await H.firstNeedsYouAt(page, older);
    const tn = await H.firstNeedsYouAt(page, newer);
    expect(to, "older pane latched a firstNeedsYouAt").not.toBeNull();
    expect(tn, "newer pane latched a firstNeedsYouAt").not.toBeNull();
    expect(to!, "older firstNeedsYouAt <= newer").toBeLessThanOrEqual(tn!);

    const t = await H.nextTarget(page);
    expect(t!.paneId, "oldest needs-you wins the tiebreak").toBe(older);
  });

  // ---- needy pane in tray: NEXT restores survival-safely + focuses -----------

  test("needy pane in tray: NEXT restores (moveTo/addGroup) + focuses; iframe survives", async ({ page }) => {
    const ids = await H.panes(page);
    const needy = ids[0];
    // Keep another pane on the grid so collapse is allowed (gridPaneCount > 1).
    const grid = ids[1];

    await H.probeStatus(page, {
      sourcePaneId: needy,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "a", title: "A", attention: "needs_permission", activity: "idle" },
    });
    await expect.poll(async () => H.needsYou(page)).toBe(1);
    const before = (await H.survival(page, needy))!;

    // Collapse the needy pane to the tray (addFloatingGroup — survival-safe; the
    // iframe stays mounted). Focus the grid pane so needy is not focused.
    await H.focusPane(page, grid);
    await H.collapse(page, needy);
    await expect.poll(async () => H.trayIds(page)).toContain(needy);

    // The needy pane is in the tray but still needs you (status is GLOBAL).
    expect(await H.needsYou(page), "trayed needy pane still counted").toBe(1);
    await expect(page.locator('[data-testid="attention-next"]')).toBeVisible();

    // NEXT: the target is the trayed needy pane → restore (moveTo/addGroup) +
    // focus. Survival-safe: NEVER removePanel.
    await page.locator('[data-testid="attention-next"]').click();

    // Restored to the grid + focused.
    await expect.poll(async () => H.focused(page), { timeout: 5000 }).toBe(needy);
    await expect.poll(async () => H.trayIds(page), { timeout: 5000 }).not.toContain(needy);

    // CRUX — the iframe SURVIVED the restore (no reload). Identity unchanged.
    await H.assertSurvived(page, needy, before, "NEXT restore-from-tray");
  });

  // ---- cross-workspace: NEXT activates the target workspace + focuses --------

  test("cross-workspace needy: NEXT activates the target ws + focuses", async ({ page }) => {
    const wsIds = await H.workspaces(page);
    const ws1 = wsIds[0]; // active, seeded panes

    // Create a second workspace (becomes active, empty).
    const ws2 = await H.addWorkspace(page, "WS2");
    expect(ws2, "second workspace created").not.toBeNull();
    // Add a server to ws2 so it has a pane to make needy.
    const ws2Pane = await H.addServer(page, "http://127.0.0.1:5174/w2", "ws2-srv");
    expect(ws2Pane, "ws2 pane created").not.toBeNull();
    await H.waitForReady(page, ws2Pane!);

    // Make the ws2 pane HIGH-priority needy (needs_permission).
    await H.probeStatus(page, {
      sourcePaneId: ws2Pane!,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "w2", title: "W2", attention: "needs_permission", activity: "idle" },
    });

    // Switch back to ws1 + make a ws1 pane LOW-priority needy (needs_reply) so
    // the button shows (active-ws N>0) but the global rank picks ws2's pane.
    await H.setActiveWorkspace(page, ws1);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);
    const ws1Panes = await H.panes(page);
    const ws1Pane = ws1Panes[0];
    await H.probeStatus(page, {
      sourcePaneId: ws1Pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "w1", title: "W1", attention: "needs_reply", activity: "idle" },
    });
    await expect.poll(async () => H.needsYou(page)).toBe(1);
    await expect(page.locator('[data-testid="attention-next"]')).toBeVisible();

    // The global ranking picks ws2's needs_permission over ws1's needs_reply.
    const t = await H.nextTarget(page);
    expect(t!.paneId, "ranking crosses ws to the higher-priority needy pane").toBe(ws2Pane);
    expect(t!.wsId, "target workspace is ws2").toBe(ws2);

    // NEXT: activate ws2 + focus ws2's pane (cross-workspace follow-through).
    await page.locator('[data-testid="attention-next"]').click();

    await expect.poll(async () => H.activeWorkspace(page), { timeout: 5000 }).toBe(ws2);
    await expect.poll(async () => H.focused(page), { timeout: 5000 }).toBe(ws2Pane);
  });

  // ---- keyboard composition -------------------------------------------------
  // The keyboard focus-mode DEV bridge is installed in DEV regardless of touch
  // (see keyboardFocus.ts installKeyboardFocus), so these compose correctly on
  // every engine without touch emulation.

  test("keyboard-open + cross-pane target: NEXT exits keyboard focus-mode then focuses", async ({ page }) => {
    const ids = await H.panes(page);
    const focusedPane = ids[0];
    const needyPane = ids[1];

    // Focus focusedPane; make the OTHER pane needy (cross-pane target).
    await H.focusPane(page, focusedPane);
    await expect.poll(async () => H.focused(page)).toBe(focusedPane);
    await H.probeStatus(page, {
      sourcePaneId: needyPane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "n", title: "N", attention: "needs_permission", activity: "idle" },
    });
    await expect.poll(async () => H.needsYou(page)).toBe(1);

    // Open keyboard focus-mode (DEV bridge). It maximizes the FOCUSED pane's
    // group (focusedPane) and claims ownership.
    await H.kbdFocusOpen(page, 360);
    await expect.poll(async () => (await H.kbdFocusState(page)).open).toBe(true);
    await expect.poll(async () => (await H.kbdFocusState(page)).ownedWs).not.toBeNull();
    await expect.poll(async () => H.isMaximized(page)).toBe(true);

    // NEXT: target (needyPane) != focused (focusedPane) → exit keyboard focus-
    // mode FIRST (exits the owned maximize), then focus the target.
    await page.locator('[data-testid="attention-next"]').click();

    await expect.poll(async () => (await H.kbdFocusState(page)).open, { timeout: 5000 }).toBe(false);
    await expect.poll(async () => (await H.kbdFocusState(page)).ownedWs).toBeNull();
    // The keyboard-owned maximize was exited (focus-mode owned it).
    await expect.poll(async () => H.isMaximized(page), { timeout: 5000 }).toBe(false);
    await expect.poll(async () => H.focused(page), { timeout: 5000 }).toBe(needyPane);
  });

  test("keyboard-open + cross-pane target preserves a user's manual maximize", async ({ page }) => {
    const ids = await H.panes(page);
    const focusedPane = ids[0];
    const needyPane = ids[1];

    // Dock needyPane into focusedPane's group as a TAB so the two panes share one
    // group. This ISOLATES the "manual-maximize preserved" property: a cross-
    // GROUP focus switch exits any maximize via Dockview's NATIVE behavior
    // (unrelated to keyboard focus-mode), so to prove the keyboard exit itself
    // does not clobber a manual maximize, the target must stay in the SAME
    // (maximized) group. dockAsTab uses the survival-safe moveTo primitive.
    await H.dockAsTab(page, needyPane, focusedPane);
    await expect.poll(async () => H.sameGroup(page, focusedPane, needyPane)).toBe(true);

    await H.focusPane(page, focusedPane);
    await H.probeStatus(page, {
      sourcePaneId: needyPane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "n", title: "N", attention: "needs_permission", activity: "idle" },
    });
    await expect.poll(async () => H.needsYou(page)).toBe(1);

    // User MANUALLY maximizes the (shared) group (toggleZoom → maximizeGroup).
    // Focus-mode does NOT own it (ownedWs stays null).
    await H.maximize(page, focusedPane);
    await expect.poll(async () => H.isMaximized(page)).toBe(true);
    expect((await H.kbdFocusState(page)).ownedWs, "manual maximize is not focus-owned").toBeNull();

    // Keyboard opens while the user's maximize is active. Focus-mode must NOT
    // clobber it (already maximized) and must NOT claim ownership.
    await H.kbdFocusOpen(page, 360);
    await expect.poll(async () => (await H.kbdFocusState(page)).open).toBe(true);
    expect((await H.kbdFocusState(page)).ownedWs, "focus-mode does not own the manual maximize").toBeNull();

    // NEXT: cross-pane target (needyPane != focused focusedPane, same group) →
    // exit keyboard focus-mode. exitOwned is a NO-OP (focus-mode owns nothing),
    // so the user's MANUAL maximize is PRESERVED. The same-group focus switch
    // (setActive on a tab within the maximized group) does NOT exit the maximize.
    await page.locator('[data-testid="attention-next"]').click();

    await expect.poll(async () => (await H.kbdFocusState(page)).open, { timeout: 5000 }).toBe(false);
    await expect.poll(async () => H.isMaximized(page), { timeout: 5000 }).toBe(true); // manual preserved
    await expect.poll(async () => H.focused(page), { timeout: 5000 }).toBe(needyPane);

    // Clean up the manual maximize so it does not leak into sibling tests.
    await H.exitMaximized(page);
    await expect.poll(async () => H.isMaximized(page)).toBe(false);
  });

  test("keyboard-open + same-pane target: NEXT keeps keyboard mode", async ({ page }) => {
    const ids = await H.panes(page);
    // The needy pane IS the focused pane (same-pane target).
    const pane = ids[0];

    await H.focusPane(page, pane);
    await expect.poll(async () => H.focused(page)).toBe(pane);
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "s", title: "S", attention: "needs_permission", activity: "idle" },
    });
    await expect.poll(async () => H.needsYou(page)).toBe(1);

    // Open keyboard focus-mode (owns the focused pane's maximize).
    await H.kbdFocusOpen(page, 360);
    await expect.poll(async () => (await H.kbdFocusState(page)).open).toBe(true);
    await expect.poll(async () => H.isMaximized(page)).toBe(true);

    // NEXT: target == focused → keep keyboard mode; just ensure focus.
    await page.locator('[data-testid="attention-next"]').click();

    // Keyboard mode STILL open + maximize still active + focus unchanged.
    await expect.poll(async () => (await H.kbdFocusState(page)).open).toBe(true);
    await expect.poll(async () => H.isMaximized(page)).toBe(true);
    await expect.poll(async () => H.focused(page)).toBe(pane);

    // Close the keyboard to clean up for sibling tests.
    await H.kbdFocusClose(page);
    await expect.poll(async () => (await H.kbdFocusState(page)).open).toBe(false);
  });

  // ---- cross-workspace COMPOSITION (reviewer a-F1) --------------------------
  // The cross-ws primitive and the tray-restore primitive are individually
  // proven above; this exercises their COMPOSITION — a needy pane that is BOTH
  // in a background workspace AND collapsed to the tray. next() must
  // setActiveWorkspace(target.ws) FIRST (the sync re-projects hostOps() to the
  // target ws) THEN hostOps().restore() on the now-active ws, survival-safely
  // (moveTo/addGroup, NEVER removePanel). Pin behaviorally that hostOps()
  // resolves the target ws after the switch + that the iframe identity survives
  // the cross-ws switch AND the tray restore together.

  test("cross-ws + tray-restore composition: NEXT switches ws AND restores the trayed needy pane; iframe survives", async ({ page }) => {
    const wsIds = await H.workspaces(page);
    const ws1 = wsIds[0]; // active, seeded panes

    // Create ws2 (becomes active). Add TWO panes so a collapse is allowed — the
    // collapse guard refuses when gridPaneCount would drop to 0.
    const ws2 = await H.addWorkspace(page, "WS2");
    expect(ws2, "second workspace created").not.toBeNull();
    const ws2Needy = await H.addServer(page, "http://127.0.0.1:5174/w2n", "ws2-needy");
    const ws2Grid = await H.addServer(page, "http://127.0.0.1:5174/w2g", "ws2-grid");
    expect(ws2Needy, "ws2 needy pane created").not.toBeNull();
    expect(ws2Grid, "ws2 grid pane created").not.toBeNull();
    await H.waitForReady(page, ws2Needy!);
    await H.waitForReady(page, ws2Grid!);

    // Collapse ws2Needy to the tray (ws2 is active; ws2Grid stays on the grid).
    // addFloatingGroup is survival-safe — the iframe stays mounted, only its
    // Dockview location moves to a floating group (renderer:'always').
    await H.focusPane(page, ws2Grid!);
    await H.collapse(page, ws2Needy!);
    await expect.poll(async () => H.trayIds(page)).toContain(ws2Needy);

    // Make the TRAYED ws2 pane HIGH-priority needy (needs_permission). Status is
    // GLOBAL (source-bound), so it lands regardless of the active workspace.
    await H.probeStatus(page, {
      sourcePaneId: ws2Needy!,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "w2", title: "W2", attention: "needs_permission", activity: "idle" },
    });

    // Capture survival baseline for the trayed pane BEFORE the cross-ws+restore.
    const before = (await H.survival(page, ws2Needy!))!;
    expect(before.connId, "trayed pane is heartbeating").not.toBeNull();

    // Switch to ws1 + make a ws1 pane LOW-priority needy (needs_reply) so the
    // button shows (active-ws N>0) but the GLOBAL rank picks ws2's trayed pane.
    await H.setActiveWorkspace(page, ws1);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);
    const ws1Panes = await H.panes(page);
    const ws1Pane = ws1Panes[0];
    await H.probeStatus(page, {
      sourcePaneId: ws1Pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "w1", title: "W1", attention: "needs_reply", activity: "idle" },
    });
    await expect.poll(async () => H.needsYou(page)).toBe(1);
    await expect(page.locator('[data-testid="attention-next"]')).toBeVisible();

    // The global ranking crosses ws AND skips the tray to pick ws2's permission pane.
    const t = await H.nextTarget(page);
    expect(t!.paneId, "ranking crosses ws to the trayed permission pane").toBe(ws2Needy);
    expect(t!.wsId, "target workspace is ws2").toBe(ws2);

    // CRUX — click NEXT: the composition is setActiveWorkspace(ws2) THEN
    // hostOps().restore(ws2Needy) on the now-active ws2. ws2 must be active AND
    // the pane restored from tray AND iframe identity unchanged.
    await page.locator('[data-testid="attention-next"]').click();

    await expect.poll(async () => H.activeWorkspace(page), { timeout: 5000 }).toBe(ws2);
    await expect.poll(async () => H.focused(page), { timeout: 5000 }).toBe(ws2Needy);
    await expect.poll(async () => H.trayIds(page), { timeout: 5000 }).not.toContain(ws2Needy);

    // CRUX — iframe SURVIVED the cross-ws switch + tray restore (no reload).
    await H.assertSurvived(page, ws2Needy!, before, "cross-ws + tray restore");
  });

  // ---- cross-workspace COMPOSITION (reviewer d-F1) --------------------------
  // The cross-ws primitive and the keyboard-exit primitive are individually
  // proven above; this exercises their COMPOSITION — keyboard focus-mode owned
  // in ws1 while a needy pane lives in ws2. next() must exitKeyboardFocus()
  // (cross-pane rule) so the keyboard closes and ws1's owned maximize is exited
  // (not re-pinned by onWorkspaceActivated, which is a no-op once
  // keyboardOpen=false). Pin behaviorally that no stale maximize is left on ws1
  // and that the iframe identity survives the cross-ws switch + keyboard exit.

  // d-F1 composition contract (now passing). This test asserts the d-F1
  // contract: a cross-ws NEXT while keyboard focus-mode is owned in ws1 must
  // EXIT keyboard focus-mode (cross-pane rule) so the keyboard closes, ws1's
  // owned maximize is exited (not re-pinned by onWorkspaceActivated), and the
  // ws2 iframe identity survives the cross-ws switch.
  //
  // HISTORY: this composition was previously broken in attentionNext.ts next().
  // The ws switch ran BEFORE the keyboard rule; setActiveWorkspace(target.wsId)
  // SYNCHRONOUSLY re-projected focusedId() to the target (store.ts
  // setActiveWorkspace → hostController.syncAll → setFocused), so by the time
  // the keyboard rule evaluated
  //     if (isKeyboardOpen() && target.paneId !== focusedId())
  // focusedId() ALREADY equaled target.paneId (the re-projected ws-switch
  // target) → the cross-pane condition was false → exitKeyboardFocus() NEVER
  // fired. onWorkspaceActivated (keyboardFocus.ts) then flushed with
  // keyboardOpen still true and re-pointed the maximize to ws2
  // (exitOwned(ws1) + maximizeActive(ws2)); switching back re-maximized ws1.
  // Observed (chromium probe): open=true ownedWs=ws-2 ws2Maximized=true
  // ws1Maximized=true.
  //
  // FIX: attentionNext.ts next() now captures the PRE-switch focusedId at the
  // top (before setActiveWorkspace) and evaluates the keyboard rule against it,
  // so the cross-pane case is correctly detected and exitKeyboardFocus() fires
  // before onWorkspaceActivated re-points the owned maximize.
  test("cross-ws + keyboard-open composition: NEXT switches ws, exits keyboard focus-mode, leaves no stale ws1 maximize; iframe survives", async ({ page }) => {
    const wsIds = await H.workspaces(page);
    const ws1 = wsIds[0]; // active, seeded panes

    // Create ws2 (becomes active) + a pane; wait for it to heartbeat so it can be
    // the needy target and so its survival is observable.
    const ws2 = await H.addWorkspace(page, "WS2");
    expect(ws2).not.toBeNull();
    const ws2Pane = await H.addServer(page, "http://127.0.0.1:5174/w2", "ws2-srv");
    expect(ws2Pane).not.toBeNull();
    await H.waitForReady(page, ws2Pane!);

    // Make the ws2 pane HIGH-priority needy (needs_permission). Status is GLOBAL.
    await H.probeStatus(page, {
      sourcePaneId: ws2Pane!,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "w2", title: "W2", attention: "needs_permission", activity: "idle" },
    });

    // Switch back to ws1 + make a ws1 pane LOW-priority needy (needs_reply) so
    // the button shows (active-ws N>0) but the GLOBAL rank picks ws2's pane.
    await H.setActiveWorkspace(page, ws1);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);
    const ws1Panes = await H.panes(page);
    const ws1Focused = ws1Panes[0];
    await H.focusPane(page, ws1Focused);
    await expect.poll(async () => H.focused(page)).toBe(ws1Focused);
    await H.probeStatus(page, {
      sourcePaneId: ws1Focused,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "w1", title: "W1", attention: "needs_reply", activity: "idle" },
    });
    await expect.poll(async () => H.needsYou(page)).toBe(1);
    await expect(page.locator('[data-testid="attention-next"]')).toBeVisible();

    // Capture ws2 pane survival BEFORE the cross-ws switch (survival is GLOBAL).
    const before = (await H.survival(page, ws2Pane!))!;
    expect(before.connId, "ws2 pane is heartbeating").not.toBeNull();

    // Open keyboard focus-mode in ws1 (owns ws1's maximize on the focused group).
    // This is the "keyboard focus-mode owned in ws1" setup.
    await H.kbdFocusOpen(page, 360);
    await expect.poll(async () => (await H.kbdFocusState(page)).open).toBe(true);
    await expect.poll(async () => (await H.kbdFocusState(page)).ownedWs).toBe(ws1);
    await expect.poll(async () => H.isMaximized(page)).toBe(true);

    // The global ranking picks ws2's permission pane over ws1's reply pane.
    const t = await H.nextTarget(page);
    expect(t!.paneId, "ranking crosses ws to ws2's permission pane").toBe(ws2Pane);
    expect(t!.wsId, "target workspace is ws2").toBe(ws2);

    // CRUX — click NEXT: composition is the cross-pane keyboard rule
    // (exitKeyboardFocus) + the ws switch. exitKeyboardFocus must fire so the
    // keyboard closes and ws1's owned maximize is exited (not re-pinned by
    // onWorkspaceActivated, which is a no-op once keyboardOpen=false).
    await page.locator('[data-testid="attention-next"]').click();

    // ws2 activated + ws2 pane focused.
    await expect.poll(async () => H.activeWorkspace(page), { timeout: 5000 }).toBe(ws2);
    await expect.poll(async () => H.focused(page), { timeout: 5000 }).toBe(ws2Pane);

    // Keyboard focus-mode EXITED (the cross-pane rule).
    await expect.poll(async () => (await H.kbdFocusState(page)).open, { timeout: 5000 }).toBe(false);
    await expect.poll(async () => (await H.kbdFocusState(page)).ownedWs).toBeNull();
    // ws2 (now active) is not left maximized.
    await expect.poll(async () => H.isMaximized(page), { timeout: 5000 }).toBe(false);

    // CRUX — no stale maximize pinned on ws1 after onWorkspaceActivated flushes.
    // Switch back to ws1 (survival-safe CSS-visibility switch) and confirm ws1's
    // group is no longer maximized.
    await H.setActiveWorkspace(page, ws1);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);
    await expect.poll(async () => H.isMaximized(page), { timeout: 5000 }).toBe(false);

    // CRUX — iframe SURVIVED the cross-ws switch + keyboard exit (no reload).
    await H.assertSurvived(page, ws2Pane!, before, "cross-ws + keyboard exit");
  });
});

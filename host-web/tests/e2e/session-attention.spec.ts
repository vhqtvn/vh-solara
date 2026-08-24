import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// P1 session-attention layer — pane status capture + routing.
//
// Proves the host captures a {type:"status"} message from a pane (source-bound,
// via the REAL routeMessage router — same path the SPA's statusEmitter uses),
// stores it per-pane, recomputes the active-workspace needs-you aggregate
// (which drives the tabstrip's P3 NEXT button + the per-tab needs-you badges),
// enforces the origin-check tier (a wrong-origin status is rejected), and does
// NOT reload the iframe (survival-unchanged).
//
// PHASE 1 (i3 host-shell, item 2): the per-pane header (label + attention badge
// + Q1-C liveness dot) was REMOVED. The bottom statusbar (which carried the Q1-C
// liveness dot/label + the "N need you · M running" attention-hub text) was
// ALSO removed (operator directive). So neither Q1-C liveness NOR the attention-
// hub count has a DOM surface anymore: the P1 attention data path reaches the
// DOM only via the tabstrip's conditional NEXT button + the per-tab needs-you
// badges, and the Q1-C liveness state is observable only via the DEV bridge
// (H.liveness). The prior statusbar-surface "distinctness" test was removed
// (its DOM targets are gone); the underlying DATA distinctness is still proven
// by the wrong-origin test (status storage vs liveness state, via the bridge).
//
// The status message is driven through the DEV-only probeStatus bridge
// (source-bound to a real pane's contentWindow) — the sanctioned seam, same
// model as route-state.spec.ts. Runs on Chromium + Firefox + WebKit.
//
// The survival NEGATIVE-CONTROLS (naiveReload / jsonReswap) are NOT exercised
// here — they remain covered by tests/e2e/survival.spec.ts (unmodified). This
// spec adds the complementary guarantee: a status message is survival-SAFE.
// =============================================================================

// A wrong origin used to prove the status branch's constraint-#3 origin check.
// NOT the seeded panes' configured origin (:5174), so a status from here must be
// rejected even though its source binds to a known pane.
const WRONG_ORIGIN = "http://127.0.0.1:9999";

test.describe("P1 session-attention", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  // ---- capture + storage ---------------------------------------------------

  test("captures a {type:status} message (source-bound) into per-pane status", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];

    // Before: only the mock's handshake-time status echo (tail-follow facet,
    // neutral attention) — no ATTENTION-bearing status posted yet. (Since the
    // tail feature, the mock reports an initial {type:"status",following:true}
    // once the handshake captures the reply origin — the faithful stand-in for
    // the real SPA's statusEmitter, which starts its idempotent-on-change
    // emission at handshake.)
    const initial = await H.status(page, pane);
    expect(initial, "handshake status echo present").not.toBeNull();
    expect(initial!.attention, "initial echo is attention-neutral").toBe("none");
    expect(initial!.following, "initial echo reports tail on").toBe(true);

    const r = await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: H.MOCK_ORIGIN,
      payload: {
        type: "status",
        dir: "/proj",
        session: "s1",
        title: "Refactor parser",
        attention: "needs_permission",
        activity: "running",
        following: true,
        runningCount: 0,
        unreadCount: 0,
      },
    });
    expect(r.accepted, "status message accepted (source-bound)").toBe(true);
    expect(r.reason).toBe("accepted:non-heartbeat");

    const st = await H.status(page, pane);
    expect(st, "status stored per-pane").not.toBeNull();
    expect(st!.attention).toBe("needs_permission");
    expect(st!.activity).toBe("running");
    expect(st!.title).toBe("Refactor parser");
    expect(st!.session).toBe("s1");
  });

  test("rejects an out-of-vocabulary status (closed-set defense-in-depth)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const before = await H.status(page, pane);

    // A status with out-of-vocabulary attention/activity from a BOUND source is
    // ignored entirely (ignored-non-pane-to-host) — never stored. (Unknown-
    // SOURCE rejection is the same constraint-#3 path covered by heartbeat.spec;
    // status reuses it verbatim.) The host never stores an arbitrary string.
    const malformed = await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: H.MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "", title: "", attention: "bogus", activity: "also-bogus", following: true, runningCount: 0, unreadCount: 0 },
    });
    expect(malformed.accepted, "out-of-vocabulary status rejected").toBe(false);
    expect(malformed.reason).toBe("ignored-non-pane-to-host");
    expect(await H.status(page, pane), "nothing stored from a malformed status").toEqual(before);
  });

  test("rejects a wrong-origin status — origin checked, not source-binding only (B-F1)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];

    // Establish a known baseline from the CORRECT origin so we can prove the
    // wrong-origin post mutates NOTHING (status store / badge / needs-you /
    // liveness). needs_permission → a visible "!" badge + needs-you count.
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: H.MOCK_ORIGIN,
      payload: { type: "status", dir: "/proj", session: "s1", title: "Baseline", attention: "needs_permission", activity: "running", following: true, runningCount: 0, unreadCount: 0 },
    });
    const baseline = await H.status(page, pane);
    expect(baseline!.attention, "baseline established").toBe("needs_permission");
    await expect.poll(async () => H.needsYou(page), { timeout: 5000 }).toBe(1);
    const baselineLiveness = await H.liveness(page, pane);

    // B-F1: a {type:"status"} whose source binds to a known pane but whose
    // origin ≠ the pane's configured origin (:5174) must be REJECTED. status
    // follows the HEARTBEAT trust tier (origin-checked), not the title/route
    // tier (source-binding-only, display-only). A bound WindowProxy survives a
    // cross-origin navigation, so a hijacked/navigated iframe could otherwise
    // inject a forged needs_permission/needs_reply (trust-destroying, since
    // attention drives operator NEXT routing).
    const r = await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: WRONG_ORIGIN,
      payload: { type: "status", dir: "/evil", session: "evil", title: "Forged", attention: "needs_reply", activity: "error", following: true, runningCount: 0, unreadCount: 0 },
    });
    expect(r.accepted, "wrong-origin status rejected").toBe(false);
    expect(r.reason).toBe("rejected:origin-mismatch");

    // The message did NOT land: statusByPane, the needs-you aggregate, and the
    // Q1-C liveness are all unchanged. (These are store-derived; the status-store
    // equality is the deterministic mutation proof. The per-pane badge chrome was
    // removed in Phase 1 item 2 — the needsYou count above is the live surface.)
    expect(await H.status(page, pane), "statusByPane unchanged by the wrong-origin post").toEqual(baseline);
    expect(await H.needsYou(page), "needs-you aggregate unchanged").toBe(1);
    expect(await H.liveness(page, pane), "Q1-C liveness unchanged").toBe(baselineLiveness);
  });

  // PHASE 1 (item 2): the per-pane header (label + attention badge) was REMOVED.
  // The two tests that asserted on .pane-label / .pane-status-badge were deleted
  // (their DOM targets no longer exist). The P1 status DATA path is still proven
  // by the capture/reject tests above; attention is now surfaced via the
  // statusbar attention-hub (the workspace-aggregate needs-you count, asserted in
  // the wrong-origin test + workspace-tabs.spec.ts needs-you-badge test).

  // ---- attention surfaces in the DOM via the tabstrip NEXT button -----------
  // The statusbar surface (Q1-C liveness text + "N need you" hub count) is gone
  // with the statusbar. The P1 attention data path now reaches the DOM only via
  // the tabstrip's conditional NEXT button (visible when needsYou>0) + the
  // per-tab needs-you badges. This proves a captured needs-permission status
  // drives the NEXT button's visibility (the remaining operator-facing attention
  // surface). (The per-tab badge is covered by workspace-tabs.spec.ts.)

  test("a needs-permission status surfaces the tabstrip NEXT button (the remaining attention DOM surface)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];

    // No needs-you before any status → no NEXT button.
    await expect(page.locator('[data-testid="attention-next"]')).toHaveCount(0);

    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: H.MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "s1", title: "T", attention: "needs_permission", activity: "running", following: true, runningCount: 0, unreadCount: 0 },
    });

    // The needs-you aggregate flips to 1 → the tabstrip NEXT button appears.
    await expect.poll(async () => H.needsYou(page), { timeout: 8000 }).toBe(1);
    await expect(page.locator('[data-testid="attention-next"]')).toBeVisible();
  });

  // ---- survival-SAFE (complements survival.spec negative controls) ---------

  test("a status message does NOT reload the iframe (survival-unchanged)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const before = (await H.survival(page, pane))!;

    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: H.MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "s1", title: "", attention: "needs_permission", activity: "running", following: true, runningCount: 0, unreadCount: 0 },
    });

    // Identity SURVIVED: mountTs/nonce/connId unchanged (P1 is additive DOM
    // reflection; it never touches the iframe element).
    await H.assertSurvived(page, pane, before, "status message");
  });

  test("title is capped at the host-side limit (defense-in-depth)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const huge = "x".repeat(5000);
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: H.MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "s1", title: huge, attention: "none", activity: "idle", following: true, runningCount: 0, unreadCount: 0 },
    });
    const st = await H.status(page, pane);
    expect(st!.title.length, "title capped at ingress").toBeLessThanOrEqual(120);
  });
});

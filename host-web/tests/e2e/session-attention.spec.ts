import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// P1 session-attention layer — pane status capture + indicators.
//
// Proves the host captures a {type:"status"} message from a pane (source-bound,
// via the REAL routeMessage router — same path the SPA's statusEmitter uses),
// reflects it into the statusbar attention hub (the workspace-aggregate needs-you
// count + NEXT routing), keeps the Q1-C document-liveness indicator visually +
// semantically DISTINCT (liveness dot/label vs the attention-hub count), and
// does NOT reload the iframe (survival-unchanged).
//
// PHASE 1 (i3 host-shell, item 2): the per-pane header (label + attention badge
// + Q1-C liveness dot) was REMOVED — panes are content + focus-border only. The
// attention + liveness signals now live at the STATUSBAR (the hub count + the
// focused-pane liveness dot/label). The two per-pane-indicator tests that
// asserted on .pane-label / .pane-status-badge / .pane-liveness-* were removed
// (their DOM targets no longer exist); the Q1-C distinctness guarantee was
// rewritten to assert at the statusbar surface.
//
// The status message is driven through the DEV-only probeStatus bridge
// (source-bound to a real pane's contentWindow) — the sanctioned seam, same
// model as route-state.spec.ts. Runs on Chromium + Firefox + WebKit.
//
// The survival NEGATIVE-CONTROLS (naiveReload / jsonReswap) are NOT exercised
// here — they remain covered by tests/e2e/survival.spec.ts (unmodified). This
// spec adds the complementary guarantee: a status message is survival-SAFE.
// =============================================================================

const MOCK_ORIGIN = "http://127.0.0.1:5174"; // mock content origin (:5174)
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

    // Before: no status reported yet.
    expect(await H.status(page, pane), "no status before any post").toBeNull();

    const r = await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: {
        type: "status",
        dir: "/proj",
        session: "s1",
        title: "Refactor parser",
        attention: "needs_permission",
        activity: "running",
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
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "", title: "", attention: "bogus", activity: "also-bogus" },
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
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "/proj", session: "s1", title: "Baseline", attention: "needs_permission", activity: "running" },
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
      payload: { type: "status", dir: "/evil", session: "evil", title: "Forged", attention: "needs_reply", activity: "error" },
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

  // ---- distinctness from Q1-C document-liveness (statusbar surface) ---------

  test("Q1-C liveness + P1 attention render simultaneously + stay distinct (statusbar)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];

    // Drive a needs_permission status on the focused pane so the attention hub
    // shows a non-zero count. Focus the pane so its Q1-C liveness surfaces in the
    // statusbar.
    await H.focusPane(page, pane);
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "s1", title: "T", attention: "needs_permission", activity: "running" },
    });

    const bar = page.locator('[data-testid="statusbar"]');

    // Q1-C liveness: the statusbar shows the focused pane's DOCUMENT liveness
    // (Q1-C wording, never realtime/SSE). The mock heartbeats → "document alive".
    await expect(bar).toContainText("document alive");

    // P1 attention hub: the statusbar shows the active-workspace needs-you count
    // (the live attention surface after the per-pane chrome was removed).
    await expect.poll(async () => H.needsYou(page), { timeout: 8000 }).toBe(1);
    await expect(bar.locator('[data-testid="attention-hub"]')).toContainText("1 need you");

    // DISTINCTNESS (the load-bearing guarantee): the liveness channel (Q1-C dot
    // + "document alive" text) and the attention channel (the hub count) are
    // SEPARATE elements with non-overlapping wording — a glance distinguishes
    // "document alive" (Q1-C) from "1 need you" (P1 attention). Both render at
    // once over the same statusbar.
    const text = (await bar.textContent()) ?? "";
    expect(text, "Q1-C liveness wording present").toContain("document alive");
    expect(text, "P1 attention wording present").toContain("need you");
  });

  // ---- survival-SAFE (complements survival.spec negative controls) ---------

  test("a status message does NOT reload the iframe (survival-unchanged)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const before = (await H.survival(page, pane))!;

    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "s1", title: "", attention: "needs_permission", activity: "running" },
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
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "s1", title: huge, attention: "none", activity: "idle" },
    });
    const st = await H.status(page, pane);
    expect(st!.title.length, "title capped at ingress").toBeLessThanOrEqual(120);
  });
});

import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// P1 session-attention layer — pane status capture + indicators.
//
// Proves the host captures a {type:"status"} message from a pane (source-bound,
// via the REAL routeMessage router — same path the SPA's statusEmitter uses),
// reflects it into the pane header (attention badge + real title over the
// server label) and the workspace-aggregate needs-you badge, keeps the Q1-C
// document-liveness indicator visually + semantically DISTINCT, and does NOT
// reload the iframe (survival-unchanged).
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
    // Q1-C liveness are all unchanged. (Badge + liveness are store-derived; the
    // status-store equality is the deterministic mutation proof.)
    expect(await H.status(page, pane), "statusByPane unchanged by the wrong-origin post").toEqual(baseline);
    expect(await H.needsYou(page), "needs-you aggregate unchanged").toBe(1);
    expect(await H.liveness(page, pane), "Q1-C liveness unchanged").toBe(baselineLiveness);
    // Badge still reflects the baseline attention (not the forged needs_reply).
    await expect(page.locator(`[data-pane-id="${pane}"] .pane-status-badge`)).toHaveAttribute("data-attention", "needs_permission");
  });

  // ---- pane-level indicator (PRIMARY): title + attention badge -------------

  test("pane header surfaces the real title over the server label", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const labelBefore = await page
      .locator(`[data-pane-id="${pane}"] .pane-label`)
      .textContent();

    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: {
        type: "status",
        dir: "/proj",
        session: "s1",
        title: "Real Session Title XYZ",
        attention: "none",
        activity: "idle",
      },
    });

    // The renderer reflects title on its ~2 Hz refresh; poll for it.
    await expect
      .poll(
        async () => page.locator(`[data-pane-id="${pane}"] .pane-label`).textContent(),
        { timeout: 5000 },
      )
      .toBe("Real Session Title XYZ");
    // And it differs from whatever was there before (the server/mock label).
    expect(labelBefore, "title replaced/augmented the raw label").not.toContain(
      "Real Session Title XYZ",
    );
  });

  test("attention badge shows for needs_permission / needs_reply; hidden for none", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const badge = page.locator(`[data-pane-id="${pane}"] .pane-status-badge`);

    // needs_permission → visible "!" badge, data-attention set.
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "s1", title: "", attention: "needs_permission", activity: "idle" },
    });
    await expect.poll(async () => badge.getAttribute("data-attention"), { timeout: 5000 }).toBe("needs_permission");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("!");

    // needs_reply → "?" badge.
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "s1", title: "", attention: "needs_reply", activity: "idle" },
    });
    await expect.poll(async () => badge.getAttribute("data-attention"), { timeout: 5000 }).toBe("needs_reply");
    await expect(badge).toHaveText("?");

    // none → hidden, no attention attr.
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "s1", title: "", attention: "none", activity: "idle" },
    });
    await expect.poll(async () => badge.isHidden(), { timeout: 5000 }).toBe(true);
  });

  // ---- workspace-aggregate badge (SECONDARY) -------------------------------

  test("workspace needs-you badge counts needs-attention panes", async ({ page }) => {
    const ids = await H.panes(page);
    // No needs-you panes → no badge, count 0.
    expect(await H.needsYou(page), "no needs-you before any status").toBe(0);
    await expect(page.locator('[data-testid="ws-needs-you"]')).toHaveCount(0);

    // Two panes need you.
    await H.probeStatus(page, {
      sourcePaneId: ids[0],
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "a", title: "", attention: "needs_permission", activity: "idle" },
    });
    await H.probeStatus(page, {
      sourcePaneId: ids[1],
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "b", title: "", attention: "needs_reply", activity: "idle" },
    });
    await expect.poll(async () => H.needsYou(page), { timeout: 5000 }).toBe(2);
    await expect(page.locator('[data-testid="ws-needs-you"]')).toHaveText("2");

    // One resolves → count drops to 1.
    await H.probeStatus(page, {
      sourcePaneId: ids[0],
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "a", title: "", attention: "none", activity: "idle" },
    });
    await expect.poll(async () => H.needsYou(page), { timeout: 5000 }).toBe(1);
    await expect(page.locator('[data-testid="ws-needs-you"]')).toHaveText("1");
  });

  // ---- distinctness from Q1-C document-liveness ----------------------------

  test("Q1-C liveness indicator stays distinct + unchanged alongside P1 attention", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const root = page.locator(`[data-pane-id="${pane}"]`);

    // Drive BOTH: a heartbeat-driven liveness state (alive) AND a needs-permission
    // status. Both indicators must render SIMULTANEOUSLY and remain distinct.
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "", session: "s1", title: "T", attention: "needs_permission", activity: "running" },
    });

    // Q1-C liveness dot + label still present with Q1-C wording (never the P1
    // attention wording). The mock heartbeats → "document alive".
    await expect(root.locator(".pane-liveness-dot")).toBeVisible();
    await expect
      .poll(async () => root.locator(".pane-liveness-label").textContent(), { timeout: 5000 })
      .toMatch(/alive|reloaded|no recent signal/);

    // P1 attention badge present with its OWN wording/shape (no overlap). Poll
    // for the renderer's reflection (it updates on a ~2 Hz tick) BEFORE reading
    // the glyph text.
    await expect
      .poll(async () => root.locator(".pane-status-badge").getAttribute("data-attention"), { timeout: 5000 })
      .toBe("needs_permission");
    await expect(root.locator(".pane-status-badge")).toBeVisible();
    const badgeText = await root.locator(".pane-status-badge").textContent();
    expect(badgeText, "P1 badge uses a glyph, never Q1-C wording").toMatch(/^[!?]$/);

    // Shape distinctness: liveness is a circle dot; attention is a rounded-rect
    // badge (different class + element).
    await expect(root.locator(".pane-liveness-dot")).toHaveClass(/pane-liveness-dot/);
    await expect(root.locator(".pane-status-badge")).toHaveClass(/pane-status-badge/);
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

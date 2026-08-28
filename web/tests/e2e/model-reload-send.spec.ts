import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// P1 regression (lane 6): an explicit per-session model/variant pick made in
// the composer must survive a page reload and be dispatched on the next send —
// NOT the stale server session.model and NOT the global fallback. This is the
// browser-level proof of the silent-flip fix (unit seam:
// modelsSessionPersist.test.ts; agent-provenance guard:
// modelsAgentOverride.test.ts (d)).
//
// Discriminator: the seeded Demo session's server evidence is
// model {fake, dummy} variant "default" (pkg/fixtures/opencode.go), so a
// pre-fix reload (in-memory pick wiped) dispatches dummy/default. The explicit
// pick is Dummy Thinking (dummy-think) + variant "low" — differing in BOTH the
// model id and the variant, so the outgoing request body alone proves which
// path resolved.
//
// Serial-suite hygiene: uses the shared Demo session (sending one turn is the
// established pattern — see codeview.spec.ts's note); the persisted pick lives
// in per-test context localStorage, so nothing leaks into sibling specs. The
// prompt_async interception is registered before any send and survives the
// reload (page routes persist across navigations).
test("explicit model/variant pick survives reload and is dispatched exactly once", async ({ page }) => {
  // Capture every outgoing prompt POST (the SPA's send path: enqueue → drain →
  // POST /oc/session/:id/prompt_async with body.model + body.variant).
  const posts: { model?: { providerID?: string; modelID?: string }; variant?: string }[] = [];
  await page.route("**/oc/session/*/prompt_async", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      try {
        posts.push(req.postDataJSON());
      } catch {
        posts.push({});
      }
    }
    await route.continue();
  });

  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();

  // Baseline: the composer resolves the STALE server evidence (Dummy Model).
  await expect(page.locator(".model-btn-name")).toHaveText("Dummy Model");

  // The explicit USER gesture: pick Dummy Thinking, then variant "low".
  await page.locator(".model-btn").click();
  const dialog = page.getByRole("dialog", { name: "Select model" });
  await dialog.getByText("Dummy Thinking").click();
  await expect(page.getByRole("dialog", { name: "Select model" })).toHaveCount(0);
  await expect(page.locator(".model-btn-name")).toContainText("Dummy Thinking");
  const variant = page.locator(".variant-select");
  await variant.locator(".vh-select-btn").click();
  await page.getByRole("option", { name: "low" }).click();
  await expect(variant.locator(".vh-select-label")).toHaveText("low");

  // THE RELOAD: in-memory sessionSel + explicit provenance are wiped; the pick
  // must restore from the per-project persisted map (vh.sessionmodels.v1:<dir>).
  await page.reload();

  // The URL still carries ?session=demo, and the restored pick must top the
  // resolution chain — the composer shows the pick, not the server's dummy.
  await expect(page.locator(".model-btn-name")).toContainText("Dummy Thinking", { timeout: 10000 });
  await expect(page.locator(".variant-select .vh-select-label")).toHaveText("low");

  // Real user action: type + Enter (through the real event model, not an API
  // call). Wait for the composer's ready signals (agents + models loaded) so
  // the send is admitted rather than bounced by the still-loading gate.
  await expect(page.locator(".agent-select")).toBeVisible({ timeout: 10000 });
  await page.getByPlaceholder(/Message/).fill("model persistence probe");
  await page.keyboard.press("Enter");

  // The outgoing request carries the ORIGINAL explicit model/variant exactly,
  // exactly once. (Poll on the captured request — NOT on server-side turn
  // settlement; the crux is what left the browser.)
  await expect.poll(() => posts.length, { timeout: 15000 }).toBe(1);
  expect(posts[0].model).toEqual({ providerID: "fake", modelID: "dummy-think" });
  expect(posts[0].variant).toBe("low");
  expect(posts.length).toBe(1);

  // Courtesy settle (serial hygiene — mirrors interactive.spec.ts): let the
  // appended turn finish so the next spec boots against an idle demo session.
  await expect(page.getByText(/Done\. Updated/).first()).toBeVisible({ timeout: 10000 });
});

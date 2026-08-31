import { expect, test, type APIRequestContext } from "@playwright/test";
import { demoDir, projectUrl } from "./util";

// A2 + B1 (lane 6): the DRAFT→live model-pick lifecycle across a TERMINAL
// first-send failure. Focused sibling of model-reload-send.spec.ts — that file
// pins the LIVE-session case (pre-existing session, reload, one send); this one
// owns the draft lifecycle it deliberately does not exercise: an explicit
// model/variant pick made as a DRAFT must (A2) ride the first-send
// materialization (send() → ensureSession → migrateModelPick("", liveID) → the
// per-project pick map, web/src/models.ts) onto the outgoing dispatch, and
// (B1) survive a terminal client-visible failure (non-2xx on prompt_async) +
// reload + the real failed-chip "Edit again" recovery, governing the resent
// dispatch too.
//
// Discriminator: a fresh DRAFT resolves the @plan agent default, whose declared
// model is dummy-think/"high" (pkg/fixtures/opencode.go /agent + /provider);
// the global fallback is dummy/no-variant. The explicit pick is
// dummy-think + variant "low" — the ONLY pick in the fixture's two-model list
// that differs from BOTH fallbacks (dummy-think/high and dummy/-), so the
// composer display AND each outgoing request body independently prove which
// resolution chain won. The materialized ses_newN carries NO server model
// evidence, so after reload the pick map is the only source that can produce
// "low" — exactly the P1/migrateModelPick contract under test.
//
// Failure-mode fidelity: the 502 is a PAGE-LOCAL Playwright fulfillment — it
// proves the CLIENT-VISIBLE terminal non-2xx contract (dispatchQueuedItem
// classifies non-2xx as `failed`, never repends), NOT the Go fixture's
// PromptAsyncRejectBeforeCommit server internals.
//
// Serial-suite hygiene (workers:1 over ONE shared fixtureserver): the test owns
// a FRESH ses_newN session and removes ALL of its residue in afterEach —
// queue items via the real /vh/session/<sid>/queue API (the recovery resend
// leaves a durable `sent` item that the FE filters but the daemon keeps until
// compaction; a mid-test failure can leave the `failed` one), then the session
// itself via the fake's /oc/fixture/delete passthrough (emits session.deleted
// so the aggregator store drops it too — see pins-multiclient.spec.ts). The
// prompt_async interception is page-scoped (dies with the page) and never
// touches the shared backend's failure mode. The PWA service worker is blocked
// for this test because an activated SW sits in the fetch path and can bypass
// page.route interception (same reason + pattern as ux.spec.ts's hung-socket
// test — mandatory in the serial suite where prior tests warm the SW).

// The materialized session id, captured for afterEach cleanup. Null until the
// first send creates the session; every cleanup step is conditional on it.
let sid: string | null = null;

function queueUrl(sessionId: string, suffix = ""): string {
  return `/vh/session/${sessionId}/queue${suffix}?dir=${encodeURIComponent(demoDir)}`;
}

// Best-effort queue purge for the fresh session (mirror of queue-recovery.spec.
// ts's cleanQueue): remove every item — terminal (`sent`/`failed`) deletable; a
// leftover `dispatching` item would 409 and is ignored (it settles terminal
// within the 12s dispatch bound and dies with the session delete below).
async function cleanQueue(request: APIRequestContext, sessionId: string): Promise<void> {
  const res = await request.get(queueUrl(sessionId));
  if (!res.ok()) return;
  const j = await res.json().catch(() => ({}));
  const items: Array<{ id: string }> = Array.isArray(j.items) ? j.items : [];
  for (const it of items) {
    await request.delete(queueUrl(sessionId, `/${encodeURIComponent(it.id)}`), {
      headers: { "X-VH-CSRF": "1" },
    });
  }
}

test.afterEach(async ({ request }) => {
  if (!sid) return; // failed before materialization: context-local state only, nothing shared
  await cleanQueue(request, sid);
  const res = await request.post(`/oc/fixture/delete?session=${encodeURIComponent(sid)}`, {
    headers: { "X-VH-CSRF": "1" },
  });
  if (!res.ok()) console.log(`[model-draft-failure-retry] WARNING: fixture delete for ${sid} -> ${res.status()}`);
});

test("explicit draft model/variant pick survives first-send materialization, a terminal failed send + reload, and governs the recovery resend", async ({ page }) => {
  test.setTimeout(90_000); // full lifecycle: materialize + 502 + reload + recovery + streamed reply

  // Block the PWA service worker for THIS test (registered before page.goto so
  // the SW script never loads; existing workers closed) — see header note.
  await page.route("**/sw.js*", (route) => route.abort());
  for (const sw of page.context().serviceWorkers()) {
    await sw.close();
  }

  // Page-local interception of the SPA's dispatch POST. The FIRST POST is
  // fulfilled 502 (terminal client-visible failure — the fixture never sees
  // it); every later POST passes through. Counted at both the route layer and
  // the page "request" event so a failure distinguishes "route never matched"
  // from a genuine double-dispatch (ux.spec.ts pattern).
  const posts: { model?: { providerID?: string; modelID?: string }; variant?: string }[] = [];
  let routeSeen = 0;
  let pageSeen = 0;
  page.on("request", (req) => {
    if (req.url().includes("/prompt_async")) pageSeen++;
  });
  await page.route("**/oc/session/*/prompt_async", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") {
      await route.continue();
      return;
    }
    routeSeen++;
    try {
      posts.push(req.postDataJSON());
    } catch {
      posts.push({});
    }
    if (routeSeen === 1) {
      await route.fulfill({
        status: 502,
        contentType: "text/plain",
        body: "e2e: forced terminal client-visible failure (bad gateway)",
      });
    } else {
      await route.continue();
    }
  });

  await page.goto(projectUrl("/"));

  // FRESH DRAFT (not the shared demo session): "Create session" opens the
  // draft composer WITHOUT creating a server session (ux.spec.ts pattern).
  const treeNew = page.locator(".tree-node", { hasText: "New session" });
  const before = await treeNew.count();
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(page.locator(".composer")).toBeVisible();

  // Baseline (the fallbacks the pick must beat): the draft resolves the @plan
  // agent default — Dummy Thinking + variant "high" — and this also proves
  // agents+models are loaded (the readyToSend gate) before we send.
  await expect(page.locator(".agent-select .vh-select-label")).toHaveText("@plan", { timeout: 10_000 });
  await expect(page.locator(".model-btn-name")).toContainText("Dummy Thinking");
  await expect(page.locator(".variant-select .vh-select-label")).toHaveText("high");

  // THE EXPLICIT DRAFT PICK: re-select Dummy Thinking (the click registers the
  // EXPLICIT pick even though the agent default already displays this model —
  // ModelDialog.pick → chooseModel fires unconditionally) then variant "low".
  // Final draft pick: {fake, dummy-think, low} + explicit provenance.
  await page.locator(".model-btn").click();
  const dialog = page.getByRole("dialog", { name: "Select model" });
  // NOTE: unlike the demo-session flow in model-reload-send.spec.ts, the DRAFT
  // init applies the @plan agent default via applyModel("") → pushRecent, so
  // the dialog shows a "Recent" Dummy Thinking row BESIDE the provider-grouped
  // one — "Dummy Thinking" matches 2 rows (strict-mode violation). Both rows
  // pick the same model; take the first deterministically.
  await dialog.locator("button.m-row").filter({ hasText: "Dummy Thinking" }).first().click();
  await expect(page.getByRole("dialog", { name: "Select model" })).toHaveCount(0);
  const variant = page.locator(".variant-select");
  await variant.locator(".vh-select-btn").click();
  await page.getByRole("option", { name: "low" }).click();
  await expect(variant.locator(".vh-select-label")).toHaveText("low");

  // FIRST SEND: materializes the live session (the tree node appears and the
  // URL takes ?session=ses_newN) — migrateModelPick moves the draft pick onto
  // the live id BEFORE captureConfig/enqueue, so the dispatched body carries it.
  const marker = `mdfr-${Date.now()}`;
  const ta = page.getByPlaceholder(/Message/);
  await ta.fill(marker);
  await page.keyboard.press("Enter");
  await expect(treeNew).toHaveCount(before + 1, { timeout: 8_000 });
  await expect
    .poll(() => new URL(page.url()).searchParams.get("session"), {
      timeout: 10_000,
      message: "URL ?session=<ses_newN> after the materializing send",
    })
    .toMatch(/^ses_new\d+$/);
  sid = new URL(page.url()).searchParams.get("session")!;

  // TERMINAL FAILURE (B1 setup): the drainer claimed the item, POSTed, and our
  // 502 resolves it `failed` — visible as a failed chip. The failure committed
  // NOTHING client-side: no user turn renders for the marker.
  const chip = page.locator(".queue-chip", { hasText: marker });
  await expect(chip).toHaveAttribute("data-state", "failed", { timeout: 15_000 });

  expect(posts.length, "A2 stage: exactly one prompt_async left the browser when the materializing send failed terminally").toBe(1);
  expect(posts[0]?.model, "A2 stage: the materializing dispatch carried the migrated draft model").toEqual({ providerID: "fake", modelID: "dummy-think" });
  expect(posts[0]?.variant, "A2 stage: the materializing dispatch carried the draft variant, not the agent-default high").toBe("low");
  expect(routeSeen).toBe(1);
  expect(pageSeen).toBe(1);
  await expect(page.locator(".msg.user", { hasText: marker }), "failure stage: the failed attempt committed no user turn").toHaveCount(0);

  // THE RELOAD (B1 core): in-memory sessionSel + explicit provenance are wiped;
  // the pick must restore from the per-project pick map under the LIVE id and
  // still top the resolution chain — "low", not the @plan default "high" and
  // not the global dummy. The failed chip survives too (backend-authoritative
  // queue), asserted separately so a failure names which contract broke.
  await page.reload();
  await expect(page.locator(".agent-select .vh-select-label"), "reload stage: app restored").toHaveText("@plan", { timeout: 10_000 });
  await expect(page.locator(".model-btn-name"), "B1 stage: pick retained through failure + reload (model)").toContainText("Dummy Thinking", { timeout: 10_000 });
  await expect(page.locator(".variant-select .vh-select-label"), "B1 stage: pick retained through failure + reload (variant — the sharp discriminator vs the high default)").toHaveText("low");
  await expect(chip, "B1 stage: the failed chip survives the reload (backend-authoritative queue)").toHaveAttribute("data-state", "failed", { timeout: 10_000 });

  // RECOVERY: the real failed-chip affordance — "Edit again" retracts the item
  // (DELETEs it, then restores the text into the composer). Retract's guard
  // requires an empty composer; after the reload it is (the failed attempt
  // committed nothing client-side — asserted as a precondition, not assumed).
  await expect(ta).toHaveValue("");
  await chip.locator(".queue-retract").click();
  await expect(ta, "recovery stage: Edit again restored the failed text into the composer").toHaveValue(marker);
  await expect(chip, "recovery stage: the retracted item was deleted, never repended").toHaveCount(0);

  // RESEND: send the recovered text as a NEW message. The enqueued sendConfig
  // re-captures from the live selection (the retained pick), so the second —
  // and only the second — POST goes through and visibly succeeds.
  await expect(page.locator(".agent-select")).toBeVisible({ timeout: 10_000 });
  await ta.click(); // focus the composer for the real Enter gesture
  await page.keyboard.press("Enter");

  await expect(page.getByText(/Done\. Updated/).first(), "resend stage: the streamed reply rendered").toBeVisible({ timeout: 15_000 });

  // Exactly TWO dispatches total — the failed first + the recovery resend, no
  // auto-retry anywhere — BOTH carrying the ORIGINAL explicit pick.
  expect(posts.length, "B1 stage: exactly two prompt_async total (failed first + recovery resend), no auto-retry").toBe(2);
  expect(routeSeen).toBe(2);
  expect(pageSeen).toBe(2);
  for (const [i, p] of posts.entries()) {
    expect(p.model, `B1 stage: attempt ${i + 1} carried the original explicit model`).toEqual({ providerID: "fake", modelID: "dummy-think" });
    expect(p.variant, `B1 stage: attempt ${i + 1} carried the original explicit variant`).toBe("low");
  }

  // Exactly ONE user turn is ultimately committed: the failed attempt
  // committed nothing client-side, the resend committed exactly one.
  await expect(page.locator(".msg.user", { hasText: marker }), "final stage: exactly one committed user turn").toHaveCount(1);
});

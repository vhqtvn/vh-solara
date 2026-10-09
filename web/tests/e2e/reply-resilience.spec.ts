import { expect, test, type APIRequestContext } from "@playwright/test";
import { projectUrl } from "./util";

// Reply resilience (send-net-resilience slice 4a) — the human permission-reply
// path through the daemon verb /vh/reply-permission, its failure shapes, and
// the card's honest states. Backed by the fixture reply-hold latch
// (pkg/fixtures/opencode.go /fixture/reply-hold/{arm,release,reset}, reached
// through the /oc passthrough with the CSRF header — the agent-hold pattern).
//
// The failure shapes and their honest surfaces:
//   TIMEOUT  — the reply POST parks (fixture hold) with no response; the SPA's
//              10s REPLY_TIMEOUT_MS bound aborts it. The card must STAY in an
//              outcome-unknown state with an explicit Retry (never silently
//              disappear, never claim failure).
//   RETRY    — a fresh-key re-dispatch through the same verb; with pending
//              intact upstream it lands 200 and the card clears (optimistic
//              delete on confirmed + the permission.replied event both
//              converge here).
//   GONE     — the request is no longer pending upstream (release-drop
//              posture: cleared silently, no event — the shutdown-world
//              shape). Retry hits upstream 404 → daemon goneOn404 → 410 →
//              the card shows the visible honest terminal ("no longer
//              pending; outcome was not confirmed") with a Dismiss — NEVER a
//              success surface.
//   EVENT    — release-apply processes the parked reply posthumously: the
//              permission.replied event clears the card through the daemon's
//              event channel even though the HTTP response was lost ("it
//              landed after all" — convergence without retry).
//
// The suite is SERIAL (workers:1) over one shared fixtureserver: each test
// sends its own [[perm]] prompt (fresh permN id) and the afterEach resets the
// reply-hold latch so no posture leaks across specs.

const csrf = { "X-VH-CSRF": "1" };

async function armReplyHold(request: APIRequestContext, kind: "permission" | "question") {
  const res = await request.post("/oc/fixture/reply-hold/arm", { headers: csrf, data: { kind } });
  if (!res.ok()) throw new Error(`reply-hold arm failed: ${res.status()} ${res.statusText()}`);
}

async function releaseReplyHold(request: APIRequestContext, mode: "pass" | "apply" | "drop") {
  const res = await request.post("/oc/fixture/reply-hold/release", { headers: csrf, data: { mode } });
  if (!res.ok()) throw new Error(`reply-hold release(${mode}) failed: ${res.status()} ${res.statusText()}`);
}

async function resetReplyHold(request: APIRequestContext) {
  const res = await request.post("/oc/fixture/reply-hold/reset", { headers: csrf });
  if (!res.ok()) throw new Error(`reply-hold reset failed: ${res.status()} ${res.statusText()}`);
}

// The session this test created (for afterEach cleanup — see below).
let currentSession = "";

// Raise a permission card in a FRESH session ([[perm]] marker). Each scenario
// uses its own session: a release-drop zombie (the daemon's store keeps a
// permission the upstream silently dropped — exactly the shutdown-world
// staleness the drop posture models) then re-projects only into ITS session's
// snapshot, so it can never shadow a later scenario's card in the shared
// fixtureserver. Draft-mode creation: "Create session" → first message
// materializes the session (ux.spec.ts "New session defers creation" flow).
async function raisePermissionCard(page: import("@playwright/test").Page) {
  currentSession = "";
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Create session" }).click();
  await page.getByPlaceholder("Message…").fill("[[perm]] please run it");
  await page.keyboard.press("Enter");
  const card = page.locator(".perm-card");
  await expect(card).toBeVisible({ timeout: 8000 });
  // The materialized session id lands in the URL once the send selects it.
  // Captured for afterEach cleanup: this suite is SERIAL over one shared
  // fixtureserver, and a leftover busy [[perm]] session (the marker pauses the
  // turn — it never goes idle) breaks later tree specs' node counts and
  // .tree-twisty.running tallies. /fixture/delete removes it outright
  // (session.deleted event → the daemon drops it live).
  await expect
    .poll(async () => new URL(page.url()).searchParams.get("session") ?? "")
    .not.toBe("");
  currentSession = new URL(page.url()).searchParams.get("session") ?? "";
  return card;
}

test.afterEach(async ({ request }) => {
  await resetReplyHold(request);
  // Remove this test's session from the shared fixtureserver (see
  // raisePermissionCard): the [[perm]] turn never idles, and a lingering busy
  // session shifts later serial-suite specs' tree counts.
  if (currentSession) {
    const res = await request.post(`/oc/fixture/delete?session=${encodeURIComponent(currentSession)}`, { headers: csrf });
    if (!res.ok()) throw new Error(`fixture delete failed: ${res.status()} ${res.statusText()}`);
    currentSession = "";
  }
});

test("timed-out permission reply keeps the card (unknown + Retry); Retry then lands and the card clears", async ({ page, request }) => {
  test.setTimeout(60000); // one real 10s abort window + retries
  await armReplyHold(request, "permission");
  const card = await raisePermissionCard(page);

  // The answer gesture routes through the daemon verb; the parked POST shows
  // the live sending state first (buttons locked while the attempt is out).
  await card.getByRole("button", { name: "Allow once" }).click();
  const status = page.locator(".reply-status");
  await expect(status).toHaveClass(/sending/, { timeout: 3000 });
  for (const b of await card.locator(".perm-actions button").all()) {
    await expect(b).toBeDisabled();
  }

  // 10s REPLY_TIMEOUT_MS abort → outcome-unknown: the card STAYS (never
  // silently disappears), states the uncertainty honestly, offers Retry.
  await expect(status).toHaveClass(/unknown/, { timeout: 13000 });
  await expect(status).toContainText("not confirmed");
  await expect(status).toContainText("may still have been applied");
  await expect(page.locator(".perm-card")).toHaveCount(1);
  // Production-bundle CSS-content guard (slice-4b review c-F1 defect class,
  // folded fix for 4a — the agent-hydration-send 4d pattern): the webServer
  // serves the PRODUCTION build (fixture-web.sh runs `npm run build`), so a
  // computed style here proves co-located ReplyStatus.css reached the bundle
  // — the former pure-:global ReplyStatus.module.css was tree-shaken from
  // it (empty locals → moduleSideEffects:false). border-radius comes from
  // the base .reply-status rule; the solid border exists only on the
  // .unknown variant — together they prove both rule tiers apply (no
  // reset/legacy rule touches .reply-status).
  await expect(status).toHaveCSS("border-radius", "6px");
  await expect(status).toHaveCSS("border-top-style", "solid");

  // release(pass): pending stays intact upstream — a retry must succeed.
  await releaseReplyHold(request, "pass");
  await page.locator(".reply-retry").click();
  // Fresh-key retry re-executes against the real stack: 200 + replied event.
  await expect(page.locator(".perm-card")).toHaveCount(0, { timeout: 8000 });
});

test("reply that is no longer pending upstream surfaces the honest gone terminal (410), never success", async ({ page, request }) => {
  test.setTimeout(60000);
  await armReplyHold(request, "permission");
  const card = await raisePermissionCard(page);

  await card.getByRole("button", { name: "Allow once" }).click();
  await expect(page.locator(".reply-status")).toHaveClass(/unknown/, { timeout: 13000 });

  // release(drop): the request stops being pending upstream with NO event —
  // the shutdown/timeout world. The retry below hits upstream 404 → daemon
  // goneOn404 → 410.
  await releaseReplyHold(request, "drop");
  await page.locator(".reply-retry").click();

  // The visible honest terminal: "no longer pending", "not confirmed" — and
  // no success wording anywhere on the status surface.
  const status = page.locator(".reply-status");
  await expect(status).toHaveClass(/gone/, { timeout: 8000 });
  await expect(status).toContainText("no longer pending");
  await expect(status).toContainText("not confirmed");
  await expect(status).not.toContainText("success");
  // Gone is terminal: the answer buttons are locked (the request is dead).
  for (const b of await page.locator(".perm-card .perm-actions button").all()) {
    await expect(b).toBeDisabled();
  }

  // Dismiss clears the card explicitly — the ONLY way it leaves the screen.
  await page.locator(".reply-dismiss").click();
  await expect(page.locator(".perm-card")).toHaveCount(0, { timeout: 5000 });
});

test("a reply that landed upstream after the timeout converges via the server event (card clears without retry)", async ({ page, request }) => {
  test.setTimeout(60000);
  await armReplyHold(request, "permission");
  const card = await raisePermissionCard(page);

  await card.getByRole("button", { name: "Reject" }).click();
  await expect(page.locator(".reply-status")).toHaveClass(/unknown/, { timeout: 13000 });
  await expect(page.locator(".perm-card")).toHaveCount(1);

  // release(apply): the parked reply is processed posthumously — the
  // permission.replied event flows daemon → SPA and clears the card through
  // the event channel, without any retry gesture.
  await releaseReplyHold(request, "apply");
  await expect(page.locator(".perm-card")).toHaveCount(0, { timeout: 8000 });
});

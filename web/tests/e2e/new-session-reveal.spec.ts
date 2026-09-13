import { expect, test, type APIRequestContext } from "@playwright/test";
import { demoDir, projectUrl } from "./util";

// New-session reveal (lane 6): the browser-level guard for commit 439b166
// ("fix(web): reveal new-session transcript on first live message") — the
// operator-reported blank-viewport bug. Before that fix, features.spec.ts:34
// (composer agent/model defaults) was the ONLY draft-mode coverage in lane 6;
// nothing drove draft → first send → render, which is exactly how the
// regression slipped through.
//
// The bug shape: after a draft's first send materialized the live session,
// the chat viewport stayed blank until the user switched sessions and back.
// `messagesDelivered[sid]` only flipped on the Stream-2 `messages.loaded`
// completion signal, which can be lost on the open connection while live
// `message.upsert` events flow — the transcript accumulated invisibly behind
// the ChatView reveal gate (opacity). 439b166's reducer flip: the
// message.upsert case now sets messagesDelivered[sid]=true when the session's
// resident order was empty pre-event and delivered isn't already true.
//
// Two tests (both end at the reveal WITHOUT any session switch — the switch
// was the manual self-heal operators had to discover):
//
//  1. HAPPY PATH (minimum bar): draft → first send → session materializes
//     (POST /oc/session, URL ?session=ses_newN) → transcript reveals and the
//     turn completes visibly. This alone would have caught the operator bug:
//     pre-fix, the cold hydration raced and could lose, blanking the viewport.
//
//  2. RACE CELL (deterministic wedge): the fixture's test-only new-session
//     cold-hold latch (pkg/fixtures/opencode.go, POST
//     /oc/fixture/new-session-hold/{arm,release}) withholds the message-LIST
//     cold fetch for ses_new* sessions — with it held, NO messages.batch /
//     messages.loaded completion can be produced for the new session (the
//     cold fetch is the only producer; pkg/state/message_window.go is
//     unreachable), while the turn's live message.*/part.* events keep
//     flowing on the open /event feed. That is cell E/E2 of the unit harness
//     web/tests/unit/ChatViewNewSessionBlank.test.tsx (gate cold +
//     messages.loaded never + live events flow → must reveal from the first
//     live message), now at the real-browser layer. A canary GET proves the
//     latch is actually intercepting before the wedge is asserted, so the
//     cell cannot pass vacuously. Pre-439b166 this test is deterministically
//     RED (delivered never flips → .chat-content never gains `ready`, and the
//     .chat-loading overlay stays); post-fix it is GREEN via the reducer's
//     firstLiveForEmptySession flip → ChatView self-heal → reveal.
//
// Serial-suite hygiene (workers:1 over ONE shared fixtureserver): each test
// owns a FRESH ses_newN session and removes ALL of its residue in afterEach —
// queue items via the real /vh/session/<sid>/queue API, then the session via
// the fake's /oc/fixture/delete passthrough (emits session.deleted so the
// aggregator store drops it too — model-draft-failure-retry.spec.ts pattern).
// The cold-hold latch is armed INSIDE the race test (never beforeEach) and
// released FIRST in afterEach so no later spec's ses_new* cold fetch can ever
// park on it. The PWA service worker is blocked per-test (an activated SW sits
// in the fetch path — same reason + pattern as model-draft-failure-retry).
//
// Selector discipline (existing-spec-consistent): .chat-content + the `ready`
// class and computed opacity come from reveal-gate.spec.ts — Playwright's
// toBeVisible does NOT see opacity:0, so the reveal must be asserted via the
// class/opacity pair, never via bare message-row visibility.

const csrf = { "X-VH-CSRF": "1" };

// The materialized session id of the test currently running, captured for
// afterEach cleanup. Null until the first send creates the session; every
// cleanup step is conditional on it. Reset at each test start.
let sid: string | null = null;

function queueUrl(sessionId: string, suffix = ""): string {
  return `/vh/session/${sessionId}/queue${suffix}?dir=${encodeURIComponent(demoDir)}`;
}

// Best-effort queue purge for the fresh session (model-draft-failure-retry
// pattern): the completed send leaves a durable `sent` item that the FE
// filters but the daemon keeps until compaction.
async function cleanQueue(request: APIRequestContext, sessionId: string): Promise<void> {
  const res = await request.get(queueUrl(sessionId));
  if (!res.ok()) return;
  const j = await res.json().catch(() => ({}));
  const items: Array<{ id: string }> = Array.isArray(j.items) ? j.items : [];
  for (const it of items) {
    await request.delete(queueUrl(sessionId, `/${encodeURIComponent(it.id)}`), {
      headers: csrf,
    });
  }
}

test.afterEach(async ({ request }) => {
  // Release the cold-hold latch FIRST (no-op when not armed): parked cold
  // fetches drain, and no later spec's ses_new* fetch can ever park on it.
  // Failures are LOGGED, not swallowed (a swallowed release failure is exactly
  // how a stranded latch hides until the next run wedges unrelated specs) —
  // but stay non-fatal, same WARNING-not-fail posture as the fixture-delete
  // below: the suite-level disarm in web/global-setup.ts is the next run's
  // safety net.
  const rel = await request
    .post(`/oc/fixture/new-session-hold/release`, { headers: csrf })
    .catch((err: unknown) => {
      console.log(`[new-session-reveal] WARNING: latch release request failed: ${String(err)}`);
      return null;
    });
  if (rel && !rel.ok()) {
    console.log(`[new-session-reveal] WARNING: latch release -> ${rel.status()} ${rel.statusText()}`);
  }
  if (!sid) return; // failed before materialization: context-local state only
  await cleanQueue(request, sid);
  const res = await request.post(`/oc/fixture/delete?session=${encodeURIComponent(sid)}`, {
    headers: csrf,
  });
  if (!res.ok()) console.log(`[new-session-reveal] WARNING: fixture delete for ${sid} -> ${res.status()}`);
  sid = null;
});

// The reveal assertion pair (reveal-gate.spec.ts pattern): the `ready` class
// on .chat-content plus its computed opacity. Both are required because
// toBeVisible is opacity-blind — pre-fix the transcript DOM exists but sits
// at opacity:0 behind the gate, which IS the blank-viewport bug.
async function expectRevealed(page: import("@playwright/test").Page): Promise<void> {
  const content = page.locator(".chat-content");
  await expect(content, "reveal gate: .chat-content must gain the ready class").toHaveClass(/\bready\b/);
  await expect
    .poll(() => content.evaluate((el) => getComputedStyle(el).opacity), {
      timeout: 10_000,
      message: "reveal gate: .chat-content must be painted at opacity 1 (not hidden behind the gate)",
    })
    .toBe("1");
}

// Shared draft→send→materialize prologue. Returns the materialized session id
// (the URL ?session param — the same source the SPA itself selects by).
async function draftSendMaterialize(page: import("@playwright/test").Page, marker: string): Promise<string> {
  // FRESH DRAFT (not the shared demo session): "Create session" opens the
  // draft composer WITHOUT creating a server session (ux.spec.ts pattern).
  const treeNew = page.locator(".tree-node", { hasText: "New session" });
  const before = await treeNew.count();
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(page.locator(".composer")).toBeVisible();

  // The @plan agent default resolving proves agents+models are loaded (the
  // readyToSend gate) BEFORE we send (model-draft-failure-retry pattern).
  await expect(page.locator(".agent-select .vh-select-label")).toHaveText("@plan", { timeout: 10_000 });

  // FIRST SEND: materializes the live session — the tree node appears and the
  // URL takes ?session=ses_newN (POST /oc/session → ses_newN mint).
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
  return new URL(page.url()).searchParams.get("session")!;
}

test("draft → first send → session materializes and the transcript reveals with no session switch (happy path)", async ({ page }) => {
  test.setTimeout(60_000);
  sid = null;

  // Block the PWA service worker for THIS test (see header note).
  await page.route("**/sw.js*", (route) => route.abort());
  for (const sw of page.context().serviceWorkers()) {
    await sw.close();
  }

  await page.goto(projectUrl("/"));

  const marker = `nsr-happy-${Date.now()}`;
  sid = await draftSendMaterialize(page, marker);

  // THE CRUX (no switch performed anywhere): the live session's transcript
  // reveals on its own — the sent user turn is visible AND the gate is open.
  await expect(page.locator(".msg.user", { hasText: marker })).toBeVisible();
  await expectRevealed(page);
  await expect(page.locator(".chat-loading"), "viewport must not sit on the loading overlay").toHaveCount(0);

  // The turn completes visibly end-to-end on the open connection (the
  // fixture's streamed assistant reply — agent-hydration-send pattern).
  await expect(
    page.locator(".chat-content").getByText(/Done\. Updated/).first(),
    "the streamed assistant reply must render in the live transcript",
  ).toBeVisible({ timeout: 20_000 });
  await expectRevealed(page);
});

test("withheld messages.loaded + live events flowing: the first live message must flip the reveal gate (439b166 race cell)", async ({ page, request }) => {
  test.setTimeout(60_000);
  sid = null;

  // Block the PWA service worker for THIS test (see header note).
  await page.route("**/sw.js*", (route) => route.abort());
  for (const sw of page.context().serviceWorkers()) {
    await sw.close();
  }

  // Arm the fixture's new-session cold-hold latch (test-only; bare `request`
  // fixture — page not navigated yet, same rationale as resetPins).
  const arm = await request.post(`/oc/fixture/new-session-hold/arm`, { headers: csrf });
  if (!arm.ok()) {
    throw new Error(`new-session-hold arm failed: ${arm.status()} ${arm.statusText()}`);
  }

  // CANARY (anti-vacuous guard): the latch must intercept message-LIST GETs
  // for ses_new* BEFORE we rely on it. A direct passthrough GET for a
  // nonexistent ses_new* session parks on the latch (the hold check runs in
  // the fall-through, before session existence matters). If it resolves
  // within 1.5s the hook is not intercepting and the race cell below would
  // pass vacuously (pre-fix, an unheld cold fetch delivers messages.loaded
  // and flips `delivered` without the reducer) — fail fast instead.
  const canary = request
    .get(`/oc/session/ses_newe2ecanary/message`)
    .then((r) => `resolved:${r.status()}`)
    .catch((e) => `error:${String(e)}`);
  const canaryOutcome = await Promise.race([
    canary,
    new Promise<"held">((resolve) => setTimeout(() => resolve("held"), 1_500)),
  ]);
  if (canaryOutcome !== "held") {
    throw new Error(`new-session-hold latch is not intercepting ses_new* message-LIST GETs (${canaryOutcome}) — race cell would be vacuous`);
  }

  await page.goto(projectUrl("/"));

  const marker = `nsr-race-${Date.now()}`;
  sid = await draftSendMaterialize(page, marker);

  // THE WEDGE, asserted while the hold is STILL armed (release happens only
  // in afterEach): the cold hydration's messages.loaded completion is
  // withheld, so the ONLY thing that can open the gate is 439b166's
  // firstLiveForEmptySession flip on the first live message.upsert.
  // Pre-fix this is deterministically red: `ready` never lands and the
  // loading overlay persists — the operator-reported blank viewport.
  await expect(page.locator(".msg.user", { hasText: marker }), "the live user turn must accumulate in the transcript").toBeVisible();
  await expectRevealed(page);
  await expect(page.locator(".chat-loading"), "withheld completion signal must NOT leave the viewport stuck on loading").toHaveCount(0);

  // The composer stays usable for the now-live session (not stuck in draft
  // limbo) — the session is genuinely the selected, streamed one.
  await expect(page.locator(".composer")).toBeVisible();
});

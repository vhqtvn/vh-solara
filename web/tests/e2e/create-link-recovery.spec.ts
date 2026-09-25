import { expect, test, type APIRequestContext, type Route } from "@playwright/test";
import { demoDir, projectUrl } from "./util";

// A1 create-linkage recovery arc (send-defers study, browser crux): the
// pure-navigation stranding half. A draft's first send fires the session-create
// POST; the RESPONSE is lost after the server applied it (Playwright
// route.fetch() + route.abort — the same fault-injection shape as the
// admission-recovery cell in send-reliability.spec.ts), so the SPA honestly
// settles to "Session creation outcome unknown" with the composer retained.
// The session STILL lands client-side — the fixture's session.created SSE →
// session.upsert → the sessions map / tree, with NO re-tap — which before the
// fix left the draft-owned uncertain/check record stranded under ownerKey
// "draft" forever (nothing observed the draft→session linkage on pure
// navigation).
//
// The fix under test: the create-unknown record now carries the create-attempt
// window [POST-armed, mark-time], and the draft view's SendStatus reactively
// correlates a session whose time.created falls inside it (± the generous
// clock-skew margin — timing is the ONLY correlation signal, the create POST
// body is "{}"), rendering an operator-CONFIRMED linkage affordance. The crux
// sequence, all through the real event model:
//
//   1. draft send → create response dropped → "Session creation unconfirmed.
//      Check possible sessions before sending again; another send may create
//      another session." renders in the STILL-DRAFT view (composer retained);
//   2. the session appears in the tree anyway (SSE — the A1 premise);
//   3. the affordance renders: "Possible sessions — timing is the only
//      match. — Link and open it";
//   4. the operator's real click re-keys the draft-owned records
//      (transferOwnerSendAttempts — never silent) and navigates;
//   5. the recovery row is now OWNER-SCOPED in the materialized session, with
//      no re-tap anywhere and ZERO dispatches (admission never ran).
//
// Serial-suite hygiene (workers:1, one shared fixtureserver): the spec owns
// its ses_newN session and removes ALL residue in afterEach — queue items via
// the real /vh/session/<sid>/queue API (expected none: the message was never
// enqueued), then the session via the fake's /oc/fixture/delete passthrough
// (emits session.deleted so the aggregator store drops it too —
// new-session-reveal.spec.ts pattern). The PWA service worker is blocked
// per-test (same reason + pattern as new-session-reveal).

const csrf = { "X-VH-CSRF": "1" };

// The session the fault-injected create minted server-side, captured from the
// route.fetch()-performed response for afterEach cleanup. Null until the
// create POST actually landed.
let createdId: string | null = null;

function queueUrl(sessionId: string): string {
  return `/vh/session/${sessionId}/queue?dir=${encodeURIComponent(demoDir)}`;
}

async function cleanQueue(request: APIRequestContext, sessionId: string): Promise<void> {
  const res = await request.get(queueUrl(sessionId));
  if (!res.ok()) return;
  const j = await res.json().catch(() => ({}));
  const items: Array<{ id: string }> = Array.isArray(j.items) ? j.items : [];
  for (const it of items) {
    await request.delete(`${queueUrl(sessionId)}/${encodeURIComponent(it.id)}`, { headers: csrf });
  }
}

test.afterEach(async ({ request }) => {
  if (!createdId) return; // failed before the create landed: context-local state only
  await cleanQueue(request, createdId);
  const res = await request.post(`/oc/fixture/delete?session=${encodeURIComponent(createdId)}`, {
    headers: csrf,
  });
  if (!res.ok()) console.log(`[create-link] WARNING: fixture delete for ${createdId} -> ${res.status()}`);
  createdId = null;
});

test("(browser) create response lost → session lands via SSE → confirmed linkage affordance → the record follows the operator into the session", async ({ page }) => {
  test.setTimeout(90_000);
  createdId = null;

  // Block the PWA service worker for THIS test (an activated SW sits in the
  // fetch path — new-session-reveal.spec.ts pattern).
  await page.route("**/sw.js*", (route) => route.abort());
  for (const sw of page.context().serviceWorkers()) {
    await sw.close();
  }

  // Capture every downstream dispatch — the A1 arc NEVER enqueues or dispatches
  // (admission stops at the unresolved create), so zero prompt_async leaving
  // the browser is the no-duplicate honesty assertion.
  const prompts: unknown[] = [];
  await page.route("**/oc/session/*/prompt_async", async (route) => {
    if (route.request().method() === "POST") {
      try {
        prompts.push(route.request().postDataJSON());
      } catch {
        prompts.push({});
      }
    }
    await route.continue();
  });

  // Transport fault injection (admission-recovery pattern): the create POST is
  // REALLY performed against the fixture server (route.fetch — the session is
  // created and session.created is emitted on the SSE feed), then the
  // browser's response is KILLED (route.abort — the fetch rejects
  // network-class → createSessionWithCertainty classifies outcome UNKNOWN).
  // One-shot: only the first POST is dropped; anything else falls through.
  let dropped = false;
  const createRouteHandler = async (route: Route) => {
    const req = route.request();
    if (req.method() === "POST" && !dropped) {
      dropped = true;
      const apiResp = await route.fetch();
      const txt = await apiResp.text();
      const sess = txt ? JSON.parse(txt) : null;
      if (sess?.id) createdId = sess.id;
      await route.abort("connectionfailed");
    } else {
      await route.fallback();
    }
  };
  await page.route("**/oc/session", createRouteHandler);

  await page.goto(projectUrl("/"));

  // FRESH DRAFT (new-session-reveal pattern): "Create session" opens the draft
  // composer WITHOUT creating a server session. The tree's "New session"-titled
  // node count brackets the later SSE arrival.
  const treeNew = page.locator(".tree-node", { hasText: "New session" });
  const before = await treeNew.count();
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(page.locator(".composer")).toBeVisible();

  // The @plan agent default resolving proves agents+models are loaded (the
  // readyToSend gate) BEFORE we send.
  await expect(page.locator(".agent-select .vh-select-label")).toHaveText("@plan", { timeout: 10_000 });

  // Real user gesture: type + click Send through the real event model.
  const ta = page.getByPlaceholder(/Message/);
  await ta.fill(`create-link probe ${Date.now()}`);
  await page.locator(".composer-bar .send-btn").click();

  // (1) The honest create-unknown state renders in the STILL-DRAFT view, and
  // the composer retained the text (no silent loss, no re-tap happened). O2
  // slice 1: the create-specific row copy carries the duplicate-session
  // warning the suppressed notification used to own.
  const unknownRow = page.locator(".sendStatusLine", {
    hasText: "Session creation unconfirmed.",
  });
  await expect(unknownRow).toBeVisible({ timeout: 15_000 });
  await expect(ta).not.toHaveValue("");

  // (2) The session REALLY landed despite the lost response — the SSE feed
  // delivered it into the tree (the A1 premise: appearance needs no re-tap).
  await expect(treeNew).toHaveCount(before + 1, { timeout: 8_000 });
  expect(createdId, "the fault-injected create actually made a session server-side").toMatch(/^ses_new\d+$/);

  // (3) The draft is still the selected view — pure navigation has NOT
  // happened (no ?session in the URL; nothing auto-materialized).
  expect(new URL(page.url()).searchParams.get("session")).toBeNull();

  // (4) THE AFFORDANCE: the in-window session correlates with the draft's
  // create-unknown record → the operator-confirmed linkage row renders. NOTE:
  // the fresh fixture server stamps EVERY seeded session's time.created at
  // boot (~1s before the POST), so the row honestly lists several in-window
  // candidates. O2 slice 2 GROUPS them: the newest TWO render as stacked
  // targets; the rest sit behind an inline "Show all N possible sessions"
  // disclosure (the F5 narrow-viewport row-width fix). The fault-minted
  // session is the NEWEST, so it is visible even before expansion; it is
  // addressed deterministically via its data-session-id (title "New session"
  // → the generic "Link and open it (time, short-id)" copy).
  const linkRow = page.locator('.sendStatusLine[data-kind="create-link"]');
  await expect(linkRow).toBeVisible({ timeout: 10_000 });
  await expect(linkRow).toContainText("Possible sessions — timing is the only match");
  // The adjacent explanation discloses the all-remaining-records sweep
  // (decision-doc matrix: the create-link row covers ALL remaining draft
  // recovery records).
  await expect(linkRow).toContainText("Confirming moves this draft");
  const candBtns = linkRow.locator(".sendStatusBtn[data-session-id]");
  const expander = linkRow.locator(".sendStatusMore", { hasText: /Show all \d+ possible sessions/ });
  await expect(expander).toBeVisible();
  const n = Number((await expander.textContent())!.match(/Show all (\d+)/)![1]);
  expect(await candBtns.count()).toBe(2); // grouping cap: the two newest only
  // Expansion is inline progressive disclosure: every candidate becomes
  // reachable without any drawer/modal.
  await expander.click();
  await expect(candBtns).toHaveCount(n);
  const openBtn = linkRow.locator(`.sendStatusBtn[data-session-id="${createdId}"]`);
  await expect(openBtn).toBeVisible();

  // (5) Confirm — the real click that re-keys the draft-owned records
  // (transferOwnerSendAttempts, never silent) and navigates.
  await openBtn.click();

  // (6) Landed in the materialized session…
  await expect
    .poll(() => new URL(page.url()).searchParams.get("session"), {
      timeout: 10_000,
      message: "URL ?session=<ses_newN> after the confirmed linkage",
    })
    .toBe(createdId);
  // …and the recovery row is now OWNER-SCOPED there: the record followed the
  // operator into the session (SendStatus reads ownerKey = session id). The
  // draft-view affordance itself is gone (a live view never renders it).
  const liveRow = page.locator(".sendStatusLine", {
    hasText: "Session creation unconfirmed.",
  });
  await expect(liveRow).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.sendStatusLine[data-kind="create-link"]')).toHaveCount(0);

  // (7) Honesty: nothing was ever enqueued or dispatched in this arc — the
  // create ambiguity is the ONLY thing that happened.
  await page.waitForTimeout(400);
  expect(prompts).toHaveLength(0);
});

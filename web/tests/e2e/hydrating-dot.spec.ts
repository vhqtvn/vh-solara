import { expect, test } from "@playwright/test";

// Pins the CURRENT behaviour of the ".dot.hydrating" indicator after its driver
// switched from the removed `state.hydrated` mirror to `messagesLoaded[id]`.
// (Originally written RED-first against the now-fixed permanent-dot driver; see
// the HISTORICAL NOTE below.)
//
// WHAT THE DOT IS NOW
//   The "loading from server…" dot (.dot.hydrating in a SessionTree row) is a
//   TRANSIENT indicator shown only while a session's message history is being
//   fetched (a cold-open). It renders at web/src/components/SessionTree.tsx:326:
//       <Show when={state.status === "live"
//                       && state.messagesLoaded[props.session.id] === false
//                       && !busy()}>
//   messagesLoaded[id] is `false` ONLY during the cold message-history fetch; it
//   is `undefined` for idle never-opened sessions and flips to `true` once
//   `messages.loaded` resolves. So the dot is ABSENT on idle rows and CLEARS the
//   moment a selected session's history lands — never a permanent label.
//
// HISTORICAL NOTE (the original bug, now fixed)
//   This spec was written RED-first against an older driver: the dot keyed off
//   `state.hydrated[id] === false`, a SyncState store mirror rebuilt each
//   snapshot from `snap.gate[id].hydrated`. Because Go `GateFacts.Hydrated`
//   (pkg/state/store.go: Hydrated = msgLoaded || messages!=nil) is lazily FALSE
//   BY DESIGN for never-opened idle sessions (pkg/aggregator: messages are
//   hydrated lazily — at startup we fetch none), that mirror armed the dot
//   PERMANENTLY on every idle row, and it survived a click. That mirror field
//   has since been removed (it had zero readers); the dot no longer keys off
//   it. NOTE: the snapshot-contract field `GateFacts.hydrated` /
//   `snap.gate[].hydrated` STILL EXISTS and is still consumed for resync-window
//   detection at web/src/sync/stream.ts:79
//   (`Object.values(snap.gate||{}).some(g => !!g && g.hydrated===false)`) — only
//   the per-session store MIRROR that drove the dot is gone. "hydrated" as a
//   concept survives at the snapshot-contract level.
//
// WHAT THESE TESTS ENCODE
//   (1) A never-opened, idle session must NOT display the dot once the page has
//       settled (messagesLoaded[id]===undefined → no dot).
//   (2) Selecting (clicking) a never-opened session clears the dot — the
//       cold-open fetch resolves, messagesLoaded flips to true, and the dot
//       disappears. (Because the idle row never arms the dot under the current
//       driver, this is belt-and-suspenders; it also guards against a regression
//       that re-arms the dot on or after selection.)
//   Both are GREEN today under the messagesLoaded driver.
//
// SHARED-BACKEND STRATEGY (the suite is SERIAL workers:1 over ONE mutable
// in-memory fixture backend — web/playwright.config.ts; each test reloads the
// PAGE but the aggregator's msgLoaded/messages state persists for the whole
// run, so once a session is opened it stays messagesLoaded===true).
//   - By the time this spec runs (alphabetically 8th: after agents, chat-
//     controls-gating, chat-navigator, composer, features, features2, header),
//     `demo`/`sub`/`other` have already been opened by chat-controls-gating.spec.ts
//     (it opens all three), so they are messagesLoaded===true, not idle. `slow`
//     is still never-opened here (only reveal-gate.spec.ts opens it, and that
//     sorts later), but opening `slow` in the click test would pre-load it
//     (messagesLoaded→true) and break reveal-gate's partial-load window.
//     /fixture/reset only resets fixture-side messages/busy — NOT aggregator-side
//     msgLoaded — so it cannot restore an idle row either.
//   - The robust option: CREATE a brand-new session via a RAW POST /oc/session
//     (pkg/fixtures/opencode.go:470 → id "ses_new%d"). A brand-new session is
//     guaranteed never-opened (no spec opens it; it is born at test runtime).
//     Crucially we do NOT route through the SPA's createSession()
//     (web/src/sync/actions.ts:94), which would setSelectedId + openSession and
//     flip messagesLoaded to true immediately — we fire the fetch directly so
//     the session lands in the tree (via session.created → session.upsert) but
//     is never selected, keeping messagesLoaded[id]===undefined.
//   - We then RELOAD so Stream-1 reconnects and renders the new row from a
//     fresh snapshot. Under the messagesLoaded driver this does NOT arm the dot
//     (messagesLoaded[id] stays undefined for an idle never-opened row); the
//     CONFIRM blocks below are therefore silent no-ops today, and the DESIRED
//     (dot absent) assertions gate the tests.

const VP = { width: 400, height: 320 };

type Page = import("@playwright/test").Page;

// The hydrating dot inside a session's tree row.
function hydratingDot(page: Page, id: string) {
  return page.locator(`.tree-node[data-session-id="${id}"] .dot.hydrating`);
}

// Wait for the tree to render (first .tree-node visible). Mirrors the helper in
// unread-dot.spec.ts.
async function waitForTree(page: Page) {
  await expect(page.locator(".tree-node").first()).toBeVisible({ timeout: 10000 });
}

// Create a brand-new never-opened session via a RAW POST /oc/session (NOT the
// SPA's createSession, which auto-selects + opens → flips messagesLoaded to true). Run in-page so
// the request is same-origin; X-VH-CSRF is included for parity with the other
// state-changing /oc/* probes (unread-dot.spec.ts) even though /vh/* is the
// guarded prefix. Returns the new session id ("ses_new%d").
async function createNeverOpenedSession(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const res = await fetch("/oc/session", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      body: "{}",
    });
    if (!res.ok) throw new Error(`POST /oc/session -> ${res.status}`);
    const sess = await res.json();
    if (!sess?.id) throw new Error("POST /oc/session returned no id");
    return sess.id as string;
  });
}

// (1) PRIMARY — a never-opened, idle session must NOT display the
// "loading from server…" dot once the page has settled (messagesLoaded[id]===undefined).
//
// The CONFIRM below (non-gating, short timeout) is a RED-first vestige from the
// old permanent-dot driver; under the current messagesLoaded driver the dot is
// never armed on an idle row, so the confirm is a silent no-op today. Only the
// DESIRED (dot absent) assertion gates the test.
test("never-opened idle session must not show a permanent hydrating dot", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await waitForTree(page);

  // Create a guaranteed never-opened session (see strategy above).
  const id = await createNeverOpenedSession(page);
  // Wait for it to appear via session.upsert on the CURRENT Stream-1 — proves
  // the aggregator has it before we reload. (messagesLoaded[id]===undefined
  // here, so no dot yet.)
  await expect(page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({
    timeout: 10000,
  });

  // Reload so Stream-1 reconnects and renders `id` from a fresh snapshot. Under
  // the messagesLoaded driver this does NOT arm the dot (messagesLoaded[id]
  // stays undefined for an idle never-opened row).
  await page.goto("/?session=demo");
  await waitForTree(page);
  await expect(page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({
    timeout: 10000,
  });

  // CONFIRM (non-gating, RED-first vestige): under the old permanent-dot driver
  // the dot would be armed here; today (messagesLoaded driver) the dot is never
  // armed on an idle row, so this silently no-ops and falls through to the
  // gating assertion below.
  try {
    await expect(hydratingDot(page, id)).toBeVisible({ timeout: 5000 });
  } catch {
    /* dot already absent — fix landed; the gating assertion below is the proof */
  }

  // DESIRED behaviour (gating): once the page has settled, a never-opened idle
  // session must NOT carry a "loading from server…" dot. GREEN today
  // (messagesLoaded[id]===undefined → no dot); a regression that re-arms the
  // dot on idle rows would turn this RED.
  await expect(hydratingDot(page, id)).toHaveCount(0);
});

// (2) SELECTING a never-opened session must clear the hydrating dot. Under the
// current driver the idle row never arms the dot to begin with
// (messagesLoaded[id]===undefined); selecting it opens Stream-2 which runs the
// cold message-history fetch → messagesLoaded flips to true → the dot stays
// absent. Same confirm-then-desired shape as test (1).
//
// NOTE on "wait for messages to load": the brand-new session created above has
// NO messages (POST /oc/session seeds none), so `.msg` never appears on open.
// We instead wait for the row to be marked `.selected`, which proves the click
// registered and openSessionChat ran — the fetch resolves to messagesLoaded===true,
// so the selection signal is sufficient to know we are observing the post-click
// state.
test("selecting a never-opened session must clear its hydrating dot", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await waitForTree(page);

  const id = await createNeverOpenedSession(page);
  await expect(page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({
    timeout: 10000,
  });
  // Reload → fresh Stream-1 snapshot. Under the messagesLoaded driver `id`
  // stays idle (messagesLoaded===undefined → no dot).
  await page.goto("/?session=demo");
  await waitForTree(page);
  await expect(page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({
    timeout: 10000,
  });

  // CONFIRM (non-gating, RED-first vestige): under the old driver the dot
  // would be armed here; today it is never armed on an idle row, so this
  // silently no-ops before the click.
  try {
    await expect(hydratingDot(page, id)).toBeVisible({ timeout: 5000 });
  } catch {
    /* dot already absent — fix landed */
  }

  // Select the never-opened session by clicking its tree row (in-app
  // openSessionChat — NOT a page.goto, which would reconnect Stream-1 and
  // re-snapshot, racing Stream-2's message load and making the result
  // nondeterministic). At 400×320 the new session row sits below the fold and
  // the tree's scroll container cannot bring it fully into view, so a native
  // Playwright .click() (even with force:true) throws "Element is outside of
  // the viewport". We instead dispatch the click via element.click() in-page:
  // it fires a real 'click' event that SolidJS's delegated onClick handler
  // catches, so openSessionChat runs exactly as a real tap — without depending
  // on viewport geometry. The tiny VP is kept for parity with the other dot
  // specs (the scenario is viewport-independent).
  await page.evaluate((sid) => {
    const el = document.querySelector(
      `.tree-node[data-session-id="${sid}"]`,
    ) as HTMLElement | null;
    if (!el) throw new Error(`tree-node ${sid} not found for click`);
    el.click();
  }, id);
  await expect(
    page.locator(`.tree-node[data-session-id="${id}"].selected`),
  ).toBeVisible({ timeout: 5000 });
  // Give Stream-2's open round-trip (EnsureMessagesAsync → snapshot /
  // messages.loaded) a moment to land, so the post-click observation is stable.
  await page.waitForTimeout(500);

  // DESIRED behaviour (gating): after selecting the session, the hydrating dot
  // must be gone. GREEN today (the idle row never arms the dot, and selecting it
  // runs the fetch → messagesLoaded===true); a regression that re-armed the dot
  // on or after selection would turn this RED.
  await expect(hydratingDot(page, id)).toHaveCount(0);
});

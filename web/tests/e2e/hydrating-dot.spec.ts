import { expect, test } from "@playwright/test";

// RED-first reproduction for the ".dot.hydrating shows PERMANENTLY" bug.
//
// THE BUG
//   The "loading from server…" dot (.dot.hydrating in a SessionTree row) shows
//   FOREVER on never-opened / idle sessions and never clears — even after the
//   user clicks (selects) that session. The dot's code comment claims it is a
//   TRANSIENT post-restart aggregation indicator; in reality it is a permanent
//   label for any session whose full message history was never fetched.
//
// ROOT CAUSE (diagnosed upstream — pinned here, not re-investigated)
//   - The dot renders at web/src/components/SessionTree.tsx:319:
//       <Show when={state.status === "live"
//                       && state.hydrated[props.session.id] === false
//                       && !busy()}>
//   - state.hydrated[id] is rebuilt ONLY in Stream-1's connect snapshot
//     (web/src/sync/stream.ts:116-117): `s.hydrated = {}; for ([id,g] of
//     snap.gate) s.hydrated[id] = !!g?.hydrated;`. It is NOT touched by the
//     session.upsert / messages.loaded event paths, so it is FROZEN at whatever
//     Stream-1's one-shot connect snapshot said.
//   - The Go gate fact driving it (pkg/state/store.go:1565):
//       Hydrated: s.msgLoaded[sid] || s.messages[sid] != nil
//     is FALSE BY DESIGN for any session whose full history was never fetched
//     AND that has no live message events (pkg/aggregator/aggregator.go:297 —
//     "Messages are hydrated LAZILY: at startup we fetch none"). So a
//     never-opened idle session has hydrated===false PERMANENTLY, and the dot
//     never clears.
//   - Clicking a session calls openSessionChat → setSelectedId → opens Stream-2
//     (/vh/stream?sessions=<id>), whose handleStream runs EnsureMessagesAsync
//     (server-side msgLoaded flips to true). That flips messagesLoaded — a
//     DIFFERENT FE signal (the ChatView reveal gate), updated by Stream-2's
//     applySessionSnapshot / messages.loaded. It does NOT update state.hydrated
//     (owned by Stream-1, which never re-snapshots). So the dot STAYS after a
//     click. That is the second half of the report.
//
// DESIRED (post-fix) BEHAVIOUR THESE TESTS ENCODE
//   (1) A never-opened, idle session must NOT display a permanent "loading from
//       server…" dot once the page has settled.
//   (2) Selecting (clicking) a never-opened session must clear the dot.
//   Both are RED today (dot is permanently present / survives a click) and turn
//   GREEN once the FE interpretation is fixed (the dot must be transient, not a
//   permanent label for lazily-unfetched sessions).
//
// SHARED-BACKEND STRATEGY (the suite is SERIAL workers:1 over ONE mutable
// in-memory fixture backend — web/playwright.config.ts; each test reloads the
// PAGE but the aggregator's msgLoaded/messages state persists for the whole
// run, so once a session is opened it stays hydrated===true).
//   - By the time this spec runs (alphabetically 8th: after agents, chat-
//     controls-gating, chat-navigator, composer, features, features2, header),
//     `demo`/`sub`/`other` are already hydrated by chat-controls-gating.spec.ts
//     (it opens all three), so they are NOT reliably hydrated===false. `slow`
//     is still never-opened here (only reveal-gate.spec.ts opens it, and that
//     sorts later), but opening `slow` in the click test would pre-hydrate it
//     and break reveal-gate's partial-hydration window. /fixture/reset only
//     resets fixture-side messages/busy — NOT aggregator-side msgLoaded — so it
//     cannot un-hydrate a session either.
//   - The robust option: CREATE a brand-new session via a RAW POST /oc/session
//     (pkg/fixtures/opencode.go:470 → id "ses_new%d"). A brand-new session is
//     guaranteed never-opened (no spec opens it; it is born at test runtime).
//     Crucially we do NOT route through the SPA's createSession()
//     (web/src/sync/actions.ts:94), which would setSelectedId + openSession and
//     hydrate it immediately — we fire the fetch directly so the session lands
//     in the tree (via session.created → session.upsert) but is never selected.
//   - Because state.hydrated[id] is rebuilt ONLY in Stream-1's connect
//     snapshot, a session created AFTER Stream-1 connected has
//     state.hydrated[id]===undefined (=== false is false → no dot) until the
//     next snapshot. So after creating it we RELOAD the page: Stream-1
//     reconnects and its fresh snapshot includes the new session with
//     hydrated===false, arming the dot. This is the only way to observe the dot
//     on a session whose never-opened state is guaranteed regardless of where
//     this spec sits in the serial run or whether a prior run dirtied the
//     backend.

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
// SPA's createSession, which auto-selects + opens → hydrates). Run in-page so
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

// (1) PRIMARY — a never-opened, idle session must NOT display a permanent
// "loading from server…" dot once the page has settled.
//
// We first CONFIRM (non-gating, short timeout) that the bug reproduces today —
// the dot IS permanently armed on the never-opened session — then assert the
// DESIRED behaviour (dot absent). The confirm is wrapped so that once the fix
// lands (dot gone) it is a silent no-op; only the desired-behaviour assertion
// gates the test, which makes it cleanly RED today and GREEN after the fix.
test("never-opened idle session must not show a permanent hydrating dot", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await waitForTree(page);

  // Create a guaranteed never-opened session (see strategy above).
  const id = await createNeverOpenedSession(page);
  // Wait for it to appear via session.upsert on the CURRENT Stream-1 — proves
  // the aggregator has it before we reload. (hydrated[id] is undefined here, so
  // no dot yet.)
  await expect(page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({
    timeout: 10000,
  });

  // Reload so Stream-1 reconnects → its fresh snapshot includes `id` with
  // hydrated===false (state.hydrated is rebuilt only in this connect snapshot).
  await page.goto("/?session=demo");
  await waitForTree(page);
  await expect(page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({
    timeout: 10000,
  });

  // CONFIRM (non-gating): the bug reproduces today — the hydrating dot is
  // permanently armed on this never-opened idle session. Caught so a fixed tree
  // (dot gone) falls through silently to the gating assertion below.
  try {
    await expect(hydratingDot(page, id)).toBeVisible({ timeout: 5000 });
  } catch {
    /* dot already absent — fix landed; the gating assertion below is the proof */
  }

  // DESIRED behaviour (gating): once the page has settled, a never-opened idle
  // session must NOT carry a permanent "loading from server…" dot. RED today
  // (the dot is permanently present), GREEN after the fix.
  await expect(hydratingDot(page, id)).toHaveCount(0);
});

// (2) SELECTING a never-opened session must clear the hydrating dot — today it
// does NOT (clicking opens Stream-2, which flips messagesLoaded, a DIFFERENT
// signal; Stream-1 never re-snapshots so state.hydrated stays false → dot
// stays). Same confirm-then-desired shape as test (1).
//
// NOTE on "wait for messages to load": the brand-new session created above has
// NO messages (POST /oc/session seeds none), so `.msg` never appears on open.
// We instead wait for the row to be marked `.selected`, which proves the click
// registered and openSessionChat ran — the dot's fate is decided entirely by
// the frozen Stream-1 snapshot (unaffected by Stream-2), so the selection
// signal is sufficient to know we are observing the post-click state.
test("selecting a never-opened session must clear its hydrating dot", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await waitForTree(page);

  const id = await createNeverOpenedSession(page);
  await expect(page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({
    timeout: 10000,
  });
  // Reload → fresh Stream-1 snapshot → `id` armed with hydrated===false.
  await page.goto("/?session=demo");
  await waitForTree(page);
  await expect(page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({
    timeout: 10000,
  });

  // CONFIRM (non-gating): the dot is armed before the click.
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
  // specs (the bug is viewport-independent).
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
  // must be gone. RED today (Stream-1's frozen snapshot keeps hydrated===false
  // → the dot survives the click), GREEN after the fix.
  await expect(hydratingDot(page, id)).toHaveCount(0);
});

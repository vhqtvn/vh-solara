// Send-net-resilience slice 3 e2e — the FE outbox + observe-only projection
// + ambiguous chip, against the REAL fixture daemon (real pkg/web queue HTTP
// API + real IndexedDB in the browser).
//
// Daemon-side behaviors this spec SIMULATES via route interception (they are
// Go-tested by the sibling daemon slices; the FE's INTERPRETATION is what
// this lane owns): daemonDispatchCapable on /vh/version, 409
// queue_custody_active on claim/resolve, and the AmbiguousDelivery terminal
// marker on list items.
//
// Scenarios (the slice's binding test matrix):
//   A. tab-kill mid-flow (gesture → outbox saved → admission → kill →
//      relaunch → converges; NO location.reload in recovery)
//   B. two tabs, one gesture: tab A's admission POST is genuinely aborted
//      (predicate-intercepted) and tab A is KILLED (the crash window); the
//      saved record is backdated past the 60s re-admission age guard with an
//      unknowable head, and tab B's session-open reconcile RE-ADMITS it
//      under the ORIGINAL intentId — exactly ONE queue item (the daemon's
//      by-value admission dedupe backs the focus re-reconcile)
//   C. IDB storage failure at gesture time → the blocking persistent
//      "Not saved — copy your text" banner; text retained + copyable
//   D. ambiguous flow (projection mode): the daemon marks AmbiguousDelivery →
//      the chip renders the VERBATIM warning + Wait/Copy/Send-new → the
//      replacement is a NEW item; both display truthfully; the original shows
//      "replacement requested"
//   E. legacy regression: daemonDispatchCapable absent → the FE still claims
//      and delivers (byte-intact legacy drain)
//   F. transient IDB failure (fail-first wrapper around the REAL indexedDB
//      factory, released mid-test) → blocking banner + retained text + no
//      durable record → "Try saving again" re-commits through REAL IDB →
//      banner clears → re-send proceeds to admission (the RECOVERY half of
//      the BLK-A3 surface; scenario C proves the failure half from boot)
//   G. stale two-tap replacement (cluster C, D-F4): a probe session seeded
//      ambiguous via route-simulated daemon facts (scenario D's shape), whose
//      live transcript head REALLY moves after the original gesture (a real
//      prompt_async turn through the fixture + real SSE) → the first tap
//      renders the INLINE stale-confirm with ZERO enqueues; "Send anyway"
//      with the head HELD admits exactly ONE replacement under a NEW
//      intentId (chip → replacement-requested; both display truthfully)
//   G-drift: the same shape, but the head moves AGAIN during the confirm
//      window → "Send anyway" REFUSES loudly (notification + zero enqueues +
//      no second outbox record; the chip stays actionable)
//   H. two LIVE tabs (cluster C, r3-bF1/gate-aF3+dF1): REAL BroadcastChannel
//      + the REAL sessionStorage opener-copy — the clone tab's same-text
//      cross-eval prune is objected over the real channel and BOTH records
//      coexist (the conservative skip); the opener's record is never deleted
//
// Hygiene: part of the serial suite over the shared fixtureserver. Queue
// state is owned + cleaned per test via the real queue API (queue-recovery
// spec's pattern); the outbox DB (vh-solara-outbox) is cleared per test from
// inside the page (same origin).
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { demoDir, projectUrl } from "./util";

// The seeded DEMO session (ux.spec's queue-drain precedent): it carries agent
// evidence (fixture messages stamp agent "build"), so composer sends — and
// legacy deliveries — actually work. Part of the serial suite; queue state is
// owned + cleaned per test via the real queue API.
const SID = "demo";
const jsonCsrf = { "Content-Type": "application/json", "X-VH-CSRF": "1" };

function apiUrl(suffix = ""): string {
  return `/vh/session/${SID}/queue${suffix}?dir=${encodeURIComponent(demoDir)}`;
}

/** Remove every queue item, retrying stuck `dispatching` items past the
 *  daemon's 30s stale-dispatch threshold (a LIST after the threshold flips
 *  them to terminal `unknown`, which is removable). The retry makes every
 *  beforeEach self-healing against leftovers from previous runs — queue.json
 *  persists on disk across fixtureserver restarts. */
async function cleanQueue(request: APIRequestContext): Promise<void> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const res = await request.get(apiUrl());
    if (!res.ok()) return;
    const j = await res.json().catch(() => ({}));
    const items: Array<{ id: string }> = Array.isArray(j.items) ? j.items : [];
    if (items.length === 0) return;
    let stuck = false;
    for (const it of items) {
      const del = await request.delete(apiUrl(`/${encodeURIComponent(it.id)}`), { headers: jsonCsrf });
      if (!del.ok()) stuck = true; // 409 dispatching — not yet stale
    }
    if (!stuck) return;
    if (Date.now() > deadline) return; // bounded: never wedge the suite
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Read every outbox gesture record from inside the page (the REAL IDB
 *  path — this is the e2e proof of the store seam the unit tests fake). */
async function readOutbox(page: Page): Promise<Array<{ intentId: string; status: string; queueItemId?: string }>> {
  return page.evaluate(
    () =>
      new Promise<any[]>((resolve) => {
        const open = indexedDB.open("vh-solara-outbox");
        open.onerror = () => resolve([]);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("gestures")) return resolve([]);
          const req = db.transaction("gestures", "readonly").objectStore("gestures").getAll();
          req.onsuccess = () => resolve(req.result ?? []);
          req.onerror = () => resolve([]);
        };
      }),
  );
}

/** Count location.reload invocations (the no-reload honesty assertion,
 * AMEND-A7). Installed BEFORE goto so every reload in the page's life is
 * counted; intentional update-flow reloads are excluded by scenario design
 * (none of these scenarios touch the update flow). */
async function installReloadCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__reloadCount = 0;
    const orig = window.location.reload.bind(window.location);
    window.location.reload = (...args: any[]) => {
      (window as any).__reloadCount++;
      return (orig as any)(...args);
    };
  });
}

/** Prepare a saved outbox record for the two-tab re-admission path
 *  (scenario B), through the page-side IDB handle (readwrite; the same
 *  database readOutbox inspects):
 *    - backdate createdAt past the 60s READMIT_MIN_AGE_MS guard (an
 *      immediate session-open reconcile would otherwise skip the young
 *      record — "its own gesture may still be mid-admission" — and the
 *      re-admission path could never run inside a test's lifetime);
 *    - null capturedHead: the tab-B reconcile races the demo transcript's
 *      hydration, and a PARTIALLY-hydrated head would false-trip the stale
 *      gate (the innocent-hydration class the 2026-10-09 amendment excludes
 *      from the compare). Null = "unknowable" — never fabricates staleness
 *      (store.ts's head contract), so the re-admission under test is
 *      deterministic. The stale gate itself has dedicated unit coverage
 *      (outbox.test.ts) and needs no second proof here.
 */
async function primeOutboxRecordForReAdmit(page: Page, intentId: string, createdAt: number): Promise<void> {
  await page.evaluate(
    ([id, ts]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("vh-solara-outbox");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("gestures")) return reject(new Error("gestures store missing"));
          const tx = db.transaction("gestures", "readwrite");
          const store = tx.objectStore("gestures");
          const get = store.get(id as string);
          get.onsuccess = () => {
            const rec = get.result;
            if (!rec) return reject(new Error("record not found: " + id));
            rec.createdAt = ts as number;
            rec.capturedHead = null;
            store.put(rec);
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        };
      }),
    [intentId, createdAt],
  );
}

async function openSession(page: Page): Promise<void> {
  await page.goto(projectUrl("/?session=" + SID));
}

async function listQueue(request: APIRequestContext): Promise<any[]> {
  const res = await request.get(apiUrl());
  expect(res.ok(), "queue list").toBeTruthy();
  const j = await res.json();
  return Array.isArray(j.items) ? j.items : [];
}

// The retry-clean (stale-dispatch window is 30s server-side) can exceed the
// default 30s test budget; these tests own a wider one (serial lane).
test.beforeEach(async ({ request }, testInfo) => {
  testInfo.setTimeout(120_000);
  await cleanQueue(request);
});

// The popup page scenario H opened (deterministic cleanup — the serial lane
// must never leak a second live tab into later specs). Declared here so the
// afterEach below can close it on failure paths.
let scenarioHPopup: Page | null = null;

test.afterEach(async ({ request }) => {
  await cleanQueue(request);
  // Scenario H's popup (deterministic two-tab hygiene): close it if the test
  // failed before its own cleanup. close() on an already-closed page is a
  // no-op, so this is safe on every path.
  if (scenarioHPopup) {
    await scenarioHPopup.close().catch(() => {});
    scenarioHPopup = null;
  }
});

// --- A. tab-kill mid-flow ------------------------------------------------------
test("A: tab-kill after admission → relaunch converges (chip → delivered, no reload, no re-admission)", async ({
  page,
  context,
  request,
}) => {
  await installReloadCounter(page);
  // Block the CLAIM so the admitted item stays pending (the kill window).
  await page.route(`**/vh/session/${SID}/queue/claim*`, (route) => route.abort());
  await openSession(page);
  const composer = page.getByPlaceholder("Message…");
  await composer.fill("survive the tab kill");
  await composer.press("Enter");
  // The item is admitted (server custody) + the outbox linked it.
  const chip = page.locator(".queue-chip", { hasText: "survive the tab kill" });
  await expect(chip).toBeVisible({ timeout: 10000 });
  await expect.poll(async () => (await listQueue(request)).length, { timeout: 5000 }).toBe(1);
  await expect.poll(async () => (await readOutbox(page)).length, { timeout: 5000 }).toBe(1);
  const record = (await readOutbox(page))[0];
  expect(record.status).toBe("admitted"); // linked: no re-admission later
  expect(record.queueItemId).toBeTruthy();

  // KILL the tab mid-flow (post-admission, pre-delivery).
  await page.close();

  // RELAUNCH a fresh page in the SAME context (same origin → same IDB + same
  // server queue). No claim interception here: the legacy drainer may run.
  const page2 = await context.newPage();
  await installReloadCounter(page2);
  await openSession(page2);
  // Convergence without reload: the still-pending item renders as a chip,
  // then the (unblocked) legacy drain delivers it into the transcript.
  await expect(page2.locator(".msg.user", { hasText: "survive the tab kill" })).toBeVisible({
    timeout: 20000,
  });
  await expect(page2.locator(".queue-chip", { hasText: "survive the tab kill" })).toHaveCount(0, {
    timeout: 20000,
  });
  // Exactly ONE item was ever admitted (the relaunch reconciled by intentId —
  // it never re-enqueued the already-admitted gesture) and it reached `sent`.
  const finalItems = await listQueue(request);
  expect(finalItems).toHaveLength(1);
  expect(finalItems[0].state).toBe("sent");
  const reloads = await page2.evaluate(() => (window as any).__reloadCount);
  expect(reloads).toBe(0); // no-reload recovery (AMEND-A7 honesty)
  await page2.close();
});

// --- B. two tabs, one gesture --------------------------------------------------
test("B: two tabs one gesture — tab B's reconcile re-admits the saved gesture under its ORIGINAL intentId; exactly ONE item (no double-send)", async ({
  context,
  request,
}) => {
  // The SPA's queue URLs carry NO query string (the project dir travels in
  // the x-opencode-directory header), so a glob like `queue?*` can NEVER
  // match the enqueue POST — Playwright's `?` is a single-char wildcard and
  // the URL ends at `queue`. The old pattern-matched "block" was vacuous
  // (tab A actually admitted). Match by PREDICATE instead (scenario D's
  // isQueueListUrl idiom): the exact /queue path with optional query, never
  // the claim/resolve sub-paths.
  const isQueueListUrl = (url: URL) => /\/vh\/session\/demo\/queue(\?.*)?$/.test(url.href);
  let tabAPostsAborted = 0;
  const blockAdmissionInTabA = async (page: Page) => {
    await page.route(isQueueListUrl, (route) => {
      if (route.request().method() === "POST") {
        tabAPostsAborted++;
        return route.abort(); // the gesture saves locally; admission never completes
      }
      return route.continue();
    });
    // The claim stays blocked: the re-admitted item must remain `pending` —
    // deliverable-free and cleanly removable by this spec's afterEach (a
    // dispatching item would 409). The prompt POST is blocked too: even if a
    // claim slipped through, the dispatch can never reach OpenCode, so no
    // transcript side effects leak.
    await page.route(`**/vh/session/${SID}/queue/claim*`, (route) => route.abort());
    await page.route(`**/oc/session/${SID}/prompt_async*`, (route) => route.abort());
  };
  // Tab A: the gesture saves locally; its own enqueue POST is genuinely
  // aborted by the predicate interception (the crash-window class).
  const pageA = await context.newPage();
  await installReloadCounter(pageA);
  await blockAdmissionInTabA(pageA);
  await openSession(pageA);
  // The ?session=demo preselect can lose the race against a cold fixture
  // tree (no sessions yet → the app falls to the DRAFT view and a send
  // there would target a brand-new session, silently invalidating the
  // scenario). Wait for the demo session to be genuinely SELECTED and its
  // transcript resident before typing.
  await expect(pageA.locator(".msg").first()).toBeVisible({ timeout: 20_000 });
  const composerA = pageA.getByPlaceholder("Message…");
  // Deterministic agent evidence (send-reliability.spec's protocol): the
  // composer must show a RESOLVED agent before Enter, or the send parks in
  // the agent-evidence gate (up to 10s) and the gesture has not even saved
  // locally yet.
  await expect(pageA.locator(".composer .agent-select .vh-select-label")).toHaveText(/@/, {
    timeout: 10_000,
  });
  await composerA.fill("one gesture two tabs");
  await composerA.press("Enter");
  // The outbox holds the UN-admitted gesture: status "saved", no queue item
  // link (the crash-window posture the re-admission path exists for).
  await expect.poll(async () => (await readOutbox(pageA)).length, { timeout: 5000 }).toBe(1);
  const recordA = (await readOutbox(pageA))[0];
  expect(recordA.status).toBe("saved");
  expect(recordA.queueItemId).toBeUndefined();
  const intent = recordA.intentId;
  expect(intent).toBeTruthy();
  // NOT vacuous, side 1: tab A's enqueue POST was REALLY intercepted (the
  // aborting route fired — tab A never admitted through the leak the old
  // glob pattern left open).
  await expect.poll(async () => tabAPostsAborted, { timeout: 5000 }).toBeGreaterThanOrEqual(1);

  // Backdate the saved record past the 60s READMIT_MIN_AGE_MS guard: tab B's
  // immediate session-open reconcile would otherwise skip the young record
  // ("its own gesture may still be mid-admission") and NEVER exercise the
  // re-admission path under test.
  await primeOutboxRecordForReAdmit(pageA, intent, Date.now() - 120_000);
  const primed = (await readOutbox(pageA))[0] as any;
  expect(primed.createdAt).toBeLessThan(Date.now() - 60_000);
  expect(primed.capturedHead).toBeNull();

  // KILL tab A — the crash-window posture it simulates. This also removes it
  // from the re-admission race: a still-open tab A would fire its OWN
  // visibilitychange reconcile when tab B appears (the record is now aged +
  // head-null, so tab A WOULD re-admit) and tab A's own interception would
  // abort that POST, starving tab B of the recovery entirely (observed: the
  // one POST in the trace was tab A's, aborted by tab A).
  await pageA.close();

  // Tab B (same context/origin → same IDB + same server queue): the enqueue
  // POST is NOT intercepted (only claim + prompt stay blocked), so tab B's
  // session-open reconcile GENUINELY re-admits the saved gesture under its
  // ORIGINAL intentId through the REAL daemon.
  const pageB = await context.newPage();
  await installReloadCounter(pageB);
  await pageB.route(`**/vh/session/${SID}/queue/claim*`, (route) => route.abort());
  await pageB.route(`**/oc/session/${SID}/prompt_async*`, (route) => route.abort());
  await openSession(pageB);
  // Same preselect guard as tab A: the session-open reconcile only runs for
  // the SELECTED session — a draft-view tab B would reconcile nothing.
  await expect(pageB.locator(".msg").first()).toBeVisible({ timeout: 20_000 });
  // NOT vacuous, side 2: the one server item came from tab B's re-admission
  // (tab A is dead and its live POSTs were all aborted) — and it carries the
  // SAME gesture identity the outbox saved (the daemon echoes the intentId
  // it deduped on).
  await expect.poll(async () => (await listQueue(request)).length, { timeout: 15000 }).toBe(1);
  const items = await listQueue(request);
  expect(items[0].intentId ?? items[0].attemptId).toBe(intent);
  // Trigger one more reconcile pass (focus) and re-assert no second item —
  // a re-admission attempt of the same intentId returns the ORIGINAL receipt
  // (the daemon's by-value admission dedupe).
  await pageB.evaluate(() => window.dispatchEvent(new Event("focus")));
  await pageB.waitForTimeout(1500);
  await expect.poll(async () => (await listQueue(request)).length, { timeout: 5000 }).toBe(1);
  await pageB.close();
});

// --- C. IDB storage failure → blocking banner ----------------------------------
test("C: storage-unavailable at gesture time → blocking 'Not saved — copy your text' banner; text retained + copyable", async ({
  page,
  request,
}) => {
  await installReloadCounter(page);
  // Break IndexedDB BEFORE the app boots (addInitScript runs before any module
  // eval — the outbox module caches its IDB connection at boot hydrate, so a
  // post-boot override cannot break an already-open connection). This is the
  // disabled-IDB / private-mode / storage-unavailable-from-the-start shape.
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      get() {
        throw new Error(" simulated quota / storage unavailable ");
      },
    });
  });
  await openSession(page);
  // Clipboard permission so the Copy affordance's confirmation is real (the
  // catch-path would otherwise silently skip the "Copied" confirm).
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const composer = page.getByPlaceholder("Message…");
  await composer.fill("do not silently lose me");
  await composer.press("Enter");
  // The BLK-A3 blocking persistent state — the exact contract phrase.
  const banner = page.getByTestId("outbox-storage-failure");
  await expect(banner).toBeVisible({ timeout: 10000 });
  await expect(banner).toContainText("Not saved — copy your text.");
  // The compose text is RETAINED in memory (copy-your-text posture).
  await expect(composer).toHaveValue("do not silently lose me");
  // Nothing was admitted (no enqueue happened).
  await expect.poll(async () => (await listQueue(request)).length, { timeout: 3000 }).toBe(0);
  // The Copy affordance confirms (the button's label flips to "Copied").
  await page.getByRole("button", { name: "Copy text" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible({ timeout: 5000 });
  expect(await page.evaluate(() => (window as any).__reloadCount)).toBe(0);
});

// --- D. ambiguous flow under projection ----------------------------------------
test("D: projection mode — AmbiguousDelivery chip (verbatim warning) → replacement → both display truthfully", async ({
  page,
  request,
}) => {
  await installReloadCounter(page);
  // The daemon-side simulation: capability advertised, claim/resolve refused
  // (custody), and the list rewriting the ORIGINAL item to the terminal
  // live-uncertain marker once it exists (only the original — never the
  // replacement gesture, which must stay a plain pending item).
  let ambiguousId: string | null = null;
  await page.route("**/vh/version", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: "e2e-projection", daemonDispatchCapable: true }),
    }),
  );
  await page.route(`**/vh/session/${SID}/queue/claim*`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "queue custody active", code: "queue_custody_active" }),
    }),
  );
  await page.route(`**/vh/session/${SID}/queue/*/resolve*`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "queue custody active", code: "queue_custody_active" }),
    }),
  );
  // The SPA's queue URLs carry NO query (the project dir travels in the
  // x-opencode-directory header), so match by predicate: the LIST endpoint
  // exactly (/queue with optional query), never claim/resolve sub-paths.
  const isQueueListUrl = (url: URL) => /\/vh\/session\/demo\/queue(\?.*)?$/.test(url.href);
  await page.route(isQueueListUrl, async (route) => {
    if (route.request().method() === "GET") {
      const res = await route.fetch();
      const j: any = await res.json();
      if (Array.isArray(j.items)) {
        for (const it of j.items) {
          if (ambiguousId && it.id === ambiguousId && it.state !== "sent") {
            it.state = "unknown";
            it.reconcileTerminal = true;
            it.ambiguousDelivery = true;
            it.detail = "journal-aware ambiguous-wait (e2e simulated)";
          }
        }
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
    }
    return route.continue();
  });

  await openSession(page);
  const composer = page.getByPlaceholder("Message…");
  await composer.fill("ambiguous original");
  await composer.press("Enter");
  // The projection FE never claims: the item STAYS pending (projected), so
  // no transcript delivery — then the "daemon" terminalizes it ambiguous.
  await expect(page.locator(".queue-chip", { hasText: "ambiguous original" })).toBeVisible({
    timeout: 10000,
  });
  // Capture the ORIGINAL item id, then arm the marker.
  await expect.poll(async () => (await listQueue(request)).length, { timeout: 5000 }).toBe(1);
  ambiguousId = (await listQueue(request))[0].id;
  // The ambiguous chip renders with the VERBATIM binding warning + actions.
  const chip = page.getByTestId("ambiguous-chip");
  await expect(chip).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("ambiguous-warning")).toContainText(
    "We could not confirm whether this message arrived. Send a new message may result in both messages being processed if the original arrives later. The original cannot be cancelled.",
  );
  // Wait keeps the chip (collapsed state).
  await page.getByTestId("ambiguous-wait").click();
  await expect(chip).toHaveAttribute("data-state", "waiting");
  await expect(page.getByTestId("ambiguous-warning")).toHaveCount(0);
  // Re-expand and replace: a NEW gesture (one tap — context unchanged).
  await chip.locator("button").first().click();
  await page.getByTestId("ambiguous-replace").click();
  // The replacement is admitted as a NEW item (different intentId); the
  // original flips to the replacement-requested overlay.
  await expect(chip).toHaveAttribute("data-state", "replacement-requested", { timeout: 10000 });
  // The replacement is admitted as a NEW item: the REAL daemon list now holds
  // exactly two items — the original plus the replacement (a different id and
  // a DIFFERENT intentId: a new gesture, not a replay).
  await expect
    .poll(async () => (await listQueue(request)).length, { timeout: 10000 })
    .toBe(2);
  const afterReplace = await listQueue(request);
  const replacement = afterReplace.find((i: any) => i.id !== ambiguousId);
  expect(replacement).toBeTruthy();
  expect(replacement.intentId).toBeTruthy();
  expect(replacement.intentId).not.toBe(afterReplace.find((i: any) => i.id === ambiguousId)?.intentId);
  // BOTH display truthfully at the FE-owned seam: the original renders the
  // ambiguous chip in its replacement-requested state, and the replacement
  // (same text) renders as its own pending chip under projection.
  await expect(chip).toHaveAttribute("data-state", "replacement-requested");
  await expect(page.locator('.queue-chip[data-state="pending"]', { hasText: "ambiguous original" })).toBeVisible({
    timeout: 10000,
  });
  // Now the "daemon" delivers BOTH: both chips clear (truthful display).
  const itemsBefore = await listQueue(request);
  await page.unroute(isQueueListUrl);
  await page.route(isQueueListUrl, (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const j: any = { items: itemsBefore.map((i: any) => ({ ...i, state: "sent", ambiguousDelivery: false })) };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
  });
  await expect(page.locator(".queue-chip")).toHaveCount(0, { timeout: 15000 });
  await expect(chip).toHaveCount(0, { timeout: 5000 });
  expect(await page.evaluate(() => (window as any).__reloadCount)).toBe(0);
});

// --- E. legacy regression ------------------------------------------------------
test("E: legacy (capability absent) — the FE still claims + dispatches (byte-intact drain)", async ({
  page,
  request,
}) => {
  await installReloadCounter(page);
  // Intercept /vh/version WITHOUT the capability field (the legacy shape) and
  // COUNT the FE's own claims (the pass-through counter proves the browser
  // is still the dispatcher).
  let feClaims = 0;
  await page.route("**/vh/version", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: "e2e-legacy" }),
    }),
  );
  await page.route(`**/vh/session/${SID}/queue/claim*`, async (route) => {
    feClaims++;
    return route.continue();
  });
  await openSession(page);
  const composer = page.getByPlaceholder("Message…");
  await composer.fill("legacy drain still works");
  await composer.press("Enter");
  // The legacy path: enqueue → the FE claims → dispatch → transcript.
  await expect(page.locator(".msg.user", { hasText: "legacy drain still works" })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.locator(".queue-chip", { hasText: "legacy drain still works" })).toHaveCount(0, {
    timeout: 20000,
  });
  expect(feClaims).toBeGreaterThanOrEqual(1); // the BROWSER claimed (legacy dispatcher)
  expect(await page.evaluate(() => (window as any).__reloadCount)).toBe(0);
});

// --- F. transient IDB failure → banner → REAL-IDB recovery ---------------------
test("F: transient IDB failure → blocking banner + retained text → retry re-commits to REAL IndexedDB → banner clears → re-send proceeds to admission", async ({
  page,
  request,
}) => {
  await installReloadCounter(page);
  // HONEST INJECTION SHAPE (D-F5): a fail-first wrapper around the REAL
  // indexedDB.open — while __vhOutboxIdbReleased is unset, every open of the
  // vh-solara-outbox DB returns a request whose error fires asynchronously
  // (exactly the observable shape the store's openDb rejects on); once the
  // test sets the release flag the wrapper delegates EVERY call (this test's
  // reads included) to the REAL implementation, so the recovery write and
  // every post-recovery assertion run against REAL IndexedDB. Limit, stated:
  // this injects failures at the FACTORY boundary (the honest equivalent of
  // storage-unavailable/blocked-open transients); a genuinely transient
  // REAL-engine put failure mid-transaction cannot be scripted from page
  // script, and the wrapper does not pretend otherwise — recovery itself is
  // 100% real IDB.
  await page.addInitScript(() => {
    (window as any).__vhOutboxIdbReleased = false;
    (window as any).__vhOutboxIdbFailsObserved = 0;
    const origOpen = indexedDB.open.bind(indexedDB);
    const failingRequest = (dbName: string) => {
      const err = new DOMException("injected transient IDB failure: " + dbName, "UnknownError");
      const req: any = {
        error: err,
        result: undefined,
        readyState: "pending",
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        onblocked: null,
      };
      setTimeout(() => {
        (window as any).__vhOutboxIdbFailsObserved++;
        if (typeof req.onerror === "function") req.onerror({ target: req, type: "error" });
      }, 0);
      return req;
    };
    indexedDB.open = function (this: IDBFactory, name: string, version?: number) {
      if (name === "vh-solara-outbox" && !(window as any).__vhOutboxIdbReleased) {
        return failingRequest(name);
      }
      return origOpen(name, version);
    } as typeof indexedDB.open;
  });
  // Keep the admitted item `pending` (no claim → no delivery churn; the
  // outbox record stays admitted-linked for the final assertion, and the
  // afterEach cleanup can delete a pending item cleanly).
  await page.route(`**/vh/session/${SID}/queue/claim*`, (route) => route.abort());
  await openSession(page);
  // Session-selection guard (scenario B's rationale): the reconcile/send
  // paths under test target the SELECTED demo session.
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 20_000 });
  const composer = page.getByPlaceholder("Message…");
  await composer.fill("storage fails then recovers");
  await composer.press("Enter");
  // The BLK-A3 blocking persistent state — the failure half. Selector fold
  // (a-F1/d-F3 round 1): the SAME outer `outbox-storage-banner` selector for
  // BOTH the appear assertions here and the disappear assertion below — the
  // previous inner-span appear (`outbox-storage-failure`) vs outer-banner
  // disappear pair could mask a half-unmounted banner (the span gone while
  // the alert container persisted).
  const banner = page.getByTestId("outbox-storage-banner");
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText("Not saved — copy your text.");
  // The compose text is RETAINED in memory.
  await expect(composer).toHaveValue("storage fails then recovers");
  // NON-VACUOUS FAILURE (observed BEFORE any recovery is asserted): real
  // opens of the outbox DB genuinely failed — while every open fails no
  // transaction can commit, which is also what proves "no durable record"
  // (a page-side read through the still-failing wrapper cannot distinguish
  // empty from failed, so the observed-failure counter carries that proof).
  const failsObserved = await page.evaluate(() => (window as any).__vhOutboxIdbFailsObserved);
  expect(failsObserved).toBeGreaterThanOrEqual(1);
  // Nothing was admitted while storage was broken.
  await expect.poll(async () => (await listQueue(request)).length, { timeout: 3000 }).toBe(0);

  // RECOVERY: release the wrapper → the retry's put goes through REAL IDB.
  await page.evaluate(() => {
    (window as any).__vhOutboxIdbReleased = true;
  });
  await page.getByRole("button", { name: "Try saving again" }).click();
  // The banner clears (storage recovered for THIS gesture).
  await expect(page.getByTestId("outbox-storage-banner")).toHaveCount(0, { timeout: 10_000 });
  // The re-commit is REAL: a durable record now exists, status `saved`, read
  // through the released wrapper → REAL IndexedDB.
  await expect
    .poll(async () => (await readOutbox(page)).length, { timeout: 5000 })
    .toBe(1);
  const recovered = (await readOutbox(page))[0];
  expect(recovered.status).toBe("saved");
  expect(recovered.intentId).toBeTruthy();
  // ADMISSION PROCEEDS: retryFailedSave deliberately never enqueues (its
  // comment owns that contract) — the operator's re-tap of the retained text
  // is the send path. This fresh gesture saves (real IDB), SUPERSEDES the
  // just-retried same-text record (same tab → own-tab supersede, R-F2's
  // scope, exercised on the real path), and admits through the real daemon.
  await composer.press("Enter");
  await expect.poll(async () => (await listQueue(request)).length, { timeout: 20_000 }).toBe(1);
  await expect
    .poll(async () => {
      const recs = await readOutbox(page);
      return recs.length === 1 && recs[0].status === "admitted" ? recs[0] : null;
    }, { timeout: 10_000 })
    .toMatchObject({ status: "admitted" });
  const finalRecord = (await readOutbox(page))[0];
  expect(finalRecord.queueItemId).toBeTruthy(); // linked to the admitted item
  expect(await page.evaluate(() => (window as any).__reloadCount)).toBe(0); // no-reload recovery
});

// --- shared machinery for G / G-drift / H (cluster C) ---------------------------

/** Queue-list URL predicate for an arbitrary session id (scenario B/D's
 *  isQueueListUrl idiom, parameterized): the exact /queue path with optional
 *  query — never the claim/resolve sub-paths (the SPA's queue URLs carry NO
 *  query string; the project dir travels in the x-opencode-directory header,
 *  so a `queue?*` glob can never match — see scenario B's note). */
const queueUrlPredicate = (sid: string) => (url: URL) =>
  new RegExp(`/vh/session/${sid}/queue(\\?.*)?$`).test(url.href);

/** Queue list for an arbitrary session (listQueue, parameterized). */
async function listQueueFor(request: APIRequestContext, sid: string): Promise<any[]> {
  const res = await request.get(`/vh/session/${sid}/queue?dir=${encodeURIComponent(demoDir)}`);
  expect(res.ok(), `queue list ${sid}`).toBeTruthy();
  const j = await res.json();
  return Array.isArray(j.items) ? j.items : [];
}

/** Delete one gesture record page-side (the same IDB handle readOutbox
 *  inspects). Used for post-assertion hygiene: G/H are the first scenarios
 *  that can leave `saved` records for the SHARED demo session (H) — without
 *  this, a later serial-suite spec's demo reconcile would age them past the
 *  60s guard and re-admit them as phantom queue items. */
async function deleteOutboxRecords(page: Page, intentIds: string[]): Promise<void> {
  await page.evaluate(
    (ids) =>
      new Promise<void>((resolve) => {
        const open = indexedDB.open("vh-solara-outbox");
        open.onerror = () => resolve();
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("gestures")) return resolve();
          const tx = db.transaction("gestures", "readwrite");
          for (const id of ids) tx.objectStore("gestures").delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        };
      }),
    intentIds,
  );
}

/** Remove a probe session's queue items (pending items delete cleanly) and
 *  then the probe session itself (session-rail's /fixture/delete pattern).
 *  G's scenarios append REAL transcript turns to the probe; the fixture's
 *  simulated replies carry NO agent stamp, which would clear a shared
 *  session's tree agent chip and composer agent evidence for every later
 *  serial-suite spec — so the probes are ALWAYS hermetic + deleted. */
async function cleanupProbe(request: APIRequestContext, sid: string): Promise<void> {
  try {
    const items = await listQueueFor(request, sid).catch(() => [] as any[]);
    for (const it of items) {
      await request.delete(
        `/vh/session/${sid}/queue/${encodeURIComponent(it.id)}?dir=${encodeURIComponent(demoDir)}`,
        { headers: jsonCsrf },
      );
    }
  } finally {
    await request.post(`/oc/fixture/delete?session=${encodeURIComponent(sid)}`, { headers: jsonCsrf });
  }
}

/** Move the live transcript head with a REAL second turn: an in-page POST to
 *  the real prompt_async route (session-rail's prompt() shape) through the
 *  real fixture, whose user+assistant messages land in the real transcript
 *  store via real SSE. Waits for the streamed reply to complete — the stable
 *  head point (no further appends after this returns). */
async function moveHeadWithRealTurn(page: import("@playwright/test").Page, sid: string, text: string): Promise<void> {
  await page.evaluate(
    async ({ sid, text }) => {
      const res = await fetch(`/oc/session/${encodeURIComponent(sid)}/prompt_async`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      });
      if (!res.ok && res.status !== 204) throw new Error(`prompt -> ${res.status}`);
    },
    { sid, text },
  );
  await expect(page.locator(".msg.assistant").last()).toContainText("Done. Updated", { timeout: 15_000 });
}

/** Seed the stale two-tap shape (scenario G family) in a FRESH probe session:
 *  projection-mode daemon facts route-simulated exactly like scenario D
 *  (capability advertised, claim/resolve refused, list rewriting the ORIGINAL
 *  item to the terminal ambiguous marker), one REAL composer gesture whose
 *  outbox record captures the provably-empty probe head, and the ambiguous
 *  chip surfaced via a focus-triggered list refetch.
 *
 *  WHY A PROBE (never the shared demo session): the head must REALLY move
 *  after the gesture, and the only honest way to move it is a real prompt
 *  turn — whose fixture replies carry no agent stamp (they would clear the
 *  demo session's agent evidence for every later serial-suite spec; the
 *  session-rail spec documents the same hazard). The probe's transcript
 *  starts provably empty, so the captured head is DETERMINISTICALLY
 *  {sid, null, 0} — asserted from the durable record below (the stale gate's
 *  basis; a null capture would make the whole scenario vacuous, so it must
 *  fail loudly here, not silently pass later). */
async function seedStaleAmbiguous(
  page: Page,
  request: APIRequestContext,
  text: string,
): Promise<{
  sid: string;
  originalItemId: string;
  originalIntentId: string;
  enqueuePosts: () => number;
}> {
  // Hermetic probe (session-rail's mkProbe): a fresh EMPTY session in the
  // demo project dir.
  const oc = { "X-VH-CSRF": "1", "x-opencode-directory": demoDir };
  const created = await request.post("/oc/session", { headers: oc, data: {} });
  if (!created.ok()) throw new Error(`probe create failed: ${created.status()} ${created.statusText()}`);
  const sid = ((await created.json()) as { id: string }).id;

  // Scenario D's route-simulated daemon facts, parameterized to the probe +
  // an enqueue-POST counter (the load-bearing zero/one assertions of the
  // stale two-tap paths read it).
  let ambiguousId: string | null = null;
  let enqueuePosts = 0;
  await page.route("**/vh/version", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: "e2e-projection", daemonDispatchCapable: true }),
    }),
  );
  await page.route(`**/vh/session/${sid}/queue/claim*`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "queue custody active", code: "queue_custody_active" }),
    }),
  );
  await page.route(`**/vh/session/${sid}/queue/*/resolve*`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "queue custody active", code: "queue_custody_active" }),
    }),
  );
  const isQueueUrl = queueUrlPredicate(sid);
  await page.route(isQueueUrl, async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      const res = await route.fetch();
      const j: any = await res.json();
      if (Array.isArray(j.items)) {
        for (const it of j.items) {
          if (ambiguousId && it.id === ambiguousId && it.state !== "sent") {
            it.state = "unknown";
            it.reconcileTerminal = true;
            it.ambiguousDelivery = true;
            it.detail = "journal-aware ambiguous-wait (e2e simulated)";
          }
        }
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
    }
    if (method === "POST") enqueuePosts++;
    return route.continue();
  });

  await installReloadCounter(page);
  await page.goto(projectUrl("/?session=" + encodeURIComponent(sid)));
  // Send-readiness guard (scenario B's rationale): the composer's agent label
  // resolves only after the empty probe's transcript hydrates "provably
  // empty" (the config-default agent branch) — which is ALSO the point where
  // state.messages[sid] is resident, so the gesture below captures a REAL
  // non-null head.
  await expect(page.locator(".composer .agent-select .vh-select-label")).toHaveText(/@/, {
    timeout: 20_000,
  });
  const composer = page.getByPlaceholder("Message…");
  await composer.fill(text);
  await composer.press("Enter");
  // The gesture: REAL save + REAL admission through the REAL daemon queue
  // API — exactly one item, exactly one POST.
  await expect(page.locator(".queue-chip", { hasText: text })).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => (await listQueueFor(request, sid)).length, { timeout: 5000 }).toBe(1);
  expect(enqueuePosts, "the original gesture admitted exactly once").toBe(1);
  const item = (await listQueueFor(request, sid))[0];
  const originalIntentId: string = item.intentId ?? item.attemptId;
  expect(originalIntentId).toBeTruthy();
  // The durable record: admitted + linked, and the STALE-GATE BASIS — the
  // captured head is the provably-empty probe head (non-null, count 0). If
  // this ever fails, the app changed when the transcript slot becomes
  // resident and every downstream stale assertion would be vacuous.
  await expect
    .poll(
      async () => {
        const recs = await readOutbox(page);
        return recs.find((r) => r.intentId === originalIntentId && r.status === "admitted") ?? null;
      },
      { timeout: 5000 },
    )
    .toBeTruthy();
  const record = ((await readOutbox(page)).find((r) => r.intentId === originalIntentId) ?? {}) as any;
  expect(record.capturedHead).toEqual({ sessionId: sid, lastMessageId: null, count: 0 });

  // Arm the ambiguous marker and surface the chip via a focus-triggered list
  // refetch (the ~5s poll would also catch it; focus is deterministic).
  ambiguousId = item.id;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByTestId("ambiguous-chip")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("ambiguous-chip")).toHaveAttribute("data-state", "active");
  return { sid, originalItemId: item.id, originalIntentId, enqueuePosts: () => enqueuePosts };
}

// --- G. stale two-tap replacement, head holds -----------------------------------
test("G: stale two-tap — inline confirm on the first tap (no enqueue); 'Send anyway' with the head HELD admits exactly ONE replacement under a NEW intentId", async ({
  page,
  request,
}) => {
  const text = `stale two tap holds ${Date.now()}`;
  const seed = await seedStaleAmbiguous(page, request, text);
  try {
    // Move the live head AFTER the original gesture captured {sid,null,0}:
    // a REAL second turn (real prompt_async through the fixture + real SSE
    // into the real transcript store). The live head deterministically
    // becomes {sid,<new id>,2} ≠ the captured head.
    await moveHeadWithRealTurn(page, seed.sid, "e2e head move (holds variant)");

    // FIRST TAP: the inline stale-confirm — NOT an immediate enqueue.
    await page.getByTestId("ambiguous-replace").click();
    const confirm = page.getByTestId("ambiguous-stale-confirm");
    await expect(confirm).toBeVisible({ timeout: 5000 });
    await expect(confirm).toContainText("The conversation moved on since this message was sent.");
    await expect(page.getByTestId("ambiguous-replace-anyway")).toBeVisible();
    await expect(page.getByTestId("ambiguous-stale-cancel")).toBeVisible();
    // The verbatim warning stays behind the confirm; the chip is still active.
    await expect(page.getByTestId("ambiguous-warning")).toBeVisible();
    await expect(page.getByTestId("ambiguous-chip")).toHaveAttribute("data-state", "active");
    // NON-VACUOUS (the refusal direction): the first tap enqueued NOTHING —
    // this fails if the controller ever skips the confirmation.
    expect(seed.enqueuePosts(), "the first tap must NOT enqueue").toBe(1); // 1 = the original gesture only

    // SECOND TAP with the head HELD during the confirm window: the operator
    // acknowledged exactly this drift → ONE replacement under a NEW intentId.
    await page.getByTestId("ambiguous-replace-anyway").click();
    const chip = page.getByTestId("ambiguous-chip");
    await expect(chip).toHaveAttribute("data-state", "replacement-requested", { timeout: 10_000 });
    expect(seed.enqueuePosts(), "exactly ONE replacement enqueue (and nothing else)").toBe(2); // original + replacement
    // The REAL daemon list holds exactly the two items, and the replacement
    // is a NEW gesture: a different id AND a different intentId.
    const items = await listQueueFor(request, seed.sid);
    expect(items).toHaveLength(2);
    const original = items.find((i: any) => i.id === seed.originalItemId)!;
    const replacement = items.find((i: any) => i.id !== seed.originalItemId)!;
    expect(original.intentId ?? original.attemptId).toBe(seed.originalIntentId);
    expect(replacement.intentId).toBeTruthy();
    expect(replacement.intentId).not.toBe(seed.originalIntentId);
    // BOTH display truthfully: the replacement renders as its own pending
    // chip; the original renders the chip's replacement-requested state.
    await expect(page.locator('.queue-chip[data-state="pending"]', { hasText: text })).toBeVisible({
      timeout: 10_000,
    });
    await expect(chip).toHaveAttribute("data-state", "replacement-requested");
    // The durable overlay: the ORIGINAL record carries replacedBy → the NEW
    // intentId (the FE-owned marker the chip renders across reloads).
    const recs = await readOutbox(page);
    const orig = recs.find((r) => r.intentId === seed.originalIntentId) as any;
    expect(orig?.replacedBy).toBe(replacement.intentId);
    expect(await page.evaluate(() => (window as any).__reloadCount)).toBe(0);
  } finally {
    await cleanupProbe(request, seed.sid);
  }
});

// --- G-drift. stale two-tap, drift DURING the confirm window --------------------
test("G-drift: stale two-tap — the head moving DURING the confirm window makes 'Send anyway' refuse loudly (zero enqueues, chip stays actionable)", async ({
  page,
  request,
}) => {
  const text = `stale two tap drifts ${Date.now()}`;
  const seed = await seedStaleAmbiguous(page, request, text);
  try {
    // First head move → first tap → the inline confirm renders (the pending
    // baseline is armed with the first-tap head).
    await moveHeadWithRealTurn(page, seed.sid, "e2e head move (first drift)");
    await page.getByTestId("ambiguous-replace").click();
    await expect(page.getByTestId("ambiguous-stale-confirm")).toBeVisible({ timeout: 5000 });
    expect(seed.enqueuePosts()).toBe(1); // the original gesture only

    // DRIFT DURING THE CONFIRM WINDOW: the head moves AGAIN before "Send
    // anyway" — the drift the operator NEVER acknowledged.
    await moveHeadWithRealTurn(page, seed.sid, "e2e head move (second drift)");

    await page.getByTestId("ambiguous-replace-anyway").click();
    // LOUD refusal — the real NotificationCenter surface. (Which branch
    // refused is structurally pinned: the stale-confirm UI above rendered
    // from the SAME "stale-confirm" tap verdict that arms pendingConfirm, so
    // the no-pending branch is unreachable here — the refusal can only be
    // the compare-at-REPLACEMENT drift branch.)
    const bell = page.getByRole("button", { name: "Notifications" });
    await expect(bell.locator(".notif-badge")).toBeVisible({ timeout: 8000 });
    await bell.click();
    const item = page.locator(".notif-item", { hasText: "Conversation moved on" }).first();
    await expect(item.locator(".notif-title")).toContainText("Conversation moved on");
    await expect(item.locator(".notif-detail")).toContainText(
      "Nothing was sent. The conversation changed again",
    );
    // THE load-bearing refusal assertions — this test FAILS if the controller
    // enqueued: zero replacement POSTs, zero new outbox records, one item.
    expect(seed.enqueuePosts(), "drift-during-confirm must NOT enqueue").toBe(1);
    const recs = (await readOutbox(page)).filter((r) => (r as any).sessionId === seed.sid);
    expect(recs, "no second outbox record was saved").toHaveLength(1);
    expect(recs[0].intentId).toBe(seed.originalIntentId);
    expect(await listQueueFor(request, seed.sid)).toHaveLength(1);
    // The chip stays actionable: back to the three actions behind the warning.
    const chip = page.getByTestId("ambiguous-chip");
    await expect(chip).toHaveAttribute("data-state", "active");
    await expect(page.getByTestId("ambiguous-replace")).toBeVisible();
    await expect(page.getByTestId("ambiguous-stale-confirm")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__reloadCount)).toBe(0);
  } finally {
    await cleanupProbe(request, seed.sid);
  }
});

// --- H. two LIVE tabs, REAL BroadcastChannel objection --------------------------

test("H: two LIVE tabs (opener-copied sessionStorage) — the clone's cross-eval prune is objected over the REAL BroadcastChannel; both records coexist", async ({
  page,
  request,
  context,
}) => {
  await installReloadCounter(page);
  // BOTH tabs' admission POSTs are genuinely aborted (predicate
  // interception, scenario B's idiom): every record stays `saved` — the
  // status the prune matches — and NO queue churn happens at all.
  const isQueueListUrl = queueUrlPredicate(SID);
  let abortedPosts = 0;
  const blockAdmission = async (p: Page) => {
    await p.route(isQueueListUrl, (route) => {
      if (route.request().method() === "POST") {
        abortedPosts++;
        return route.abort();
      }
      return route.continue();
    });
    await p.route(`**/vh/session/${SID}/queue/claim*`, (route) => route.abort());
    await p.route(`**/oc/session/${SID}/prompt_async*`, (route) => route.abort());
  };
  await blockAdmission(page);
  await openSession(page);
  // Scenario B's guards: transcript resident + a resolved composer agent.
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".composer .agent-select .vh-select-label")).toHaveText(/@/, {
    timeout: 10_000,
  });
  const text = `two live tabs one text ${Date.now()}`;
  const composer = page.getByPlaceholder("Message…");
  await composer.fill(text);
  await composer.press("Enter");
  // Tab A's record commits through REAL IDB: status saved (its POST was
  // genuinely aborted — the crash-window posture), stamped with A's clientId
  // + bootNonce.
  await expect
    .poll(async () => {
      const recs = await readOutbox(page);
      return recs.filter((r) => (r as any).payload?.text === text).length;
    }, { timeout: 5000 })
    .toBe(1);
  const recA = ((await readOutbox(page)).find((r) => (r as any).payload?.text === text) ?? {}) as any;
  expect(recA.status).toBe("saved");
  expect(recA.clientId).toBeTruthy();
  expect(recA.bootNonce).toBeTruthy();
  const intentA = recA.intentId;

  // A PASSIVE sniffer on the REAL claim channel, installed in tab A before
  // tab B exists. BroadcastChannel delivery is same-origin broadcast to every
  // open channel object, so the sniffer observes BOTH the clone's 'who-has'
  // and the app module's 'mine' answer — the honest discriminator between
  // "objection received → skip" and "no answer → timeout → also skip" (both
  // end in coexistence; only this makes the objection OBSERVABLE). Purely
  // passive: receiving changes nothing about the gate under test.
  await page.evaluate(() => {
    (window as any).__bcLog = [];
    const ch = new BroadcastChannel("vh-solara-outbox");
    ch.onmessage = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; id?: string } | null;
      (window as any).__bcLog.push({ type: d?.type, id: d?.id, t: Date.now() });
    };
  });

  // Tab B: opener-created same-origin tab — the platform COPIES sessionStorage
  // into it (the exact shape the bootNonce + uncontested-claim gate exist
  // for): SAME clientId, DIFFERENT page-evaluation nonce.
  const popupPromise = context.waitForEvent("page");
  await page.evaluate(() => window.open(location.href));
  const pageB = await popupPromise;
  scenarioHPopup = pageB;
  await blockAdmission(pageB);
  // Same session + send-readiness guards as tab A (the prune match is
  // same-session + same-text).
  await expect(pageB.locator(".msg").first()).toBeVisible({ timeout: 20_000 });
  await expect(pageB.locator(".composer .agent-select .vh-select-label")).toHaveText(/@/, {
    timeout: 10_000,
  });
  // The COPY actually happened — otherwise this scenario is vacuous (a
  // different-clientId tab would never enter the cross-eval branch at all).
  const [idA, idB] = await Promise.all([
    page.evaluate(() => sessionStorage.getItem("vh-solara-outbox-client")),
    pageB.evaluate(() => sessionStorage.getItem("vh-solara-outbox-client")),
  ]);
  expect(idB, "sessionStorage was copied into the opener-created tab").toBe(idA);
  expect(idB).toBe(recA.clientId);

  // Tab B saves the SAME session + SAME text gesture: REAL saveGesture →
  // REAL put through REAL IDB → pruneSupersededOwnTab finds tab A's record
  // (same clientId — the copy) under a DIFFERENT nonce → the cross-eval
  // uncontested-claim gate runs over the REAL channel.
  const composerB = pageB.getByPlaceholder("Message…");
  await composerB.fill(text);
  await composerB.press("Enter");
  // WAIT STRATEGY (timing honesty): poll the IDB state until the clone's
  // record EXISTS (the put committed — the prune scan follows inside the
  // same saveGesture), then a bounded 400ms settle window > CLAIM_WAIT_MS
  // (120ms) + margin for the gate verdict to land, then assert — never a
  // bare sleep as the only gate.
  await expect
    .poll(async () => {
      const recs = await readOutbox(page);
      return recs.filter((r) => (r as any).payload?.text === text).length;
    }, { timeout: 8000 })
    .toBe(2);
  await page.waitForTimeout(400);
  const recs = (await readOutbox(page)).filter((r) => (r as any).payload?.text === text) as any[];
  expect(recs).toHaveLength(2);
  const recB = recs.find((r) => r.intentId !== intentA)!;
  expect(recB.status).toBe("saved");
  expect(recB.clientId, "the clone writes under the COPIED tab identity").toBe(recA.clientId);
  expect(recB.bootNonce).toBeTruthy();
  expect(recB.bootNonce, "the clone is a DIFFERENT page evaluation").not.toBe(recA.bootNonce);
  // COEXISTENCE — the conservative skip: tab A's original record SURVIVED the
  // clone's prune scan (this assertion fails in the gate-less world, where
  // the clone deletes the live opener's record).
  const survived = recs.find((r) => r.intentId === intentA);
  expect(survived?.status).toBe("saved");
  // No delete of A's record happened at all: still exactly the two records.
  expect((await readOutbox(page)).filter((r) => (r as any).payload?.text === text)).toHaveLength(2);

  // The handshake genuinely traversed the REAL channel: the clone asked
  // who-has and the live opener's permanent module listener answered 'mine'
  // (the objection — proof this is the objected skip, not the timeout skip).
  const log = (await page.evaluate(() => (window as any).__bcLog)) as Array<{
    type?: string;
    id?: string;
  }>;
  const whoHas = log.find((e) => e.type === "who-has" && e.id === recA.clientId);
  const mine = log.find((e) => e.type === "mine" && e.id === recA.clientId);
  expect(whoHas, "the clone's cross-eval prune posted who-has on the real channel").toBeTruthy();
  expect(mine, "the live opener's permanent listener objected ('mine')").toBeTruthy();

  // NON-VACUOUS interception: both tabs' admission POSTs really were aborted.
  expect(abortedPosts).toBeGreaterThanOrEqual(2);
  // No queue churn whatsoever.
  expect(await listQueue(request)).toHaveLength(0);

  // Hygiene: close tab B deterministically, and remove BOTH demo-session
  // `saved` records (this spec's own reconcile would otherwise eventually
  // re-admit them after the 60s age guard — see deleteOutboxRecords).
  await pageB.close();
  scenarioHPopup = null;
  await deleteOutboxRecords(page, [intentA, recB.intentId]);
  expect(await page.evaluate(() => (window as any).__reloadCount)).toBe(0);
});

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

test.afterEach(async ({ request }) => {
  await cleanQueue(request);
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

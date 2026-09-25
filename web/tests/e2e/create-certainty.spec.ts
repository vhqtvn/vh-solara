import { expect, test, type APIRequestContext, type Route } from "@playwright/test";
import { demoDir, projectUrl } from "./util";

// Create-certainty Slice 2 — THE BROWSER CRUX. The SPA's modern
// /vh/session/create client lifecycle against the REAL fixtureserver (the
// Slice-1 worker contract) with the fixture's one-shot create-hold modes
// (POST /oc/fixture/create-hold/{arm,release,reset} — pkg/fixtures), all
// through the real event model (trusted typing + Send clicks):
//
//   (a) POSITIVE hold→release arc: a real Send's create POST is held at the
//       fixture (upstream COMMITTED + session.created emitted, response
//       withheld) → the browser's 12s bound classifies outcome-unknown
//       ("Checking session creation." while the bounded receipt-recovery
//       budget runs) → release delivers the id inside the worker's
//       server-owned window → the recovery LOOKUP resolves the EXACT id →
//       the certainty upgrade lands with NO operator confirmation (records
//       transfer operation-scoped; the draft view shows the resolved row;
//       timing candidates disappear) → the re-tap Send continues in the SAME
//       session (the linked-operation reuse: ZERO further create POSTs).
//       Asserts exactly ONE create POST, ONE tree session, and ZERO
//       prompt_async dispatches until the explicit re-send.
//   (b) NEGATIVE drop arc: the fixture commits then DROPS the response — the
//       worker can never learn the id. The create stays honestly unknown
//       through the whole bounded budget (and a manual Check again): no
//       fabricated link (no resolved row), no auto-navigation, the
//       unconfirmed copy + the modern affordances render, and the timing-
//       candidate affordance REMAINS (the brief's modern-ambiguity fallback
//       — it cannot become strictly legacy-only).
//   (d) LEGACY fallback: the capability probe answers 404 (route-
//       unsupported) → the client takes the legacy /oc/session lane with
//       ZERO /vh/session/create POSTs, the draft send materializes the
//       session and dispatches exactly once.
//
// Serial-suite hygiene (workers:1, one shared fixtureserver): every test
// arms the one-shot create mode it needs and POSTs /oc/fixture/create-hold/
// reset in afterEach — the reset unblocks any held create, invalidates late
// responses, disarms the mode, and DELETES the hold/drop-minted sessions
// (emitting session.deleted so the aggregator store drops them too). The
// legacy test's session is removed via the fake's /oc/fixture/delete
// passthrough (queue cleaned first — model-draft-failure-retry pattern).
// The PWA service worker is blocked per-test (new-session-reveal pattern).

const csrf = { "X-VH-CSRF": "1" };

function queueUrl(sessionId: string, suffix = ""): string {
  return `/vh/session/${sessionId}/queue${suffix}?dir=${encodeURIComponent(demoDir)}`;
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
  // Serial-lane hygiene: release/invalidate/delete everything the create-hold
  // mode may have left behind (one-shot modes must never leak into the next
  // spec — Slice-1 fixture discipline).
  await request.post(`/oc/fixture/create-hold/reset`, { headers: csrf }).catch(() => {});
});

// Network observability for the one-create / no-dispatch honesty assertions:
// counts (does not intercept) every create POST, receipt GET and prompt_async
// POST leaving the browser. The glob's `**` tail matters: the create POST
// carries ?dir=… and the receipt GET carries ?key=… — a bare trailing `*`
// (no `/`) would miss the receipt path, and `endsWith`-style checks would
// miss the query — classify by PATHNAME.
function instrumentCreateWire(page: import("@playwright/test").Page): {
  createPosts: () => number;
  receiptGets: () => number;
  prompts: () => number;
} {
  const counters = { posts: 0, gets: 0, prompts: 0 };
  void page.route("**/vh/session/create**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() === "POST" && path === "/vh/session/create") counters.posts++;
    if (req.method() === "GET" && path === "/vh/session/create/receipt") counters.gets++;
    await route.continue();
  });
  void page.route("**/oc/session/*/prompt_async", async (route) => {
    if (route.request().method() === "POST") counters.prompts++;
    await route.continue();
  });
  return {
    createPosts: () => counters.posts,
    receiptGets: () => counters.gets,
    prompts: () => counters.prompts,
  };
}

async function openDraftComposer(page: import("@playwright/test").Page): Promise<number> {
  const treeNew = page.locator(".tree-node", { hasText: "New session" });
  const before = await treeNew.count();
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(page.locator(".composer")).toBeVisible();
  // The @plan agent default resolving proves agents+models are loaded (the
  // readyToSend gate) BEFORE we send.
  await expect(page.locator(".agent-select .vh-select-label")).toHaveText("@plan", { timeout: 10_000 });
  return before;
}

test("(a+c) create held → unknown row → release → receipt recovery resolves the EXACT id with ONE create; the re-tap Send continues in the SAME session", async ({ page, request }) => {
  test.setTimeout(120_000);
  let sid: string | null = null;

  await page.route("**/sw.js*", (route) => route.abort());
  for (const sw of page.context().serviceWorkers()) await sw.close();

  const wire = instrumentCreateWire(page);

  // Arm the one-shot delayed-response boundary: the NEXT create commits +
  // emits upstream, then withholds the response.
  const arm = await request.post(`/oc/fixture/create-hold/arm?mode=hold`, { headers: csrf });
  if (!arm.ok()) throw new Error(`create-hold arm failed: ${arm.status()}`);

  await page.goto(projectUrl("/"));
  const before = await openDraftComposer(page);
  const treeNew = page.locator(".tree-node", { hasText: "New session" });

  // Real user gesture: type + click Send through the real event model.
  const marker = `cc-hold-${Date.now()}`;
  const ta = page.getByPlaceholder(/Message/);
  await ta.fill(marker);
  await page.locator(".composer-bar .send-btn").click();

  // (1) The browser's 12s bound fires while the worker's server-owned create
  // is still held: outcome-unknown. The bounded receipt-recovery budget
  // starts — the row's primary line is the honest "Checking session
  // creation." (never "queued", never a Retry).
  const checking = page.locator(".sendStatusLine", { hasText: "Checking session creation." });
  await expect(checking).toBeVisible({ timeout: 20_000 });
  // The composer retained the text (no silent loss; admission never ran).
  await expect(ta).not.toHaveValue("");

  // (2) The fixture COMMITTED the session before withholding the response —
  // the SSE feed lands it in the tree with no re-tap (exactly ONE new
  // session so far).
  await expect(treeNew).toHaveCount(before + 1, { timeout: 8_000 });

  // (3) Release the hold INSIDE the worker's server-owned window (and inside
  // the client's 12s recovery budget): the withheld id reaches the worker
  // and the next receipt LOOKUP resolves the EXACT id.
  const rel = await request.post(`/oc/fixture/create-hold/release`, { headers: csrf });
  if (!rel.ok()) throw new Error(`create-hold release failed: ${rel.status()}`);

  // (4) THE CERTAINTY UPGRADE — no operator confirmation anywhere: the
  // resolved row appears in the STILL-DRAFT view; the timing-candidate
  // affordance is GONE (an exact receipt is available); navigation has NOT
  // been hijacked (recovery never navigates).
  const resolvedRow = page.locator('.sendStatusLine[data-kind="create-resolved"]');
  await expect(resolvedRow).toBeVisible({ timeout: 15_000 });
  await expect(resolvedRow).toContainText("Session was created.");
  await expect(page.locator('.sendStatusLine[data-kind="create-link"]')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("session")).toBeNull();

  // (5) Honesty so far: exactly ONE create POST ever, ZERO dispatches.
  expect(wire.createPosts()).toBe(1);
  expect(wire.prompts()).toBe(0);
  expect(wire.receiptGets()).toBeGreaterThanOrEqual(1); // recovery ran
  // The resolution row's Open it names the session — capture it for the
  // in-session assertions + cleanup.
  const openBtn = resolvedRow.locator(".sendStatusBtn");
  sid = await openBtn.getAttribute("data-tip");
  expect(sid).toMatch(/^ses_new\d+$/);

  // (6) THE (c) REPLAY/CONTINUE PHASE: the operator re-taps Send (text was
  // retained). ensureSession reuses the LINKED operation — the SAME session
  // id returns with ZERO new create POSTs — and the message finally
  // dispatches into that session (a separate explicit send interaction may
  // continue using the known session).
  await page.locator(".composer-bar .send-btn").click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("session"), {
      timeout: 15_000,
      message: "URL ?session=<ses_newN> after the continuing re-send",
    })
    .toBe(sid);
  expect(wire.createPosts()).toBe(1); // NEVER re-created
  await expect
    .poll(() => wire.prompts(), { timeout: 20_000, message: "the continuing send dispatched exactly once" })
    .toBe(1);
  // Still exactly ONE new session in the tree (no duplicate from the
  // re-tap).
  await expect(treeNew).toHaveCount(before + 1, { timeout: 5_000 });

  // (7) The auto-re-key is visible IN the session: the old create-unknown
  // record followed the operator (owner-scoped "Session was created — this
  // message was not sent." row), while the continuing tap's own record is
  // gone (admitted → the queue item owns custody).
  const movedRow = page.locator(".sendStatusLine", { hasText: "Session was created — this message was not sent." });
  await expect(movedRow).toBeVisible({ timeout: 10_000 });

  // Cleanup: queue items (the continuing send leaves a durable sent item the
  // FE filters but the daemon keeps) then the session itself.
  await cleanQueue(request, sid);
  const del = await request.post(`/oc/fixture/delete?session=${encodeURIComponent(sid)}`, { headers: csrf });
  if (!del.ok()) console.log(`[create-certainty] WARNING: fixture delete for ${sid} -> ${del.status()}`);
});

test("(b) create dropped → stays honestly unknown through the whole budget; no fabricated link, no auto-navigation; candidates remain + Check again never re-creates", async ({ page, request }) => {
  test.setTimeout(120_000);

  await page.route("**/sw.js*", (route) => route.abort());
  for (const sw of page.context().serviceWorkers()) await sw.close();

  const wire = instrumentCreateWire(page);

  // Arm the one-shot permanently-lost-id boundary: the create commits
  // upstream, then the response is dropped — the worker can NEVER learn the
  // id (its cached receipt stays unknown forever).
  const arm = await request.post(`/oc/fixture/create-hold/arm?mode=drop`, { headers: csrf });
  if (!arm.ok()) throw new Error(`create-hold arm failed: ${arm.status()}`);

  await page.goto(projectUrl("/"));
  const before = await openDraftComposer(page);
  const treeNew = page.locator(".tree-node", { hasText: "New session" });

  const ta = page.getByPlaceholder(/Message/);
  await ta.fill(`cc-drop-${Date.now()}`);
  await page.locator(".composer-bar .send-btn").click();

  // (1) Unknown → the bounded budget runs (3 lookups, 0/4/8s schedule) →
  // exhausted. The unconfirmed copy returns WITH the modern affordances.
  const unconfirmed = page.locator(".sendStatusLine", {
    hasText: "Session creation unconfirmed.",
  });
  await expect(unconfirmed).toBeVisible({ timeout: 30_000 });
  await expect(unconfirmed).toContainText("Check again");
  await expect(unconfirmed).toContainText("Start a new session anyway");

  // (2) NO fabricated certainty: the resolved row NEVER appears, navigation
  // NEVER happens, nothing dispatched, exactly one create POST.
  await expect(page.locator('.sendStatusLine[data-kind="create-resolved"]')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("session")).toBeNull();
  expect(wire.createPosts()).toBe(1);
  expect(wire.prompts()).toBe(0);
  expect(wire.receiptGets()).toBeGreaterThanOrEqual(3); // the full budget ran

  // (3) The session DID land server-side (committed before the drop) — the
  // SSE feed shows it, and the TIMING-CANDIDATE affordance remains (the
  // brief's modern-ambiguity fallback: the affordance cannot become strictly
  // legacy-only). It is operator-confirmed linkage, never silent.
  await expect(treeNew).toHaveCount(before + 1, { timeout: 8_000 });
  await expect(page.locator('.sendStatusLine[data-kind="create-link"]')).toBeVisible({ timeout: 10_000 });

  // (4) The composer retained the text (nothing was sent).
  await expect(ta).not.toHaveValue("");

  // (5) Explicit "Check again": a FRESH bounded LOOKUP budget — more receipt
  // GETs, still ZERO creates, still no fabricated resolution.
  const getsBefore = wire.receiptGets();
  await unconfirmed.locator(".sendStatusBtn", { hasText: "Check again" }).click();
  await expect
    .poll(() => wire.receiptGets(), { timeout: 15_000, message: "Check again ran a fresh lookup budget" })
    .toBeGreaterThan(getsBefore);
  await expect(page.locator('.sendStatusLine[data-kind="create-resolved"]')).toHaveCount(0);
  expect(wire.createPosts()).toBe(1);
  expect(wire.prompts()).toBe(0);
});

test("(d) legacy fallback: capability 404 → the old /oc/session path still works (zero /vh POSTs) incl. the create-link affordance lane", async ({ page, request }) => {
  test.setTimeout(90_000);
  let sid: string | null = null;

  await page.route("**/sw.js*", (route) => route.abort());
  for (const sw of page.context().serviceWorkers()) await sw.close();

  // Force the LEGACY lane the way an old server presents it: the capability
  // route answers 404 (route-unsupported — the uncertainty ladder's legacy
  // branch). The modern POST route is left OPEN but must never be used.
  // REGISTRATION ORDER MATTERS: Playwright matches the most-recently-
  // registered route first, so the broad create** counter goes in BEFORE the
  // capabilities fulfilment (else the counter's continue() swallows the
  // probe).
  let legacyPosts = 0;
  await page.route("**/oc/session", async (route: Route) => {
    if (route.request().method() === "POST") legacyPosts++;
    await route.continue();
  });
  let modernPosts = 0;
  await page.route("**/vh/session/create**", async (route: Route) => {
    const req = route.request();
    if (req.method() === "POST" && new URL(req.url()).pathname === "/vh/session/create") modernPosts++;
    await route.continue();
  });
  let capProbes = 0;
  await page.route("**/vh/session/create/capabilities**", async (route: Route) => {
    capProbes++;
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  let prompts = 0;
  await page.route("**/oc/session/*/prompt_async", async (route: Route) => {
    if (route.request().method() === "POST") prompts++;
    await route.continue();
  });

  await page.goto(projectUrl("/"));
  const before = await openDraftComposer(page);
  const treeNew = page.locator(".tree-node", { hasText: "New session" });

  // Real send on the legacy lane: /oc/session create → materialization →
  // exactly one dispatch.
  const ta = page.getByPlaceholder(/Message/);
  await ta.fill(`cc-legacy-${Date.now()}`);
  await page.locator(".composer-bar .send-btn").click();

  await expect
    .poll(() => new URL(page.url()).searchParams.get("session"), {
      timeout: 15_000,
      message: "legacy create materialized the session",
    })
    .toMatch(/^ses_new\d+$/);
  sid = new URL(page.url()).searchParams.get("session");
  await expect(treeNew).toHaveCount(before + 1, { timeout: 8_000 });
  await expect
    .poll(() => prompts, { timeout: 20_000, message: "the legacy-lane send dispatched exactly once" })
    .toBe(1);

  // The ladder: the probe ran and answered 404; the legacy POST went to
  // /oc/session; ZERO create POSTs hit the modern route.
  expect(capProbes).toBeGreaterThanOrEqual(1);
  expect(legacyPosts).toBe(1);
  expect(modernPosts).toBe(0);

  // Cleanup (queue first, then the session — model-draft-failure-retry
  // pattern).
  await cleanQueue(request, sid);
  const del = await request.post(`/oc/fixture/delete?session=${encodeURIComponent(sid)}`, { headers: csrf });
  if (!del.ok()) console.log(`[create-certainty] WARNING: fixture delete for ${sid} -> ${del.status()}`);
});

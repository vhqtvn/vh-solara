// Epoch-flip native auto-reconnect e2e (defer-triage Slice C — D2) — the
// real-browser crux the epoch handshake (commit 2623803) never had: no real
// browser has ever been driven through a LIVE epoch transition on NATIVE
// EventSource auto-reconnect. This is the 2026-10-31 incident shape (clients
// reconnected but never converged) turned into a regression pin.
//
// Scenario — a genuine server-side store lifetime flip with NO process
// control and NO injected EventSource drops:
//   1. Boot against a DEDICATED non-default project dir (fresh per run under
//      repo tmp/, seeded via /oc/fixture/seed-project). The fake scopes
//      session LISTINGS by directory, so sibling specs never LIST these rows
//      — but the fake's /event broadcast is NOT directory-filtered: the
//      seeded session.created (and every turn event) fans out to every live
//      aggregator, including the process-lifetime default/demo stores. The
//      afterEach cleanup therefore deletes the session through the same
//      broadcast (fixture /delete emits session.deleted, which every
//      aggregator applies immediately) and tears the dir's aggregator down,
//      so the lane's shared state is left exactly as found.
//   2. Baseline: seeded session renders. Then ONE deliberate page reload
//      (scenario setup — a client that has connected before, the incident's
//      posture): the first boot's snapshot apply persisted the store
//      lifetime (bootEpoch), so the reloaded app's stream URLs DECLARE
//      &epoch= on open (the client's side of the 2623803 handshake). The
//      in-page upgrade swap intentionally does NOT arm on an epoch-less
//      FIRST boot (tree-transport noteEpochAdvanced), so the reload is what
//      establishes the declaring posture. The declared epoch must equal the
//      dir's live store epoch (observed via the X-VH-Epoch response stamp).
//   3. POST /vh/reload-project?dir=<dir>: the daemon disposes the upstream
//      instance, STOPS the dir's aggregator (closing the store's SSE
//      subscribers → the browser's EventSources error) and deletes it; the
//      next request for that dir builds a FRESH store with a NEW epoch
//      (newEpoch) — a genuine mid-test epoch transition.
//   4. The browser's EventSource NATIVE auto-reconnect re-requests the frozen
//      URL verbatim → the server sees the STALE epoch → handshake mismatch →
//      fresh full fallback. NATIVE is pinned by construction count: the
//      first post-flip tree GET still declaring the dead epoch must arrive
//      with NO new tree EventSource construction (the same ES object's own
//      retry — a transport-level close+reconnect would have constructed a
//      replacement, and an in-page JS rebuild is a different recovery path).
//   5. Assert OUTCOME convergence, not just reconnection (the incident's
//      failure was "reconnected but never converged"): the client APPLIED a
//      snapshot whose epoch changed (the "vh-solara restarted — re-syncing…"
//      notice rendered), a post-flip prompt completes its turn with its
//      content delivered through the re-seeded SESSION stream (the reply
//      text + the fake's final "Done. Updated" chunk render in the live
//      transcript), the tree fallback re-seeded the view (the seeded row
//      still renders), no permanent Reconnecting surface, no navigation or
//      page-reload cheat, and the client finally re-declares the NEW epoch
//      on the tree stream (the upgrade swap only arms after a mid-life
//      epoch transition has been APPLIED — tree-side convergence proof).
//
// The task's optional stronger variant (proving the post-flip message-load
// kick renders COLD content) is deliberately NOT attempted: the DOM already
// holds any pre-flip transcript text (no reload happens), so visibility
// alone cannot distinguish re-delivery from persistence — an honest
// assertion would need new client instrumentation, i.e. a product change,
// which this slice forbids. The post-flip turn above already proves the
// re-seeded streams DELIVER.

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const jsonCsrf = { "Content-Type": "application/json", "X-VH-CSRF": "1" };
const csrfOnly = { "X-VH-CSRF": "1" };

// Dedicated project dir: fresh per run (timestamp + pid — nothing else can
// reference it), under repo-scoped tmp/ (gitignored). MUST exist on disk:
// the daemon's queue admission writes <dir>/.vh-solara/sessions/<sid>/
// queue.json beneath it (it creates the .vh-solara subtree, not the project
// root). Derived from the spec file location (ESM — no __dirname), matching
// playwright.config.ts's own repoRoot derivation, so it never depends on
// the runner's cwd.
const specDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(specDir, "..", "..", "..");
const runRoot = path.join(repoRoot, "tmp", "epoch-flip-e2e", `run-${Date.now()}-${process.pid}`);
const projectDir = path.join(runRoot, "project");

// Hoisted so the afterEach cleanup runs even when the test body fails early.
let seededSid = "";

// The tree stream URL carries sessions= EMPTY ("sessions=&"); the session
// stream carries sessions=<id> (cascade-reconnect.spec.ts precedent).
const isTreeStreamUrl = (url: string): boolean =>
  url.includes("/vh/stream") && !/[?&]sessions=[^&]/.test(url);

const epochParamOf = (url: string): string => new URL(url).searchParams.get("epoch") || "";

test.afterEach(async ({ request }) => {
  // Leave the lane's shared state exactly as found (see header step 1):
  //   1. fixture-delete the session — emits session.deleted on the SAME
  //      unfiltered broadcast that leaked the row, so EVERY live aggregator
  //      (default + demo + this dir's) purges it immediately, not just on
  //      their reconcile ticks.
  //   2. tear this dir's aggregator down (otherwise it outlives the spec,
  //      holding the seeded row + its watchers for the rest of the suite
  //      process).
  //   3. remove the per-run tmp dir (queue.json scratch underneath it).
  // Stages are independently attempted (try/finally per stage) so a failure
  // in one never skips the others, and seededSid is reset so a run that
  // failed before seeding cannot fire a stale delete in a later iteration.
  const sidToDelete = seededSid;
  seededSid = "";
  try {
    if (sidToDelete !== "") {
      const del = await request.post(`/oc/fixture/delete?session=${sidToDelete}`, {
        headers: jsonCsrf,
        data: {},
      });
      if (!del.ok()) throw new Error(`afterEach fixture delete -> ${del.status()} ${del.statusText()}`);
    }
  } finally {
    try {
      await request.post(`/vh/reload-project?dir=${encodeURIComponent(projectDir)}`, {
        headers: csrfOnly,
      });
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  }
});

// Bounded poll for test-side (Node) state — the stream URL collector lives
// outside the page, so page.waitForFunction cannot see it. The probe returns
// a snapshot value captured at the SAME tick as the condition, so callers
// can co-observe related counters without a race window.
async function waitFor<T>(
  page: Page,
  probe: () => T | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await page.waitForTimeout(150);
  }
}

// The dir's live store epoch, observed via the X-VH-Epoch stamp every /vh/*
// response carries for the dir-resolved aggregator (server stampMeta).
async function epochOf(request: APIRequestContext): Promise<string> {
  const resp = await request.get("/vh/version", {
    headers: { "x-opencode-directory": projectDir },
  });
  expect(resp.ok(), "GET /vh/version").toBeTruthy();
  const e = resp.headers()["x-vh-epoch"] || "";
  expect(e, "x-vh-epoch header present").not.toBe("");
  return e;
}

test("live epoch flip via reload-project converges on native EventSource auto-reconnect", async ({
  page,
  context,
  request,
}) => {
  // Fail-safe diagnosis bound, deliberately BELOW the summed per-step
  // ceilings (~240s worst case): if convergence genuinely stalls, the plain
  // timeout names the stalled step rather than letting the scenario drag
  // through every ceiling serially (observed runtime is ~5s).
  test.setTimeout(180_000);

  mkdirSync(projectDir, { recursive: true });

  // Seed the dedicated dir: ONE root session ("Ghost seed 1") with a real
  // fake model and an EMPTY transcript (the send gate's provably-empty
  // resolution makes the composer immediately usable — queue-delivery
  // precedent). Replace-per-dir, so even a re-run against the same dir
  // cannot double-seed; sibling specs never LIST these rows (the fake
  // scopes listings by directory — the broadcast leak is cleaned in
  // afterEach).
  const seed = await request.post("/oc/fixture/seed-project", {
    headers: jsonCsrf,
    data: { dir: projectDir, count: 1 },
  });
  expect(seed.ok(), "POST /oc/fixture/seed-project").toBeTruthy();
  const sid = ((await seed.json()) as { sessions: string[] }).sessions[0];
  expect(sid, "seeded session id").toMatch(/^ses_gseed/);
  seededSid = sid;

  // Passive instrumentation #1 (cascade-reconnect wrapper precedent, capture
  // only): count TREE EventSource constructions. The native-vs-rebuilt
  // discriminator for step 4 — the browser's own retry reuses the SAME ES
  // object, so a post-flip tree GET with no accompanying construction is
  // the native auto-reconnect signature. The CONNECTING/OPEN/CLOSED statics
  // are copied like the cascade precedent: tree-transport/session-stream
  // read them off the global in their recovery branches, and a wrapper
  // without them would silence exactly those branches under test.
  await page.addInitScript(() => {
    const w = window as unknown as { __treeEsConstructs: string[] };
    w.__treeEsConstructs = [];
    const OrigES = window.EventSource;
    const Wrapped = function (this: EventSource, url: string | URL, opts?: EventSourceInit) {
      const es = opts !== undefined ? new OrigES(url, opts) : new OrigES(url);
      const u = typeof url === "string" ? url : String(url);
      if (u.indexOf("/vh/stream") !== -1 && !/[?&]sessions=[^&]/.test(u)) {
        w.__treeEsConstructs.push(u);
      }
      return es;
    } as unknown as {
      new (url: string | URL, opts?: EventSourceInit): EventSource;
      CLOSED: number;
      OPEN: number;
      CONNECTING: number;
    };
    Wrapped.prototype = OrigES.prototype;
    const W = Wrapped as unknown as { CLOSED: number; OPEN: number; CONNECTING: number };
    W.CLOSED = OrigES.CLOSED;
    W.OPEN = OrigES.OPEN;
    W.CONNECTING = OrigES.CONNECTING;
    window.EventSource = Wrapped as unknown as typeof EventSource;
  });

  // Passive instrumentation #2: count window.location.reload calls (the
  // cascade AMEND-A7 pattern). Belt to #3 — location.reload is not a fully
  // reliable interception seam, so the authoritative no-navigation check is
  // the Node-side framenavigated sentinel below.
  await page.addInitScript(() => {
    (window as unknown as { __reloadCount: number }).__reloadCount = 0;
    const orig = window.location.reload.bind(window.location);
    (window.location as unknown as { reload: (...a: unknown[]) => void }).reload =
      function (...args: unknown[]) {
        (window as unknown as { __reloadCount: number }).__reloadCount++;
        return (orig as (...a: unknown[]) => void)(...args);
      };
  });

  // Exact-path GET /vh/stream collector (queue-delivery precedent): the
  // SPA's POST /vh/stream/probe liveness sentinel is a different request
  // and must not be mistaken for a (re)connect.
  const streamUrls: string[] = [];
  context.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === "/vh/stream") {
      streamUrls.push(r.url());
    }
  });

  // Boot into the dedicated dir with the seeded session open.
  const params = new URLSearchParams({ session: sid, dir: projectDir });
  await page.goto("/?" + params.toString());

  // --- Baseline: the view is live on the dedicated project. --------------
  await expect(page.getByText("Ghost seed 1").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByPlaceholder("Message…")).toBeVisible({ timeout: 10_000 });

  // --- The deliberate pre-flip reload (scenario setup, see header). The
  // first boot's snapshot apply wrote the store lifetime (bootEpoch); the
  // reloaded app declares it on every stream open. NOTE: page.reload() is
  // driver-driven (CDP), so it neither trips the __reloadCount wrapper nor
  // the navigation sentinel armed right after it.
  await page.reload();
  await expect(page.getByText("Ghost seed 1").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByPlaceholder("Message…")).toBeVisible({ timeout: 10_000 });

  // Passive instrumentation #3 (authoritative no-navigation check, F2-hard):
  // count MAIN-FRAME navigations from here on. Convergence must happen on
  // this living document — any later navigation (reload, redirect, href
  // change) is a recovery cheat.
  let mainFrameNavigations = 0;
  const frame = page.mainFrame();
  page.on("framenavigated", (f) => {
    if (f === frame) mainFrameNavigations++;
  });

  // --- The client's side of the handshake: the reloaded app's frozen tree
  // URL declares the CURRENT store epoch. ---------------------------------
  const upgradedUrl = await waitFor(
    page,
    () => streamUrls.find((u) => isTreeStreamUrl(u) && epochParamOf(u) !== ""),
    30_000,
    "tree stream URL declaring an epoch (post-reload boot)",
  );
  const e1 = await epochOf(request);
  expect(epochParamOf(upgradedUrl), "declared epoch == live store epoch (pre-flip)").toBe(e1);

  // Restart-notice witness: the "vh-solara restarted — re-syncing…" toast
  // auto-expires after 4s AND a live-grade landing retires it immediately,
  // so it may flash for well under a frame-budget — catch ANY render via
  // MutationObserver records (insertion-time textContent), not just live
  // innerText. Installed AFTER baseline proves the baseline never fires it.
  await page.evaluate(() => {
    const w = window as unknown as { __sawRestartToast: boolean };
    w.__sawRestartToast = false;
    const seesIt = (n: Node): boolean =>
      n instanceof HTMLElement && !!n.textContent && n.textContent.includes("vh-solara restarted");
    const look = () => {
      if (document.body && document.body.innerText.includes("vh-solara restarted")) {
        w.__sawRestartToast = true;
      }
    };
    look();
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) if (seesIt(n)) w.__sawRestartToast = true;
      }
      look();
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
  expect(
    await page.evaluate(() => (window as unknown as { __sawRestartToast: boolean }).__sawRestartToast),
    "restart notice never fired pre-flip",
  ).toBe(false);

  // --- THE FLIP: tear down this dir's aggregator (store + subscribers). --
  const urlsBeforeFlip = streamUrls.length;
  const treeEsConstructsBeforeFlip = await page.evaluate(
    () => (window as unknown as { __treeEsConstructs: string[] }).__treeEsConstructs.length,
  );
  const reload = await request.post(`/vh/reload-project?dir=${encodeURIComponent(projectDir)}`, {
    headers: csrfOnly,
  });
  expect(reload.ok(), "POST /vh/reload-project").toBeTruthy();

  // --- Native auto-reconnect carried the STALE epoch verbatim. -----------
  // The subscriber close errors the browser's tree EventSource; its OWN
  // retry re-requests the frozen URL (still declaring e1) — this GET is
  // what triggers the fresh store build + handshake mismatch fallback.
  // The construction count captured at the SAME tick is the discriminator:
  // it must be UNCHANGED (native retry of the same ES object; a
  // transport-level or in-page rebuild would have constructed a new one).
  const staleObservation = await waitFor(
    page,
    () =>
      streamUrls
        .slice(urlsBeforeFlip)
        .find((u) => isTreeStreamUrl(u) && epochParamOf(u) === e1),
    30_000,
    `post-flip reconnect whose frozen URL still declares the dead epoch ${e1}`,
  );
  expect(staleObservation).toContain("/vh/stream");
  const treeEsConstructsAtStaleGet = await page.evaluate(
    () => (window as unknown as { __treeEsConstructs: string[] }).__treeEsConstructs.length,
  );
  expect(
    treeEsConstructsAtStaleGet,
    "stale-epoch reconnect was the SAME EventSource object's native retry (no new construction)",
  ).toBe(treeEsConstructsBeforeFlip);

  // The store lifetime genuinely flipped: a fresh, different epoch.
  const e2 = await epochOf(request);
  expect(e2, "post-flip epoch differs (fresh store lifetime)").not.toBe(e1);

  // The client APPLIED a snapshot whose epoch changed e1→e2: the restart
  // notice rendered (the epochChanged latch's only consuming surface — the
  // exact user-visible announcement of the transition).
  await page.waitForFunction(
    () => (window as unknown as { __sawRestartToast: boolean }).__sawRestartToast === true,
    undefined,
    { timeout: 30_000, polling: 250 },
  );

  // --- OUTCOME convergence: a post-flip turn runs END-TO-END. ------------
  // The reply text and the fake's final "Done. Updated" chunk are SESSION-
  // stream transcript content — they render only if the re-seeded session
  // stream DELIVERS (a dead-but-open stream — the incident's shape — never
  // shows them). Tree-side re-seed is proven by the row still rendering
  // (below) and by the final E2 re-declaration (the upgrade swap only arms
  // after the E2 snapshot was APPLIED on the tree stream).
  const marker = `epoch-flip post-turn ${Date.now()}`;
  await page.getByPlaceholder("Message…").fill(marker);
  await page.keyboard.press("Enter");
  await expect(page.getByText(marker).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Done\. Updated/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Ghost seed 1").first()).toBeVisible({ timeout: 10_000 });

  // No PERMANENT reconnect surface once converged (the quiet pill only
  // renders after 1500ms of foreground hard-down; the RestartOverlay shares
  // the string — both must be absent).
  await expect(page.getByText("Reconnecting…")).toHaveCount(0, { timeout: 10_000 });

  // Honest no-navigation assertions — run AFTER the final convergence wait
  // so the sentinel covers the ENTIRE scenario: neither the in-page reload
  // wrapper nor the Node-side main-frame tracker may see any navigation
  // after scenario setup (convergence happened on this living document).
  expect(
    await page.evaluate(() => (window as unknown as { __reloadCount: number }).__reloadCount),
  ).toBe(0);
  expect(mainFrameNavigations, "no main-frame navigation after scenario setup").toBe(0);

  // The client fully re-synchronized on the NEW lifetime: the epoch-upgrade
  // machinery re-armed after the mid-life transition and rebuilt the tree
  // URL declaring e2 (a later transition or in-flight decode can re-arm the
  // 2s quiet window — hence the generous wait).
  await waitFor(
    page,
    () => streamUrls.find((u) => isTreeStreamUrl(u) && epochParamOf(u) === e2),
    30_000,
    `tree stream URL declaring the new epoch ${e2} (post-flip epoch-upgrade)`,
  );
  // The sentinel's final reading, after the last convergence phase too.
  expect(mainFrameNavigations, "no main-frame navigation through final convergence").toBe(0);
});

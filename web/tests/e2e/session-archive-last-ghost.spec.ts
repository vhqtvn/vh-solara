import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

// F1 browser half — the archive-to-zero GHOST ROW, pinned end-to-end through
// the REAL UI gesture, the REAL /vh/archive cascade, and the REAL tree stream.
//
// Background (commit 514ff2c): archiving a project's LAST live session must
// remove its sidebar row with NO reload. Two independent mechanisms guarantee
// that, and this spec pins BOTH in the real browser:
//
//   1. NATURAL path — the server cascade's node.remove on the LIVE tree
//      stream (plus the client's eager prune on the /vh/archive response).
//      → Test 1.
//   2. RACY path (the F1 crux) — the tree stream is DEAD when the cascade
//      emits node.remove, so the frame is LOST. The reconnect's bootstrap
//      tree.snapshot (nodes: [] once the project is empty) must reseed the
//      stale treeMap and clear the ghost.
//      → Test 2.
//
// WHY TEST 2 NEEDS AN OBSERVER PAGE: archiveSession (web/src/archive.ts)
// runs an EAGER client-side prune on its own POST response
// (pruneSessionDeleted → removeTreeNode) — the page that CLICKED Archive can
// never ghost post-514ff2c. The ghost is only observable on a DIFFERENT view
// of the same project whose tree stream died: it receives no eager prune (it
// never POSTed) and no node.remove (its socket is a client-side stub), so its
// treeMap goes stale — exactly the operator scenario F1 described (reconnect
// racing the server's async cascade). The ACTOR page keeps its tree stream
// dead too, which additionally pins the eager prune as the actor's own
// defense-in-depth (see the P1 asserts in Test 2 — this is also the assert the
// red-check on the reconcile.ts wiring turns red).
//
// ISOLATION (settled lane-6 fact): archiving the SHARED demo dir to zero is
// unrecoverable in-lane (the fake's PATCH only sets time.archived,
// /fixture/reset never clears f.archived, /vh/unarchive is guard-refused in
// this topology, and the store's 30s tombstone blocks reinsertion) — that is
// why session-archive-hold.spec.ts never confirms an archive. Both tests here
// seed a DEDICATED throwaway project dir via POST /oc/fixture/seed-project
// (pkg/fixtures/opencode.go handleFixtureSeedProject): fresh session ids per
// call, dir-scoped, fully independent of the shared demo dir, so archiving it
// to empty poisons nothing. Each test uses its OWN dir (and mints fresh ids
// per run), making them order-independent and --repeat-each safe — a
// deliberate deviation from a shared-dir variant, which would couple the two
// tests' lifecycles for no benefit in the serial lane.
//
// NO page.reload() appears anywhere in this file: every removal/heal assert
// is a live-DOM observation.

// ─── fixture plumbing ────────────────────────────────────────────────────────

// State-changing requests through the web server (the /oc proxy included)
// are wrapped by csrfGuard: unsafe methods without the header 403 — same
// convention as the lane's other fixture POSTs (send-reliability.spec.ts:42).
const csrf = { "X-VH-CSRF": "1" };

// Seed a dedicated project dir with count live ROOT sessions and return their
// ids in creation order (oldest first). Goes through the real /oc proxy to the
// fake's emitter path (session.created), so the aggregator store + tree emitter
// project the rows exactly like real sessions.
async function seedProject(request: APIRequestContext, dir: string, count: number): Promise<string[]> {
  const res = await request.post("/oc/fixture/seed-project", { data: { dir, count }, headers: csrf });
  if (!res.ok()) {
    throw new Error(`seedProject: POST /oc/fixture/seed-project -> ${res.status()} ${res.statusText()}`);
  }
  const body = (await res.json()) as { sessions?: string[] };
  if (!body.sessions || body.sessions.length !== count) {
    throw new Error(`seedProject: bad response ${JSON.stringify(body)}`);
  }
  return body.sessions;
}

// The dedicated dir for one test run. Non-existent on disk (nothing writes
// there — it only scopes the tree), unique per run so repeat-each reruns never
// collide with a prior run's 30s store tombstone.
function freshDir(label: string): string {
  return `/work/ghost-${label}-${Date.now()}`;
}

// Mirrors tree2-parity.spec.ts: tree populated + no busy sessions.
async function waitForTreeSettled(page: Page): Promise<void> {
  await expect(page.locator(".tree-row").first()).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".tree-twisty.running")).toHaveCount(0, { timeout: 10000 });
}

// ─── archive gesture (real UI path) ──────────────────────────────────────────

// Archive a session through the REAL gesture chain: select the row, right-click
// the chat header title, tap Archive… (a plain click is a tap — the recoverable
// Archive confirm, NOT the long-press Delete), confirm. Resolves only after the
// POST /vh/archive response is observed 200 and the dialog has closed.
// Locators mirror session-archive-hold.spec.ts (proven) exactly.
async function archiveViaMenu(page: Page, sid: string): Promise<void> {
  await page.locator(`.tree-node[data-session-id="${sid}"]`).click();
  await expect(page.locator(".main-title.has-menu")).toBeVisible({ timeout: 8000 });
  await page.locator(".main-title.has-menu").click({ button: "right" });
  const menu = page.locator(".ctxm-menu");
  await expect(menu).toBeVisible();
  // Plain click = tap (<450ms) → Archive confirm. Never .click({delay:500}) —
  // that is the Delete gesture.
  await menu.getByText("Archive…").click();
  const confirm = page.getByRole("dialog", { name: "Confirm archive" });
  await expect(confirm).toBeVisible();
  // /vh/archive (POST) — the method filter keeps /vh/archived GETs out.
  const respP = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes("/vh/archive"),
    { timeout: 10000 },
  );
  await confirm.locator(".confirm-go").click();
  const resp = await respP;
  expect(resp.status(), `POST /vh/archive for ${sid}`).toBe(200);
  await expect(confirm).toHaveCount(0, { timeout: 5000 });
}

// ─── EventSource orchestration (extend of session-completion's probe) ────────

// installGhostProbe wraps EventSource (addInitScript — before any app code)
// with the tree-stream controls Test 2 needs. Evolves the proven
// installReconnectProbe pattern (session-completion.spec.ts:1071-1142):
//
//   __vhTreeFrames        — every tree.snapshot / tree.op frame delivered to
//                           THIS page's real tree stream (type + raw data).
//   __vhSuppressTreeES    — while true, tree-stream constructions return a
//                           client-side STUB (EventTarget, readyState pinned to
//                           CONNECTING, close() → CLOSED): no socket exists,
//                           so server tree frames are LOST BY CONSTRUCTION and
//                           the only possible heal is the next REAL stream's
//                           bootstrap snapshot. The app's connect() called
//                           markTreeSeen() on the stub, so the 45s watchdog
//                           (STALE_MS) cannot race the test's ghost window.
//   __vhKillTreeES()      — close the page's REAL tree ES + dispatch a synthetic
//                           error → the app's own onerror CLOSED branch
//                           schedules the backoff connect() that lands on the
//                           stub (proven __vhForceTreeReconnect mechanics).
//   __vhReviveDeadTreeES() — close + error the STUB the same way → the app
//                           reconnects; with suppression cleared the new
//                           construction is a REAL EventSource whose bootstrap
//                           (ring replay + fresh tree.snapshot — C-F1,
//                           pkg/web/tree_resume_detail_test.go) is the heal.
//   __vhForceTreeReconnect() — the original probe's forced reconnect on the
//                           current real ES (no-resurrection phase).
//
// The statics are re-exported because the app compares
// `es.readyState === EventSource.CLOSED` against window.EventSource (this
// wrapper) — the established mandatory discipline.
async function installGhostProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    w.__vhTreeFrames = [];
    w.__vhSuppressTreeES = false;
    w.__vhDeadTreeES = null;
    w.__vhTreeES = null;
    const OrigES = w.EventSource;
    function ProbeES(url: string, opts?: any) {
      const u = typeof url === "string" ? url : "";
      const isTree = u.indexOf("sessions=&") !== -1 && u.indexOf("tree=2") !== -1;
      if (isTree && w.__vhSuppressTreeES) {
        // Dead-stream stub: a plain EventTarget with an EventSource-ish shape.
        // readyState stays CONNECTING (0) so the app's watchdog sees an
        // in-flight connect (isTreeClosed false; transport-stale needs 45s).
        // on* property assignments are bridged into real listeners so a
        // dispatched "error" reaches the app's onerror exactly like a native
        // EventSource's would.
        const stub: any = new EventTarget();
        stub.readyState = 0;
        stub.close = () => {
          stub.readyState = 2; // CLOSED
        };
        for (const ty of ["open", "message", "error"]) {
          let h: any = null;
          Object.defineProperty(stub, "on" + ty, {
            configurable: true,
            get: () => h,
            set: (fn: any) => {
              if (h) stub.removeEventListener(ty, h);
              h = fn;
              if (typeof fn === "function") stub.addEventListener(ty, fn);
            },
          });
        }
        w.__vhDeadTreeES = stub;
        return stub;
      }
      const es = opts !== undefined ? new OrigES(url, opts) : new OrigES(url);
      if (isTree) {
        w.__vhTreeES = es;
        // Frame recorder: forward synchronously (no holding — unlike the
        // orphan probe we never delay delivery, only observe).
        const origAdd = es.addEventListener.bind(es);
        es.addEventListener = function (type: any, listener: any, options: any) {
          return origAdd(
            type,
            (ev: any) => {
              if (type === "tree.snapshot" || type === "tree.op") {
                w.__vhTreeFrames.push({ type, data: (ev && ev.data) || "" });
              }
              if (typeof listener === "function") listener(ev);
              else if (listener) listener.handleEvent(ev);
            },
            options,
          );
        };
      }
      return es;
    }
    ProbeES.prototype = OrigES.prototype;
    ProbeES.CLOSED = OrigES.CLOSED;
    ProbeES.OPEN = OrigES.OPEN;
    ProbeES.CONNECTING = OrigES.CONNECTING;
    w.EventSource = ProbeES;
    w.__vhKillTreeES = () => {
      const es = w.__vhTreeES;
      if (!es || es.readyState !== 1) return false;
      es.close();
      es.dispatchEvent(new Event("error"));
      return true;
    };
    w.__vhReviveDeadTreeES = () => {
      const stub = w.__vhDeadTreeES;
      if (!stub) return false;
      stub.close(); // readyState → CLOSED (the branch onerror gates on)
      stub.dispatchEvent(new Event("error")); // → app's backoff connect()
      return true;
    };
    w.__vhForceTreeReconnect = () => {
      const es = w.__vhTreeES;
      if (!es || es.readyState !== 1) return false;
      es.close();
      es.dispatchEvent(new Event("error"));
      return true;
    };
  });
}

// Kill the page's live tree stream and wait until the app's backoff connect()
// has produced the suppressed STUB (proves the tree stream is now dead before
// the test proceeds — no real socket exists from here on).
async function suppressTreeStream(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__vhSuppressTreeES = true;
    (window as any).__vhKillTreeES();
  });
  await page.waitForFunction(() => (window as any).__vhDeadTreeES != null, null, { timeout: 10000 });
}

// ─── Test 1: the natural path ────────────────────────────────────────────────

test("archive removes the session's tree row live (natural path, no reload)", async ({ page, request }) => {
  const dir = freshDir("nat");
  const [a, b] = await seedProject(request, dir, 2);
  await page.goto("/?dir=" + encodeURIComponent(dir));
  await waitForTreeSettled(page);
  await expect(page.locator(`.tree-node[data-session-id="${a}"]`)).toBeVisible();
  await expect(page.locator(`.tree-node[data-session-id="${b}"]`)).toBeVisible();

  await archiveViaMenu(page, a);

  // CRUX (auto-retrying): the row disappears WITHOUT any reload — via the
  // eager prune and/or the live stream's node.remove, whichever lands first.
  await expect(page.locator(`.tree-node[data-session-id="${a}"]`)).toHaveCount(0, { timeout: 10000 });
  // The sibling survives; the tree is NOT emptied (one live session remains).
  await expect(page.locator(`.tree-node[data-session-id="${b}"]`)).toBeVisible();
  await expect(page.locator(".tree-empty")).toHaveCount(0);
});

// ─── Test 2: the racy path (F1 crux) ─────────────────────────────────────────

test("archive of the LAST live session on a dead tree stream ghosts on an observer; the reconnect's empty tree.snapshot heals it; no resurrection", async ({ page: p1, request, browser }) => {
  test.setTimeout(120_000);
  const dir = freshDir("racy");
  const [a, b] = await seedProject(request, dir, 2);

  // P1 (actor) — the page that will perform both archives.
  await installGhostProbe(p1);
  await p1.goto("/?dir=" + encodeURIComponent(dir));
  await waitForTreeSettled(p1);
  await expect(p1.locator(`.tree-node[data-session-id="${a}"]`)).toBeVisible();
  await expect(p1.locator(`.tree-node[data-session-id="${b}"]`)).toBeVisible();

  // Step 1: archive A while every stream is live, so B becomes the project's
  // LAST live session (asserted on the actor via the natural path).
  await archiveViaMenu(p1, a);
  await expect(p1.locator(`.tree-node[data-session-id="${a}"]`)).toHaveCount(0, { timeout: 10000 });
  await expect(p1.locator(`.tree-node[data-session-id="${b}"]`)).toBeVisible();

  // P2 (observer) — a SEPARATE browser context (own localStorage, own
  // sockets): a second operator view of the same project that never POSTs.
  // It loads AFTER A's archive, so its bootstrap shows exactly one live row.
  const p2ctx = await browser.newContext();
  const p2 = await p2ctx.newPage();
  await installGhostProbe(p2);
  await p2.goto("/?dir=" + encodeURIComponent(dir));
  await waitForTreeSettled(p2);
  await expect(p2.locator(`.tree-node[data-session-id="${a}"]`)).toHaveCount(0);
  await expect(p2.locator(`.tree-node[data-session-id="${b}"]`)).toBeVisible();

  // Step 2: kill BOTH views' tree streams (each reconnects into the stub —
  // no socket, so the upcoming cascade's node.remove is lost by construction).
  await suppressTreeStream(p2);
  await suppressTreeStream(p1);
  // Frame baseline on the observer: everything recorded after this index
  // belongs to the heal stream.
  const frameBaseline: number = await p2.evaluate(() => (window as any).__vhTreeFrames.length);

  // Step 3: archive B — the LAST live session — via the REAL gesture on the
  // actor, tree stream dead.
  await archiveViaMenu(p1, b);

  // ACTOR defense-in-depth pin: the actor's own row disappears even with its
  // tree stream dead — archiveSession's eager prune (removeTreeNode in
  // reconcile.ts interpretEffects) is the only stream-independent removal.
  // This is the assert the red-check on the reconcile wiring turns red; the
  // actor's project is now at ZERO live sessions, so the empty-tree fallback
  // renders.
  await expect(p1.locator(`.tree-node[data-session-id="${b}"]`)).toHaveCount(0, { timeout: 10000 });
  await expect(p1.locator(".tree-empty")).toBeVisible({ timeout: 10000 });

  // Step 4: GHOST PRECONDITION on the observer. The POST resolved 200 and the
  // single-root cascade (loopback PATCH + RemoveSessions emits — wire contract
  // pinned by tests/e2e/tree_archive_zero_test.go) completes in milliseconds;
  // 2s is >100x that margin. P2 has no eager prune (it never POSTed) and no
  // socket (the stub), so its treeMap is stale and B's row persists.
  await p2.waitForTimeout(2000);
  await expect(p2.locator(`.tree-node[data-session-id="${b}"]`)).toHaveCount(1);
  await expect(p2.locator(".tree-empty")).toHaveCount(0);

  // Step 5: HEAL. Clear the suppression and force the stub to error → the
  // app's own backoff connect() builds a REAL EventSource → the server
  // replays the ring AND bootstraps a fresh tree.snapshot (C-F1) whose nodes
  // are now EMPTY for this dir.
  await p2.evaluate(() => {
    (window as any).__vhSuppressTreeES = false;
    (window as any).__vhReviveDeadTreeES();
  });

  // CRUX (auto-retrying): the ghost row disappears WITHOUT reload…
  await expect(p2.locator(`.tree-node[data-session-id="${b}"]`)).toHaveCount(0, { timeout: 15000 });
  // …the zero-rows fallback renders…
  await expect(p2.locator(".tree-empty")).toBeVisible({ timeout: 10000 });
  // …and the heal really came through a NEW stream whose bootstrap
  // tree.snapshot carried an EMPTY nodes array (raw, not gzip64 — an empty
  // dir's snapshot is far under the 2 KiB compression threshold).
  const framesAfter: Array<{ type: string; data: string }> = await p2.evaluate(
    (base: number) => (window as any).__vhTreeFrames.slice(base),
    frameBaseline,
  );
  const emptySnap = framesAfter.some((f) => {
    if (f.type !== "tree.snapshot") return false;
    try {
      const parsed = JSON.parse(f.data);
      return !parsed.encoding && Array.isArray(parsed.nodes) && parsed.nodes.length === 0;
    } catch {
      return false;
    }
  });
  expect(emptySnap, `expected an empty-nodes tree.snapshot among ${framesAfter.length} recorded frames`).toBe(true);

  // Step 6: NO RESURRECTION across a further reconnect. Force the healed
  // stream to reconnect and wait for its NEXT bootstrap frame (the at-head
  // resume still bootstraps — C-F1); the tombstoned session must not come
  // back and the tree must stay empty.
  await p2.waitForFunction(() => {
    const es = (window as any).__vhTreeES;
    return !!es && es.readyState === 1;
  }, null, { timeout: 15000 });
  const framesBeforeForce: number = await p2.evaluate(() => (window as any).__vhTreeFrames.length);
  await p2.evaluate(() => (window as any).__vhForceTreeReconnect());
  await p2.waitForFunction(
    (n: number) => (window as any).__vhTreeFrames.length > n,
    framesBeforeForce,
    { timeout: 15000 },
  );
  await expect(p2.locator(`.tree-node[data-session-id="${b}"]`)).toHaveCount(0);
  await expect(p2.locator(".tree-empty")).toBeVisible();

  await p2ctx.close();
});

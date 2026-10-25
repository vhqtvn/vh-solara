import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { projectUrl, resetPins } from "./util";

// Phase 7 — server-managed pinned sessions: multi-client convergence.
//
// Pins are now WORKER-OWNED durable state (Phase 4+: /vh/pins doc + SSE
// pins.snapshot/pins.updated). The defining property of server-managed state is
// that TWO browsers viewing the same worker CONVERGE: a pin/unpin/reorder in one
// reaches the other through the server, and lifecycle cleanup (archive/delete)
// removes the pin from EVERY viewer. These specs prove that end-to-end through
// real browsers against the real fixtureserver (real web.NewServer + aggregator
// + fake OpenCode, same binary `npm run test:e2e` boots via scripts/fixture-web.sh).
//
// SCENARIO → LANE MAP (honest deterministic coverage, not "force everything into
// Playwright"):
//   (a) pin in A → appears in B .................... Playwright (here)
//   (b) unpin in A → removed in B .................. Playwright (here)
//   (c) reorder in A → order syncs to B ............ Playwright (here, keyboard)
//   (d) conflicting reorder → 409 adoption ......... NOT here. A true concurrent
//        conflict is inherently racy in a browser (the UI reads the live revision
//        at click time, so two real clients almost never collide on the same
//        baseRevision). The CONTRACT is covered deterministically elsewhere:
//          - server CAS: pkg/web TestPinsHTTPPut409CASMismatch (409 returns the
//            full current doc, does NOT mutate).
//          - client adoption: web/tests/unit/sidebar-pins.test.ts ("on 409
//            discards optimistic, does NOT auto-replay"; "stale reorder NOT
//            silently replayed — adopts server doc verbatim").
//   (e) archive a pinned session → both remove .... Playwright (here, single
//        disposable session cross-client broadcast). The SUBTREE-cascade
//        mechanics (affected[] fan-out) are covered deterministically by
//        pkg/web TestPinsL1_ArchiveCascadesSubtree + TestPinsL1_ArchiveBroadcastsUpdate.
//   (f) delete a pinned session → both remove ..... Playwright (here, disposable
//        session). L2 subscriber mechanics: pkg/web TestPinsL2_SessionDeleteRemovesPin
//        / TestPinsL2_RawSessionDeletedRemovesPin / TestPinsL2_SubscriberBroadcastsUpdate.
//   (g) disconnect/reconnect → surviving pins persist  Playwright (here; reload
//        B and assert the pins.snapshot bootstrap restores the surviving pins).
//
// TEST HYGIENE: the suite is SERIAL (workers:1) over ONE shared fixtureserver
// process, so server-side pin state leaks across specs. beforeEach/afterEach
// reset the pin doc via the real /vh/pins API (resetPins) so this spec neither
// inherits nor leaks pinned state. (e)/(f) use DISPOSABLE sessions created via
// POST /oc/session — archive/delete are destructive and permanent (the fixture
// has no un-archive-for-test path), so the seeded demo/other/slow/sub sessions
// are never archived or deleted.
//
// CROSS-CLIENT CONVERGENCE BUDGET: the polls that wait for a pin mutation made
// in client A to converge in client B (and the L1/L2 lifecycle broadcasts that
// reach BOTH clients) allow 20s, not the historical 8/10s. Grounding (not a
// blind bump): a pins mutation reaches the other client ONLY as a transient
// pins.updated SSE frame (never replayed, never re-GET'd by the client). The
// transport's by-design slow-consumer path (pkg/state subscriptions.go
// EmitTransient: subscriber channel full → close + drop) means a busy
// full-suite moment can cut a client's stream at the exact frame under test;
// recovery is reconnect-based — the server's jittered SSE retry hint is
// 2–3s (pkg/web stream_http.go sseRetryHintMs) and, if the first attempts
// also fail under load, the SPA's tree stream takes over after a 3-failure
// CONNECTING streak onto its bounded manual backoff ladder 1s→2s→4s→8s→15s
// (web/src/sync/tree-transport.ts). pins.snapshot on the reconnect (emitted on
// EVERY /vh/stream connect) then restores the doc — a legitimate end-to-end
// recovery sequence that can exceed 8s. Observed once in two full-lane runs
// (2026-10-22/23: run-2 failure — B frozen at ["demo"] for the whole 8s poll,
// consistent with a reconnect recovery still in flight; the exact frame is
// unobservable post-hoc); 90/90 green across isolated 5-repeat runs, so the
// budget change waits LONGER for the SAME convergence — every assertion
// (which sessions are pinned, in which order) is unchanged.
const CONVERGE_MS = 20_000;

// ─── Recurrence diagnostics (assertion-message-only) ─────────────────────────
// This spec carries a multi-observation full-lane flake history (:151/:174/:196
// convergence polls, :305 bootstrap toBeVisible; see the 2026-10-16 regression
// sweep checkpoint + 80b569d) whose captured artifacts were lost to later green
// runs wiping the output dir. These helpers append an OBSERVABLE-STATE payload
// (rendered tree rows, pinned-group ids, expected-id presence, the legacy pins
// localStorage shadow, and the .status-mark conn-state class) to the timeout
// message of every cross-client wait — enough to adjudicate the NEXT recurrence
// (SSE-recovery tail vs render defect vs shadow miss vs boot starvation) with
// no assertion-semantics or budget change: the enriched error is the SAME error
// object, rethrown, with one [pins-diag] line appended.
async function pinsDiag(page: Page, expectId: string): Promise<Record<string, unknown>> {
  return page.evaluate((id) => {
    const nodesFor = (sel: string) =>
      Array.from(document.querySelectorAll(sel)).map((n) => (n as HTMLElement).dataset.sessionId ?? "?");
    return {
      rows: document.querySelectorAll(".tree-row").length,
      pinned: nodesFor(".tree-pinned .tree-node"),
      expectAnywhere: document.querySelectorAll(`.tree-node[data-session-id="${id}"]`).length,
      expectInBody: Array.from(document.querySelectorAll(`.tree-node[data-session-id="${id}"]`)).filter(
        (n) => !n.closest(".tree-pinned")
      ).length,
      lsPinned: localStorage.getItem("vh.pinned.v1"),
      lsOrder: localStorage.getItem("vh.pinned-order.v1"),
      conn: document.querySelector(".status-mark")?.className ?? null,
      pinErr: document.querySelector('[role="status"]')?.textContent ?? null,
      events: ((window as unknown as { __pinsJournal?: string[] }).__pinsJournal ?? []).slice(-12),
    };
  }, expectId);
}

async function withPinsDiag<T>(page: Page, label: string, expectId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    let diag: string;
    try {
      const dom = await pinsDiag(page, expectId);
      const consoleLines = (page as unknown as { __consoleLines?: string[] }).__consoleLines ?? [];
      diag = JSON.stringify({ ...dom, console: consoleLines.slice(-8) });
    } catch {
      diag = "(diag unavailable — page/context closed)";
    }
    (err as Error).message += `\n[pins-diag ${label}] ${diag}`;
    throw err;
  }
}

// Wait for the tree to populate. Unlike tree2-parity's waitForTreeSettled this
// does NOT gate on `.tree-twisty.running` count 0: in a full serial-suite run a
// PRIOR spec (e.g. layout.spec's "Working… indicator" stream test) can leave a
// session genuinely busy, and gating on global idle would couple these pin
// tests to every other spec's session state. Pin/unpin/reorder and the pinned
// group render are independent of any session's busy state, so waiting for the
// first tree row is sufficient and deterministic.
async function waitForTreeSettled(page: Page): Promise<void> {
  await expect(page.locator(".tree-row").first()).toBeVisible({ timeout: 15000 });
}

// openClient loads a fresh browser CONTEXT (a distinct client — its own SSE
// /vh/stream connection, its own Solid state) and waits for the tree to settle.
// Manually-created contexts are NOT auto-closed by Playwright; callers MUST close
// the returned handle in a finally block (a leaked context keeps a /vh/stream
// open and can perturb later broadcast assertions).
async function openClient(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Recurrence diagnostics: buffer recent console lines ([vh:*] warns/errors —
  // e.g. "PUT /vh/pins network error", stale-frame drops) for the [pins-diag]
  // payload. Record-only; no behavioral effect.
  const consoleLines: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "warning" || m.type() === "error") {
      consoleLines.push(`${m.type()}:${m.text().slice(0, 120)}`);
      if (consoleLines.length > 30) consoleLines.shift();
    }
  });
  (page as unknown as { __consoleLines?: string[] }).__consoleLines = consoleLines;
  await page.goto(projectUrl("/"));
  // Recurrence diagnostics: a PASSIVE pointer-event journal (capture-phase
  // record-only listeners; no handler changes, no behavioral effect) so a
  // failed local menu confirm can show whether the Unpin/Pin click was ever
  // DISPATCHED (and onto what element class/text). Dumped into the
  // [pins-diag] payload only on a wait timeout.
  await page.evaluate(() => {
    const w = window as unknown as { __pinsJournal?: string[] };
    w.__pinsJournal = [];
    const rec = (kind: string) => (ev: Event) => {
      const j = (window as unknown as { __pinsJournal?: string[] }).__pinsJournal;
      if (!j || j.length >= 200) return;
      const t = ev.target as HTMLElement | null;
      j.push(
        `${kind}@${Math.round(performance.now())}:${t?.className?.toString().slice(0, 40) ?? "?"}:${t?.textContent?.trim().slice(0, 20) ?? ""}`
      );
    };
    document.addEventListener("pointerdown", rec("pd"), true);
    document.addEventListener("pointerup", rec("pu"), true);
    document.addEventListener("click", rec("ck"), true);
  });
  await waitForTreeSettled(page);
  return { page, close: () => ctx.close() };
}

// pinViaMenu / unpinViaMenu — drive a pin-membership mutation through the real
// context menu and confirm it LOCALLY (in THIS client's .tree-pinned group).
//
// MECHANISM NOTE (2026-10-25 verdict drive, run-4 journal): under full-lane
// load a client's pin state can transiently EVANESCE — a stream sever +
// reconnect whose pins.snapshot was captured before the in-flight PUT commit
// resets the adopted base (snapshots are always-adopted). The context menu
// reactively RELABELS its item ("Unpin" ⇄ "Pin to top") inside Playwright's
// actionability window, so the dispatched click can carry the INVERTED intent
// (observed: click dispatched onto "Pin to top" 246ms after the menu opened
// labeled "Unpin" → the unpin became a re-pin → the 5s local confirm timed
// out on a stable pin). This is a click-integrity race, not a convergence
// budget problem — so the fix re-dispatches the INTENDED mutation (what a
// user re-clicking after a UI flicker does) instead of waiting longer. The
// per-attempt assertion and its 5000ms budget are UNCHANGED; retries only
// fire when the dispatched mutation observably failed to land, and the
// attempt history is reported in the final error / stdout.
async function setPinnedViaMenu(
  page: Page,
  sessionId: string,
  wantPinned: boolean,
  confirm: (attempt: number) => Promise<void>
): Promise<void> {
  const pinnedLoc = page.locator(`.tree-pinned .tree-node[data-session-id="${sessionId}"]`);
  const attempts: string[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      const node = (
        wantPinned
          ? page.locator(`.tree-node[data-session-id="${sessionId}"]`)
          : pinnedLoc
      ).first();
      await node.click({ button: "right", timeout: 5000 });
      await expect(page.locator(".ctxm-menu")).toBeVisible();
      // Click the item for the intent we WANT. If the label flipped mid-click
      // (the relabel race above), the dispatch lands the inverted intent and
      // the confirm below fails — re-dispatch, bounded.
      await page
        .locator(".ctxm-item", { hasText: wantPinned ? "Pin to top" : "Unpin" })
        .click({ timeout: 5000 });
      await confirm(attempt);
      if (attempt > 1) {
        console.log(
          `[pins-e2e] ${wantPinned ? "pin" : "unpin"}ViaMenu landed on attempt ${attempt} (earlier attempt(s) inverted/flickered)`
        );
      }
      return;
    } catch (err) {
      attempts.push(`attempt${attempt}`);
      if (attempt >= 3) {
        (err as Error).message += `\n[pins-menu] intent=${wantPinned ? "pin" : "unpin"} re-dispatched (${attempts.join(",")}) without landing`;
        throw err;
      }
      // Already in the wantPinned state (previous attempt landed late)? Done.
      const isPinnedNow = (await pinnedLoc.count()) > 0;
      if (isPinnedNow === wantPinned) {
        console.log(
          `[pins-e2e] ${wantPinned ? "pin" : "unpin"}ViaMenu landed late after attempt ${attempt}`
        );
        return;
      }
    }
  }
}

async function pinViaMenu(page: Page, sessionId: string): Promise<void> {
  await setPinnedViaMenu(page, sessionId, true, (attempt) =>
    withPinsDiag(page, `pinViaMenu local confirm (attempt ${attempt})`, sessionId, () =>
      expect(
        page.locator(`.tree-pinned .tree-node[data-session-id="${sessionId}"]`)
      ).toBeVisible({ timeout: 5000 })
    )
  );
}

// unpinViaMenu — right-click a PINNED session (in the pinned group) and choose
// "Unpin". Waits for the pin to leave THIS client's .tree-pinned group. See
// setPinnedViaMenu's MECHANISM NOTE for the re-dispatch rationale.
async function unpinViaMenu(page: Page, sessionId: string): Promise<void> {
  await setPinnedViaMenu(page, sessionId, false, (attempt) =>
    withPinsDiag(page, `unpinViaMenu local confirm (attempt ${attempt})`, sessionId, () =>
      expect(
        page.locator(`.tree-pinned .tree-node[data-session-id="${sessionId}"]`)
      ).toHaveCount(0, { timeout: 5000 })
    )
  );
}

// pinnedOrder returns the ordered list of pinned session ids as rendered in the
// DOM (.tree-pinned children in document order). This is the observable shape of
// the server's orderedSessionIds after reconcile + render.
async function pinnedOrder(page: Page): Promise<string[]> {
  return page.locator(`.tree-pinned .tree-node`).evaluateAll((nodes) =>
    nodes.map((n) => (n as HTMLElement).dataset.sessionId ?? "")
  );
}

// createDisposableSession creates a fresh never-opened root session via the raw
// /oc/session passthrough (the fake OpenCode's /session handler). Used by (e)/(f)
// so the destructive archive/delete never touches a seeded session. Emits a
// session.upsert that both browsers render in their trees.
async function createDisposableSession(request: APIRequestContext): Promise<string> {
  const res = await request.post("/oc/session", {
    headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
    data: {},
  });
  if (!res.ok()) {
    throw new Error(`createDisposableSession: POST /oc/session -> ${res.status()} ${res.statusText()}`);
  }
  const body = await res.json();
  if (!body?.id) throw new Error("createDisposableSession: POST /oc/session returned no id");
  return body.id as string;
}

test.beforeEach(async ({ request }) => {
  await resetPins(request);
});
test.afterEach(async ({ request }) => {
  await resetPins(request);
});

// ─── (a) pin in A → appears in B ─────────────────────────────────────────────
test("(a) pinning a session in client A appears in client B", async ({ browser }) => {
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    // Sanity: `other` is unpinned in both before the action.
    await expect(a.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)).toHaveCount(0);
    await expect(b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)).toHaveCount(0);

    await pinViaMenu(a.page, "other");

    // B converges via pins.updated SSE: the pin hoists `other` into B's
    // .tree-pinned group too.
    await withPinsDiag(b.page, "(a) B pin convergence", "other", () =>
      expect(
        b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)
      ).toBeVisible({ timeout: CONVERGE_MS })
    );
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (b) unpin in A → removed in B ───────────────────────────────────────────
test("(b) unpinning a session in client A removes it in client B", async ({ browser }) => {
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    // Establish the shared pin first (A pins, B converges).
    await pinViaMenu(a.page, "other");
    await withPinsDiag(b.page, "(b) B establish convergence", "other", () =>
      expect(
        b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)
      ).toBeVisible({ timeout: CONVERGE_MS })
    );

    // A unpins; B must follow.
    await unpinViaMenu(a.page, "other");

    await withPinsDiag(b.page, "(b) B unpin convergence", "other", () =>
      expect(
        b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)
      ).toHaveCount(0, { timeout: CONVERGE_MS })
    );
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (c) reorder in A → order syncs to B ─────────────────────────────────────
test("(c) reordering pinned sessions in A syncs the new order to B", async ({ browser }) => {
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    // Pin two ROOTS (Move up/down are gated to pinned roots only). Insertion
    // order → server orderedSessionIds = [demo, other].
    await pinViaMenu(a.page, "demo");
    await pinViaMenu(a.page, "other");

    // Both clients converge to [demo, other].
    await expect.poll(async () => await pinnedOrder(a.page), { timeout: 8000 }).toEqual(["demo", "other"]);
    await withPinsDiag(b.page, "(c) B establish order", "other", () =>
      expect.poll(async () => await pinnedOrder(b.page), { timeout: CONVERGE_MS }).toEqual(["demo", "other"])
    );

    // Reorder in A: right-click `other` (currently last) → "Move up". This fires
    // movePinnedByOffset(other, -1) → server reorders to [other, demo].
    const otherPinned = a.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`).first();
    await otherPinned.click({ button: "right" });
    await expect(a.page.locator(".ctxm-menu")).toBeVisible();
    await a.page.locator(".ctxm-item", { hasText: "Move up" }).click();

    // A adopts its own successful reorder...
    await expect.poll(async () => await pinnedOrder(a.page), { timeout: 8000 }).toEqual(["other", "demo"]);
    // ...and B converges to the SAME server order via pins.updated.
    await withPinsDiag(b.page, "(c) B reorder order", "other", () =>
      expect.poll(async () => await pinnedOrder(b.page), { timeout: CONVERGE_MS }).toEqual(["other", "demo"])
    );
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (e) archive a pinned session → both clients remove it ───────────────────
test("(e) archiving a pinned disposable session removes it in both clients", async ({ request, browser }) => {
  const id = await createDisposableSession(request);
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    // The new session fans out via session.upsert; wait for it in both trees.
    await expect(a.page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({ timeout: 10000 });
    await expect(b.page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({ timeout: 10000 });

    // Pin it in A; B converges.
    await pinViaMenu(a.page, id);
    await withPinsDiag(b.page, "(e) B pin convergence", id, () =>
      expect(
        b.page.locator(`.tree-pinned .tree-node[data-session-id="${id}"]`)
      ).toBeVisible({ timeout: CONVERGE_MS })
    );

    // Archive via the real /vh/archive path (the L1 cleanup hook runs on its
    // success). The response returns before the async cascade completes, so we
    // poll for the broadcast below.
    const res = await request.post("/vh/archive", {
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      data: { sessionID: id },
    });
    expect(res.ok()).toBe(true);

    // The L1 archive hook (removePinsAndBroadcast) fans out pins.updated → the
    // pin is removed from BOTH clients. (Subtree-cascade mechanics for a parent
    // with descendants are covered deterministically by pkg/web
    // TestPinsL1_ArchiveCascadesSubtree; this is the single-session cross-client
    // broadcast slice.)
    await withPinsDiag(a.page, "(e) A archive broadcast removal", id, () =>
      expect(
        a.page.locator(`.tree-pinned .tree-node[data-session-id="${id}"]`)
      ).toHaveCount(0, { timeout: CONVERGE_MS })
    );
    await withPinsDiag(b.page, "(e) B archive broadcast removal", id, () =>
      expect(
        b.page.locator(`.tree-pinned .tree-node[data-session-id="${id}"]`)
      ).toHaveCount(0, { timeout: CONVERGE_MS })
    );
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (f) delete a pinned session → both clients remove it ────────────────────
test("(f) deleting a pinned disposable session removes it in both clients", async ({ request, browser }) => {
  const id = await createDisposableSession(request);
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    await expect(a.page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({ timeout: 10000 });
    await expect(b.page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({ timeout: 10000 });

    await pinViaMenu(a.page, id);
    await withPinsDiag(b.page, "(f) B pin convergence", id, () =>
      expect(
        b.page.locator(`.tree-pinned .tree-node[data-session-id="${id}"]`)
      ).toBeVisible({ timeout: CONVERGE_MS })
    );

    // Delete via the fake OpenCode's /fixture/delete, reached through the web
    // server's /oc/ passthrough (NOT the bare /fixture/delete form, which hits
    // the static handler and silently no-ops). The fake emits session.deleted →
    // the aggregator → the L2 subscriber → removePinsAndBroadcast → pins.updated.
    const res = await request.post(`/oc/fixture/delete?session=${encodeURIComponent(id)}`, {
      headers: { "X-VH-CSRF": "1" },
    });
    expect(res.ok()).toBe(true);

    // L2 cleanup broadcasts to BOTH clients.
    await withPinsDiag(a.page, "(f) A delete broadcast removal", id, () =>
      expect(
        a.page.locator(`.tree-pinned .tree-node[data-session-id="${id}"]`)
      ).toHaveCount(0, { timeout: CONVERGE_MS })
    );
    await withPinsDiag(b.page, "(f) B delete broadcast removal", id, () =>
      expect(
        b.page.locator(`.tree-pinned .tree-node[data-session-id="${id}"]`)
      ).toHaveCount(0, { timeout: CONVERGE_MS })
    );
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (g) disconnect/reconnect → surviving pins persist ───────────────────────
test("(g) a reconnecting client receives surviving pins via the bootstrap snapshot", async ({ browser }) => {
  // Load B FIRST (clean — beforeEach reset left no pins), then pin in A while B
  // is connected, then RELOAD B (tearing down + re-establishing its /vh/stream)
  // and assert B re-acquires the pin via the pins.snapshot bootstrap frame, not
  // via retained DOM. This is the reconnect-catches-up guarantee: pins are
  // server-owned, so a client that drops and reconnects is never permanently out
  // of sync.
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    await expect(b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)).toHaveCount(0);

    await pinViaMenu(a.page, "other");
    // B (still connected) sees the live update.
    await withPinsDiag(b.page, "(g) B live convergence", "other", () =>
      expect(
        b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)
      ).toBeVisible({ timeout: CONVERGE_MS })
    );

    // Reconnect B: reload tears down its SSE stream + Solid state; on reconnect
    // the server emits pins.snapshot as the bootstrap frame, which restores the
    // surviving pin.
    await b.page.reload();
    await waitForTreeSettled(b.page);
    await withPinsDiag(b.page, "(g) bootstrap snapshot restore", "other", () =>
      expect(
        b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)
      ).toBeVisible({ timeout: 10000 })
    );
  } finally {
    await a.close();
    await b.close();
  }
});

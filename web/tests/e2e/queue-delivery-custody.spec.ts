// Queue-delivery custody e2e (O3) — closes the verification caveat from the
// queue-delivery-watch commit: REAL browser admission (textarea + Send click),
// REAL daemon dispatch in a REAL fixtureserver process (daemon-dispatch
// enabled; the browser is observe-only), LIVE SSE, and observed Sending-chip
// clearance BEFORE the unchanged 30s stale deadline — with the browser's queue
// GETs deliberately held to a frozen dispatching snapshot, so the clearance
// can only be explained by the live delivered event, not by a queue refresh.
//
// This spec is DISPATCH-ONLY: excluded from ordinary lane-6 discovery
// (playwright.config.ts testIgnore) and run via its dedicated config
// (playwright.queue-delivery.config.ts — fresh process, fresh dirs, distinct
// port, daemon-dispatch enabled, service workers blocked, serial, zero
// retries).
//
// Topology / attribution discipline (brief F3–F5):
//   - The fixture's prompt-hold latch parks the fake upstream turn BEFORE
//     persistence AND event emission (pkg/fixtures/opencode.go), so while
//     held: no user message persisted, no transcript message, no busy.
//   - The daemon's custody drain loop claims the admitted item and POSTs
//     prompt_async (which 204s immediately; the turn stays parked). The
//     browser must remain observe-only: any attempted claim / resolve /
//     /vh/send / direct upstream prompt POST is DETECTED and FAILS the test.
//   - Browser queue GETs are fulfilled from RAW queue.json reads (the
//     production List endpoint can trigger reconciliation — never touched
//     here). Once the genuine dispatching snapshot (claimGeneration>0,
//     correlation id, dispatchStartedAt) has been observed, it is FROZEN:
//     every later GET serves that same nonterminal snapshot. SSE, timers,
//     and browser execution are untouched.
//   - Watcher attribution is INDEPENDENT (parallel consumer): the raw
//     queue.json must reach `sent` with the EXACT watcher-specific delivered
//     detail, and the fixture witness must record exactly one correlated
//     arrival and one persisted user-message occurrence.
//
// The receipt wording this spec earns lives in the slice closeout (see
// docs/checkpoints/2026-10-13-queue-delivery-caveat-closure.md).

import { expect, test, type APIRequestContext, type BrowserContext, type Route } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { demoDir, projectUrl } from "./util";

// "other" is the seeded "Another root" session — openable via ?session=other,
// renders a normal composer + queue chip row (queue-recovery.spec precedent).
const SID = "other";
const MARKER_PREFIX = "QD-CUSTODY";

const jsonCsrf = { "Content-Type": "application/json", "X-VH-CSRF": "1" };

// The raw durable queue file the route handler reads (passive witness — never
// the List endpoint, which can reconcile).
const queueJsonPath = path.join(demoDir, ".vh-solara", "sessions", SID, "queue.json");

// Queue-policy B2 cell: that cell runs on "demo" for DETERMINISM — its seeded
// transcript carries agent-stamped assistant messages, so the send gate's
// evidence scan resolves identically regardless of turn history.
// (Historical note: this used to be a WORKAROUND, not a determinism choice —
// the fake's turn messages carried NO agent field, so after any delivered
// turn a session had messages but ZERO agent-stamped evidence and the send
// gate's agent resolution pended forever; "demo" was the only host for the
// policy cell. The fixture now stamps agent "build" on fake turn messages —
// user messages sender-stamped, assistant messages matching the resolver's
// lastAssistantAgent scan (commit 8f78bcc) — so FRESH sessions send fine
// after a delivered turn. The fresh-session cells at the bottom of this spec
// prove that repair end-to-end through the real FE resolver.)
const POLICY_SID = "demo";
const policyQueueJsonPath = path.join(demoDir, ".vh-solara", "sessions", POLICY_SID, "queue.json");

interface RawItem {
  id: string;
  state: string;
  text?: string;
  opencodeMsgID?: string;
  claimGeneration?: number;
  dispatchStartedAt?: number;
  detail?: string;
  intentId?: string;
  dispatchPolicy?: string;
  attachments?: { url?: string; filename?: string; mime?: string; path?: string }[];
}

function readRawItems(): RawItem[] {
  try {
    const j = JSON.parse(readFileSync(queueJsonPath, "utf8")) as { items?: RawItem[] };
    return Array.isArray(j.items) ? j.items : [];
  } catch {
    return []; // no queue file yet — an honest empty list
  }
}

// The raw snapshot the handler freezes once genuinely dispatching.
interface FrozenSnapshot {
  body: string;
  dispatchStartedAt: number;
  opencodeMsgID: string;
  itemId: string;
}

test.afterEach(async ({ request }) => {
  // Hygiene: never leave the latch armed/held (the reset also JOINS a parked
  // turn, so a failed run cannot leak a goroutine into the next).
  await request.post("/oc/fixture/prompt-hold/reset", { headers: jsonCsrf, data: {} });
});

test("real Send under daemon custody clears the Sending chip via the live delivered event", async ({
  page,
  context,
  request,
}) => {
  const marker = `${MARKER_PREFIX}-${Date.now()}`;

  // --- Pre-navigation state: arm the upstream hold for this session ------
  // Everything the test drives on the fixture goes through the daemon's /oc
  // proxy — the same production proxy path the SPA's upstream traffic takes.
  const arm = await request.post(`/oc/fixture/prompt-hold/arm?session=${SID}`, {
    headers: jsonCsrf,
    data: { deadlineMs: 90_000 },
  });
  expect(arm.ok(), "arm prompt hold over /oc proxy").toBeTruthy();

  // --- Controlled stale-pull isolation (F4), installed BEFORE navigation --
  const violations: string[] = [];
  let frozen: FrozenSnapshot | null = null;
  let queueGetCount = 0;
  // Exact-path GET /vh/stream only — the SPA's POST /vh/stream/probe
  // liveness sentinel is a different request and must not be mistaken for a
  // reconnect.
  const streamRequestUrls: string[] = [];
  context.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === "/vh/stream") {
      streamRequestUrls.push(r.url());
    }
  });
  const mainFrameNavigations: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) mainFrameNavigations.push(f.url());
  });

  await context.route(`**/vh/session/${SID}/queue**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const isExactQueuePath = url.pathname === `/vh/session/${SID}/queue`;
    if (isExactQueuePath && method === "GET") {
      queueGetCount++;
      if (frozen) {
        await route.fulfill({ status: 200, contentType: "application/json", body: frozen.body });
        return;
      }
      // Track actual raw state until genuinely dispatching, then freeze.
      const items = readRawItems();
      const target = items.find((it) => it.text === marker);
      if (
        target &&
        target.state === "dispatching" &&
        (target.claimGeneration ?? 0) > 0 &&
        target.opencodeMsgID &&
        (target.dispatchStartedAt ?? 0) > 0
      ) {
        frozen = {
          body: JSON.stringify({ items }),
          dispatchStartedAt: target.dispatchStartedAt as number,
          opencodeMsgID: target.opencodeMsgID,
          itemId: target.id,
        };
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items }),
      });
      return;
    }
    if (isExactQueuePath && method === "POST") {
      await route.continue(); // admission passes unchanged
      return;
    }
    // claim / resolve / remove — prohibited browser-side writes under custody.
    violations.push(`${method} ${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  // Prohibited-write detection: /vh/send and direct upstream prompt/message
  // POSTs must never come from the observe-only browser.
  await context.route("**/vh/send", async (route) => {
    if (route.request().method() === "POST") {
      violations.push("POST /vh/send");
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.route(`**/oc/session/**`, async (route) => {
    if (route.request().method() === "POST") {
      const u = new URL(route.request().url());
      violations.push(`direct upstream POST ${u.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  // --- Navigate; the browser must see the daemon-dispatch capability ------
  await page.goto(projectUrl(`/?session=${SID}`));
  await page.evaluate(() => {
    // Marker proving no reload/replacement happened during the observation.
    (window as unknown as Record<string, unknown>).__qdMarker = true;
  });
  const capable = await page.evaluate(async () => {
    const r = await fetch("/vh/version", { cache: "no-store" });
    const j = (await r.json()) as { daemonDispatchCapable?: boolean };
    return j.daemonDispatchCapable === true;
  });
  expect(capable, "browser observes daemonDispatchCapable:true on /vh/version").toBeTruthy();

  // Wait for send readiness (agents/models load asynchronously).
  const ta = page.getByPlaceholder(/Message/);
  await expect(ta).toBeVisible();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const btn = document.querySelector('button[aria-label="Send"]');
          return btn ? !(btn as HTMLButtonElement).disabled : false;
        }),
      { timeout: 15_000, message: "Send button becomes ready (agents/models loaded)" },
    )
    .toBeTruthy();

  // --- The real gesture: literal textarea input + Send click -------------
  await ta.fill(marker);
  await expect(ta).toHaveValue(marker);
  await page.locator('button[aria-label="Send"]').click();

  // Admission completed: the composer cleared (durable custody confirmed).
  await expect(ta).toHaveValue("", { timeout: 10_000 });

  // Nudge the app's own focus-triggered queue refresh until the daemon's
  // claim is visible through the raw-snapshot GETs.
  const chip = page.locator(`.queue-chip[data-state="dispatching"]`, { hasText: marker });
  const nudgeDeadline = Date.now() + 15_000;
  while ((await chip.count()) === 0) {
    if (Date.now() > nudgeDeadline) throw new Error("target Sending chip never became visible");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(300);
  }
  await expect(chip).toBeVisible();
  expect(
    frozen,
    "the dispatching snapshot was captured (claimGeneration>0 + correlation id)",
  ).not.toBeNull();

  // --- Held precondition: custody taken, upstream has NOT moved -----------
  const heldWitness = (
    (await (
      await request.get(`/oc/fixture/prompt-hold/state?session=${SID}`)
    ).json()) as { held: boolean; arrivals: string[]; persistedUserIDs: string[] }
  );
  expect(heldWitness.held, "the upstream turn is parked in the fixture hold").toBeTruthy();
  expect(
    heldWitness.arrivals,
    "exactly ONE upstream prompt_async arrival, under the claim correlation id",
  ).toEqual([frozen!.opencodeMsgID]);
  expect(heldWitness.persistedUserIDs, "no user message persisted while held").toEqual([]);

  const userMsg = page.locator(".msg.user", { hasText: marker });
  await expect(userMsg, "held precondition: no transcript user message").toHaveCount(0);

  const rawAtHold = readRawItems().find((it) => it.id === frozen!.itemId);
  expect(rawAtHold?.state, "raw queue state is dispatching (nonterminal)").toBe("dispatching");
  expect((rawAtHold?.claimGeneration ?? 0) > 0, "custody-era claim generation").toBeTruthy();
  expect(rawAtHold?.opencodeMsgID, "raw correlation id matches the frozen snapshot").toBe(
    frozen!.opencodeMsgID,
  );

  // Snapshot confound counters for the observation window.
  const streamCountAtRelease = streamRequestUrls.length;

  // --- Release: the normal fake upstream flow delivers over live SSE ------
  const releaseAt = Date.now();
  const rel = await request.post("/oc/fixture/prompt-hold/release", {
    headers: jsonCsrf,
    data: {},
  });
  expect(rel.ok()).toBeTruthy();

  // Observe chip clearance (the user-visible outcome), polling tightly so
  // the observation timestamp is meaningful.
  const clearBudgetMs = 8_000; // the actual post-release causal window
  let cleared = false;
  const clearDeadline = releaseAt + clearBudgetMs;
  while (!cleared) {
    if (Date.now() > clearDeadline) {
      throw new Error(
        `Sending chip never cleared within ${clearBudgetMs}ms of release (dispatchStartedAt=${frozen!.dispatchStartedAt})`,
      );
    }
    cleared = (await chip.count()) === 0;
    if (!cleared) await page.waitForTimeout(100);
  }
  const clearedAt = Date.now();
  // The brief's timing requirement: record the real elapsed from RAW
  // dispatchStartedAt and require clearance COMFORTABLY before the unchanged
  // 30,000ms stale deadline (conservative bound — no production threshold is
  // changed or introduced here; the held precondition phase consumes part of
  // this window by design).
  const elapsedFromDispatch = clearedAt - frozen!.dispatchStartedAt;
  expect(
    elapsedFromDispatch,
    `chip cleared ${elapsedFromDispatch}ms after raw dispatchStartedAt — must be comfortably before the 30,000ms stale deadline`,
  ).toBeLessThan(20_000);
  expect(elapsedFromDispatch).toBeLessThan(30_000);

  // The delivered user turn rendered in the transcript (live SSE outcome).
  await expect(userMsg, "the delivered user message rendered in the transcript").toBeVisible();

  // The browser's own queue GETs still return the frozen dispatching
  // snapshot — the clearance can NOT be explained by a queue refresh.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(500);
  expect(frozen, "queue GET responses remain frozen at the dispatching snapshot").not.toBeNull();
  await expect(
    chip,
    "chip stays gone after a focus-triggered refresh against the frozen snapshot",
  ).toHaveCount(0);

  // --- Watcher attribution: raw durable state, independently observed ------
  const WATCHER_DETAIL =
    "Delivered: OpenCode persisted the user message under the queue correlation id (observed on the live event stream); resolved to sent.";
  let rawSent: RawItem | undefined;
  const sentDeadline = Date.now() + 10_000;
  for (;;) {
    rawSent = readRawItems().find((it) => it.id === frozen!.itemId);
    if (rawSent?.state === "sent" && rawSent?.detail === WATCHER_DETAIL) break;
    if (Date.now() > sentDeadline) {
      throw new Error(
        `raw queue never reached sent with the watcher detail (got state=${rawSent?.state} detail=${rawSent?.detail})`,
      );
    }
    await page.waitForTimeout(200);
  }
  expect(
    (rawSent.claimGeneration ?? 0) > 0,
    "terminal item retains its custody-era claim",
  ).toBeTruthy();
  expect(rawSent.opencodeMsgID).toBe(frozen!.opencodeMsgID);

  // --- Fake-upstream witness: one correlated arrival, one persisted turn ---
  const finalWitness = (
    (await (
      await request.get(`/oc/fixture/prompt-hold/state?session=${SID}`)
    ).json()) as { arrivals: string[]; persistedUserIDs: string[] }
  );
  expect(
    finalWitness.arrivals.filter((id) => id === frozen!.opencodeMsgID),
    "exactly one correlated upstream arrival (no redispatch)",
  ).toHaveLength(1);
  expect(
    finalWitness.persistedUserIDs.filter((id) => id === frozen!.opencodeMsgID),
    "exactly one persisted user-message occurrence under the correlation id",
  ).toHaveLength(1);

  // --- Confound exclusions ------------------------------------------------
  expect(violations, "no browser claim/resolve/direct-send was attempted").toEqual([]);
  expect(
    mainFrameNavigations,
    "exactly ONE main-frame navigation (the initial goto) — no reload confound",
  ).toHaveLength(1);
  expect(
    streamRequestUrls.length,
    "no SSE reconnect during the observation window",
  ).toBe(streamCountAtRelease);
  const markerAlive = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return w.__qdMarker === true;
  });
  expect(markerAlive, "the page was never reloaded (boot marker survived)").toBeTruthy();
  expect(
    queueGetCount,
    "the browser performed its queue reads (fulfilled from raw snapshots)",
  ).toBeGreaterThan(0);

  test.info().annotations.push(
    { type: "qd-correlation-id", description: frozen!.opencodeMsgID },
    { type: "qd-dispatch-started-at", description: String(frozen!.dispatchStartedAt) },
    { type: "qd-cleared-at", description: String(clearedAt) },
    { type: "qd-elapsed-ms", description: String(elapsedFromDispatch) },
    { type: "qd-item-id", description: frozen!.itemId },
  );
});

// ---------------------------------------------------------------------------
// G2 custody-bypass fix (2026-10-27, annex-2 §2) — the modern Retry affordance
// must never direct-POST prompt_async around daemon custody. The G2 chain's
// producer is stale-dispatch recovery (pkg/web/queue.go
// recoverStaleDispatchingLocked): it leaves an UNMARKED terminal `unknown`
// item (retained claim correlation id, NO ambiguousDelivery marker), which
// the Composer renders as the GENERIC QueueChip — whose Retry button was the
// one browser affordance that direct-POSTs the upstream prompt endpoint with
// no arbitrated step in front of it (the queue custody 409 fires only AFTER a
// POST, on claim/resolve). The fix guards BOTH the render (the leaf suppresses
// the Retry button while projectionActive) and the execution
// (createSend.retryQueuedItem refuses before the POST, re-checking ownership
// after every await).
//
// This cell plants the custody-recovery shape in the raw durable queue file
// (the lane-9 planted-operator-blob precedent: production-safe, no dev
// bridges), serves it to the REAL SPA in the REAL daemon-dispatch posture,
// and proves the OUTCOME in the real environment:
//   - the unknown chip renders with its sanctioned recovery affordances
//     (mark-sent / edit-again / dismiss) but NO Retry button — through real
//     navigation, real mounts, and real focus-driven queue refreshes;
//   - zero direct upstream prompt POSTs arrive at the fake OpenCode for the
//     seeded correlation id (the fixture's unconditional arrival witness —
//     evidence independent of the browser route layer);
//   - zero prohibited browser writes (claim/resolve/remove//vh/send/direct
//     upstream) are attempted.
// The execution guard's click-path refusal (including the capability-flip
// mid-await windows) is unit-pinned in createSendAttempts.test.ts (G2
// describe); in modern mode no real gesture can even reach it — the render
// guard removed the affordance — which is exactly the fix.
// ---------------------------------------------------------------------------
test("G2: unmarked unknown chip under daemon custody renders NO Retry and produces zero direct upstream prompt POSTs", async ({
  page,
  context,
  request,
}) => {
  const marker = `${MARKER_PREFIX}-G2-${Date.now()}`;
  // Unique per run: the arrival witness is session-cumulative across the
  // serial lane (the cell above dispatched once), so the zero-POST proof
  // filters by THIS run's seeded correlation id.
  const seedMsgID = `msg_g2_e2e_${Date.now()}`;
  const seedItem = {
    id: "q-g2-seed",
    order: 1,
    state: "unknown",
    text: marker,
    attachments: [],
    sendConfig: { providerID: "p", modelID: "m", agent: "build" },
    opencodeMsgID: seedMsgID,
    createdAt: Date.now() - 60_000,
    dispatchStartedAt: Date.now() - 55_000,
    resolvedAt: Date.now() - 50_000,
    detail: "Send outcome unknown after a dispatch interruption",
    claimGeneration: 1,
  };
  const seededBody = JSON.stringify({ version: 1, order: 1, items: [seedItem] });
  mkdirSync(path.dirname(queueJsonPath), { recursive: true });
  writeFileSync(queueJsonPath, seededBody);

  // --- Prohibited-write + direct-POST detection (browser context only) ----
  const violations: string[] = [];
  let queueGetCount = 0;
  await context.route(`**/vh/session/${SID}/queue**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const isExactQueuePath = url.pathname === `/vh/session/${SID}/queue`;
    if (isExactQueuePath && method === "GET") {
      queueGetCount++;
      // Frozen at the seed: the browser's view of the custody-recovery shape
      // is deterministic regardless of daemon-side reconciliation.
      await route.fulfill({ status: 200, contentType: "application/json", body: seededBody });
      return;
    }
    if (isExactQueuePath && method === "POST") {
      await route.continue(); // admission passes unchanged
      return;
    }
    // claim / resolve / remove — prohibited browser-side writes under custody.
    violations.push(`${method} ${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  await context.route("**/vh/send", async (route) => {
    if (route.request().method() === "POST") {
      violations.push("POST /vh/send");
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.route(`**/oc/session/**`, async (route) => {
    if (route.request().method() === "POST") {
      const u = new URL(route.request().url());
      violations.push(`direct upstream POST ${u.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  // --- Navigate; the browser must be in the daemon-dispatch posture --------
  await page.goto(projectUrl(`/?session=${SID}`));
  const capable = await page.evaluate(async () => {
    const r = await fetch("/vh/version", { cache: "no-store" });
    const j = (await r.json()) as { daemonDispatchCapable?: boolean };
    return j.daemonDispatchCapable === true;
  });
  expect(capable, "browser observes daemonDispatchCapable:true on /vh/version").toBeTruthy();

  // --- The custody-recovery chip renders through the real mount ------------
  const chip = page.locator(`.queue-chip[data-state="unknown"]`, { hasText: marker });
  const nudgeDeadline = Date.now() + 15_000;
  while ((await chip.count()) === 0) {
    if (Date.now() > nudgeDeadline) throw new Error("seeded unknown chip never became visible");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(300);
  }
  await expect(chip).toBeVisible();

  // --- THE RENDER-GUARD CRUX: no Retry affordance on the custody-owned chip -
  // The unknown chip keeps its sanctioned recovery affordances — only the
  // direct-POSTing Retry is suppressed (a wiring-level consumer of QueueChip
  // cannot resurrect it; the leaf owns the guard).
  await expect(chip.locator(".queue-retry")).toHaveCount(0);
  await expect(chip.locator(".queue-mark-sent")).toHaveCount(1);
  await expect(chip.locator(".queue-retract")).toHaveCount(1);
  await expect(chip.locator(".queue-dismiss")).toHaveCount(1);
  // The visible duplicate-risk guidance (the honest recovery contract).
  await expect(page.locator(".queue-detail-note", { hasText: seedItem.detail })).toBeVisible();

  // --- Real-event re-observation window: focus-driven queue refreshes re-
  // render the chip (real browser events through the real event model); the
  // affordance must STILL be absent, and the chip must persist (nothing was
  // resolved, dispatched, or dismissed by the page).
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(500);
  await expect(chip).toBeVisible();
  await expect(chip.locator(".queue-retry")).toHaveCount(0);

  // --- OUTCOME witness at the upstream: zero arrivals under the seeded
  // correlation id (the fixture records every prompt_async POST
  // unconditionally — evidence independent of the route layer).
  const witness = (await (
    await request.get(`/oc/fixture/prompt-hold/state?session=${SID}`)
  ).json()) as { arrivals: string[]; persistedUserIDs: string[] };
  expect(
    witness.arrivals.filter((id) => id === seedMsgID),
    "zero direct upstream prompt POSTs for the seeded correlation id",
  ).toHaveLength(0);
  expect(
    witness.persistedUserIDs.filter((id) => id === seedMsgID),
    "no persisted user message for the seeded correlation id",
  ).toHaveLength(0);

  // --- Confound exclusions -------------------------------------------------
  expect(violations, "no browser claim/resolve/direct-send/direct-upstream POST was attempted").toEqual([]);
  expect(
    queueGetCount,
    "the browser performed its queue reads (served from the frozen seed)",
  ).toBeGreaterThan(0);

  test.info().annotations.push(
    { type: "qd-g2-seed-msg-id", description: seedMsgID },
    { type: "qd-g2-queue-gets", description: String(queueGetCount) },
  );
});

// ---------------------------------------------------------------------------
// Queue-policy slice B2 (2026-10-29 amendment) — the FE policy feature on the
// REAL daemon-dispatch stack: capability-driven composer button table under a
// REAL busy subtree, the busy Queue gesture held by the interim gate, the
// busy Send-now gesture + the pending-chip Send-now escalation both admitted
// with dispatchPolicy "now" through the DURABLE pipeline and dispatched by the
// daemon's now-bypass DESPITE the busy tree. Raw queue.json is the passive
// witness (the List endpoint is never frozen here); the browser stays
// observe-only (claim/resolve/direct-upstream POSTs are detected and failed).
// ---------------------------------------------------------------------------
test("busy-state policy gestures: Queue waits, Send now + chip escalation dispatch under busy", async ({
  page,
  context,
  request,
}) => {
  const markerA = `QP-A-${Date.now()}`; // the queued (policy-absent) message
  const markerC = `QP-C-${Date.now()}`; // the composer Send-now message
  const readRaw = (): RawItem[] => {
    try {
      const j = JSON.parse(readFileSync(policyQueueJsonPath, "utf8")) as { items?: RawItem[] };
      return Array.isArray(j.items) ? j.items : [];
    } catch {
      return []; // no queue file yet — an honest empty list
    }
  };

  // --- Guards: the browser must stay observe-only (G2 closed) -----------
  const violations: string[] = [];
  await context.route(`**/vh/session/${POLICY_SID}/queue**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (method === "GET") {
      await route.continue(); // live truth — no freezing in this cell
      return;
    }
    if (method === "POST" && (path.endsWith(`/queue`) || path.endsWith(`/escalate`))) {
      await route.continue(); // admission + escalation: sanctioned browser writes
      return;
    }
    violations.push(`${method} ${path}`);
    await route.abort("blockedbyclient");
  });
  await context.route("**/vh/send", async (route) => {
    if (route.request().method() === "POST") {
      violations.push("POST /vh/send");
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.route("**/oc/session/**", async (route) => {
    if (route.request().method() === "POST") {
      violations.push(`direct upstream POST ${new URL(route.request().url()).pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  try {
    // --- Busy subtree + held upstream -------------------------------------
    const arm = await request.post(`/oc/fixture/prompt-hold/arm?session=${POLICY_SID}`, {
      headers: jsonCsrf,
      data: { deadlineMs: 120_000 },
    });
    expect(arm.ok(), "arm prompt hold").toBeTruthy();
    const busy = await request.post(`/oc/fixture/busy?session=${POLICY_SID}`, {
      headers: jsonCsrf,
      data: {},
    });
    expect(busy.ok(), "mark the session busy (live session.status)").toBeTruthy();

    // --- Navigate; the policy capability must be advertised ---------------
    await page.goto(projectUrl(`/?session=${POLICY_SID}`));
    const capable = await page.evaluate(async () => {
      const r = await fetch("/vh/version", { cache: "no-store" });
      return (await r.json()) as { queueDispatchPolicyVersion?: number };
    });
    expect(
      capable.queueDispatchPolicyVersion,
      "queueDispatchPolicyVersion advertised (the policy scheduler is active)",
    ).toBeGreaterThanOrEqual(1);

    const ta = page.getByPlaceholder(/Message/);
    await expect(ta).toBeVisible();
    // Busy flip first (the amendment's empty-text row: Stop only — there is
    // no Send button to poll in the busy state).
    await expect
      .poll(
        async () => page.locator('button[aria-label="Stop"]').count(),
        { timeout: 15_000, message: "busy reached the composer (Stop renders)" },
      )
      .toBeGreaterThan(0);

    // --- Busy + text: the policy button table (Queue + Send now, NO Stop) --
    await ta.fill(markerA);
    await expect(page.locator('button[aria-label="Queue"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Send now"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Stop"]')).toHaveCount(0);
    // Readiness (agents/models load asynchronously): both busy actions
    // enable once readyToSend clears.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const q = document.querySelector('button[aria-label="Queue"]') as HTMLButtonElement | null;
            const n = document.querySelector('button[aria-label="Send now"]') as HTMLButtonElement | null;
            return !!q && !!n && !q.disabled && !n.disabled;
          }),
        { timeout: 15_000, message: "policy buttons ready (agents/models loaded)" },
      )
      .toBeTruthy();

    // --- Phase 1: the Queue gesture is HELD by the interim gate -----------
    await page.locator('button[aria-label="Queue"]').click();
    await expect(ta).toHaveValue("", { timeout: 10_000 }); // admission confirmed
    let held: RawItem | undefined;
    const heldDeadline = Date.now() + 10_000;
    for (;;) {
      held = readRaw().find((it) => it.text === markerA);
      if (held) break;
      if (Date.now() > heldDeadline) throw new Error("queued item never appeared in raw queue.json");
      await page.waitForTimeout(200);
    }
    expect(held.state).toBe("pending");
    expect(held.dispatchPolicy ?? "").toBe(""); // queue elided — absent member
    expect((held.claimGeneration ?? 0)).toBe(0); // NOT claimed
    // The interim gate holds under busy: ~12 drain ticks (250ms) with no claim.
    await page.waitForTimeout(3_000);
    const stillHeld = readRaw().find((it) => it.text === markerA);
    expect(stillHeld?.state, "queue-policy item stays pending while the tree is busy").toBe("pending");
    expect((stillHeld?.claimGeneration ?? 0)).toBe(0);

    // --- Phase 2: the pending chip's Send-now ESCALATION ------------------
    const chip = page.locator(`.queue-chip[data-state="pending"]`, { hasText: markerA });
    const chipDeadline = Date.now() + 10_000;
    while ((await chip.count()) === 0) {
      if (Date.now() > chipDeadline) throw new Error("pending chip never became visible");
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForTimeout(300);
    }
    await chip.locator(".queue-escalate").click();
    // The server cancel+re-admitted under a FRESH id born "now"; the daemon's
    // now-bypass claims it DESPITE the busy tree.
    let escalated: RawItem | undefined;
    const escDeadline = Date.now() + 15_000;
    for (;;) {
      const items = readRaw().filter((it) => it.text === markerA);
      escalated = items.find((it) => it.dispatchPolicy === "now");
      if (
        escalated &&
        escalated.state === "dispatching" &&
        (escalated.claimGeneration ?? 0) > 0 &&
        escalated.opencodeMsgID
      ) {
        break;
      }
      if (Date.now() > escDeadline) {
        throw new Error(
          `escalated item never reached dispatching (got ${JSON.stringify(items)})`,
        );
      }
      await page.waitForTimeout(200);
    }
    expect(readRaw().some((it) => it.id === held!.id), "the original id was consumed").toBe(false);

    // --- Phase 3: the busy composer's Send-now gesture --------------------
    await ta.fill(markerC);
    await page.locator('button[aria-label="Send now"]').click();
    await expect(ta).toHaveValue("", { timeout: 10_000 });
    let nowItem: RawItem | undefined;
    const nowDeadline = Date.now() + 15_000;
    for (;;) {
      nowItem = readRaw().find((it) => it.text === markerC);
      if (
        nowItem &&
        nowItem.dispatchPolicy === "now" &&
        (nowItem.claimGeneration ?? 0) > 0 &&
        nowItem.opencodeMsgID
      ) {
        break;
      }
      if (Date.now() > nowDeadline) {
        throw new Error(`Send-now item never dispatched (got ${JSON.stringify(nowItem)})`);
      }
      await page.waitForTimeout(200);
    }

    // --- Release; both now items converge to sent via the watcher ---------
    const rel = await request.post("/oc/fixture/prompt-hold/release", {
      headers: jsonCsrf,
      data: {},
    });
    expect(rel.ok()).toBeTruthy();
    const sentDeadline = Date.now() + 15_000;
    for (;;) {
      const items = readRaw().filter((it) => it.text === markerA || it.text === markerC);
      const allSent =
        items.length === 2 && items.every((it) => it.state === "sent" && (it.claimGeneration ?? 0) > 0);
      if (allSent) break;
      if (Date.now() > sentDeadline) {
        throw new Error(`items never reached sent (got ${JSON.stringify(items)})`);
      }
      await page.waitForTimeout(300);
    }

    // --- Confound exclusion: the browser never bypassed custody -----------
    expect(violations, "no browser claim/resolve/direct-send/direct-upstream POST was attempted").toEqual([]);
  } finally {
    // Hygiene: join/reset the hold and restore the session to idle so later
    // cells start from a clean busy state.
    await request.post("/oc/fixture/prompt-hold/reset", { headers: jsonCsrf, data: {} });
    await request.post(`/oc/fixture/idle?session=${POLICY_SID}`, { headers: jsonCsrf, data: {} });
  }
});

// ---------------------------------------------------------------------------
// Queue-policy riding follow-ups (web slice, 2026-10-29) — fresh-session
// breadth cells (d-F2/b-F3) + the b-F1/b-F3 fixture agent-stamp repair proof.
// Each cell creates its OWN fresh session through the real POST /session
// create route (the same call the SPA's draft materialization takes), so no
// seeded transcript is involved and no cross-cell state is shared. Raw
// queue.json is the passive witness; the browser stays observe-only.
// ---------------------------------------------------------------------------

// Shared shape for the fresh-session cells: create the session + the raw
// queue reader + the observe-only guard stack (with admission-body snooping —
// the queue.json policy member is server-NORMALIZED ("queue" elided to
// absent), so the pre-normalization admission body is the only wire-level
// witness of WHICH stamp the gesture carried).
async function freshSessionHarness(
  request: APIRequestContext,
  context: BrowserContext,
  sid: string,
): Promise<{ admissionBodies: any[]; violations: string[] }> {
  const admissionBodies: any[] = [];
  const violations: string[] = [];
  await context.route(`**/vh/session/${sid}/queue**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (method === "GET") {
      await route.continue(); // live truth — no freezing in these cells
      return;
    }
    if (method === "POST" && (path.endsWith(`/queue`) || path.endsWith(`/escalate`))) {
      // Snoop the admission/escalation body (the gesture's policy stamp +
      // attachment refs BEFORE server normalization), then pass through.
      try {
        admissionBodies.push(route.request().postDataJSON());
      } catch {
        /* unreadable body — the durable queue.json witness still applies */
      }
      await route.continue(); // admission + escalation: sanctioned browser writes
      return;
    }
    violations.push(`${method} ${path}`);
    await route.abort("blockedbyclient");
  });
  await context.route("**/vh/send", async (route) => {
    if (route.request().method() === "POST") {
      violations.push("POST /vh/send");
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.route("**/oc/session/**", async (route) => {
    if (route.request().method() === "POST") {
      violations.push(`direct upstream POST ${new URL(route.request().url()).pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return { admissionBodies, violations };
}

// Create a fresh session through the REAL create route (zero seeded
// messages) and return its id. Must run BEFORE the /oc/session/** POST guard
// is installed (the guard would block the create itself).
async function createFreshSession(request: APIRequestContext): Promise<string> {
  const created = await request.post("/oc/session", { headers: jsonCsrf, data: {} });
  expect(created.ok(), "create fresh session via the real POST /session").toBeTruthy();
  const sid = ((await created.json()) as { id: string }).id;
  expect(sid).toBeTruthy();
  return sid;
}

function rawQueueReader(sid: string): () => RawItem[] {
  const qPath = path.join(demoDir, ".vh-solara", "sessions", sid, "queue.json");
  return () => {
    try {
      const j = JSON.parse(readFileSync(qPath, "utf8")) as { items?: RawItem[] };
      return Array.isArray(j.items) ? j.items : [];
    } catch {
      return []; // no queue file yet — an honest empty list
    }
  };
}

// (a) Busy-Enter cell: typing + Enter on a FRESH session (stamped by the
// Enter-default rule) admits a queue-policy item that is HELD pending — no
// claim, no dispatch — while the tree is busy. Contrast with the attachment
// cell below: the same busy driver + a "now" stamp DOES claim.
test("busy-Enter on a FRESH session: Enter-default Queue stamp admits an item HELD (no claim) while busy", async ({
  page,
  context,
  request,
}) => {
  const sid = await createFreshSession(request);
  const readRaw = rawQueueReader(sid);
  const marker = `QP-ENTER-${Date.now()}`;
  const { admissionBodies, violations } = await freshSessionHarness(request, context, sid);

  try {
    // Busy the fresh session's tree (the lane's busy driver — live
    // session.status busy through the /oc proxy).
    const busy = await request.post(`/oc/fixture/busy?session=${sid}`, {
      headers: jsonCsrf,
      data: {},
    });
    expect(busy.ok(), "mark the fresh session busy").toBeTruthy();

    await page.goto(projectUrl(`/?session=${sid}`));
    const capable = await page.evaluate(async () => {
      const r = await fetch("/vh/version", { cache: "no-store" });
      return (await r.json()) as { queueDispatchPolicyVersion?: number };
    });
    expect(
      capable.queueDispatchPolicyVersion,
      "queueDispatchPolicyVersion advertised (the policy scheduler is active)",
    ).toBeGreaterThanOrEqual(1);

    const ta = page.getByPlaceholder(/Message/);
    await expect(ta).toBeVisible();
    // Busy + empty text → Stop only (amendment §2 row 2).
    await expect
      .poll(
        async () => page.locator('button[aria-label="Stop"]').count(),
        { timeout: 15_000, message: "busy reached the composer (Stop renders)" },
      )
      .toBeGreaterThan(0);

    // Busy + text → the policy button table (Queue + Send now, NO Stop).
    await ta.fill(marker);
    await expect(page.locator('button[aria-label="Queue"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Send now"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Stop"]')).toHaveCount(0);
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const q = document.querySelector('button[aria-label="Queue"]') as HTMLButtonElement | null;
            const n = document.querySelector('button[aria-label="Send now"]') as HTMLButtonElement | null;
            return !!q && !!n && !q.disabled && !n.disabled;
          }),
        { timeout: 15_000, message: "policy buttons ready (agents/models loaded)" },
      )
      .toBeTruthy();

    // THE GESTURE: Enter (the safe-default key) — the controller stamps
    // "queue" exactly when capability + busy held at tap (amendment §2).
    await ta.press("Enter");
    await expect(ta).toHaveValue("", { timeout: 10_000 }); // admitted (fresh-session agent gate resolved via provably-empty)

    // WIRE WITNESS: the admission body carried the explicit Enter-default
    // "queue" stamp. The durable queue.json CANNOT distinguish this from a
    // legacy admission (the server normalizes "queue" to the elided absent
    // member) — the snooped body is the only pre-normalization witness.
    const body = admissionBodies.find((b: any) => b?.text === marker);
    expect(body, "the Enter admission POST was observed").toBeTruthy();
    expect((body as any).dispatchPolicy).toBe("queue");

    // DURABLE WITNESS: pending, elided policy member, NOT claimed.
    let held: RawItem | undefined;
    const heldDeadline = Date.now() + 10_000;
    for (;;) {
      held = readRaw().find((it) => it.text === marker);
      if (held) break;
      if (Date.now() > heldDeadline) throw new Error("Enter-admitted item never appeared in raw queue.json");
      await page.waitForTimeout(200);
    }
    expect(held.state).toBe("pending");
    expect(held.dispatchPolicy ?? "").toBe(""); // queue elided — absent member
    expect(held.claimGeneration ?? 0).toBe(0); // NOT claimed
    // The interim gate holds under busy: ~12 drain ticks (250ms) with no claim.
    await page.waitForTimeout(3_000);
    const stillHeld = readRaw().find((it) => it.text === marker);
    expect(stillHeld?.state, "Enter-default item stays pending while the tree is busy").toBe("pending");
    expect(stillHeld?.claimGeneration ?? 0).toBe(0);

    expect(violations, "no browser claim/resolve/direct-send/direct-upstream POST was attempted").toEqual([]);
  } finally {
    // Release the busy marker: the interim gate opens and the daemon owns the
    // held item from here (dispatch + turn complete server-side; this cell's
    // assertions are already done).
    await request.post(`/oc/fixture/idle?session=${sid}`, { headers: jsonCsrf, data: {} });
  }
});

// (b) Attachment-bearing gesture cell: a REAL file attach (real file input →
// real /vh/attach upload) + Send now under busy — the admitted item carries
// the attachment refs AND dispatchPolicy "now", and the daemon's now-bypass
// claims it DESPITE the busy tree (the same busy driver that HOLDS the
// Enter-default cell above — the contrast is the despite-busy proof).
//
// FIXTURE LIMITATION (reported honestly; cell kept at the admission
// boundary): the fake's prompt_async persists only the first TEXT part
// (promptText, pkg/fixtures/opencode.go) — it cannot express file parts, so
// upstream attachment-part delivery is NOT witnessable in this lane. Proven
// here: the admission wire body, the durable queue.json attachment refs, and
// the now-dispatch under busy.
test("busy Send now with an attachment: the admitted item carries the refs and dispatches as now DESPITE busy", async ({
  page,
  context,
  request,
}) => {
  const sid = await createFreshSession(request);
  const readRaw = rawQueueReader(sid);
  const marker = `QP-ATT-${Date.now()}`;
  const { admissionBodies, violations } = await freshSessionHarness(request, context, sid);

  try {
    // Park the upstream turn deterministically (the lane's prompt-hold latch)
    // so the now-dispatch is observably held at dispatching while assertions
    // run — same shape as the B2 policy cell above.
    const arm = await request.post(`/oc/fixture/prompt-hold/arm?session=${sid}`, {
      headers: jsonCsrf,
      data: { deadlineMs: 90_000 },
    });
    expect(arm.ok(), "arm prompt hold").toBeTruthy();
    const busy = await request.post(`/oc/fixture/busy?session=${sid}`, {
      headers: jsonCsrf,
      data: {},
    });
    expect(busy.ok(), "mark the fresh session busy").toBeTruthy();

    await page.goto(projectUrl(`/?session=${sid}`));
    const capable = await page.evaluate(async () => {
      const r = await fetch("/vh/version", { cache: "no-store" });
      return (await r.json()) as { queueDispatchPolicyVersion?: number };
    });
    expect(capable.queueDispatchPolicyVersion).toBeGreaterThanOrEqual(1);

    const ta = page.getByPlaceholder(/Message/);
    await expect(ta).toBeVisible();
    await expect
      .poll(
        async () => page.locator('button[aria-label="Stop"]').count(),
        { timeout: 15_000, message: "busy reached the composer (Stop renders)" },
      )
      .toBeGreaterThan(0);

    // Attach a small file through the REAL hidden file input (the production
    // upload path: POST /vh/attach writes under
    // <demoDir>/.vh-solara/sessions/<sid>/attachments — a real writable dir).
    await page.locator(".composer input[type=file]").setInputFiles({
      name: "note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello attachment"),
    });
    await expect(
      page.locator(".attach-chip .attach-name", { hasText: "note.txt" }),
      "the attachment chip uploaded through the real /vh/attach path",
    ).toBeVisible({ timeout: 8_000 });

    await ta.fill(marker);
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const n = document.querySelector('button[aria-label="Send now"]') as HTMLButtonElement | null;
            return !!n && !n.disabled;
          }),
        { timeout: 15_000, message: "Send now ready (agents/models loaded)" },
      )
      .toBeTruthy();
    await page.locator('button[aria-label="Send now"]').click();
    await expect(ta).toHaveValue("", { timeout: 10_000 }); // admitted
    await expect(page.locator(".attach-chip")).toHaveCount(0, { timeout: 8_000 }); // chips cleared with the admission

    // WIRE WITNESS: the admission body carried the attachment refs AND "now".
    const body = admissionBodies.find((b: any) => b?.text === marker);
    expect(body, "the Send-now admission POST was observed").toBeTruthy();
    const wireAtt = (body as any).attachments as any[] | undefined;
    expect(wireAtt, "the admission body carries the attachment array").toHaveLength(1);
    expect(wireAtt![0]).toMatchObject({ filename: "note.txt", mime: "text/plain" });
    expect((body as any).dispatchPolicy).toBe("now");

    // DURABLE WITNESS: the raw item carries the refs + "now" and the daemon's
    // now-bypass claimed it DESPITE the busy tree (claim > 0 + correlation id
    // + dispatching while the SAME busy marker still holds the Enter-default
    // cell's queue-stamped shape).
    let nowItem: RawItem | undefined;
    const nowDeadline = Date.now() + 15_000;
    for (;;) {
      nowItem = readRaw().find((it) => it.text === marker);
      if (
        nowItem &&
        nowItem.dispatchPolicy === "now" &&
        nowItem.state === "dispatching" &&
        (nowItem.claimGeneration ?? 0) > 0 &&
        nowItem.opencodeMsgID
      ) {
        break;
      }
      if (Date.now() > nowDeadline) {
        throw new Error(`attachment-bearing now item never dispatched under busy (got ${JSON.stringify(nowItem)})`);
      }
      await page.waitForTimeout(200);
    }
    expect(nowItem.attachments, "the durable item carries the attachment refs").toHaveLength(1);
    expect(nowItem.attachments![0]).toMatchObject({ filename: "note.txt", mime: "text/plain" });

    // Release; the parked turn delivers and the watcher resolves to sent.
    const rel = await request.post("/oc/fixture/prompt-hold/release", {
      headers: jsonCsrf,
      data: {},
    });
    expect(rel.ok()).toBeTruthy();
    const sentDeadline = Date.now() + 15_000;
    for (;;) {
      nowItem = readRaw().find((it) => it.text === marker);
      if (nowItem?.state === "sent" && (nowItem.claimGeneration ?? 0) > 0) break;
      if (Date.now() > sentDeadline) {
        throw new Error(`attachment-bearing now item never reached sent (got ${JSON.stringify(nowItem)})`);
      }
      await page.waitForTimeout(300);
    }

    expect(violations, "no browser claim/resolve/direct-send/direct-upstream POST was attempted").toEqual([]);
  } finally {
    await request.post("/oc/fixture/prompt-hold/reset", { headers: jsonCsrf, data: {} });
    await request.post(`/oc/fixture/idle?session=${sid}`, { headers: jsonCsrf, data: {} });
  }
});

// (c) Fresh-session send-readiness outcome cell (b-F1/b-F3, the Go review):
// on a fresh session (NOT demo) send once while idle, wait for the delivered
// turn, then send AGAIN — the second send must dispatch. This proves the
// fixture agent-stamp repair (8f78bcc: fake turn messages carry agent
// "build") end-to-end through the REAL FE resolver: pre-repair, the first
// delivered turn left messages with ZERO agent evidence, the second send's
// agent resolution pended forever, and the admission never happened (the
// B2 policy cell had to run on seeded "demo" — see the POLICY_SID note).
test("FRESH-session send readiness: the first delivered turn leaves agent evidence — a SECOND send dispatches", async ({
  page,
  context,
  request,
}) => {
  const sid = await createFreshSession(request);
  const readRaw = rawQueueReader(sid);
  const marker1 = `QP-F1-${Date.now()}`;
  const marker2 = `QP-F2-${Date.now()}`;
  const { violations } = await freshSessionHarness(request, context, sid);

  // No latch: idle turns complete in ~1s; nothing needs parking.

  // FIRST send while idle: the provably-empty resolution (zero messages +
  // hydration delivered) legitimately resolves via the draft-default policy.
  await page.goto(projectUrl(`/?session=${sid}`));
  const capable = await page.evaluate(async () => {
    const r = await fetch("/vh/version", { cache: "no-store" });
    return (await r.json()) as { queueDispatchPolicyVersion?: number; daemonDispatchCapable?: boolean };
  });
  expect(capable.daemonDispatchCapable).toBe(true);

  const ta = page.getByPlaceholder(/Message/);
  await expect(ta).toBeVisible();
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const btn = document.querySelector('button[aria-label="Send"]') as HTMLButtonElement | null;
          return btn ? !btn.disabled : false;
        }),
      { timeout: 15_000, message: "Send button becomes ready (agents/models loaded)" },
    )
    .toBeTruthy();
  await ta.fill(marker1);
  await page.locator('button[aria-label="Send"]').click();
  await expect(ta).toHaveValue("", { timeout: 15_000 }); // first admission (fresh-session gate resolved)

  // The delivered turn renders over live SSE — its messages now carry agent
  // evidence (the fixture repair): user sender-stamped "build", assistant
  // stamped for the lastAssistantAgent scan.
  await expect(
    page.locator(".msg.user", { hasText: marker1 }),
    "the first delivered user message rendered",
  ).toBeVisible({ timeout: 15_000 });

  // Wait out the turn + watcher: the first item reaches sent and the composer
  // flips back to the idle Send button (the tree is idle again).
  const sent1Deadline = Date.now() + 15_000;
  for (;;) {
    const it = readRaw().find((x) => x.text === marker1);
    if (it?.state === "sent") break;
    if (Date.now() > sent1Deadline) throw new Error(`first item never reached sent (got ${JSON.stringify(it)})`);
    await page.waitForTimeout(300);
  }
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const btn = document.querySelector('button[aria-label="Send"]') as HTMLButtonElement | null;
          return btn ? !btn.disabled : false;
        }),
      {
        timeout: 15_000,
        message: "composer back to idle Send after the first turn",
      },
    )
    .toBeTruthy();

  // SECOND send — THE CRUX. Pre-repair this pended at the agent gate (messages
  // present but unstamped → resolution pended → "Not sent — agent unresolved"
  // after the 10s bound, composer retained, NOTHING dispatched). Post-repair
  // the first turn's stamped messages ARE the evidence: resolution is
  // immediate and the second send ADMISSION clears the composer well inside
  // the gate bound.
  await ta.fill(marker2);
  await page.locator('button[aria-label="Send"]').click();
  await expect(ta, "second send admitted (agent evidence resolved — no gate pend)").toHaveValue("", {
    timeout: 8_000,
  });

  // And it DISPATCHED: the second item reaches sent through the daemon.
  const sent2Deadline = Date.now() + 15_000;
  for (;;) {
    const it = readRaw().find((x) => x.text === marker2);
    if (it?.state === "sent" && (it.claimGeneration ?? 0) > 0) break;
    if (Date.now() > sent2Deadline) throw new Error(`second item never reached sent (got ${JSON.stringify(it)})`);
    await page.waitForTimeout(300);
  }
  await expect(
    page.locator(".msg.user", { hasText: marker2 }),
    "the second delivered user message rendered",
  ).toBeVisible({ timeout: 15_000 });

  expect(violations, "no browser claim/resolve/direct-send/direct-upstream POST was attempted").toEqual([]);
});

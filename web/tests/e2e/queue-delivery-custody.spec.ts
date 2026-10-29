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

import { expect, test, type APIRequestContext, type Route } from "@playwright/test";
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

// Queue-policy B2 cell: that cell runs on "demo", NOT "other" — "other" is
// provably-empty only until the first delivered turn; the fake's turn
// messages (simulatePrompt/streamAssistant) carry NO agent field, so after
// the first test's delivered turn "other" has messages but ZERO
// agent-stamped evidence and the send gate's agent resolution pends forever.
// "demo"'s SEEDED transcript carries agent-stamped assistant messages, so
// the evidence scan resolves deterministically regardless of turn history.
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

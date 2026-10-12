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
// The receipt wording this spec earns lives in the slice closeout (see the
// brief, tmp/agent-runs/queue-delivery-verification-brief/brief.md §5).

import { expect, test, type APIRequestContext, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
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

interface RawItem {
  id: string;
  state: string;
  text?: string;
  opencodeMsgID?: string;
  claimGeneration?: number;
  dispatchStartedAt?: number;
  detail?: string;
  intentId?: string;
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

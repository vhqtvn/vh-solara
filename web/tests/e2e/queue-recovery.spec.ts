// Phase 3 e2e: the already-shipped queue-chip recovery affordances
// (retract-to-compose, occupied-composer guard, mark-sent on `unknown`).
//
// These were implemented in Slices 1–4 (createQueueRecovery.ts, QueueChip.tsx,
// the backend queue HTTP API) but never exercised in a real browser. This spec
// adds that coverage. It is part of the serial suite (workers:1,
// fullyParallel:false) over the ONE shared fixtureserver process, so every test
// owns + cleans its own queue state on the "other" seeded session to avoid
// leaking chips into sibling specs.
//
// Fixture strategy (NO pkg/fixtures/opencode.go change required): the
// per-session queue is the daemon's own feature (pkg/web/queue*.go), NOT the
// fake OpenCode's. So chips are surfaced deterministically by driving the real
// /vh/session/<sid>/queue HTTP API directly from the test's `request` fixture:
//
//   enqueue (pending) → claim (dispatching) → resolve {state} (terminal)
//
// The terminal item is then reflected to the browser by the FE's normal
// fetch-on-session-open + ~5s poll. Because the item is ALREADY terminal when
// the browser first sees it, the auto-drainer claims nothing (it only claims
// `pending`) and there is no dispatch race. This leaves the Slice 6 fake
// OpenCode exact-GET / caller-id contract completely untouched: the fake is
// never asked to persist or look up these e2e items (the chips never dispatch).

import { expect, test, type APIRequestContext } from "@playwright/test";
import { demoDir, projectUrl } from "./util";

// "other" is the seeded "Another root" session (pkg/fixtures/opencode.go). It is
// openable via ?session=other and renders a normal composer + queue chip row.
// The serial suite means we can safely own/clean its queue here.
const SID = "other";

const jsonCsrf = { "Content-Type": "application/json", "X-VH-CSRF": "1" };

// apiUrl builds a daemon queue API URL for the "other" session under the demo
// project dir (the same dir projectUrl() encodes). State-changing calls carry
// the X-VH-CSRF header (the /vh/* convention).
function apiUrl(suffix = ""): string {
  return `/vh/session/${SID}/queue${suffix}?dir=${encodeURIComponent(demoDir)}`;
}

// cleanQueue removes every item currently in the "other" session's queue. Used
// before/after each test for isolation. Safe for terminal items (sent/failed/
// unknown) and pending; a leftover dispatching item would 409 (rare — our setup
// always resolves to terminal before the browser touches it) and is ignored.
async function cleanQueue(request: APIRequestContext): Promise<void> {
  const res = await request.get(apiUrl());
  if (!res.ok()) return;
  const j = await res.json().catch(() => ({}));
  const items: Array<{ id: string }> = Array.isArray(j.items) ? j.items : [];
  for (const it of items) {
    await request.delete(apiUrl(`/${encodeURIComponent(it.id)}`), { headers: jsonCsrf });
  }
}

// setupChip drives a deterministic terminal chip through the real queue API:
// enqueue → claim → resolve. Returns the resolved item. The browser later
// observes it via its normal poll. Because setup completes before page.goto, the
// item is terminal when the browser first sees it → no drainer dispatch race.
async function setupChip(
  request: APIRequestContext,
  text: string,
  state: "failed" | "unknown",
): Promise<{ id: string }> {
  const enq = await request.post(apiUrl(), { headers: jsonCsrf, data: { text } });
  expect(enq.ok(), `enqueue "${text}"`).toBeTruthy();
  const enqueued = (await enq.json()).item;
  expect(enqueued?.id, "enqueue returned an item id").toBeTruthy();

  // Claim moves the item pending → dispatching (resolve rejects a still-pending
  // item with 409). After cleanQueue this is the only pending item, so claim
  // returns exactly the one we just enqueued.
  const claimRes = await request.post(apiUrl("/claim"), { headers: jsonCsrf, data: {} });
  const claimed = (await claimRes.json()).item;
  expect(claimed?.id, "claim returned the just-enqueued item").toBe(enqueued.id);

  const resRes = await request.post(apiUrl(`/${encodeURIComponent(enqueued.id)}/resolve`), {
    headers: jsonCsrf,
    data: { state, detail: "e2e fixture setup" },
  });
  expect(resRes.ok(), `resolve → ${state}`).toBeTruthy();
  return { id: enqueued.id };
}

test.beforeEach(async ({ request }) => {
  await cleanQueue(request);
});

test.afterEach(async ({ request }) => {
  await cleanQueue(request);
});

test("retract a failed chip restores its text into the composer", async ({ page, request }) => {
  await setupChip(request, "RETRACT_TARGET", "failed");
  await page.goto(projectUrl("/?session=other"));

  const chip = page
    .locator('.queue-chip[data-state="failed"]')
    .filter({ hasText: "RETRACT_TARGET" });
  await expect(chip).toBeVisible();

  // Retract requires an EMPTY composer (its occupied-composer guard refuses
  // otherwise). Clear any persisted per-session draft so the precondition holds.
  const ta = page.getByPlaceholder(/Message/);
  await ta.fill("");
  await expect(ta).toHaveValue("");

  // Retract (edit icon) → confirm-deletes the old item, then restores the text.
  await chip.locator(".queue-retract").click();

  // The composer now holds the recovered text; the chip is gone (deleted).
  await expect(ta).toHaveValue("RETRACT_TARGET");
  await expect(chip).toHaveCount(0);
});

test("occupied-composer guard refuses to overwrite an in-progress draft", async ({ page, request }) => {
  await setupChip(request, "GUARD_TARGET", "failed");
  await page.goto(projectUrl("/?session=other"));

  const chip = page
    .locator('.queue-chip[data-state="failed"]')
    .filter({ hasText: "GUARD_TARGET" });
  await expect(chip).toBeVisible();

  // Occupy the composer with an in-progress draft. Retract's preflight guard
  // must refuse rather than silently discard it.
  const ta = page.getByPlaceholder(/Message/);
  await ta.fill("MY DRAFT IN PROGRESS");
  await expect(ta).toHaveValue("MY DRAFT IN PROGRESS");

  await chip.locator(".queue-retract").click();

  // Guard fired: the draft is untouched (NOT overwritten with the chip's text)
  // and the chip is still present (the DELETE never ran). This is the
  // occupied-composer TOCTOU guard (Phase 1) proving out at the browser level.
  await expect(ta).toHaveValue("MY DRAFT IN PROGRESS");
  await expect(chip).toBeVisible();
  // And the chip's own text was NOT smuggled into the composer.
  await expect(ta).not.toHaveValue("GUARD_TARGET");
});

test("mark-sent on an unknown chip resolves it and the chip disappears", async ({ page, request }) => {
  const { id } = await setupChip(request, "MARK_SENT_TARGET", "unknown");
  await page.goto(projectUrl("/?session=other"));

  const chip = page
    .locator('.queue-chip[data-state="unknown"]')
    .filter({ hasText: "MARK_SENT_TARGET" });
  await expect(chip).toBeVisible();

  // Mark-sent (check icon) → resolveQueued(... "sent") → the only auto-clear
  // state. `sent` is filtered from the visible queue, so the chip vanishes.
  // This NEVER enqueues or dispatches (resolve only records an outcome).
  await chip.locator(".queue-mark-sent").click();

  await expect(chip).toHaveCount(0);

  // Durable daemon-persisted `sent` proof. Chip disappearance alone is
  // satisfiable by the FE's OPTIMISTIC-LOCAL terminal state: resolveQueued
  // applies the known outcome to the in-memory cache BEFORE the resolve
  // POST completes/retries (web/src/queue.ts:329-351). A future reader could
  // wrongly cite the chip-disappearance assertion above as evidence of durable
  // persistence / no-redispatch. Close that gap by polling the daemon's own
  // authoritative store: GET /vh/session/<sid>/queue (the same real queue API
  // the `request` fixture drives in setup) until the target item's durable
  // state reflects `sent`.
  //
  // The daemon's List() does NOT filter `sent` (that filtering is FE-only) and
  // a freshly-resolved `sent` item survives compaction (1h TTL / cap 50), so
  // the item stays present with state "sent". store.Resolve persists the
  // terminal outcome atomically before returning (pkg/web/queue.go:768), so
  // once this reads "sent" it is durable daemon state, not an optimistic
  // projection. The bounded poll avoids a flaky synchronous read right after
  // the click (the resolve write may still be in flight).
  await expect.poll(
    async () => {
      const res = await request.get(apiUrl());
      const j = await res.json().catch(() => ({}));
      const items: Array<{ id: string; state: string }> = Array.isArray(j.items) ? j.items : [];
      return items.find((it) => it.id === id)?.state;
    },
    { timeout: 10_000, message: "daemon queue reflects durable `sent` for the target item" },
  ).toBe("sent");
});

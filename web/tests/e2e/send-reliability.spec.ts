// Send-reliability slice 3 — lane-6 e2e extension (mandated coverage a–e).
//
// The fixture server serves the REAL pkg/web queue handlers (queue_http.go →
// queue.go), so these are true cross-layer proofs of the slice-1/2/3
// admission contracts, not FE mocks:
//
//   (a) enqueue carries attemptId on the wire (captured request body),
//   (b) the replayed feature-detect works against the REAL server envelope
//       (`replayed` present and correct on fresh + replay),
//   (c) a replay of the same attemptId → exactly ONE queue item (no dup chip
//       materialized server-side) — plus, in the browser test, exactly ONE
//       downstream dispatch,
//   (d) an admission conflict is an explicit definitive 409 +
//       queue_admission_conflict (the FE surfaces an explicit state — no
//       retry-forever; FE surfacing pinned in SendStatus.test.tsx),
//   (e) a resolve-conflict STOPS: 409 queue_resolve_conflict, stored truth
//       preserved (FE stop-behavior pinned in queue.test.ts /
//       sendActionStatus tests).
//
// The browser test drives the FULL user-visible recovery arc through the real
// event model (type + click Send + click Retry same message) against the real
// server: the enqueue POST's response is LOST after the server processed it
// (Playwright route.fetch() performs the real admission, then route.abort()
// kills the browser's response), the reconcile LIST is equally blind → the
// SPA settles to outcome-unknown, renders "Queue confirmation unknown." with
// the payload-surfacing Retry-same-message affordance, and the operator's
// re-tap replays the SAME attemptId (server dedupes → exactly one item,
// exactly one dispatch, composer retained — a row retry never modifies the
// composer).
//
// Serial-suite hygiene (workers:1, one shared fixtureserver): every test owns
// + cleans its queue state; the browser test uses the agent-hold fixture
// session ("agenthold") for DETERMINISTIC agent evidence (arm/release/reset —
// same protocol as agent-hydration-send.spec.ts) and resets it after.

import { expect, test, type APIRequestContext, type Route } from "@playwright/test";
import { demoDir, projectUrl } from "./util";

const SID = "other";
const HOLD_SESSION = "agenthold";
const jsonCsrf = { "Content-Type": "application/json", "X-VH-CSRF": "1" };
const csrf = { "X-VH-CSRF": "1" };

// F6 (slice-3 review): per-run unique suffix for the API tests' attempt ids.
// Per-item deletion does NOT clear the server's admission receipts (replay
// after removal answers the original receipt — the TESTED contract), so FIXED
// ids flip replayed:false→true on repeat runs against a reused fixture
// server. Evaluated once per worker process; the serial suite (workers:1)
// gets exactly one suffix per run, and a CI retry re-loads the file fresh.
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function apiUrl(sid: string, suffix = ""): string {
  return `/vh/session/${sid}/queue${suffix}?dir=${encodeURIComponent(demoDir)}`;
}

async function cleanQueue(request: APIRequestContext, sid: string): Promise<void> {
  const res = await request.get(apiUrl(sid));
  if (!res.ok()) return;
  const j = await res.json().catch(() => ({}));
  const items: Array<{ id: string }> = Array.isArray(j.items) ? j.items : [];
  for (const it of items) {
    await request.delete(apiUrl(sid, `/${encodeURIComponent(it.id)}`), { headers: jsonCsrf });
  }
}

test.beforeEach(async ({ request }) => {
  await cleanQueue(request, SID);
});

test.afterEach(async ({ request }) => {
  await cleanQueue(request, SID);
  await cleanQueue(request, HOLD_SESSION);
  // Hygiene for the agent-hold fixture (no-op unless the browser test ran).
  await request.post(`/oc/fixture/agent-hold/reset`, { headers: csrf }).catch(() => {});
});

test("(a+b+c API) enqueue carries attemptId on the wire; the real envelope reports replayed; a replay creates exactly one item", async ({ request }) => {
  const att = `att-e2e-envelope-${RUN}`;
  const first = await request.post(apiUrl(SID), {
    headers: jsonCsrf,
    data: { text: "envelope probe", attemptId: att },
  });
  expect(first.ok(), "fresh admission").toBeTruthy();
  const firstBody = await first.json();
  // (b) fresh admission: the envelope carries replayed=false — the field the
  // FE feature-detects (absence ⇒ legacy server).
  expect(firstBody.replayed).toBe(false);
  // (a) the server echoes the attemptId on the item — the wire carried it.
  expect(firstBody.item.attemptId).toBe(att);

  // Replay the SAME (attemptId, payload).
  const replay = await request.post(apiUrl(SID), {
    headers: jsonCsrf,
    data: { text: "envelope probe", attemptId: att },
  });
  expect(replay.ok()).toBeTruthy();
  const replayBody = await replay.json();
  expect(replayBody.replayed).toBe(true);
  expect(replayBody.item.id).toBe(firstBody.item.id);

  // (c) exactly ONE item exists — no duplicate from the replay.
  const list = await request.get(apiUrl(SID));
  const items: Array<{ id: string; attemptId?: string }> = (await list.json()).items;
  expect(items).toHaveLength(1);
  expect(items[0].id).toBe(firstBody.item.id);
});

test("(d API) admission conflict is an explicit definitive 409 — the FE surfaces a state, never a retry loop", async ({ request }) => {
  const att = `att-e2e-conflict-${RUN}`;
  const first = await request.post(apiUrl(SID), {
    headers: jsonCsrf,
    data: { text: "one", attemptId: att },
  });
  expect(first.ok()).toBeTruthy();

  // Same attemptId, CHANGED payload: the server's explicit conflict contract.
  // On the FE this classifies definitive/conflict (EnqueueError code
  // queue_admission_conflict → SendStatus "Queue state conflict…"), a
  // terminal state — the retry loop provably cannot happen (unit-pinned).
  const conflict = await request.post(apiUrl(SID), {
    headers: jsonCsrf,
    data: { text: "two", attemptId: att },
  });
  expect(conflict.status()).toBe(409);
  expect((await conflict.json()).code).toBe("queue_admission_conflict");

  // The original admission is untouched (exactly one item, original text).
  const list = await request.get(apiUrl(SID));
  const items: Array<{ attemptId?: string; text: string }> = (await list.json()).items;
  expect(items).toHaveLength(1);
  expect(items[0].text).toBe("one");
});

test("(e API) resolve-conflict stops: 409 queue_resolve_conflict, stored truth preserved", async ({ request }) => {
  const enq = await request.post(apiUrl(SID), {
    headers: jsonCsrf,
    data: { text: "resolve probe", attemptId: `att-e2e-resolve-${RUN}` },
  });
  const itemId = (await enq.json()).item.id;
  const claim = await request.post(apiUrl(SID, "/claim"), { headers: jsonCsrf, data: {} });
  expect(claim.ok()).toBeTruthy();

  const resolve = async (state: string, detail: string) =>
    request.post(apiUrl(SID, `/${encodeURIComponent(itemId)}/resolve`), {
      headers: jsonCsrf,
      data: { state, detail },
    });

  // unknown is a legal first terminal.
  expect((await resolve("unknown", "interrupted")).status()).toBe(200);
  // unknown → sent: allowed (monotonic terminal upgrade).
  expect((await resolve("sent", "seen in transcript")).status()).toBe(200);
  // sent → failed: the EXPLICIT conflict. Terminal for the write — the FE's
  // bounded resolve loop STOPS on it (resolveWithRetry returns conflict; no
  // retry-forever), and the server's stored truth stays `sent`.
  const conflict = await resolve("failed", "late report");
  expect(conflict.status()).toBe(409);
  expect((await conflict.json()).code).toBe("queue_resolve_conflict");

  const list = await request.get(apiUrl(SID));
  const items: Array<{ id: string; state: string; detail: string }> = (await list.json()).items;
  expect(items).toHaveLength(1);
  expect(items[0].state).toBe("sent");
  expect(items[0].detail).toBe("seen in transcript");
});

// The full user-visible recovery arc (a+b+c+UI): a real send whose enqueue
// response is LOST after server admission settles to the honest
// outcome-unknown state; the operator's Retry same message replays the SAME
// attemptId; the server dedupes to exactly one item and exactly one dispatch;
// the status row resolves (a record-addressed row retry never modifies the
// composer — O2 review A-F1).
test("(browser) lost enqueue response → 'Queue confirmation unknown.' + Retry same message (same attemptId) recovers custody with no duplicate", async ({ page, request }) => {
  test.setTimeout(90_000);

  // Deterministic agent evidence (same protocol as agent-hydration-send):
  // arm → open the held session → release → the composer resolves @plan.
  const arm = await request.post(`/oc/fixture/agent-hold/arm`, { headers: csrf });
  if (!arm.ok()) throw new Error(`agent-hold arm failed: ${arm.status()}`);

  // Capture every downstream dispatch (prompt_async) — the dedupe crux is
  // that the recovered send dispatches EXACTLY ONCE.
  const prompts: unknown[] = [];
  await page.route("**/oc/session/*/prompt_async", async (route) => {
    if (route.request().method() === "POST") {
      try {
        prompts.push(route.request().postDataJSON());
      } catch {
        prompts.push({});
      }
    }
    await route.continue();
  });

  await page.goto(projectUrl("/"));
  await page.locator(`.tree-node[data-session-id="${HOLD_SESSION}"]`).click();
  await expect(page.locator(".model-btn")).toBeVisible({ timeout: 10_000 });
  const rel = await request.post(`/oc/fixture/agent-hold/release`, { headers: csrf });
  if (!rel.ok()) throw new Error(`agent-hold release failed: ${rel.status()}`);
  await expect(page.locator(".composer .agent-select .vh-select-label")).toHaveText("@plan", { timeout: 10_000 });

  // The transport fault injection: the browser's queue POSTs to the held
  // session are REALLY performed against the fixture server (route.fetch —
  // the admission lands server-side), then the browser's response is KILLED
  // (route.abort — the fetch rejects network-class). Queue GETs are equally
  // blind so reconcile-first cannot confirm custody either. Registered as a
  // NAMED handler so ONLY this route is lifted for recovery (the prompt_async
  // capture must keep running — it proves single-dispatch after the retry).
  const wireAttempts: string[] = [];
  let firstServerAdmission: { replayed?: boolean; item?: { attemptId?: string } } | null = null;
  const queueRouteHandler = async (route: Route) => {
    const req = route.request();
    if (req.method() === "POST") {
      try {
        wireAttempts.push(req.postDataJSON().attemptId);
      } catch {
        wireAttempts.push("");
      }
      const apiResp = await route.fetch(); // the REAL server admission
      if (!firstServerAdmission) {
        const txt = await apiResp.text();
        firstServerAdmission = txt ? JSON.parse(txt) : null;
      }
      await route.abort("connectionfailed"); // the browser never sees it
    } else if (req.method() === "GET") {
      await route.abort("connectionfailed"); // reconcile + poll stay blind
    } else {
      await route.fallback();
    }
  };
  await page.route(`**/vh/session/${HOLD_SESSION}/queue`, queueRouteHandler);

  // Real user gesture: type + click Send through the real event model. The
  // message is DELIBERATELY longer than the 80-char compact-preview bound so
  // the same arc also proves the O2-slice-2 bounded full-text payload
  // expansion (collapsed clip → "Show full message" → verbatim stored text).
  const MSG =
    "E2E RETRY SAME — full-text expansion probe. This stored message body is deliberately far longer than the eighty-character compact preview bound, so the collapsed Same-message quote is clipped and the Show-full-message affordance must render the stored text verbatim inline.";
  const MSG_TAIL = "verbatim inline"; // unique to the FULL stored text
  const ta = page.getByPlaceholder(/Message/);
  await ta.fill(MSG);
  await page.locator(".composer-bar .send-btn").click();

  // (a) the wire carried an attemptId; the server admitted the item (the
  // fetch-performed admission got a 200 with an attemptId echo).
  await expect
    .poll(() => wireAttempts.length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);
  expect(wireAttempts[0]).toBeTruthy();
  // The handler captures the admission body AFTER route.fetch resolves —
  // poll for it rather than racing the handler's post-fetch assignment.
  await expect.poll(() => firstServerAdmission !== null, { timeout: 10_000 }).toBe(true);
  expect(firstServerAdmission?.replayed).toBe(false);
  expect(firstServerAdmission?.item?.attemptId).toBe(wireAttempts[0]);

  // The honest outcome-unknown state renders — readable text, payload
  // surfacing ("Same message:"), and the retry-SAME affordance (never an
  // unqualified Retry). O2 slice 2: the collapsed preview is the 80-char
  // CLIP (tail absent); "Show full message" expands the verbatim stored
  // text INLINE in the row (no new surface), and toggles back.
  const statusRow = page.locator(".sendStatusLine", { hasText: "Queue confirmation unknown." });
  await expect(statusRow).toBeVisible({ timeout: 15_000 });
  await expect(statusRow).toContainText("Check the queue, or retry this same message.");
  await expect(statusRow).toContainText("Same message:");
  await expect(statusRow).toContainText("E2E RETRY SAME");
  await expect(statusRow).not.toContainText(MSG_TAIL);
  const fullBtn = statusRow.locator(".sendStatusMore", { hasText: "Show full message" });
  await expect(fullBtn).toBeVisible();
  await fullBtn.click();
  await expect(statusRow).toContainText(MSG_TAIL);
  await expect(statusRow).toContainText(MSG);
  await expect(
    statusRow.locator(".sendStatusMore", { hasText: "Hide full message" }),
  ).toBeVisible();
  await expect(statusRow.locator(".sendStatusBtn", { hasText: "Retry same message" })).toBeVisible();

  // The composed text is PRESERVED (no silent loss) and nothing dispatched.
  await expect(ta).toHaveValue(MSG);
  expect(prompts).toHaveLength(0);

  // Recovery: restore transport (ONLY the queue route — the prompt_async
  // capture stays armed for the single-dispatch proof), then the operator
  // re-taps the SAME message.
  await page.unroute(`**/vh/session/${HOLD_SESSION}/queue`, queueRouteHandler);
  const replayRespPromise = page.waitForResponse(
    (r) => r.url().endsWith(`/vh/session/${HOLD_SESSION}/queue`) && r.request().method() === "POST",
    { timeout: 20_000 },
  );
  await statusRow.locator(".sendStatusBtn", { hasText: "Retry same message" }).click();
  const replayResp = await replayRespPromise;
  expect(replayResp.status()).toBe(200);
  // (b) the REAL envelope answers replayed:true for the same attemptId —
  // this is exactly the response the FE's feature-detect consumes.
  const replayBody = await replayResp.json();
  expect(replayBody.replayed).toBe(true);
  expect(replayBody.item.attemptId).toBe(wireAttempts[0]);
  // The retry reused the SAME attemptId on the wire (no fresh attempt).
  expect(wireAttempts[wireAttempts.length - 1]).toBe(wireAttempts[0]);

  // Custody confirmed → the unknown-status row resolves (user-visible
  // recovery outcome). Record-addressed retry (O2 slice-1 review A-F1): a
  // row retry NEVER modifies the composer — the replayed message's text
  // intentionally remains for the operator to clear or edit for the next
  // send (the row's own preview always advertised the stored payload, and
  // the verbatim replay is what recovered custody).
  await expect(statusRow).toHaveCount(0);
  await expect(ta).toHaveValue(MSG);

  // (c) exactly ONE item server-side under this attemptId — no duplicate —
  // and exactly ONE downstream dispatch of the recovered message.
  await expect
    .poll(
      async () => {
        const res = await request.get(apiUrl(HOLD_SESSION));
        const items: Array<{ attemptId?: string }> = (await res.json().catch(() => ({ items: [] }))).items ?? [];
        return items.filter((it) => it.attemptId === wireAttempts[0]).length;
      },
      { timeout: 10_000, message: "exactly one daemon queue item under the replayed attemptId" },
    )
    .toBe(1);
  await expect
    .poll(() => prompts.length, { timeout: 20_000, message: "the recovered message dispatches exactly once" })
    .toBe(1);
});

import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Agent-hydration send gate (lane 6): the browser-level proof of the landed
// agent-silent-flip fix (commit 055c10f) — the riding DEFERs aF2/dF3 asked
// for exactly this real-browser crux. Unit seams: agents-resolver.test.ts /
// createSend gate tests (lane 5, fake timers own the 10s-timeout behavior —
// deliberately NOT exercised here).
//
// Crux sequence (the interaction-reachability receipt this spec produces):
//   1. arm the fixture's agent-evidence hold and open the session — the row
//      is visible (nonempty session) but the message tail is withheld behind
//      a latch, so the composer's resolver is `pending`;
//   2. assert the composer shows "Resolving agent…" (NOT a default agent);
//   3. real gesture: type + click Send while the evidence is pending;
//   4. assert NO dispatch occurred while pending (the awaitSendAgent gate
//      holds; the tap is acknowledged by the Send button's in-flight state);
//   5. release the evidence (<1s — release is the only clock);
//   6. the composer flips to @plan;
//   7. EXACTLY ONE outgoing prompt_async carries agent:"plan";
//   8. the streamed reply completes visibly.
//
// Fixture: POST /oc/fixture/agent-hold/{arm,release,reset} (pkg/fixtures/
// opencode.go). Arm deterministically resets BOTH the fixture-side transcript
// AND the aggregator-visible state (session.deleted → session.created wipes
// messages, msgLoaded, lastAgent, and the cold-seed memo — both memoization
// traps), so the spec is order-independent within the serial suite. Reset
// removes the session entirely: sibling specs never observe it.
//
// Serial-suite hygiene: fresh context per test → clean localStorage (no
// sessionAgentPicks residue that could override the evidence path).

const HOLD_SESSION = "agenthold";
const csrf = { "X-VH-CSRF": "1" };

test.beforeEach(async ({ request }) => {
  // Uses the bare `request` fixture (NOT page.request): in beforeEach the page
  // has not navigated yet, so page.request would resolve the relative URL
  // against about:blank and silently no-op (same rationale as resetPins).
  const res = await request.post(`/oc/fixture/agent-hold/arm`, { headers: csrf });
  if (!res.ok()) {
    throw new Error(`agent-hold arm failed: ${res.status()} ${res.statusText()}`);
  }
});

test.afterEach(async ({ request }) => {
  // Hygiene: release any held GET, remove the session row + transcript, and
  // purge the aggregator-visible state — zero residue for sibling specs. Best
  // effort: a failing cleanup must not mask the test's own failure.
  await request
    .post(`/oc/fixture/agent-hold/reset`, { headers: csrf })
    .catch(() => {});
});

test("send while agent evidence is pending dispatches exactly once with the evidence-backed agent", async ({ page, request }) => {
  // Capture every outgoing prompt POST (the SPA's send path: gate → enqueue →
  // drain → POST /oc/session/:id/prompt_async with body.agent). Registered
  // before goto so nothing can slip past (page routes persist navigations).
  const posts: { agent?: string; parts?: unknown[] }[] = [];
  await page.route("**/oc/session/*/prompt_async", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      try {
        posts.push(req.postDataJSON());
      } catch {
        posts.push({});
      }
    }
    await route.continue();
  });

  await page.goto(projectUrl("/"));

  // 1. Open the held session via a real tree-row click. The row is present
  //    (arm made it nonempty + visible); the click routes the chat view and
  //    the client-open message fetch blocks on the fixture latch.
  await page.locator(`.tree-node[data-session-id="${HOLD_SESSION}"]`).click();

  // 2. Pending window: the composer shows the explicit pending state — NOT a
  //    default agent pick (that is the silent flip this fixture exists to
  //    disprove). Agents must be loaded for the bar to render at all.
  const resolving = page.locator(".composer .bar-loading", { hasText: "Resolving agent…" });
  await expect(resolving).toBeVisible({ timeout: 10000 });

  // Models loaded → readyToSend holds, so the Send button is clickable (the
  // gate is the AGENT evidence, not the model list).
  await expect(page.locator(".model-btn")).toBeVisible({ timeout: 10000 });

  // 3. Real user gesture while evidence is pending: type + click Send through
  //    the real event model (no API-call stand-in).
  await page.getByPlaceholder(/Message/).fill("agent hydration probe");
  await page.locator(".composer-bar .send-btn").click();

  // 4. The tap was acknowledged (single-flight engaged → "Sending…", button
  //    disabled) and admission is parked in the evidence gate. This state is
  //    STABLE — evidence is withheld until the release below, so there is no
  //    race between this assertion and a wrongful dispatch.
  const sendBtn = page.locator(".composer-bar .send-btn");
  await expect(sendBtn).toHaveAttribute("aria-label", "Sending…", { timeout: 10000 });

  // 4b. O2 slice 2 — STATIC tap acknowledgement: the former infinite
  //     icon-opacity pulse is gone (no animation loop even without
  //     prefers-reduced-motion); the disabled + dimmed button IS the ack.
  await expect(sendBtn.locator(".icon")).toHaveCSS("animation-name", "none");
  // 4c. O2 slice 2 — compact merged happy-path line: the parked preparing
  //     record renders as ONE calm progress row (not a per-record ledger).
  await expect(page.locator('.sendStatusLine[data-kind="progress"]')).toHaveText("Sending…");

  // 4d. O2 slice-2 review C-F4 — production-bundle CSS-content guard. The
  //     webServer serves the PRODUCTION-built SPA (fixture-web.sh runs
  //     `npm run build`), so computed styles here prove the co-located
  //     Composer.css/SendStatus.css actually REACHED the bundle: slice-2
  //     review C-F1 found both former pure-:global css modules tree-shaken
  //     from the built CSS (empty locals → moduleSideEffects:false), while
  //     the JS carried the markup — every style below was inert and the
  //     announcer rendered as visible duplicated raw status text.
  //     (a) opacity 0.75 also proves the C-F2 specificity fix:
  //         '.send-btn.sending:disabled' (0,3,0) beats the later-emitted
  //         legacy '.send-btn:disabled { opacity: 0.45 }' (0,2,0) — component
  //         CSS is emitted BEFORE the legacy shards (index.tsx imports App
  //         before './styles/main.css'), so a same-specificity tie would
  //         render 0.45.
  await expect(sendBtn).toHaveCSS("opacity", "0.75");
  //     (b) the polite announcer mirror is VISUALLY HIDDEN by SendStatus.css's
  //         sr-only clip recipe (1px absolute clip box) — without the
  //         stylesheet it is a visible duplicate of the status text.
  const announcer = page.locator('[data-testid="send-status-announcer"]');
  await expect(announcer).toHaveCSS("position", "absolute");
  await expect(announcer).toHaveCSS("width", "1px");
  await expect(announcer).toHaveCSS("height", "1px");
  await expect(announcer).toHaveCSS("overflow", "hidden");
  await expect(announcer).toHaveCSS("clip-path", "inset(50%)");

  // No dispatch while pending: still resolving after a bounded settle window
  // (any wrongful dispatch would have landed here), and ZERO prompt_async
  // requests left the browser.
  await expect(resolving).toBeVisible();
  await page.waitForTimeout(400);
  expect(posts).toHaveLength(0);

  // 5. Release the evidence — release is the only clock (<1s by construction:
  //    the held GET completes immediately and the reconcile fans out).
  const rel = await request.post(`/oc/fixture/agent-hold/release`, { headers: csrf });
  if (!rel.ok()) {
    throw new Error(`agent-hold release failed: ${rel.status()} ${rel.statusText()}`);
  }

  // 6. The composer flips from the pending state to the evidence-backed agent.
  await expect(page.locator(".composer .agent-select")).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".composer .agent-select .vh-select-label")).toHaveText("@plan");

  // 7. Exactly one dispatch, carrying the evidence-backed agent — never the
  //    fixture/global default. (Poll on the captured request — the crux is
  //    what left the browser, not server-side turn settlement.)
  await expect.poll(() => posts.length, { timeout: 15000 }).toBe(1);
  expect(posts[0].agent).toBe("plan");
  expect(posts.length).toBe(1);

  // 8. Visible send completion: the fixture's streamed reply lands and the
  //    button returns from the in-flight state.
  await expect(page.getByText(/Done\. Updated/).first()).toBeVisible({ timeout: 10000 });
  await expect(sendBtn).toHaveAttribute("aria-label", "Send");
});

import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// TreeRow status-dot family — dedicated e2e coverage. DEFER from the 2408fb1
// review: `.dot.error` / `.dot.retry` / `.dot.needs-input` had no dedicated
// spec while `.dot.unread` did (unread-dot.spec.ts, the structural model for
// this file). Both DEFER triggers — path_touched(TreeRow.tsx) and
// path_touched(web/tests/e2e/) — have since fired.
//
// RENDER CONDITIONS (web/src/components/TreeRow.tsx, verified this slice):
//   .dot.error        <Show when={!isWorking() && isError()}>
//                                     isError    = activity === "error"
//   .dot.needs-input  <Show when={needsInput()}>
//                                     needsInput = flags.pendingInput
//                                                || flags.subtreeNeedsInput
//   .dot.retry        REMOVED as dead markup: working() includes
//                                     activity === "retry"
//                                     (web/src/sync/treeSelectors.ts), so the
//                                     old !isWorking() && isRetry() gate was
//                                     unsatisfiable — the twisty running ring
//                                     is the retry signal (by design, unit-
//                                     pinned in web/tests/unit/TreeRow.test.tsx
//                                     "renders NO retry dot"). The retry
//                                     absence assertions below pin the OUTCOME
//                                     (no retry dot ever renders again — a
//                                     future satisfiable retry-dot path fails
//                                     them); an exact re-add of the dead span
//                                     itself is invisible to DOM assertions
//                                     and stays a code-review concern.
// isWorking = working(node) = busy || retry || subtreeBusy || subtreeNeedsInput
// (web/src/sync/treeSelectors.ts). The error/unread dots are suppressed while
// working; needs-input is the documented exception (stays visible even on a
// working subtree-needs-input ancestor).
//
// FIXTURE DRIVABILITY AUDIT (pkg/fixtures/opencode.go; emit census re-run
// this slice):
//
//   needs-input — DRIVABLE. prompt_async with a `[[ask]]` body arms a pending
//     question (simulatePrompt) → the aggregator store sets the node's
//     PendingInput flag (pkg/state/tree_node.go) → the dot renders.
//     The disappearance pin uses /fixture/reset's question.replied fan-out
//     (handleFixtureReset — clears the store blocker AND forwards the delete
//     to a connected SPA). Reset ALSO recreates the session row
//     (session.deleted + session.created, resetSessionQueueState), so the
//     post-reset absence check ANCHORS on the recreated row
//     (resetSessionAwaitingRecreation) — still reset-clears-the-dot
//     coverage, not an isolated question-resolution proof (see the NOTE at
//     the assertion).
//
//   error — DRIVABLE since this slice via /fixture/error (handleFixtureError,
//     the /fixture/idle sibling): it emits the turn-terminal session.error
//     through the real /event stream — the ONLY wire shape that seeds
//     ActivityError (a session.status type:"error" observation normalizes to
//     idle in pkg/state). The event flows fixture → aggregator store → tree
//     activity facet → this SPA, so the dot appears live. /fixture/reset
//     clears it the way it clears busy: its own session.idle fan-out (an
//     activity error→idle transition). Pinned: appearance + idle-baseline
//     absence + post-reset clear (below).
//
//   retry — no HTTP seam (deliberately out of scope): the only retry-status
//     producer is the TEST-ONLY EmitSessionRetry (no HTTP route), and the
//     retry DOT no longer exists in production markup (see RENDER CONDITIONS).
//     Retry's real UI signal (the running ring) is exercised by the busy/
//     working coverage here and in the unit pin. A retry-status HTTP seam has
//     no dot to drive; if one is ever wanted for ring coverage, /fixture/busy
//     already covers the working-ring render path.
//
// SHARED-STATE CONTRACT (serial lane, ONE mutable fixture backend — the
// unread-dot.spec.ts / compaction-burst.spec.ts conventions):
//   - uses `other` (childless root, clean activity history — the unread-dot
//     precedent; `demo` is prompted by ~half the suite). `sub` is untouched
//     (arming a blocker on it would roll subtreeNeedsInput onto demo and
//     disturb tree-structure specs).
//   - every test PRE-resets `other` (absorb prior specs' leakage) and the
//     file-level afterEach resets it again (restore seeded transcript, clear
//     mirrored busy, resolve armed blockers — opencode.go handleFixtureReset).
//     The retired hydrating-dot spec was cited as a shared-state PRODUCER;
//     this spec leaves `other` at its seeded idle baseline.

type Page = import("@playwright/test").Page;

// One status dot inside a session's tree row (same locator shape as
// unread-dot.spec.ts's dot() helper).
function dot(page: Page, id: string, kind: "error" | "retry" | "needs-input") {
  return page.locator(`.tree-node[data-session-id="${id}"] .dot.${kind}`);
}

// Reset a session to its seeded baseline (serial-suite hygiene). Mirrors
// compaction-burst.spec.ts resetSession — reached through the real /oc/*
// proxy; the CSRF header satisfies the state-changing-request guard.
async function resetSession(page: Page, id: string) {
  const res = await page.request.post(`/oc/fixture/reset?session=${id}`, {
    headers: { "X-VH-CSRF": "1" },
  });
  if (!res.ok()) throw new Error(`resetSession(${id}) -> ${res.status()} ${res.statusText()}`);
}

// Reset a session AND deterministically await its row's RECREATION before
// returning — the anchor for the post-reset dot-absence checks (review
// e06b984 F1: the old bare toHaveCount(0) could pass vacuously).
//
// Why recreation is awaitable by ELEMENT IDENTITY (DOM evidence): reset ends
// with resetSessionQueueState emitting session.deleted THEN session.created
// back-to-back (pkg/fixtures/opencode.go:3069-3071). The SPA receives both
// structurally — tree.op node.remove + node.upsert (tree-transport.ts:
// session.delete/created "emitted on BOTH wires") — and the tree renders
// rows through KEYED <For> (SessionTree sections / TreeBranch children), so
// the remove DISPOSES the old row element and the re-add mounts a FRESH one.
//
// Why identity and not detach→re-attach: the two emits can be co-delivered
// and applied within one Playwright poll interval, making the transient
// no-row state UNOBSERVABLE — an expect(row).not.toBeAttached() step could
// time out on correct behavior, and a bare locator re-resolve +
// toBeVisible() can bind the still-attached OLD element (proving nothing).
// Comparing the attached row against a page-realm reference to the pre-reset
// element needs only the END state: recreation happened ⟺ identity differs.
// If reset ever stopped recreating the row this times out — the anchor
// self-verifies the recreation premise.
//
// The capture lives on `window` (page realm), not an ElementHandle arg, so
// the comparison is a true in-page reference compare; each test's
// page.goto() starts a fresh document realm, so it cannot leak across
// tests. Folding capture+reset+wait into ONE helper makes capture-after-
// reset (which could grab the fresh element and pass vacuously) structurally
// impossible.
async function resetSessionAwaitingRecreation(page: Page, id: string, timeout = 10000) {
  const sel = `.tree-node[data-session-id="${id}"]`;
  // Capture pre-reset (the caller has just asserted the row — and its dot —
  // visible, so a null here is a fixture-shape surprise, fail fast).
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`resetSessionAwaitingRecreation: row not attached at capture (${s})`);
    (window as { __vhPreResetRow?: Element | null }).__vhPreResetRow = el;
  }, sel);
  await resetSession(page, id);
  await page.waitForFunction(
    (s) => {
      const pre = (window as { __vhPreResetRow?: Element | null }).__vhPreResetRow;
      const cur = document.querySelector(s);
      return cur !== null && cur !== pre;
    },
    sel,
    { timeout },
  );
}

async function waitForTree(page: Page) {
  await expect(page.locator(".tree-node").first()).toBeVisible({ timeout: 10000 });
}

// Prompt a session through the same route the composer uses (copied from
// unread-dot.spec.ts): the in-page fetch is same-origin and the X-VH-CSRF
// header satisfies the state-changing-request guard. `[[ask]]` makes the
// fake arm a pending question and return without an assistant reply — the
// pendingInput FLAG persists (that is the dot's driver), while the turn's
// own deferred session.idle still fires (opencode.go:2902-2910), so the
// session itself is idle again with the question pending.
async function promptSession(page: Page, id: string, text: string) {
  await page.evaluate(
    async ({ id, text }) => {
      const res = await fetch(`/oc/session/${id}/prompt_async`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      });
      // 204 is the expected immediate ack (the reply streams over SSE).
      if (!res.ok && res.status !== 204) {
        throw new Error(`prompt_async ${id} -> ${res.status}`);
      }
    },
    { id, text },
  );
}

// needs-input — appearance + absence. `[[ask]]` arms the pending question
// (flags.pendingInput → dot); the reset's question.replied resolves it and
// the dot must clear live in the open SPA.
test("needs-input dot appears on a pending question and clears when it resolves", async ({ page }) => {
  await resetSession(page, "other");
  await page.goto(projectUrl("/?session=demo"));
  await waitForTree(page);

  // Absence before the driving state exists (idle, no blocker armed).
  await expect(dot(page, "other", "needs-input")).toHaveCount(0);

  // Arm the blocker. `other` is unselected (demo is open) — selection is
  // irrelevant to the dot (TreeRow derives it from node flags alone), but
  // this keeps the arming posture the same as unread-dot's. The turn emits
  // busy first; the needs-input dot is NOT suppressed by working() (the
  // documented exception), so it renders as soon as the question.asked SSE
  // frame lands in the tree node's flags.
  await promptSession(page, "other", "tree-row-dots probe [[ask]]");
  await expect(dot(page, "other", "needs-input")).toBeVisible({ timeout: 15000 });

  // Resolve via the reset's question.replied fan-out. The aggregator store
  // clears the blocker and forwards the delete to the connected SPA — the
  // row must drop the dot (absence when the driving state is not present).
  // NOTE (review e06b984 F1, strengthened): reset ends with a
  // session.deleted + session.created pair, so the SPA disposes and
  // RECREATES the row — the absence check below is ANCHORED on the
  // recreated row (resetSessionAwaitingRecreation proves the attached row
  // is a fresh element before the count runs; a bare toHaveCount(0) could
  // have polled the old-row-gone / new-row-not-yet-attached gap and passed
  // vacuously). Still reset-clears-the-dot coverage, NOT an isolated
  // question-resolution proof — reset both resolves the blocker AND
  // recreates the row; the isolated question.replied → flag-clear
  // transition stays pinned aggregator-side (pkg/state).
  await resetSessionAwaitingRecreation(page, "other");
  await expect(dot(page, "other", "needs-input")).toHaveCount(0, { timeout: 10000 });
});

// error — appearance + clear. /fixture/error (the /fixture/idle sibling)
// emits the turn-terminal session.error through the real /event stream; the
// aggregator store routes it to ActivityError (the only source — a
// session.status type:"error" would normalize to idle), the tree activity
// facet reaches this SPA over SSE, and the row must render the danger dot.
// /fixture/reset clears it via its own session.idle fan-out (the same
// error→idle transition that clears busy).
test("error dot appears via /fixture/error and clears on reset", async ({ page }) => {
  await resetSession(page, "other");
  await page.goto(projectUrl("/?session=demo"));
  await waitForTree(page);

  // Absence before the driving state exists (idle baseline).
  await expect(dot(page, "other", "error")).toHaveCount(0);

  // Arm the error terminal. `other` is unselected (demo is open) — the dot
  // derives from the node's activity alone, so selection is irrelevant.
  const res = await page.request.post(`/oc/fixture/error?session=other`, {
    headers: { "X-VH-CSRF": "1" },
  });
  if (!res.ok()) throw new Error(`fixture/error -> ${res.status()} ${res.statusText()}`);
  await expect(dot(page, "other", "error")).toBeVisible({ timeout: 15000 });

  // Clear via reset. NOTE (same confound as the needs-input pin, anchored
  // the same way — review e06b984 F1): reset's session.deleted +
  // session.created pair recreates the row, so the absence check below runs
  // only AFTER the recreated (fresh-element) row is attached
  // (resetSessionAwaitingRecreation — non-vacuous). It remains
  // reset-clears-the-dot coverage, not an isolated error→idle transition
  // proof — reset both fires its session.idle fan-out AND recreates the
  // row; the isolated transition is aggregator-side territory (pkg/state
  // pins own it).
  await resetSessionAwaitingRecreation(page, "other");
  await expect(dot(page, "other", "error")).toHaveCount(0, { timeout: 10000 });
});

// error + retry — absence coverage. error: pinned ABSENT at the idle
// baseline and under a sticky /fixture/busy turn (a working row must never
// leak a priority dot — error is suppressed while working; busy alone arms
// no needs-input). retry: the dot no longer exists in production markup
// (dead span removed); these assertions are regression guards against
// re-introducing an unsatisfiable render path. The busy row's running class
// is asserted FIRST so the busy-state absences are not vacuous.
test("error and retry dots stay absent on an idle and a busy session", async ({ page }) => {
  await resetSession(page, "other");
  await page.goto(projectUrl("/?session=demo"));
  await waitForTree(page);

  // Idle baseline: the drivable family is absent (error, needs-input); the
  // retry assertion pins that no retry dot RENDERS (span removed — see
  // header for what that guard does and does not catch).
  await expect(dot(page, "other", "error")).toHaveCount(0);
  await expect(dot(page, "other", "retry")).toHaveCount(0);
  await expect(dot(page, "other", "needs-input")).toHaveCount(0);

  // Sticky busy (handleFixtureBusy — busy until reset, no terminal).
  const res = await page.request.post(`/oc/fixture/busy?session=other`, {
    headers: { "X-VH-CSRF": "1" },
  });
  if (!res.ok()) throw new Error(`fixture/busy -> ${res.status()} ${res.statusText()}`);
  // Prove busy took: the row's running class is the working() signal.
  await expect(page.locator(`.tree-node[data-session-id="other"].running`)).toBeVisible({
    timeout: 10000,
  });
  // error absent under working is REAL coverage (working suppresses priority
  // dots); retry absent pins the same render-outcome — it would fail only on
  // a future retry-dot path that actually renders.
  await expect(dot(page, "other", "error")).toHaveCount(0);
  await expect(dot(page, "other", "retry")).toHaveCount(0);
  await expect(dot(page, "other", "needs-input")).toHaveCount(0);
});

// Serial-suite hygiene: restore `other` to its seeded idle baseline for the
// specs after this file (both tests mutate its activity/flags).
test.afterEach(async ({ page }) => {
  await resetSession(page, "other");
});

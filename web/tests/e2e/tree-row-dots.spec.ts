import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// TreeRow status-dot family — dedicated e2e coverage. DEFER from the 2408fb1
// review: `.dot.error` / `.dot.retry` / `.dot.needs-input` had no dedicated
// spec while `.dot.unread` did (unread-dot.spec.ts, the structural model for
// this file). Both DEFER triggers — path_touched(TreeRow.tsx) and
// path_touched(web/tests/e2e/) — have since fired.
//
// RENDER CONDITIONS (web/src/components/TreeRow.tsx, verified this slice):
//   .dot.error        :229-231  <Show when={!isWorking() && isError()}>
//                                     isError    = activity === "error"  (:103)
//   .dot.retry        :232-234  <Show when={!isWorking() && isRetry()}>
//                                     isRetry    = activity === "retry"  (:104)
//   .dot.needs-input  :235-237  <Show when={needsInput()}>
//                                     needsInput = flags.pendingInput
//                                                || flags.subtreeNeedsInput (:105)
// isWorking = working(node) = busy || retry || subtreeBusy || subtreeNeedsInput
// (web/src/sync/treeSelectors.ts:138-145). The error/retry/unread dots are
// suppressed while working; needs-input is the documented exception (stays
// visible even on a working subtree-needs-input ancestor).
//
// FIXTURE DRIVABILITY AUDIT (pkg/fixtures/opencode.go; exhaustive emit
// census — every HTTP-reachable session.status is type "busy", and NO
// handler ever emits session.error):
//
//   needs-input — DRIVABLE. prompt_async with a `[[ask]]` body arms a pending
//     question (simulatePrompt :2937-2957) → the aggregator store sets the
//     node's PendingInput flag (pkg/state/tree_node.go:46) → the dot renders.
//     The disappearance pin uses /fixture/reset's question.replied fan-out
//     (:3188-3190 — clears the store blocker AND forwards the delete to a
//     connected SPA). Caveat: reset ALSO recreates the session row, so that
//     pin is absence coverage, not an isolated question-resolution proof
//     (see the NOTE at the assertion).
//
//   error — NOT-DRIVABLE from the browser. activity === "error" needs a
//     session.error event; session.error production is reachable exclusively
//     from in-process Go e2e via the TEST-ONLY EmitSessionTerminal
//     (opencode.go:1329) — its sole HTTP sibling /fixture/idle (:3332)
//     hardcodes "session.idle", and no other handler emits it. Pinned:
//     ABSENCE only (idle + busy).
//
//   retry — NOT-DRIVABLE and, deeper, RENDER-DEAD (flagged, not papered
//     over). (a) The only retry-status producer is the TEST-ONLY
//     EmitSessionRetry (opencode.go:1312; sole caller
//     tests/e2e/fleet_status_e2e_test.go:1007 — no HTTP route). (b) Even
//     WITH activity === "retry" the dot cannot render: working() includes
//     activity === "retry" (treeSelectors.ts:141), so the render condition
//     !isWorking() && isRetry() is unsatisfiable — the twisty running ring
//     is the retry signal. That is deliberate and already unit-pinned
//     (web/tests/unit/TreeRow.test.tsx:154-162: ring present, .dot.retry
//     NULL for activity "retry"). A follow-up card is justified for either
//     an HTTP retry seam or removing the dead span; this spec pins the
//     retry-ABSENT half only.
//
// SHARED-STATE CONTRACT (serial lane, ONE mutable fixture backend — the
// unread-dot.spec.ts / compaction-burst.spec.ts conventions):
//   - uses `other` (childless root, clean activity history — the unread-dot
//     precedent; `demo` is prompted by ~half the suite). `sub` is untouched
//     (arming a blocker on it would roll subtreeNeedsInput onto demo and
//     disturb tree-structure specs).
//   - every test PRE-resets `other` (absorb prior specs' leakage) and the
//     file-level afterEach resets it again (restore seeded transcript, clear
//     mirrored busy, resolve armed blockers — opencode.go:3087-3224). The
//     retired hydrating-dot spec was cited as a shared-state PRODUCER; this
//     spec leaves `other` at its seeded idle baseline.

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
  // NOTE (review B1): this pin is reset-clears-the-dot coverage, NOT an
  // isolated question-resolution proof — /fixture/reset also recreates the
  // session row (session.deleted + session.created), so toHaveCount(0) alone
  // would not distinguish "blocker resolved" from "row replaced". Isolating
  // the live question.replied → dot-clear propagation (reply route, session
  // row never replaced) is a possible follow-up; this slice pins the
  // absence half only.
  await resetSession(page, "other");
  await expect(dot(page, "other", "needs-input")).toHaveCount(0, { timeout: 10000 });
});

// error + retry — the drivable half only: the dots stay ABSENT. Pinned at
// idle AND under a sticky /fixture/busy turn: a working row must never leak
// a priority dot (error/retry are suppressed while working; busy alone arms
// no needs-input). The busy row's running class is asserted FIRST so the
// busy-state absences are not vacuous.
test("error and retry dots stay absent on an idle and a busy session", async ({ page }) => {
  await resetSession(page, "other");
  await page.goto(projectUrl("/?session=demo"));
  await waitForTree(page);

  // Idle baseline: none of the family renders.
  await expect(dot(page, "other", "error")).toHaveCount(0);
  await expect(dot(page, "other", "retry")).toHaveCount(0);
  await expect(dot(page, "other", "needs-input")).toHaveCount(0);

  // Sticky busy (handleFixtureBusy :3232 — busy until reset, no terminal).
  const res = await page.request.post(`/oc/fixture/busy?session=other`, {
    headers: { "X-VH-CSRF": "1" },
  });
  if (!res.ok()) throw new Error(`fixture/busy -> ${res.status()} ${res.statusText()}`);
  // Prove busy took: the row's running class is the working() signal.
  await expect(page.locator(`.tree-node[data-session-id="other"].running`)).toBeVisible({
    timeout: 10000,
  });
  await expect(dot(page, "other", "error")).toHaveCount(0);
  await expect(dot(page, "other", "retry")).toHaveCount(0);
  await expect(dot(page, "other", "needs-input")).toHaveCount(0);
});

// Serial-suite hygiene: restore `other` to its seeded idle baseline for the
// specs after this file (both tests mutate its activity/flags).
test.afterEach(async ({ page }) => {
  await resetSession(page, "other");
});

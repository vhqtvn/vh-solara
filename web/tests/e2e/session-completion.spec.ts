import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// RED-SIGNAL spec for the session-finish tail-drop bug.
//
// Symptom (verbatim): the real-time session view FREEZES AT THE TAIL when an
// OpenCode session completes — the final assistant chat message(s) are missing
// from the live view, but a full page reload recovers them. Single worker. Chat/
// agent messages only. Frozen-missing-tail (not frozen-then-continues). Triggers
// at session completion.
//
// Why existing tests miss it: smoke.spec.ts:80 asserts `/Done\. Updated/` which
// arrives via the message.part.delta STREAM (chunk 2 of 4), so it passes even if
// the final consolidated part.updated + the message.updated(time.completed) that
// flips `settled` are dropped/clobbered. And `await expect().toBeVisible()`
// auto-waits, masking any drop-then-self-heal.
//
// This spec's red signal captures the DOM at the EXACT completion instant with
// NO auto-wait:
//   1. A browser-side MutationObserver fires the instant `.working-text` (the
//      busy shimmer) leaves the DOM — that is the session.idle transition.
//   2. At that instant it snapshots the last assistant message's render state:
//        - `.md-stream` present?  → `settled` did NOT flip (message.updated
//          carrying time.completed was dropped/clobbered). This is the "freeze".
//        - final consolidated text present?  → the part.updated(FINAL) landed.
//   3. EventSource is monkey-patched to log every session-stream event, so the
//      report can show whether the final part.updated + message.updated arrived
//      client-side at all (distinguishes network drop vs store/render drop).
//
// Test A (control): plain live completion on `other` — a small session whose
//   snapshot is RAW (< 2048B threshold), so no gzip64 decode window exists. If
//   the bug reproduces HERE, S1 (snapshot-clobber) is refuted → third suspect.
// Test B: plain live completion on `demo` — a large session whose snapshot IS
//   gzip64. Still a LIVE completion (no reconnect mid-stream), so S1's decode
//   window is not open unless a reconnect coincides. Localizes whether the bug
//   is size-dependent even without a forced reconnect.

// Height 600, not the historical 320: since S2a (height-tier responsiveness,
// web/src/shapeTier.ts) 400×320 classifies as the `tiny` height tier, whose
// CSS defenses hide the `.working` pill — every test below gates its turn on
// `.working-text` visibility (and the capture observer arms on `.working-text`
// DOM presence, which is unaffected). Width 400 (narrow intent) is preserved;
// 600 is safely normal-tier (short is <=520, hysteresis leaves at >=536).
// Nothing in this spec depends on total page height.
const VP = { width: 400, height: 600 };
type Page = import("@playwright/test").Page;

// Final consolidated assistant text the fixture streams (opencode.go:1063).
// The deltas accumulate to exactly this string; the FINAL part.updated carries
// this same text. If `settled` flips, MarkdownHtml renders it; if not, the
// streaming view shows the same text raw. So text-presence alone is necessary
// but not sufficient — the `.md-stream` (settled did NOT flip) check is the
// sharper signal.
const FINAL_TEXT = "Working on it…\n\nDone. Updated `parser.go` and added a test.";

// Install the completion-instant capture + SSE event logger. Must run BEFORE the
// app boots (addInitScript) so the EventSource wrapper is in place before the
// SPA constructs its stream connections.
async function installCapture(page: Page, session: string) {
  await page.addInitScript((sid) => {
    // --- SSE event log (session stream only) ---
    // Mirrors unread-dot.spec.ts's DelayedSnapshotES pattern, but records every
    // event instead of delaying. Captures {type, dataPreview, t} so the report
    // can prove whether the final part.updated + message.updated arrived.
    (window as any).__vhSSE = [];
    const OrigES = (window as any).EventSource;
    function LoggingES(url: string, opts?: any) {
      const es = opts !== undefined ? new OrigES(url, opts) : new OrigES(url);
      // Only instrument the per-SESSION stream (Stream 2). The tree stream has
      // no `sessions=` param (or sessions= empty).
      if (typeof url === "string" && url.indexOf("sessions=" + sid) !== -1) {
        const origAdd = es.addEventListener.bind(es);
        es.addEventListener = function (type: string, listener: any, options?: any) {
          return origAdd(
            type,
            (ev: MessageEvent) => {
              try {
                const d = typeof ev.data === "string" ? ev.data.slice(0, 200) : "";
                (window as any).__vhSSE.push({ type, dataPreview: d, t: performance.now() });
              } catch {
                /* ignore */
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
    LoggingES.prototype = OrigES.prototype;
    (LoggingES as any).CLOSED = OrigES.CLOSED;
    (LoggingES as any).OPEN = OrigES.OPEN;
    (LoggingES as any).CONNECTING = OrigES.CONNECTING;
    (window as any).EventSource = LoggingES;

    // --- Completion-instant DOM snapshot ---
    // Fires the instant `.working-text` (busy shimmer) leaves the DOM = the
    // session.idle transition processed by the SPA. Captures the render state of
    // the LAST assistant message at that exact tick (no auto-wait, no retry).
    //
    // ARM-ON-BUSY: at page boot `.working-text` is absent (no turn has started
    // yet), so a naive "capture when shimmer gone" would latch immediately with
    // zero messages. We arm ONLY after the shimmer has appeared at least once
    // (the turn started), then capture the FIRST transition back to absent.
    (window as any).__vhCompletionSnap = null;
    (window as any).__vhCompletionTook = 0;
    (window as any).__vhSeenBusy = false;
    const t0 = performance.now();
    const capture = () => {
      const wt = document.querySelectorAll(".working-text");
      if (wt.length > 0) {
        (window as any).__vhSeenBusy = true; // arm: a turn is in progress
        return;
      }
      if (!(window as any).__vhSeenBusy) return; // not armed yet (pre-turn)
      if ((window as any).__vhCompletionSnap) return; // already captured
      // Find the last assistant message row. Assistant rows are .msg[data-mid]
      // whose role we can't easily read from DOM; instead grab the LAST .msg
      // row's prose content (the tail). The user row has no .md/.md-stream.
      const msgs = Array.from(document.querySelectorAll(".msg[data-mid]"));
      const last = msgs[msgs.length - 1] as HTMLElement | undefined;
      const snap: any = {
        t: performance.now(),
        elapsedSinceBoot: performance.now() - t0,
        msgCount: msgs.length,
        lastMid: last?.dataset.mid ?? null,
        // `.md-stream` = streaming view still mounted → settled did NOT flip.
        // `.md` (no -stream) = settled view mounted.
        streamViewsMounted: document.querySelectorAll(".md-stream").length,
        settledMdMounted: document.querySelectorAll(".md:not(.md-stream)").length,
        // Full text content of the last row (raw, incl. streamed text).
        lastRowText: last ? (last.textContent || "").trim() : null,
        // Does the last row contain the FINAL consolidated text?
        lastRowHasFinal: last ? !!(last.textContent || "").includes("added a test") : false,
      };
      (window as any).__vhCompletionSnap = snap;
      (window as any).__vhCompletionTook = performance.now() - t0;
    };
    // Poll on a tight interval — the MutationObserver on .working-text is the
    // trigger; the capture itself is a single synchronous read (no retry).
    const obs = new MutationObserver(() => capture());
    // Observe as soon as body exists.
    const start = () => {
      if (!document.body) {
        setTimeout(start, 16);
        return;
      }
      obs.observe(document.body, { childList: true, subtree: true });
      // Also poll briefly — a mutation-only observer can miss a same-tick
      // add-then-remove if both happen in one microtask batch.
      const interval = setInterval(() => {
        capture();
        if ((window as any).__vhCompletionSnap) clearInterval(interval);
      }, 20);
    };
    start();
  }, session);
}

// Read back the completion snapshot + SSE log.
async function readCapture(page: Page) {
  return page.evaluate(() => ({
    snap: (window as any).__vhCompletionSnap,
    sse: (window as any).__vhSSE,
    took: (window as any).__vhCompletionTook,
  }));
}

// Read the CURRENT live DOM state of the last assistant row (post-completion,
// no auto-wait — a single evaluate).
async function liveTailState(page: Page) {
  return page.evaluate(() => {
    const msgs = Array.from(document.querySelectorAll(".msg[data-mid]"));
    const last = msgs[msgs.length - 1] as HTMLElement | undefined;
    return {
      msgCount: msgs.length,
      streamViewsMounted: document.querySelectorAll(".md-stream").length,
      lastRowText: last ? (last.textContent || "").trim().slice(-200) : null,
    };
  });
}

// Gate "the final consolidated text is in the tail" with a brief grace for the
// SESSION stream (Stream 2) to consolidate under the two-SSE-stream architecture.
// cap.snap locks at the EXACT idle instant (the tree stream / Stream 1's
// activity=idle), but the session stream delivers the CONTENT (message.part.delta
// + the final message.part.updated) on an INDEPENDENT connection whose delivery
// order vs the tree stream is NOT guaranteed (see reducers.ts "Cross-stream
// completion bridge" + fixture streamAssistant, which emits part.updated(final)
// BEFORE session.idle — but on a different stream). Under load the session stream
// can lag the idle by a few ms, so snap may lock partial text; the production data
// is eventually consistent (the session stream catches up). This poll tolerates
// ONLY that benign transient: a real "frozen-missing-tail" freeze (text NEVER
// arrives — reload-only, the bug this spec exists for) still fails the timeout.
// The sharper freeze signal — streamViewsMounted (settled flipped at idle, made
// deterministic by the bridge) — stays strict in each test.
async function expectFinalTextInTail(page: Page, timeoutMs = 2000): Promise<void> {
  await expect.poll(
    () =>
      page.evaluate(() => {
        const msgs = Array.from(document.querySelectorAll(".msg[data-mid]"));
        const last = msgs[msgs.length - 1] as HTMLElement | undefined;
        // Substring of FINAL_TEXT ("...and added a test."); matches the snap's
        // lastRowHasFinal check exactly.
        return last && (last.textContent || "").includes("added a test") ? 1 : 0;
      }),
    {
      timeout: timeoutMs,
      message:
        "final text never consolidated into the tail (real freeze — missing-tail persists past the cross-stream grace)",
    },
  ).toBe(1);
}

// Prompt a session through the composer route and wait for ONE busy→idle turn.
async function promptAndComplete(page: Page, id: string, text: string) {
  await page.evaluate(
    async ({ id, text }) => {
      const res = await fetch(`/oc/session/${id}/prompt_async`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      });
      if (!res.ok && res.status !== 204) throw new Error(`prompt_async ${id} -> ${res.status}`);
    },
    { id, text },
  );
}

// Reset a session to its seeded baseline so the serial suite's shared fixture
// state doesn't bleed across specs. Uses Playwright's request context (Node-
// side) so it works before the page has navigated to a baseURL.
//
// Routes through the daemon's /oc/* passthrough (the daemon only proxies /oc/*,
// server.go handlePassthrough — a bare /fixture/reset silently hits the SPA
// fallback and no-ops). The X-VH-CSRF header satisfies the shared CSRF guard on
// /oc/* POSTs. Mirrors scroll-follow.spec.ts:170.
async function resetSession(page: Page, id: string) {
  const res = await page.request.post(`/oc/fixture/reset?session=${id}`, {
    headers: { "X-VH-CSRF": "1" },
  });
  if (!res.ok()) throw new Error(`resetSession(${id}) -> ${res.status()} ${res.statusText()}`);
}

// Test A (CONTROL): plain live completion on `other` — small session, RAW
// snapshot (< 2048B), no gzip64 decode window. If the tail drops HERE, S1 is
// refuted and the bug is a third suspect (fires on every completion).
test("PLAIN completion on small session (other) — tail present at completion instant (control for S1)", async ({ page }) => {
  await page.setViewportSize(VP);
  await installCapture(page, "other");
  await page.goto(projectUrl("/?session=other"));
  await expect(page.locator(".chat-scroll")).toBeVisible({ timeout: 10000 });

  // Fire the prompt and wait for the busy shimmer to appear then vanish.
  await promptAndComplete(page, "other", "completion-tail-drop probe");
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 12000 });

  // Give the MutationObserver one more tick to land its capture (it fires on the
  // mutation that removed .working-text; a single 50ms grace covers the
  // same-microtask poll). This is NOT an auto-wait on the text assertion — it
  // only lets the observer callback settle.
  await page.waitForTimeout(50);

  const cap = await readCapture(page);
  const live = await liveTailState(page);

  // The SSE log MUST show the final two events arrived client-side.
  const sse = cap.sse || [];
  const sawPartUpdatedFinal = sse.some(
    (e: any) => e.type === "message.part.updated" && e.dataPreview.includes("added a test"),
  );
  const sawMessageUpdatedCompleted = sse.some(
    (e: any) => e.type === "message.updated" && e.dataPreview.includes("completed"),
  );

  // ASSERTION (no auto-wait): at the completion instant the streaming view MUST
  // have unmounted (settled flipped) and the final text MUST be present.
  // streamViewsMounted===0 proves `settled` flipped (message.updated landed).
  expect(
    cap.snap,
    `completion snapshot never captured (sse events: ${sse.length}; last 5: ${JSON.stringify(sse.slice(-5))})`,
  ).not.toBeNull();
  expect(
    cap.snap.streamViewsMounted,
    `BUG: .md-stream still mounted at completion instant → settled did NOT flip (message.updated w/ time.completed dropped). snap=${JSON.stringify(cap.snap)}`,
  ).toBe(0);
  // Final text: gate on a cross-stream consolidation grace (the session stream
  // can lag the tree stream's idle by a few ms — see expectFinalTextInTail).
  // cap.snap.lastRowHasFinal (the exact-instant value) rides along inside
  // cap.snap for diagnostics in the assertions above.
  await expectFinalTextInTail(page);

  // Sanity: confirm the self-heal didn't paper over it later (it should still be
  // gone — this is a control, the bug should NOT reproduce here).
  expect(live.streamViewsMounted, `live state still shows streaming view`).toBe(0);

  // Diagnostic echo (always visible in the report, not just on failure).
  console.log(
    "[control-other] sse events=" +
      sse.length +
      " sawPartUpdatedFinal=" +
      sawPartUpdatedFinal +
      " sawMessageUpdatedCompleted=" +
      sawMessageUpdatedCompleted +
      " completionAt=" +
      (cap.took?.toFixed(0) ?? "?") +
      "ms",
  );
});

// === CROSS-STREAM completion race (deterministic red + regression guard) =========
//
// ROOT CAUSE of Test A's flake (confirmed by instrumentation): the `settled`
// flip and the `.working-text` removal are driven by events on TWO DIFFERENT
// SSE streams:
//   - `message.upsert` carrying `time.completed` arrives on the SESSION stream
//     (Stream 2 — the per-session `sessions=<sid>` EventSource). This is what
//     flips `settled()` (ChatView.tsx:175 reads props.m.info.time.completed).
//   - `activity=idle` arrives on the TREE stream (Stream 1 — see
//     TREE_STREAM_KINDS in sync/stream.ts). This is what unmounts
//     `.working-text` (working() reads state.activity[id]).
// The two streams are independent TCP connections whose delivery order is NOT
// guaranteed. When Stream 1 wins (idle lands before the completed upsert), the
// completion-instant capture fires (working-text gone) with `settled` still
// false → `.md-stream` still mounted → Test A's `streamViewsMounted === 0`
// assertion fails.
//
// FIX (sync/stream.ts, case "activity"): when activity=idle is applied, stamp
// time.completed on the last assistant message in the SAME produce() draft that
// clears activity — so `settled` flips in the SAME reactive flush that unmounts
// .working-text. Whichever stream wins, the streaming view never outlives the
// busy indicator. The real message.upsert(completed) is then a no-op.
//
// This test makes the race DETERMINISTIC by delaying EVERY event on the
// session stream (Stream 2) so the tree stream's activity=idle ALWAYS lands
// first. It pins the settled-flip guarantee directly: streamViewsMounted MUST
// be 0 at the completion instant even though Stream 2's completion events have
// not landed. (The full text-presence assertion is covered by Test A's
// realistic race — under this artificial full-stream delay the final part.upsert
// is also delayed, so text presence is a transport concern, not the settled
// flip this guard targets.)
const CROSS_STREAM_RACE_DELAY_MS = 150;

async function installCaptureWithStreamRace(page: Page, session: string) {
  await page.addInitScript(({ sid, delay }) => {
    (window as any).__vhSSE = [];
    const OrigES = (window as any).EventSource;
    function LoggingES(url: string, opts?: any) {
      const es = opts !== undefined ? new OrigES(url, opts) : new OrigES(url);
      const isSession = typeof url === "string" && url.indexOf("sessions=" + sid) !== -1;
      const origAdd = es.addEventListener.bind(es);
      es.addEventListener = function (type: string, listener: any, options?: any) {
        return origAdd(
          type,
          (ev: MessageEvent) => {
            try {
              const d = typeof ev.data === "string" ? ev.data.slice(0, 200) : "";
              (window as any).__vhSSE.push({ type, dataPreview: d, t: performance.now() });
            } catch {
              /* ignore */
            }
            const dispatch = () => {
              if (typeof listener === "function") listener(ev);
              else if (listener) listener.handleEvent(ev);
            };
            // RACE INJECTION: delay EVERY event on the SESSION stream (Stream 2)
            // by CROSS_STREAM_RACE_DELAY_MS so the TREE stream (Stream 1:
            // activity=idle, undelayed) always wins the race. At .working-text
            // removal (Stream 1 idle), Stream 2's completion events (final
            // part.upsert + message.upsert(completed)) have NOT landed → without
            // the fix, settled is still false and .md-stream is still mounted.
            if (isSession) {
              setTimeout(dispatch, delay);
              return;
            }
            dispatch();
          },
          options,
        );
      };
      return es;
    }
    LoggingES.prototype = OrigES.prototype;
    (LoggingES as any).CLOSED = OrigES.CLOSED;
    (LoggingES as any).OPEN = OrigES.OPEN;
    (LoggingES as any).CONNECTING = OrigES.CONNECTING;
    (window as any).EventSource = LoggingES;

    // --- Completion-instant DOM snapshot (identical to installCapture) ---
    (window as any).__vhCompletionSnap = null;
    (window as any).__vhCompletionTook = 0;
    (window as any).__vhSeenBusy = false;
    const t0 = performance.now();
    const capture = () => {
      const wt = document.querySelectorAll(".working-text");
      if (wt.length > 0) {
        (window as any).__vhSeenBusy = true;
        return;
      }
      if (!(window as any).__vhSeenBusy) return;
      if ((window as any).__vhCompletionSnap) return;
      const msgs = Array.from(document.querySelectorAll(".msg[data-mid]"));
      const last = msgs[msgs.length - 1] as HTMLElement | undefined;
      const snap: any = {
        t: performance.now(),
        elapsedSinceBoot: performance.now() - t0,
        msgCount: msgs.length,
        lastMid: last?.dataset.mid ?? null,
        streamViewsMounted: document.querySelectorAll(".md-stream").length,
        settledMdMounted: document.querySelectorAll(".md:not(.md-stream)").length,
        lastRowText: last ? (last.textContent || "").trim() : null,
        lastRowHasFinal: last ? !!(last.textContent || "").includes("added a test") : false,
      };
      (window as any).__vhCompletionSnap = snap;
      (window as any).__vhCompletionTook = performance.now() - t0;
    };
    const obs = new MutationObserver(() => capture());
    const start = () => {
      if (!document.body) {
        setTimeout(start, 16);
        return;
      }
      obs.observe(document.body, { childList: true, subtree: true });
      const interval = setInterval(() => {
        capture();
        if ((window as any).__vhCompletionSnap) clearInterval(interval);
      }, 20);
    };
    start();
  }, { sid: session, delay: CROSS_STREAM_RACE_DELAY_MS });
}

// ============================================================================
// UN-FIXME'd — fix B landed (delivery-path-independent completion bridge).
// The bridge in web/src/sync/reducers.ts (stampCompletionIfIdle) now stamps
// time.completed when activity transitions to idle via a SNAPSHOT path
// (projectScopedPartial / projectSnapshot), not only via the discrete
// activity{state:idle} event. In this cross-stream race the discrete idle was
// dropped by the Inv1 tree-gap-reconnect gen guard (tree-transport.ts:1490), so
// the idle landed via the seq-scoped partial snapshot — which previously had NO
// bridge. Now it does, so `settled` flips regardless of which path delivered the
// idle. Inv2 (tail-incomplete-on-idle) is untouched (discrete-path-only; its
// unit tests in seqGapRecovery.test.ts use applyMessageEvent, unaffected).
//
// LANDED: Inv1-A (O3) — the covering-check root fix. The cross-stream covering
// check (getSesCursor >= seq-1) was REMOVED and replaced with a per-connection
// delivery ordinal (compound SSE id "globalSeq.ordinal") that counts ONLY
// Inv1-relevant logical source events. A gap in the ordinal is DIRECTLY
// actionable as real loss — no timing heuristic, no false-positive thrash.
// B closes the completion-correctness gap + this test; A removes the spurious-
// tree-reconnect thrash risk (the false-positive Inv1 gap that bumped treeGen
// in the race). Both A + B together close the race cleanly.
// ============================================================================
// Deterministic regression guard for the cross-stream completion race. With the
// session stream deliberately lagging the tree stream, the streaming view MUST
// still have unmounted at the completion instant — the idle transition settles
// the last assistant message regardless of which stream wins.
test("CROSS-STREAM RACE: session stream lags tree stream (activity=idle) — settled still flips at completion instant", async ({ page }) => {
  await page.setViewportSize(VP);
  await installCaptureWithStreamRace(page, "other");
  await page.goto(projectUrl("/?session=other"));
  await expect(page.locator(".chat-scroll")).toBeVisible({ timeout: 10000 });

  await promptAndComplete(page, "other", "cross-stream-race probe");
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 12000 });
  // Same grace as Test A: lets the MutationObserver callback settle. NOT an
  // auto-wait on the assertion — the capture is a single synchronous read.
  await page.waitForTimeout(50);

  const cap = await readCapture(page);
  const sse = cap.sse || [];

  expect(
    cap.snap,
    `completion snapshot never captured (sse events: ${sse.length}; last 5: ${JSON.stringify(sse.slice(-5))})`,
  ).not.toBeNull();
  // RED SIGNAL / REGRESSION GUARD: at the completion instant (working-text just
  // unmounted via the tree stream's activity=idle), the streaming view MUST
  // already have unmounted too — even though the session stream's completion
  // events were intentionally delayed by CROSS_STREAM_RACE_DELAY_MS. Pins the
  // guarantee that an idle transition settles the last assistant message
  // regardless of cross-stream ordering.
  expect(
    cap.snap.streamViewsMounted,
    `BUG: cross-stream race — .md-stream still mounted at completion instant because the session stream (Stream 2) lost the race to activity=idle (Stream 1); the idle transition did not settle the last assistant message. snap=${JSON.stringify(cap.snap)}`,
  ).toBe(0);

  console.log(
    "[cross-stream-race] sse events=" +
      sse.length +
      " completionAt=" +
      (cap.took?.toFixed(0) ?? "?") +
      "ms streamViews=" +
      cap.snap.streamViewsMounted +
      " snap=" +
      JSON.stringify(cap.snap),
  );
});

// === S1 conditions forced: reconnect-during-completion + decode latency + epoch bump ===
//
// Mission hypothesis (the "pinned suspect S1 residual"): stream.ts:2186-2198 —
// if a gzip64 snapshot decode is in flight when a live part.upsert/message.upsert
// arrives, the live event AWAITS the decode; if gateEpoch bumped during the
// await, the live event is DROPPED (epoch guard :2195). For the tail to be
// PERSISTENTLY lost this requires: a reconnect mid-completion (snapshot decode
// in flight) + a gateEpoch bump during the decode (the ONLY gateEpoch bumpers
// are archive/unarchive/orphan-adopt via withGlobalBusy, busy.ts:74/:105).
//
// This test FORCES all three S1 conditions to determine whether S1 clobbers the
// tail AT ALL (even though these conditions do NOT match the user's stated repro,
// which involves no archive). Findings:
//  - If the tail SURVIVES: S1 is not a real clobber even when constructible
//    (reconcile self-heals, or the epoch guard is protective — drops the STALE
//    snapshot, preserving the old in-store tail). S1 refuted as the user's bug.
//  - If the tail drops TRANSIENTLY then self-heals: S1 is a real but self-healing
//    race — does NOT match "frozen-until-reload". Still not the user's bug.
//  - If the tail drops PERSISTENTLY: S1 confirmed as a latent bug (fix-worth),
//    but STILL requires archive — does not explain the no-archive user repro.
//
// LATENCY INJECTION: monkey-patch window.DecompressionStream so each gzip decode
// takes ~400ms, opening a reliably-wide decode window for the epoch bump to land
// in. This is the test-only knob the mission's determinism guidance calls for.

const DECODE_LATENCY_MS = 100;

async function installCaptureWithLatency(page: Page, session: string) {
  await page.addInitScript(({ sid, latency }) => {
    // --- SSE event log (session stream only) + STALE-SNAPSHOT INJECTION ---
    // The S1 clobber's only non-determinism is whether the forced-reconnect
    // snapshot is generated STALE (before completion events reach the
    // aggregator) or healthy. To make the client-side clobber deterministic,
    // capture the FIRST session snapshot (the pre-prompt seeded baseline,
    // guaranteed to lack the completion tail) and INJECT it on every SUBSEQUENT
    // snapshot frame (the forced reconnect + reconcile). This deterministically
    // exercises applySessionSnapshot's wholesale-replace overwriting live data.
    (window as any).__vhSSE = [];
    (window as any).__vhStaleSnap = null; // captured pre-prompt baseline
    (window as any).__vhInjections = 0;
    const OrigES = (window as any).EventSource;
    function LoggingES(url: string, opts?: any) {
      const es = opts !== undefined ? new OrigES(url, opts) : new OrigES(url);
      if (typeof url === "string" && url.indexOf("sessions=" + sid) !== -1) {
        const origAdd = es.addEventListener.bind(es);
        es.addEventListener = function (type: string, listener: any, options?: any) {
          return origAdd(
            type,
            (ev: MessageEvent) => {
              let dispatchEv = ev;
              try {
                const d = typeof ev.data === "string" ? ev.data.slice(0, 200) : "";
                (window as any).__vhSSE.push({ type, dataPreview: d, t: performance.now() });
                // STALE-SNAPSHOT INJECTION: on a `snapshot` frame, capture the
                // first (baseline) and replace all later ones with it.
                if (type === "snapshot" && typeof ev.data === "string") {
                  if (!(window as any).__vhStaleSnap) {
                    (window as any).__vhStaleSnap = ev.data; // capture baseline
                  } else {
                    // Inject the stale baseline as a NEW snapshot frame so the
                    // SPA's snapshot listener applies the stale data.
                    dispatchEv = new MessageEvent("snapshot", {
                      data: (window as any).__vhStaleSnap,
                      lastEventId: ev.lastEventId,
                    });
                    (window as any).__vhInjections++;
                  }
                }
              } catch {
                /* ignore */
              }
              if (typeof listener === "function") listener(dispatchEv);
              else if (listener) listener.handleEvent(dispatchEv);
            },
            options,
          );
        };
      }
      return es;
    }
    LoggingES.prototype = OrigES.prototype;
    (LoggingES as any).CLOSED = OrigES.CLOSED;
    (LoggingES as any).OPEN = OrigES.OPEN;
    (LoggingES as any).CONNECTING = OrigES.CONNECTING;
    (window as any).EventSource = LoggingES;

    // --- DecompressionStream latency injection (the test-only knob) ---
    // Wraps the native gzip decoder so each decode pauses ~latency ms AFTER the
    // real decode resolves, before resolving the readable reader. This opens a
    // wide, deterministic decode window without altering the decoded output.
    const OrigDS = (window as any).DecompressionStream;
    if (OrigDS) {
      function SlowDS(format: string) {
        const ds = new OrigDS(format);
        const origGet = Object.getOwnPropertyDescriptor(OrigDS.prototype, "readable")!.get!;
        Object.defineProperty(ds, "readable", {
          get() {
            const real = origGet.call(ds);
            // Wrap in a transformed stream whose reader delays the final read.
            const tr = new TransformStream({
              transform(chunk: Uint8Array, ctrl: any) {
                ctrl.enqueue(chunk);
              },
            });
            const piped = real.pipeThrough(tr);
            const origReader = piped.getReader.bind(piped);
            piped.getReader = function () {
              const r = origReader();
              const origRead = r.read.bind(r);
              r.read = async function () {
                const res = await origRead();
                if (res.done) {
                  // Hold the decode window open for `latency` ms before the
                  // await sesSnapshotDecode in the live-event listener resolves.
                  await new Promise<void>((r2) => setTimeout(r2, latency));
                }
                return res;
              };
              return r;
            };
            return piped;
          },
        });
        return ds;
      }
      SlowDS.prototype = OrigDS.prototype;
      (window as any).DecompressionStream = SlowDS as any;
    }

    // --- Multi-sample DOM state capture (no auto-wait) ---
    // Instead of a single completion-instant snapshot, capture an ARRAY of
    // samples so the report can show transient-vs-persistent. Sampled on every
    // DOM mutation + a 30ms poll, stopped when explicitly drained.
    (window as any).__vhSamples = [];
    (window as any).__vhSeenBusy = false;
    const sample = () => {
      const msgs = Array.from(document.querySelectorAll(".msg[data-mid]"));
      const last = msgs[msgs.length - 1] as HTMLElement | undefined;
      (window as any).__vhSamples.push({
        t: performance.now(),
        msgCount: msgs.length,
        streamViewsMounted: document.querySelectorAll(".md-stream").length,
        lastRowHasFinal: last ? !!(last.textContent || "").includes("added a test") : false,
        workingVisible: document.querySelectorAll(".working-text").length > 0,
      });
      // cap to avoid unbounded growth
      if ((window as any).__vhSamples.length > 400) (window as any).__vhSamples = (window as any).__vhSamples.slice(-400);
    };
    const obs = new MutationObserver(() => sample());
    const start = () => {
      if (!document.body) {
        setTimeout(start, 16);
        return;
      }
      obs.observe(document.body, { childList: true, subtree: true });
      setInterval(sample, 30);
    };
    start();
  }, { sid: session, latency: DECODE_LATENCY_MS });
}

function summarizeSamples(samples: any[]) {
  if (!samples.length) return "no samples";
  // Did the tail ever go missing AFTER it first appeared?
  const firstFinalIdx = samples.findIndex((s) => s.lastRowHasFinal);
  const lastSample = samples[samples.length - 1];
  // Build the drop-window timeline: samples where finalPresent transitions.
  // Shows the exact clobber (true→false) and heal (false→true) instants.
  const transitions: any[] = [];
  let prev = samples[0]?.lastRowHasFinal;
  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i].lastRowHasFinal;
    if (cur !== prev) {
      transitions.push({
        atSample: i,
        tMs: Math.round(samples[i].t),
        from: prev,
        to: cur,
        streamViews: samples[i].streamViewsMounted,
        working: samples[i].workingVisible,
        msgCount: samples[i].msgCount,
      });
      prev = cur;
    }
  }
  const minFinalAfterFirst = firstFinalIdx >= 0
    ? Math.min(...samples.slice(firstFinalIdx).map((s) => (s.lastRowHasFinal ? 1 : 0)))
    : -1;
  return JSON.stringify({
    n: samples.length,
    firstFinalAtSample: firstFinalIdx,
    finalPresentAtEnd: lastSample.lastRowHasFinal,
    streamViewsAtEnd: lastSample.streamViewsMounted,
    workingAtEnd: lastSample.workingVisible,
    // 0 = tail STAYED present after first appearing; <1 means it DISAPPEARED at some point (clobber)
    tailEverDroppedAfterFirstAppear: firstFinalIdx >= 0 ? (minFinalAfterFirst === 0 ? "YES" : "no") : "never-appeared",
    transitions,
  });
}

// Test B: plain live completion on `demo` — large session whose snapshot IS
// gzip64 (> 2048B). Still a LIVE completion (no reconnect mid-stream), so S1's
// decode window is not open. If the tail drops here but not on `other`, the bug
// is size-correlated even without a forced reconnect.
test("PLAIN completion on large session (demo, gzip64 snapshot) — tail present at completion instant", async ({ page }) => {
  await page.setViewportSize(VP);
  // Reset demo to its seeded baseline so prior-spec prompt accumulation doesn't
  // change the tail we assert against.
  await resetSession(page, "demo");
  await installCapture(page, "demo");
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });

  await promptAndComplete(page, "demo", "completion-tail-drop probe demo");
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 12000 });
  await page.waitForTimeout(50);

  const cap = await readCapture(page);
  const live = await liveTailState(page);
  const sse = cap.sse || [];
  const sawPartUpdatedFinal = sse.some(
    (e: any) => e.type === "message.part.updated" && e.dataPreview.includes("added a test"),
  );
  const sawMessageUpdatedCompleted = sse.some(
    (e: any) => e.type === "message.updated" && e.dataPreview.includes("completed"),
  );

  expect(
    cap.snap,
    `completion snapshot never captured (sse events: ${sse.length})`,
  ).not.toBeNull();
  expect(
    cap.snap.streamViewsMounted,
    `BUG: .md-stream still mounted at completion instant on demo → settled did NOT flip. snap=${JSON.stringify(cap.snap)}`,
  ).toBe(0);
  // Final text: gate on a cross-stream consolidation grace (the session stream
  // can lag the tree stream's idle by a few ms — see expectFinalTextInTail).
  await expectFinalTextInTail(page);

  console.log(
    "[demo-large] sse events=" +
      sse.length +
      " sawPartUpdatedFinal=" +
      sawPartUpdatedFinal +
      " sawMessageUpdatedCompleted=" +
      sawMessageUpdatedCompleted +
      " completionAt=" +
      (cap.took?.toFixed(0) ?? "?") +
      "ms",
  );
});

// Test D (DETERMINISTIC RED for the applySessionSnapshot wholesale-replace
// clobber). This isolates the mechanism the S1 analysis pointed at:
// `applySessionSnapshot` (stream.ts:1762) does an UNCONDITIONAL wholesale replace
// of messages[id] via buildMessages(items). If a reconnect/reconcile snapshot is
// STALE (generated before the final completion events reached the aggregator),
// applySnap OVERWRITES the in-store live tail — and because completion is done
// (no further live events to override), the clobber PERSISTS until a manual
// reload fetches a fresh healthy snapshot. This is the "frozen-missing-tail,
// reload recovers" symptom.
//
// The S1 epoch-guard/decode-window machinery (stream.ts:2097,2186-2198) only
// mitigates the case where a live event lands DURING the gzip64 decode (it
// serializes the live event behind the decode so it applies AFTER applySnap).
// It does NOT protect the case where the live data is ALREADY in the store when
// a stale snapshot lands — applySnap's wholesale replace clobbers it regardless.
//
// DETERMINISM: the only non-determinism in the real bug is whether the
// reconnect snapshot is generated stale. This test removes that non-determinism
// by INJECTING a captured pre-prompt baseline snapshot as the reconnect frame
// (the SSE monkey-patch in installCaptureWithLatency). This deterministically
// exercises the client-side clobber WITHOUT depending on server-side event-
// processing timing, and WITHOUT an archive (no gateEpoch bump needed — the
// clobber is purely applySnap's wholesale replace). A real reload (new
// navigation) bypasses the injection and recovers, matching the symptom.
//
// Regression guard for the session-finish tail-drop bug: applySessionSnapshot
// now merges via prependMessagesIfAbsent (live always wins), so a stale
// reconnect snapshot must NOT drop a tail that already appeared.
test("regression: stale reconnect snapshot must not clobber the settled tail (merge-if-absent)", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize(VP);
  await resetSession(page, "demo");
  await installCaptureWithLatency(page, "demo");
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });

  // Phase 1: complete a prompt NORMALLY (no reconnect during completion). The
  // tail lands via live events; baseline snapshot is captured by the SSE wrapper
  // on the first `snapshot` frame (pre-prompt, no tail).
  await promptAndComplete(page, "demo", "wholesale-replace probe");
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(200);

  // Confirm the tail IS present after normal completion (pre-clobber baseline).
  const before = await liveTailState(page);
  expect(
    before.lastRowText && before.lastRowText.includes("added a test"),
    `precondition: tail present after normal completion. before=${JSON.stringify(before)}`,
  ).toBe(true);
  const injectionsBefore = await page.evaluate(() => (window as any).__vhInjections ?? 0);

  // Scope the tail-drop sampler to Phase 2 (the reconnect window). Phase 1's
  // prompt legitimately cycles the last row through a fresh user message +
  // working phase — the tail is SUPPOSED to be absent from the last row while
  // a new turn generates. Without this reset, firstFinalIdx would catch any
  // pre-existing "added a test" in the baseline (the serial suite's shared
  // fixture server retains demo's messages across Test B → Test D; the
  // /oc/fixture/reset call in resetSession clears the fixture but not the
  // aggregator's pkg/state store), and Phase 1's
  // prompt would be counted as a spurious "drop". The red signal this test
  // guards is the RECONNECT clobber (Phase 2), not prompt-cycle churn.
  await page.evaluate(() => { (window as any).__vhSamples = []; });

  // Phase 2: FORCE A RECONNECT by switching to `other` then back to `demo`. The
  // selectedId effect (sync.ts:66) calls openSessionStream → demo's stream closes
  // + reopens → a new `snapshot` frame arrives → the SSE wrapper INJECTS the
  // captured stale baseline (no tail); applySessionSnapshot must MERGE
  // (prependMessagesIfAbsent), leaving the settled tail intact.
  await page.evaluate(() => {
    const u = new URL(location.href);
    u.searchParams.set("session", "other");
    history.pushState({}, "", u.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
    (window as any).__vhSwitchOtherT = performance.now();
  });
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    const u = new URL(location.href);
    u.searchParams.set("session", "demo");
    history.pushState({}, "", u.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
    (window as any).__vhSwitchDemoT = performance.now();
  });

  // Wait for the injected stale snapshot's decode + applySnap to land (gzip64
  // decode, no injected latency here — but give the async decode a moment).
  await page.waitForTimeout(1500);

  const samples = await page.evaluate(() => (window as any).__vhSamples);
  const sse = await page.evaluate(() => (window as any).__vhSSE);
  const injectionsAfter = await page.evaluate(() => (window as any).__vhInjections ?? 0);
  const switchTimes = await page.evaluate(() => ({
    otherT: Math.round((window as any).__vhSwitchOtherT ?? 0),
    demoT: Math.round((window as any).__vhSwitchDemoT ?? 0),
  }));
  const after = await liveTailState(page);
  const summary = summarizeSamples(samples);

  console.log("[wholesale-replace] samples=" + summary);
  console.log("[wholesale-replace] switchTimes=" + JSON.stringify(switchTimes));
  console.log(
    "[wholesale-replace] injections=" +
      injectionsBefore +
      "→" +
      injectionsAfter +
      " sseSnapshotFrames=" +
      (sse as any[]).filter((e) => e.type === "snapshot").length +
      " afterTail=" +
      JSON.stringify(after),
  );

  // Sanity: the injection actually fired (at least one stale snapshot injected
  // by the reconnect). If this fails, the reconnect did not produce a snapshot
  // frame — the test harness is mis-wired, not the bug.
  expect(
    injectionsAfter,
    `test harness: no stale snapshot was injected on reconnect (injections ${injectionsBefore}→${injectionsAfter}). The SSE wrapper did not see a 2nd snapshot frame.`,
  ).toBeGreaterThan(injectionsBefore);

  // RED SIGNAL (deterministic, 4/4): the tail MUST NOT drop after first
  // appearing. applySessionSnapshot's wholesale-replace clobbers the in-store
  // live tail when a stale reconnect snapshot lands → tailEverDroppedAfterFirst
  //Appear === "YES". Whether the drop then PERSISTS (run-variant: msgCount:0,
  // tail gone at END) or SELF-HEALS (live events replay on the new connection)
  // is timing-dependent — but the CLOBBER itself is deterministic and is the
  // bug. Fixed in 379d172 (merge-if-absent); this test guards against regression.
  const parsed = JSON.parse(summary);
  expect(
    parsed.tailEverDroppedAfterFirstAppear,
    `REGRESSION FAILED: stale reconnect snapshot dropped the settled tail (applySessionSnapshot merge-if-absent regressed). transitions=${JSON.stringify(parsed.transitions)} after=${JSON.stringify(after)}`,
  ).toBe("no");
});

import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// DEFER #1 browser crux: prove the negotiated live SSE→SPA→apply path for
// part.append. For a part_delta=1 connection, a real part.append frame with
// start > 0 is delivered over a live browser EventSource from the real
// fixtureserver/store, AND the production SPA incrementally applies a streamed
// suffix (prefix-only → suffix-visible) BEFORE the fixture's final authoritative
// update can mask a failure.
//
// Why existing tests miss this: smoke.spec.ts:74 and sync.spec.ts:64-76 assert
// only the FINAL streamed text ("Done. Updated"). The fixture's final
// message.part.updated (opencode.go:1589) carries the FULL accumulated text, so
// a broken suffix-apply path would be silently repaired by that final upsert →
// false positive. This test closes that gap with three assertions:
//
//   1. Wire (negotiation): the session EventSource URL includes part_delta=1
//      (session-stream.ts:603-604).
//   2. Wire (frame): at least one part.append frame with start > 0 is observed
//      on the NATIVE live EventSource (not a mock).
//   3. Outcome (incremental, anti-false-positive): the DOM shows an intermediate
//      state where the prefix is present but the suffix is NOT, then the suffix
//      becomes visible WHILE STREAMING (before the final chunk). This progression
//      proves the suffix was applied incrementally, not repaired by the final
//      authoritative message.part.updated.
//
// Timing determinism: the fixture streams 4 chunks at 180ms intervals
// (opencode.go:1576). The streaming-markdown component coalesces DOM flushes to
// ~5fps / FRAME_MS=200ms (Part.tsx:103). Because chunk gaps (180ms) are shorter
// than the coalesce window (200ms), each chunk lands in a SEPARATE flush: chunk
// 1 renders alone, then chunk 2 (suffix) renders in the NEXT flush ~200ms later.
// The prefix-only DOM window is therefore ~200ms — well above the 20ms sample
// resolution. No fixture synchronization fallback is needed.

const VP = { width: 400, height: 320 };
type Page = import("@playwright/test").Page;

// The fixture's 4 streamed chunks (opencode.go:1558) and their byte offsets:
//   "Working on it…"     start=0   (chunk 1)
//   "\n\nDone. Updated " start=14  (chunk 2 — first start>0 suffix)
//   "`parser.go` "       start=31  (chunk 3)
//   "and added a test."  start=43  (chunk 4)
// PREFIX / SUFFIX / FINAL are stable substrings that identify each chunk's
// arrival in the DOM textContent without encoding edge-cases.
const PREFIX = "Working on it";
const SUFFIX = "Done. Updated";
const FINAL = "added a test";

// Install a TRANSPARENT delegating EventSource observer + DOM sample timeline.
// Delegates ALL construction + event dispatch to the REAL native EventSource
// while RECORDING (never synthesizing) the data. Does NOT replace the connection
// with a mock, does NOT inject frames. Mirrors the observer pattern in
// session-completion.spec.ts:installCapture (lines 52-89).
async function installPartAppendObserver(page: Page, session: string) {
  await page.addInitScript((sid) => {
    // --- Wire records (populated by the observer below) ---
    (window as any).__vhStreamUrls = [];    // every constructed EventSource URL
    (window as any).__vhPartAppends = [];   // parsed part.append payloads {start,field,textLen,t}
    (window as any).__vhSSELog = [];        // all session-stream events {type,t}

    const OrigES = (window as any).EventSource;

    // ObservingES is a transparent delegating wrapper: it constructs the REAL
    // native EventSource and returns it (with addEventListener patched for the
    // session stream only). All network activity — connection, reconnection,
    // event delivery — is handled by the native EventSource. The wrapper ONLY
    // records constructed URLs and event payloads before dispatching to the real
    // listener. No synthesis, no injection, no mock.
    function ObservingES(url: string, opts?: any) {
      const es = opts !== undefined ? new OrigES(url, opts) : new OrigES(url);
      try { (window as any).__vhStreamUrls.push(url); } catch { /* ignore */ }
      // Only instrument the per-SESSION stream (has sessions=<sid> param). The
      // tree stream carries no part.append events.
      const isSession = typeof url === "string" && url.indexOf("sessions=" + sid) !== -1;
      if (isSession) {
        const origAdd = es.addEventListener.bind(es);
        es.addEventListener = function (type: string, listener: any, options?: any) {
          return origAdd(
            type,
            (ev: MessageEvent) => {
              try {
                const d = typeof ev.data === "string" ? ev.data : "";
                (window as any).__vhSSELog.push({ type, t: performance.now() });
                // Parse part.append payloads to extract `start` for assertion 2.
                if (type === "part.append" && d) {
                  const parsed = JSON.parse(d);
                  (window as any).__vhPartAppends.push({
                    start: typeof parsed.start === "number" ? parsed.start : null,
                    field: parsed.field ?? null,
                    textLen: typeof parsed.text === "string" ? parsed.text.length : 0,
                    t: performance.now(),
                  });
                }
              } catch { /* ignore */ }
              // Delegate to the REAL listener — transparent pass-through.
              if (typeof listener === "function") listener(ev);
              else if (listener) listener.handleEvent(ev);
            },
            options,
          );
        };
      }
      return es;
    }
    ObservingES.prototype = OrigES.prototype;
    (ObservingES as any).CLOSED = OrigES.CLOSED;
    (ObservingES as any).OPEN = OrigES.OPEN;
    (ObservingES as any).CONNECTING = OrigES.CONNECTING;
    (window as any).EventSource = ObservingES;

    // --- DOM sample timeline (the incremental-apply proof) ---
    // Samples the last assistant message row's textContent on every DOM mutation
    // + a tight 20ms interval. With the fixture's 180ms chunk gaps and the 200ms
    // coalesce window, the prefix-only DOM window is ~200ms → ~10 samples, well
    // above the sampling resolution. The suffix-before-final window is even
    // wider (~400ms).
    (window as any).__vhDomSamples = [];
    const sample = () => {
      const msgs = Array.from(document.querySelectorAll(".msg[data-mid]"));
      const last = msgs[msgs.length - 1] as HTMLElement | undefined;
      const text = last ? (last.textContent || "") : "";
      (window as any).__vhDomSamples.push({
        t: performance.now(),
        hasPrefix: text.indexOf("Working on it") !== -1,
        hasSuffix: text.indexOf("Done. Updated") !== -1,
        hasFinal: text.indexOf("added a test") !== -1,
        workingVisible: document.querySelectorAll(".working-text").length > 0,
        msgCount: msgs.length,
      });
      const arr = (window as any).__vhDomSamples;
      if (arr.length > 600) (window as any).__vhDomSamples = arr.slice(-600);
    };
    const obs = new MutationObserver(() => sample());
    const start = () => {
      if (!document.body) { setTimeout(start, 16); return; }
      obs.observe(document.body, { childList: true, subtree: true });
      setInterval(sample, 20);
    };
    start();
  }, session);
}

// Reset a session to its seeded baseline (serial-suite hygiene). Mirrors
// session-completion.spec.ts:resetSession (lines 233-238). Uses page.request
// (Node-side HTTP) so it works before page.goto.
async function resetSession(page: Page, id: string) {
  const res = await page.request.post(`/oc/fixture/reset?session=${id}`, {
    headers: { "X-VH-CSRF": "1" },
  });
  if (!res.ok()) throw new Error(`resetSession(${id}) -> ${res.status()} ${res.statusText()}`);
}

// Prompt a session through the composer route. Mirrors
// session-completion.spec.ts:promptAndComplete (lines 211-223). The prompt text
// deliberately avoids the PREFIX/SUFFIX/FINAL markers so it can't pollute the
// DOM sample timeline.
async function promptSession(page: Page, id: string, text: string) {
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

test("part.append: live SSE suffix streaming — negotiated, delivered, incrementally applied before final update", async ({ page }) => {
  test.setTimeout(30_000);
  await page.setViewportSize(VP);
  // Serial-suite hygiene: clear accumulated turns from prior specs.
  await resetSession(page, "other");
  // Install the observer BEFORE page.goto so the EventSource wrapper is in
  // place before the SPA constructs its stream connections.
  await installPartAppendObserver(page, "other");
  await page.goto(projectUrl("/?session=other"));
  await expect(page.locator(".chat-scroll")).toBeVisible({ timeout: 10000 });

  // Drive one assistant turn through the real fixture (opencode.go:streamAssistant).
  await promptSession(page, "other", "part-append live wire probe");
  // Wait for the busy shimmer (session became active) then its removal (idle).
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 12000 });
  // Let the final DOM update + any trailing SSE events settle.
  await page.waitForTimeout(100);

  // === Read back wire + DOM records ===
  const rec = await page.evaluate(() => ({
    urls: (window as any).__vhStreamUrls as string[],
    appends: (window as any).__vhPartAppends as any[],
    sseLog: (window as any).__vhSSELog as any[],
    samples: (window as any).__vhDomSamples as any[],
  }));

  // --- Assertion 1: Wire negotiation — part_delta=1 in the session URL ---
  const sessionUrls = rec.urls.filter((u) => u.indexOf("sessions=other") !== -1);
  expect(
    sessionUrls.length,
    `no session-stream EventSource constructed. All URLs: ${JSON.stringify(rec.urls)}`,
  ).toBeGreaterThan(0);
  const negotiated = sessionUrls.some((u) => u.indexOf("part_delta=1") !== -1);
  expect(
    negotiated,
    `BUG: session stream URL missing part_delta=1 — the SPA did not opt into the ` +
      `suffix wire format (session-stream.ts:603). URLs: ${JSON.stringify(sessionUrls)}`,
  ).toBe(true);

  // --- Assertion 2: Wire frame — at least one part.append with start > 0 ---
  expect(
    rec.appends.length,
    `BUG: no part.append frames observed on the live session EventSource. ` +
      `Either the server did not convert message.part.delta → part.append, or the ` +
      `connection was not opted in. SSE event types seen: ` +
      `${JSON.stringify([...new Set(rec.sseLog.map((e) => e.type))])}`,
  ).toBeGreaterThan(0);
  const startPositive = rec.appends.filter((a) => a.start !== null && a.start > 0);
  expect(
    startPositive.length,
    `BUG: no part.append frame with start > 0 observed (all suffixes were start=0 ` +
      `or start was absent). This means the server is only emitting the initial ` +
      `frame, not the incremental suffixes. All starts: ` +
      `${JSON.stringify(rec.appends.map((a) => a.start))}`,
  ).toBeGreaterThan(0);

  // --- Assertion 3: Outcome — incremental DOM progression (anti-false-positive) ---
  // (a) Intermediate state: prefix present, suffix NOT yet visible.
  const prefixOnlyIdx = rec.samples.findIndex((s) => s.hasPrefix && !s.hasSuffix);
  // (b) Later state: suffix visible, final chunk NOT yet visible — proving the
  //     suffix arrived via streaming (part.append apply), not via the final
  //     authoritative message.part.updated (which carries ALL text at once).
  //     If the SPA ignored suffixes, the DOM would jump from prefix-only
  //     straight to final (all chunks at once) and this sample would never exist.
  const suffixNotFinalIdx = rec.samples.findIndex((s) => s.hasSuffix && !s.hasFinal);

  expect(
    prefixOnlyIdx,
    `Never observed prefix-only state ("${PREFIX}" present, "${SUFFIX}" absent). ` +
      `This means either the suffix was applied too fast to observe, or the SPA ` +
      `is not applying suffixes incrementally. Samples: ${rec.samples.length}. ` +
      `Timeline (first 30): ${JSON.stringify(rec.samples.slice(0, 30))}`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    suffixNotFinalIdx,
    `Never observed suffix-before-final state ("${SUFFIX}" present, "${FINAL}" absent). ` +
      `This is the false-positive signal: the suffix only appeared via the final ` +
      `authoritative message.part.updated (which carries all text at once), meaning ` +
      `the SPA is NOT applying part.append suffixes. Samples: ${rec.samples.length}.`,
  ).toBeGreaterThanOrEqual(0);
  // The suffix-before-final state must come AT OR AFTER the prefix-only state —
  // the progression is prefix-only → suffix-visible.
  expect(
    suffixNotFinalIdx >= prefixOnlyIdx,
    `suffix-before-final (sample ${suffixNotFinalIdx}) appeared BEFORE prefix-only ` +
      `(sample ${prefixOnlyIdx}) — the DOM progression order is wrong.`,
  ).toBe(true);

  // --- Diagnostic echo (always visible in the report, not just on failure) ---
  const sseTypes = [...new Set(rec.sseLog.map((e) => e.type))];
  const prefixOnlyCount = rec.samples.filter((s) => s.hasPrefix && !s.hasSuffix).length;
  const suffixNotFinalCount = rec.samples.filter((s) => s.hasSuffix && !s.hasFinal).length;
  console.log(
    "[part.append] " +
      `urls=${rec.urls.length} sessionUrls=${sessionUrls.length} part_delta=1=${negotiated} | ` +
      `part.append frames=${rec.appends.length} startPositive=${startPositive.length} ` +
      `starts=${JSON.stringify(rec.appends.map((a) => a.start))} | ` +
      `DOM samples=${rec.samples.length} prefixOnly=${prefixOnlyCount} ` +
      `suffixNotFinal=${suffixNotFinalCount} | ` +
      `sseTypes=${JSON.stringify(sseTypes)}`,
  );
});

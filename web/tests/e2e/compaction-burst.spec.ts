import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Incident 2026-08-19 stale-rows — LIVE-PATH CRUX for the FE keyless-shadow
// fix (281a2f2 + bcc578c, unit-proven only until this spec).
//
// Scenario class: IN-WINDOW NON-RESIDENT, PART-FIRST (keyless) burst,
// delivered through the REAL Stream-2 egress. The fixtureserver wires the
// REAL aggregator + REAL web server (tools/fixtureserver/main.go), so its SSE
// passes the production sendable window filter (pkg/web/server.go, 9401881).
// The burst parents are message ids that NEVER receive a message.updated
// during the burst (fork-like re-publication of old completed TOOL parts).
// The store holds part-first messages as keyless placeholders appended at
// order END (pkg/state upsertPartLocked → insertMessageIDOrdered: keyless
// sorts +∞), making each parent the NEWEST and therefore INSIDE the egress
// window (message_window.go: newest always in-window) — the real filter
// DELIVERS these frames BY DESIGN (the "keyless newest message on the live
// tail" class its contract names). This is NOT an out-of-window scripted
// bypass: out-of-window part frames are dropped by the production filter in
// this lane and can only be proven fixture-bypassed, which this repo forbids.
//
// What this proves (FE robustness, defense-in-depth behind the server
// filter): for whatever part-only events a server DOES forward — an older
// daemon without the filter, a client whose resident set disagrees with the
// server window, or the by-design keyless-newest live tail — the SPA must
//   (1) hold part-only events for non-resident parents as keyless shadows
//       that NEVER render (no stale rows after the final message, no rows
//       anywhere for unpromoted parents — including no top-jump),
//   (2) promote a shadow to its CHRONOLOGICAL slot (before the live tail,
//       ascending created order) when a keyed message.upsert follows,
//   (3) settle an idle tail that is the REAL newest message, with follow
//       intact (final row in viewport).
//
// What this spec does NOT cover (honest boundary): the out-of-window burst
// class (scripted delivery would require weakening/bypassing the production
// filter — dropped here by design) and the Load-older/eviction variant
// (evicted parents are server-out-of-window → dropped the same way; the FE
// eviction behavior is pinned unit-side in messagePage.test.ts "(e)").
//
// Scripting seam: POST /oc/fixture/compaction-burst (pkg/fixtures
// handleFixtureCompactionBurst) emits the sequence through the fake
// opencode's REAL /event stream — the same authoritative ingress path
// production events take. /fixture/reset hygiene (before + after each test)
// removes the scripted transcript fixture-side AND aggregator-side.

// Height 600, not the historical 320: since S2a (height-tier responsiveness,
// web/src/shapeTier.ts) 400×320 classifies as the `tiny` height tier, whose
// CSS defenses hide the `.working` pill. Width 400 (narrow intent) is
// preserved; 600 is safely normal-tier. Mirrors part-delta.spec.ts's VP note.
const VP = { width: 400, height: 600 };
type Page = import("@playwright/test").Page;

const SESSION = "other"; // empty-seeded session; reset-first users: part-delta, session-completion
const MARKER = "transcript tail stays clean"; // unique text on the real newest message

// Per-run tag for the scripted message ids. A module-scope const is evaluated
// once per worker, so --repeat-each iterations within this serial lane
// (workers:1) SHARE the tag — repeat safety comes from the reset hygiene
// below (before + after each test) plus same-id upsert dedup, NOT from tag
// distinctness. The tag still guarantees no collision with any OTHER spec's
// scripted ids or the seeded fixtures.
const TAG = "cb" + Date.now().toString(36);
const PARENTS = 12; // burst parents (cb…-m0..m11)
const PROMOTE = 4; // promoted subset (cb…-m0..m3), oldest ascending

// Transparent delegating EventSource observer (mirrors part-delta.spec.ts's
// ObservingES): records every session-stream event WITHOUT replacing the
// connection. The part.upsert/message.upsert records are the DELIVERY proof —
// without them the DOM assertions could pass vacuously (a filter drop would
// also leave the transcript clean).
async function installStreamObserver(page: Page, session: string) {
  await page.addInitScript((sid) => {
    (window as any).__vhStreamUrls = [];
    (window as any).__vhPartUpserts = []; // {sid, mid, pid}
    (window as any).__vhMessageUpserts = []; // {sid, mid, created}
    const OrigES = (window as any).EventSource;
    function ObservingES(url: string, opts?: any) {
      const es = opts !== undefined ? new OrigES(url, opts) : new OrigES(url);
      try { (window as any).__vhStreamUrls.push(url); } catch { /* ignore */ }
      const isSession = typeof url === "string" && url.indexOf("sessions=" + sid) !== -1;
      if (isSession) {
        const origAdd = es.addEventListener.bind(es);
        es.addEventListener = function (type: string, listener: any, options?: any) {
          return origAdd(
            type,
            (ev: MessageEvent) => {
              try {
                const d = typeof ev.data === "string" ? ev.data : "";
                if (type === "part.upsert" && d) {
                  const p = JSON.parse(d);
                  (window as any).__vhPartUpserts.push({ sid: p.sessionID, mid: p.messageID, pid: p.id });
                } else if (type === "message.upsert" && d) {
                  const m = JSON.parse(d);
                  (window as any).__vhMessageUpserts.push({
                    sid: m.sessionID, mid: m.id, created: m.time?.created ?? null,
                  });
                }
              } catch { /* ignore */ }
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
    (window as any).EventSource = ObservingES;
  }, session);
}

// Reset a session to its seeded baseline (serial-suite hygiene). Mirrors
// part-delta.spec.ts resetSession — reached through the real /oc/* proxy.
async function resetSession(page: Page, id: string) {
  const res = await page.request.post(`/oc/fixture/reset?session=${id}`, {
    headers: { "X-VH-CSRF": "1" },
  });
  if (!res.ok()) throw new Error(`resetSession(${id}) -> ${res.status()} ${res.statusText()}`);
}

test("compaction burst: part-only re-publications for non-resident parents never render; promotion re-slots; idle tail is the real newest", async ({ page }) => {
  test.setTimeout(40_000);
  await page.setViewportSize(VP);

  // Serial-suite hygiene: clear accumulated turns from prior specs (both
  // directions — beforeEach-equivalent here, afterEach hook below).
  await resetSession(page, SESSION);
  await installStreamObserver(page, SESSION);
  await page.goto(projectUrl("/?session=" + SESSION));
  await expect(page.locator(".chat-scroll")).toBeVisible({ timeout: 10000 });

  // Fire the scripted end-of-turn compaction burst through the real fixture
  // ingress. The handler emits busy → live tail (user + completed assistant,
  // the real newest) → 16 part-ONLY tool-part frames for 12 never-seen
  // parents → 4 keyed message.updated promotions (old, ascending) → idle,
  // then persists everything for the reset hygiene.
  const res = await page.request.post(
    `/oc/fixture/compaction-burst?session=${SESSION}&tag=${TAG}&parents=${PARENTS}&promote=${PROMOTE}`,
    { headers: { "X-VH-CSRF": "1" } },
  );
  if (!res.ok()) throw new Error(`compaction-burst -> ${res.status()} ${res.statusText()}`);

  // Outcome waits: the real newest message's marker text lands, and the turn
  // settles idle (busy shimmer gone). The scripted sequence is fast (~200ms
  // fixture-side), so gate on the OUTCOME, not on catching the transient
  // busy shimmer mid-flight.
  await expect(page.locator(".msg", { hasText: MARKER })).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 10000 });
  // Let any trailing SSE frames + the final DOM update settle.
  await page.waitForTimeout(250);

  // === Wire: the burst was DELIVERED through the real egress ===
  const rec = await page.evaluate(() => ({
    urls: (window as any).__vhStreamUrls as string[],
    parts: (window as any).__vhPartUpserts as any[],
    msgs: (window as any).__vhMessageUpserts as any[],
  }));
  const sessionUrls = rec.urls.filter((u) => u.indexOf("sessions=" + SESSION) !== -1);
  expect(
    sessionUrls.length,
    `no session-stream EventSource constructed. All URLs: ${JSON.stringify(rec.urls)}`,
  ).toBeGreaterThan(0);

  // Part frames for the burst parents crossed the REAL sendable filter.
  const burstParts = rec.parts.filter((p) => p.sid === SESSION && p.mid && p.mid.startsWith(TAG + "-m"));
  expect(
    burstParts.length,
    `BUG(vacuous): no part.upsert frames for burst parents observed on the live session ` +
      `stream — the scenario never reached the FE, so the DOM assertions below would prove ` +
      `nothing. All part mids: ${JSON.stringify([...new Set(rec.parts.map((p) => p.mid))])}`,
  ).toBeGreaterThanOrEqual(PARENTS);

  // The sharpest single proof, part 1 (wire): an UNPROMOTED parent's part
  // frame WAS delivered to the browser.
  const unpromotedMids: string[] = [];
  for (let i = PROMOTE; i < PARENTS; i++) unpromotedMids.push(`${TAG}-m${i}`);
  const deliveredUnpromoted = burstParts.filter((p) => unpromotedMids.includes(p.mid));
  expect(
    deliveredUnpromoted.length,
    `no part.upsert delivered for any unpromoted parent (${unpromotedMids[0]}..). ` +
      `Delivered burst mids: ${JSON.stringify([...new Set(burstParts.map((p) => p.mid))])}`,
  ).toBeGreaterThan(0);

  // Promotion frames arrived with OLD keys (chronological re-slot input).
  const promotedMids: string[] = [];
  for (let i = 0; i < PROMOTE; i++) promotedMids.push(`${TAG}-m${i}`);
  const promotedMsgs = rec.msgs.filter((m) => m.sid === SESSION && promotedMids.includes(m.mid));
  expect(
    promotedMsgs.length,
    `expected ${PROMOTE} message.upsert promotions on the wire, saw ${JSON.stringify(rec.msgs)}`,
  ).toBe(PROMOTE);
  for (const m of promotedMsgs) {
    expect(m.created, `promotion for ${m.mid} must carry an old time.created`).toBeTruthy();
  }

  // === DOM: the rendered transcript stays clean ===
  // The render list is exactly [promoted parents ascending] → [live user] →
  // [final assistant]. One exact-sequence assertion subsumes: no stale rows
  // after the final message, no top-jump misplacement, promotion re-slotted
  // chronologically (m0 oldest → first), live tail intact.
  const expectedOrder = [...promotedMids, `${TAG}-lu`, `${TAG}-la`];
  const domOrder = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".msg[data-mid]")).map((el) => el.getAttribute("data-mid")),
  );
  expect(
    domOrder,
    `BUG(stale-rows): rendered row order diverges. Expected the promoted parents in ` +
      `ascending-created order followed by the live tail (${JSON.stringify(expectedOrder)}), ` +
      `saw ${JSON.stringify(domOrder)}. Unpromoted parents present = stale shadow rows; ` +
      `misordered promoted rows = broken re-slot; anything after ${TAG}-la = tail pollution.`,
  ).toEqual(expectedOrder);

  // The sharpest single proof, part 2 (DOM): the UNPROMOTED parents whose
  // part frames demonstrably arrived on the wire (asserted above) never
  // rendered ANY row — the keyless-shadow contract live.
  for (const mid of unpromotedMids) {
    await expect(
      page.locator(`.msg[data-mid="${mid}"]`),
      `BUG(stale-rows): unpromoted parent ${mid} rendered a row — a part-only event for a ` +
        `non-resident parent must be held as a keyless shadow (never in order, never rendered).`,
    ).toHaveCount(0);
  }

  // Idle tail is the REAL newest message: last row is the live assistant,
  // carries the marker text, and is in the viewport (follow intact — no
  // top-jump stranded the view away from the tail).
  const rows = page.locator(".msg[data-mid]");
  await expect(rows).toHaveCount(expectedOrder.length);
  const lastRow = rows.last();
  await expect(lastRow).toHaveAttribute("data-mid", `${TAG}-la`);
  await expect(lastRow).toContainText(MARKER);
  await expect(lastRow).toBeInViewport({ timeout: 5000 });

  // Diagnostic echo (visible in the report, not just on failure).
  console.log(
    "[compaction-burst] " +
      `tag=${TAG} burstPartsDelivered=${burstParts.length} ` +
      `distinctBurstMids=${new Set(burstParts.map((p) => p.mid)).size} ` +
      `deliveredUnpromoted=${deliveredUnpromoted.length} promotions=${promotedMsgs.length} | ` +
      `domRows=${domOrder.length} order=${JSON.stringify(domOrder)}`,
  );
});

// Serial-suite hygiene: remove the scripted transcript (fixture-side AND
// aggregator-store-side via /fixture/reset's message.removed fan-out) so
// later specs opening this session start from the seeded empty baseline.
test.afterEach(async ({ page }) => {
  await resetSession(page, SESSION);
});

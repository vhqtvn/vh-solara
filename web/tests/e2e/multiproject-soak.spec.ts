import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  digestMessage,
  installObserver,
  pageOrigin,
  pollDone,
  post,
  runStreamingScenario,
  startRun,
  summarizePage,
  type Expected,
} from "./multiproject-helpers";

// THE SOAK (dispatch-only lane). This is the FULL-SCALE Phase-A2 sustained
// seven-page demand test, verbatim as it ran in the PR lane until the
// test-speed plan slice 3 split (researches/decisions/test-suite-speed.md,
// option 2): seven pages, minutes-scale-free streaming runs, the full ring
// filler. Wall class: ~49s of PR-lane body time (2026-10-18 receipt) for
// LATENCY-DIAGNOSTIC value — the structural/correctness obligations it also
// carried are retained per-PR by the scaled-down form in
// multiproject-latency.spec.ts plus the Go latency guard
// (tests/e2e/multiproject_latency_guard_test.go).
//
// Excluded from ordinary lane-6 discovery (playwright.config.ts testIgnore);
// runs ONLY via its dedicated config:
//   cd web && npx playwright test --config=playwright.multiproject-soak.config.ts
// (CI: nightly cron + workflow_dispatch, NOT PR-blocking — the
// queue-delivery-custody lane's pattern.)
//
// Scenarios (serial, in ONE test so the fleet stays warm):
//   S1 cold seven-page opening (hydrate from nothing, 7 pages at once)
//   S2 warm suffix streaming   (part_delta=1 negotiated — asserted)
//   S3 bulk (one 48KiB-chunk project) + six small flows
//   S4 clean reconnect         (close page-0's session EventSource; the SPA's
//                               real CLOSED-retry path reopens with cursor=
//                               and the ring replays the missed window)
//   S5 stale-ring repair       (close page-1's stream WITHOUT retry, rotate
//                               the 4096-event shared ring past its cursor
//                               with an unselected-session filler run, then
//                               dispatch the retry: cursor is stale → server
//                               falls back to a fresh snapshot repair)
//
// METRICS (diagnostic — latency thresholds are deliberately NOT asserted
// here; the Go guard carries the PR-facing latency watch): per project/page,
// same-clock browser timestamps — SSE callback entry → decode completion →
// flush (store-apply boundary via the SPA's __vhFlushCollector slot) → DOM
// marker observation, rAF intervals, long-task entries, hydrate/reconnect
// timings, sequence IDs. Rows are dumped to the JSON file named by VH_MP_A2_OUT
// when set.

const PROJECTS = 7;
const CHUNK_BYTES = 2048;
const WARM_EVENTS = 40;
const WARM_CADENCE_MS = 120;
const BULK_CHUNK_BYTES = 48 * 1024;
// 20 × 48 KiB = 960 KiB < the store's 1 MiB per-part text cap
// (pkg/state/store.go partTextCap): a part that crosses the cap is SEALED
// with a "…[output truncated: N further bytes omitted]…" marker and further
// deltas are DROPPED. Keeping bulk under the cap keeps the byte-exact digest
// gate meaningful — and keeping it NEAR the cap (the full 20-event form,
// soak-only) also exercises the close-to-truncation regime. The scaled PR
// form's 6-event bulk (288 KiB) stays comfortably clear of it.
const BULK_EVENTS = 20;
const BULK_CADENCE_MS = 220;
const RECONNECT_EVENTS = 36;
const RECONNECT_CADENCE_MS = 150;
// The shared store ring retains 4096 events (web.NewServer(..., 4096)); the
// filler must push past that to make page-1's cursor stale. Empirically the
// per-event ring accounting under a 1ms-cadence filler left cursor=794 still
// replayable with 4600 events, so over-provision heavily: 9000 events per
// session (~4900 events of slack over capacity — covers any half-push
// accounting). 64-byte chunks on UNSELECTED sessions (mp0_s1/mp1_s1) keep the
// filler invisible to every page (interest filtering) while it rotates rings.
// DO NOT TRIM THIS OVER-PROVISION when scaling other knobs — it is the
// correctness-critical staleness guarantee (and the historical CI flake was
// exactly here before the backpressure contract landed).
const RING_CAP = 4096;
const FILLER_EVENTS = 2 * RING_CAP + 808;

test("A2 seven-page sustained demand: fixture-driven browser attribution (soak)", async ({ page, request }) => {
  // Headroom for pollDone's slow-runner allowance (see POLL_STALL_MS).
  test.setTimeout(300_000);
  const t0 = Date.now();
  const fleet: Page[] = [page];
  const runIDs: number[] = [];
  const dump: any = { startedAt: new Date().toISOString(), scenarios: {} as any };
  const ctx = { request, fleet, projects: PROJECTS, runIDs, dump };

  try {
    // ---- 0. Seed the multi-project substrate (idempotent across reruns
    // against a reused fixtureserver) ----
    const seed = await post(request, "/oc/fixture/mp-seed", {
      projects: PROJECTS,
      sessions_per_proj: 2, // s0 = page-selected; s1 = unselected filler target (S5)
      bulk_sessions: 1,
      turns_per_session: 4,
      small_part_bytes: 1024,
      bulk_part_bytes: 120_000,
    });
    if (seed.status !== 200 && seed.status !== 409) {
      throw new Error(`mp-seed -> ${seed.status}: ${JSON.stringify(seed.body)}`);
    }

    // ---- fleet: 7 pages in ONE context (same-profile tabs) ----
    for (let i = 1; i < PROJECTS; i++) fleet.push(await page.context().newPage());
    for (let i = 0; i < PROJECTS; i++) await installObserver(fleet[i], i);

    // ---- 1.5 pre-warm each dir's store BEFORE any fleet page loads ----
    // The per-dir aggregator is created lazily on first request and its store
    // fills a moment later; a page that connects before its dir's rows are
    // resident can snapshot-empty and drop the URL session selection. Warm
    // each dir by fetching its tree stream until a frame actually contains
    // the dir's first session, then move on (lane-3's mpBootstrapDirs
    // pattern, ported to the browser).
    await fleet[0].goto("/", { waitUntil: "commit" });
    for (let i = 0; i < PROJECTS; i++) {
      const sid = `mp${i}_s0`;
      const deadline = Date.now() + 25_000;
      let lastHead = "";
      for (;;) {
        const ok = await fleet[0].evaluate(async ({ dir, sid }) => {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 4000);
          try {
            const r = await fetch(`/vh/stream?dir=${encodeURIComponent(dir)}`, { signal: ctrl.signal });
            const rd = r.body!.getReader();
            const dec = new TextDecoder();
            let buf = "";
            for (;;) {
              const { done, value } = await rd.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              if (buf.includes(`"${sid}"`)) {
                await rd.cancel().catch(() => {});
                return { ok: true, head: buf.slice(0, 200) };
              }
              // A snapshot already arrived WITHOUT our session: reconnect
              // (the store fills between attempts; waiting on live events of
              // a connection that snapshotted pre-hydration is slower).
              if (buf.includes("event: snapshot") || buf.includes("event: tree.snapshot")) {
                await rd.cancel().catch(() => {});
                return { ok: false, head: buf.slice(0, 200) };
              }
            }
            return { ok: false, head: buf.slice(0, 200) };
          } catch {
            return { ok: false, head: "fetch-error" };
          } finally {
            clearTimeout(to);
          }
        }, { dir: `/work/mproj${i}`, sid });
        if (ok.ok) break;
        lastHead = ok.head;
        if (Date.now() > deadline) {
          throw new Error(`prewarm: dir /work/mproj${i} never served session ${sid} within 25s; last stream head: ${JSON.stringify(lastHead)}`);
        }
        await fleet[0].waitForTimeout(400);
      }
    }

    // ================= S1: cold seven-page opening =================
    const tGoto = Date.now();
    await Promise.all(
      fleet.map((p, i) => p.goto(`${pageOrigin(i)}/?dir=${encodeURIComponent(`/work/mproj${i}`)}&session=mp${i}_s0`, { waitUntil: "commit" })),
    );
    // Hydration complete = the LAST seeded baseline turn is rendered.
    await Promise.all(
      fleet.map((p, i) =>
        expect(p.locator(`[data-mid="mp${i}_s0_a4"]`)).toBeVisible({ timeout: 25_000 }),
      ),
    );
    const coldNodeMs = Date.now() - tGoto;

    // Project isolation (S1 gate): page i shows ONLY project i's sessions.
    for (let i = 0; i < PROJECTS; i++) {
      const body = await fleet[i].evaluate(() => document.body.innerText);
      expect(body, `page ${i} cross-project bleed`).toContain(`Multi project ${i} `);
      for (let j = 0; j < PROJECTS; j++) {
        if (j === i) continue;
        expect(body, `page ${i} leaks project ${j}`).not.toContain(`Multi project ${j} `);
      }
    }
    const coldCols = [];
    for (const p of fleet) coldCols.push(await p.evaluate(() => (window as any).__mpCollect()));
    // Hydrate timing: per page, session-ES construct → first snapshot frame.
    const coldRows = coldCols.map((c: any) => {
      const ses = c.es.filter((e: any) => e.url.indexOf("sessions=mp") !== -1);
      const firstSnap = c.snapshots[0];
      const constructT = ses.length ? ses[0].t : -1;
      const snapT = firstSnap ? firstSnap.t : -1;
      return {
        proj: c.proj,
        esConstructed: ses.length,
        negotiated: ses.some((e: any) => e.url.indexOf("part_delta=1") !== -1),
        constructToSnapshotMs: constructT >= 0 && snapT >= 0 ? +(snapT - constructT).toFixed(2) : -1,
        nodeColdMs: coldNodeMs,
      };
    });
    for (const r of coldRows) {
      expect(r.esConstructed, `page ${r.proj} never opened a session stream`).toBeGreaterThan(0);
      // GATE: append negotiation is active on every page from the cold open.
      expect(r.negotiated, `page ${r.proj} session stream missing part_delta=1`).toBe(true);
    }
    dump.scenarios.cold = { nodeColdMs: coldNodeMs, pages: coldRows };
    console.log(`[A2 S1 cold] 7-page hydrate nodeMs=${coldNodeMs} | ` + coldRows.map((r) => `p${r.proj} snap=${r.constructToSnapshotMs}ms`).join(" "));

    // ================= S2: warm suffix streaming =================
    const s2 = await runStreamingScenario(ctx, "warm", {
      projects: PROJECTS, session_idx: 0, events: WARM_EVENTS,
      chunk_bytes: CHUNK_BYTES, bulk_project: -1, cadence_ms: WARM_CADENCE_MS,
    }, 30_000, true);
    await post(request, "/oc/fixture/mp-workload/reset", { run_id: s2.start.run_id });

    // ================= S3: bulk (one project) + six small flows =================
    await runStreamingScenario(ctx, "bulk", {
       projects: PROJECTS, session_idx: 0, events: BULK_EVENTS,
       chunk_bytes: 1536, bulk_project: 0, bulk_chunk_bytes: BULK_CHUNK_BYTES,
       cadence_ms: BULK_CADENCE_MS,
    }, 40_000, false);

    // ================= S4: clean reconnect (cursor replay) =================
    let s4Expected: Expected | null = null;
    {
      const spec = {
        projects: PROJECTS, session_idx: 0, events: RECONNECT_EVENTS,
        chunk_bytes: CHUNK_BYTES, bulk_project: -1, cadence_ms: RECONNECT_CADENCE_MS,
      };
      const start = await startRun(request, spec);
      runIDs.push(start.run_id);
      await Promise.all(fleet.map((p) => p.evaluate((run) => {
        (window as any).__mpTarget = { run };
        (window as any).__mp.rafOn = true;
      }, start.run_id)));
      await post(request, "/oc/fixture/mp-workload/release", { run_id: start.run_id });

      // Mid-run: close page-0's session EventSource and dispatch the error —
      // driving the SPA's REAL fatal-error path (onerror + readyState CLOSED
      // → 1.5s backoff → open() retry WITH retained cursor → ring replay).
      await fleet[0].waitForTimeout(1200);
      const closed = await fleet[0].evaluate(() => {
        const M = (window as any).__mp;
        const rec = [...M.es].reverse().find((r: any) => r.url.indexOf("sessions=mp0_s0") !== -1 && r.es.readyState === 1);
        if (!rec) return { found: false };
        const t = performance.now();
        rec.es.close();
        rec.es.dispatchEvent(new Event("error"));
        return { found: true, t };
      });
      expect(closed.found, "page 0 session EventSource not open at reconnect time").toBe(true);
      // The found-assert above guarantees the {found:true,t} branch; narrow once.
      const closedT = (closed as { t: number }).t;

      const done = await pollDone(request, start.run_id, 30_000);
      s4Expected = done.expected[1]; // S5 re-checks page 1's transcript after repair
      await expect
        .poll(() => fleet[0].evaluate(() => ((window as any).__mp.markers.slice(-1)[0] || { k: 0 }).k), { timeout: 20_000 })
        .toBe(RECONNECT_EVENTS);
      await fleet[0].waitForTimeout(300);

      const col0 = await fleet[0].evaluate(() => (window as any).__mpCollect());
      const e0 = done.expected[0];
      // GATE: replay repaired the gap — final content still byte-exact.
      const dig = await digestMessage(fleet[0], e0.message_id);
      expect((dig as any).hex, "page 0 post-reconnect digest").toBe(e0.digest);
      // GATE: the retry really was cursor-based (replay path).
      const retryUrl = col0.es.map((x: any) => x.url).filter((u: string) => u.indexOf("sessions=mp0_s0") !== -1 && u.indexOf("cursor=") !== -1);
      expect(retryUrl.length, "no cursor= retry URL constructed after close").toBeGreaterThan(0);
      // GATE: replay completeness — suffix frames still contiguous 0..final.
      const frames = col0.frames.filter((f: any) => f.start !== null).sort((a: any, b: any) => a.start - b.start);
      let off = 0;
      for (const f of frames) { expect(f.start).toBe(off); off += f.textBytes; }
      expect(off).toBe(e0.final_len);
      const flushSum = col0.flushes.reduce((a: number, b: any) => a + b.n, 0);
      expect(flushSum).toBe(frames.length);

      // Other pages unaffected by page 0's reconnect.
      for (let i = 1; i < PROJECTS; i++) {
        const dig = await digestMessage(fleet[i], done.expected[i].message_id);
        expect((dig as any).hex, `page ${i} digest after page-0 reconnect`).toBe(done.expected[i].digest);
      }

      const retryConn = col0.es.reduce((acc: any, x: any, idx: number) => (x.url.indexOf("cursor=") !== -1 && x.url.indexOf("sessions=mp0_s0") !== -1 ? idx : acc), -1);
      const firstEv = retryConn >= 0 ? col0.connFirst[retryConn] : null;
      const mkLast = (col0.markers[col0.markers.length - 1] || { t: -1 }).t;
      const reopenMs = firstEv && closedT >= 0 ? +(firstEv.t - closedT).toFixed(1) : -1;
      const caughtUpMs = mkLast >= 0 && closedT >= 0 ? +(mkLast - closedT).toFixed(1) : -1;
      dump.scenarios.reconnect = {
        runId: start.run_id,
        closeT: closed.t,
        firstEventAfterReopenMs: reopenMs,
        caughtUpMs,
        retryFirstEventType: firstEv ? firstEv.type : null,
        page0: summarizePage(col0, e0.chunk_bytes, e0.events),
      };
      console.log(`[A2 S4 reconnect] reopen=${reopenMs}ms caughtUp=${caughtUpMs}ms first=${firstEv ? firstEv.type : "?"}`);
    }

    // ================= S5: stale-ring repair (snapshot fallback) =================
    {
      // Close page-1's session stream WITHOUT the error dispatch: no retry is
      // armed (STALE_MS=45s » our window), so the cursor freezes in place.
      const closed = await fleet[1].evaluate(() => {
        const M = (window as any).__mp;
        const rec = [...M.es].reverse().find((r: any) => r.url.indexOf("sessions=mp1_s0") !== -1 && r.es.readyState === 1);
        if (!rec) return { found: false, t: -1, connCount: M.es.length };
        const t = performance.now();
        rec.es.close();
        return { found: true, t, connCount: M.es.length };
      });
      expect(closed.found, "page 1 session EventSource not open at S5 start").toBe(true);
      const connCountAtClose: number = (closed as any).connCount;

      // Rotate the shared 4096-event ring past page-1's cursor using
      // UNSELECTED sessions (mp0_s1 AND mp1_s1): rings are PER-STORE (one
      // per-dir aggregator), so the filler must push the store page-1's
      // stream reads from — /work/mproj1 — not just any ring. Interest
      // filtering keeps both fillers invisible to every page.
      const filler = await startRun(request, {
        projects: 2, session_idx: 1, events: FILLER_EVENTS, chunk_bytes: 64,
        bulk_project: -1, cadence_ms: 1,
      });
      runIDs.push(filler.run_id);
      await post(request, "/oc/fixture/mp-workload/release", { run_id: filler.run_id });
      const fillerDone = await pollDone(request, filler.run_id, 40_000);
      expect(fillerDone.emitted, "filler emitted").toBe(FILLER_EVENTS * 2); // 2 unselected sessions
      expect(fillerDone.dropped_run, "filler overflow (aggregator pump fell behind?)").toBe(0);

      // Repair detection: page 1's session stream must come back and deliver
      // a SNAPSHOT on a post-close connection. TWO real repair paths exist:
      //   (a) cursor-fallback — the CLOSED-retry reuses the now-stale cursor
      //       and the server's ring-gap path answers with a fresh snapshot;
      //   (b) cursorless-reopen — the SPA proactively reopens (a CLOSED
      //       stream fails openSessionStream's early-return guard, and the
      //       filler's tree churn re-asserts selection), which is a fresh
      //       client to the server → snapshot.
      // Both are legitimate repair; record which fired. If nothing reconnected
      // during the filler, dispatch the error to arm the 1.5s CLOSED retry.
      const dispatch = await fleet[1].evaluate(() => {
        const M = (window as any).__mp;
        const mp1 = M.es.filter((e: any) => e.url.indexOf("sessions=mp1_s0") !== -1);
        if (mp1.some((e: any) => e.es.readyState === 1)) return { dispatched: false, reason: "already-reconnected" };
        const rec = [...M.es].reverse().find((r: any) => r.url.indexOf("sessions=mp1_s0") !== -1 && r.es.readyState === 2);
        if (rec) {
          rec.es.dispatchEvent(new Event("error"));
          return { dispatched: true, reason: "closed-retry-armed" };
        }
        return { dispatched: false, reason: "no-closed-conn" };
      });
      let repair: { repaired: boolean; path?: string; conn?: number; regs?: any } = { repaired: false };
      {
        const deadline = Date.now() + 20_000;
        for (;;) {
          repair = await fleet[1].evaluate((fromIdx: number) => {
            const M = (window as any).__mp;
            const idxs = M.es.map((e: any, i: number) => ({ i, url: e.url }))
              .filter((r: { i: number; url: string }) => r.url.indexOf("sessions=mp1_s0") !== -1 && r.i >= fromIdx)
              .map((r: { i: number; url: string }) => r.i);
            for (const i of idxs) {
              const evs = M.events.filter((e: any) => e.conn === i);
              if (evs.some((e: any) => e.type === "snapshot")) {
                return {
                  repaired: true,
                  path: M.es[i].url.indexOf("cursor=") !== -1 ? "cursor-fallback" : "cursorless-reopen",
                  conn: i,
                };
              }
            }
            return {
              repaired: false,
              regs: M.es.map((e: any) => ({ u: e.url.slice(0, 60), s: e.es.readyState })).filter((r: any) => r.u.indexOf("mp1_s0") !== -1),
            };
          }, connCountAtClose);
          if (repair.repaired) break;
          if (Date.now() > deadline) {
            throw new Error(
              `stale-ring repair never delivered a snapshot (dispatch=${JSON.stringify(dispatch)}); mp1_s0 connections: ${JSON.stringify(repair.regs)}`,
            );
          }
          await fleet[1].waitForTimeout(250);
        }
      }

      // GATE: repair correctness — the transcript is intact and byte-exact
      // after the snapshot fallback. Page 1's latest message is still S4's
      // streamed message (S4/S3 runs are NOT reset yet — the snapshot must
      // reproduce them exactly).
      const repairDigest = await fleet[1].evaluate(async () => {
        const rows = Array.from(document.querySelectorAll(".msg[data-mid], .msg[ln]"));
        const last = rows[rows.length - 1] as HTMLElement | null;
        if (!last) return { error: "no messages" };
        const mid = last.getAttribute("data-mid") || last.getAttribute("ln") || "";
        const md = last.querySelector(".md");
        if (!md) return { error: "no-md", mid };
        const raw = md.textContent || "";
        const txt = raw.endsWith("\n") ? raw.slice(0, -1) : raw; // renderer's one trailing newline
        const bytes = new TextEncoder().encode(txt);
        const buf = await crypto.subtle.digest("SHA-256", bytes);
        const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
        return { mid, hex, bytes: bytes.length };
      });
      expect(s4Expected, "S4 expected not captured").not.toBeNull();
      expect((repairDigest as any).mid, "post-repair latest message is not S4's").toBe((s4Expected as Expected).message_id);
      expect((repairDigest as any).hex, "post-repair digest mismatch").toBe((s4Expected as Expected).digest);
      expect((repairDigest as any).bytes, "post-repair byte length").toBe((s4Expected as Expected).final_len);
      dump.scenarios.staleRing = { fillerRunId: filler.run_id, fillerEvents: FILLER_EVENTS, dispatch, repairPath: repair.path, repairConn: repair.conn, repair: repairDigest };
      console.log(`[A2 S5 stale-ring] filler=${FILLER_EVENTS}ev×2 dispatch=${dispatch.reason} repairPath=${repair.path} lastMsg=${(repairDigest as any).mid} digest OK`);

      // Reset every workload run this test created (hygiene; also proves reset
      // works on completed runs with live pages still attached).
      for (const id of [...runIDs]) await post(request, "/oc/fixture/mp-workload/reset", { run_id: id });
      runIDs.length = 0;
    }

    dump.totalNodeMs = Date.now() - t0;
    dump.ok = true;
  } finally {
    // Best-effort hygiene + diagnostics dump (even on failure).
    for (const id of [...runIDs]) {
      await post(request, "/oc/fixture/mp-workload/stop", { run_id: id }).catch(() => {});
      await post(request, "/oc/fixture/mp-workload/reset", { run_id: id }).catch(() => {});
    }
    const out = process.env.VH_MP_A2_OUT;
    if (out) {
      const abs = path.resolve(out);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, JSON.stringify(dump, null, 1));
      console.log(`[A2] metrics dump → ${abs}`);
    }
  }
});

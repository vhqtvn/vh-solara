import { expect, test, type Page, type APIRequestContext } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Phase A2 — browser-side apply/render attribution under SUSTAINED
// seven-project demand (Q2 of the multi-project contention brief,
// tmp/agent-runs/multiproject-contention-20260918/open-questions-brief.md).
//
// Shape: SEVEN pages in ONE browser context (shared cookies/storage — the
// same-profile-tabs model the operator reported), each pointed at its own
// seeded project dir (/work/mproj<i>, session mp<i>_s0), driven against the
// DIRECT fixture server (tunnel-sever is explicitly out of scope here; a
// later lane-6 tunnel configuration extends this rail).
//
// Demand comes from the fixture-side sustained-workload controls
// (pkg/fixtures/mpworkload.go): deterministic byte-exact UTF-8 chunks at a
// fixed cadence behind a start barrier, with emitted/overflow accounting.
// The fixture's old 4-chunk @180ms prompt simulation cannot sustain demand;
// these runs stream 26–40 chunks/page for minutes-scale-free seconds.
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
// METRICS (diagnostic — latency thresholds are deliberately NOT asserted):
// per project/page, same-clock browser timestamps — SSE callback entry →
// decode completion → flush (store-apply boundary via the SPA's
// __vhFlushCollector slot) → DOM marker observation (MutationObserver on the
// streaming text nodes), rAF intervals, long-task entries ("unavailable"
// when the browser lacks support, never zero), hydrate/reconnect timings,
// sequence IDs (SSE lastEventId) for correlation. Rows are dumped to the
// JSON file named by VH_MP_A2_OUT when set (the A1b VH_MP_SHAPED_OUT
// pattern).
//
// CI GATES (structural, asserted): exact final content (DOM textContent
// sha256 == fixture digest, byte length == expected), project isolation (no
// foreign project markers, own-project tree only), append negotiation active
// (part_delta=1 URL + part.append frames with contiguous byte ranges),
// workload accounting (fixture emitted/dropped reconciles; flush ledger sums
// to the observed frame count), repair/replay correctness (cursor replay in
// S4, snapshot fallback in S5, digests intact after both), bounded
// completion (every wait has a generous deadline).

const PROJECTS = 7;
const CHUNK_BYTES = 2048;
const WARM_EVENTS = 40;
const WARM_CADENCE_MS = 120;
const BULK_CHUNK_BYTES = 48 * 1024;
// 20 × 48 KiB = 960 KiB < the store's 1 MiB per-part text cap
// (pkg/state/store.go partTextCap): a part that crosses the cap is SEALED
// with a "…[output truncated: N further bytes omitted]…" marker and further
// deltas are DROPPED — measured live during this spec's bring-up (wire
// appends stop ~1.045MB in, DOM freezes, cold digest shows the marker).
// Keeping bulk under the cap keeps the byte-exact digest gate meaningful;
// the cap itself is recorded as an A2 finding.
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
const RING_CAP = 4096;
const FILLER_EVENTS = 2 * RING_CAP + 808;

const CSRF = { "X-VH-CSRF": "1", "content-type": "application/json" };

// Per-page origins: the SPA holds 3 long-lived SSE connections per page
// (tree + session + project-settings watch); 7 pages on ONE HTTP/1.1 origin
// need 21 concurrent connections against Chromium's 6-per-host budget, which
// starves pages 3-7 entirely (verified by probe: p0-p2 hydrate, p3-p6 sit at
// "No sessions yet" forever). Real same-origin deployments hit this too
// unless served over h2 — recorded as a finding, worked around HERE by giving
// each page its own *.localhost loopback host alias (same server, same
// context, same process — only the origin label differs; per-origin storage
// was never shared across different origins anyway, so the same-profile
// fidelity that matters — shared process/GPU/scheduling — is preserved).
function pageOrigin(i: number): string {
  const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8099";
  const port = new URL(base).port || "8099";
  return `http://mp${i}.localhost:${port}`;
}

type Expected = {
  sid: string;
  message_id: string;
  part_id: string;
  events: number;
  chunk_bytes: number;
  final_len: number;
  digest: string;
};
type RunSnap = {
  run_id: number;
  state: string;
  emitted: number;
  bookends: number;
  dropped_run: number;
  dropped_total: number;
  expected: Expected[];
};

async function post(request: APIRequestContext, p: string, data?: unknown) {
  const res = await request.post(p, { headers: CSRF, data: data ?? {} });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

async function startRun(request: APIRequestContext, spec: unknown): Promise<RunSnap> {
  const { status, body } = await post(request, "/oc/fixture/mp-workload/start", spec);
  if (status !== 200) throw new Error(`workload start -> ${status}: ${JSON.stringify(body)}`);
  return body as RunSnap;
}

// pollDone waits for a released workload run to finish. It fails on a STALL
// (no `emitted` progress for POLL_STALL_MS) or past a hard cap of 3× the
// scenario's expected budget — not on a fixed deadline: the fixture's 1 ms
// ticker drops ticks when emit fan-out falls behind, so a loaded CI runner
// streams the same run several times slower while still making progress (CI:
// the S5 filler was 93% done — 16.7k/18k events — at the old 40 s deadline).
const POLL_STALL_MS = 15_000;
async function pollDone(request: APIRequestContext, runID: number, timeoutMs: number): Promise<RunSnap> {
  const started = Date.now();
  const hardCap = started + timeoutMs * 3;
  let lastEmitted = -1;
  let lastProgress = started;
  for (;;) {
    const res = await request.get(`/oc/fixture/mp-workload/status?run=${runID}`);
    const body = (await res.json()) as RunSnap;
    if (body.state === "done") {
      const took = Date.now() - started;
      if (took > timeoutMs) console.log(`[pollDone] run ${runID} took ${took}ms (> ${timeoutMs}ms budget; slow runner)`);
      return body;
    }
    if (body.state === "cancelled" || body.state === "reset") {
      throw new Error(`run ${runID} unexpectedly ${body.state}`);
    }
    const now = Date.now();
    if (body.emitted !== lastEmitted) {
      lastEmitted = body.emitted;
      lastProgress = now;
    }
    if (now - lastProgress > POLL_STALL_MS) {
      throw new Error(`run ${runID} stalled: no progress for ${POLL_STALL_MS}ms (state=${body.state} emitted=${body.emitted})`);
    }
    if (now > hardCap) {
      throw new Error(`run ${runID} not done after ${now - started}ms, 3× its ${timeoutMs}ms budget (state=${body.state} emitted=${body.emitted})`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// installObserver — transparent measurement rail installed BEFORE the SPA
// boots (addInitScript). Nothing here mocks or synthesizes: the REAL native
// EventSource constructs, connects, and dispatches; the wrapper only records.
// Mirrors the delegating-observer pattern of part-delta.spec.ts.
async function installObserver(page: Page, proj: number) {
  await page.addInitScript((proj: number) => {
    const W = window as any;
    const M = (W.__mp = {
      proj,
      es: [] as any[],        // {url, t, es} — es stripped on collect
      events: [] as any[],    // session-stream events {type,id,tCb,tDec,len,conn}
      frames: [] as any[],    // part.append frames {start,textLen,tCb,tDec,id,conn}
      flushes: [] as any[],   // SPA flush boundaries {t,n} (store-apply proxy)
      markers: [] as any[],   // DOM progress {k,t} (own project+run max tick)
      foreign: 0,             // markers of another project/run seen in OUR DOM
      snapshots: [] as any[], // {t,conn}
      connFirst: {} as any,   // conn index -> first delivered event {url,type,t}
      raf: [] as number[],
      rafOn: false,
      longtasks: [] as any[],
      ltAvailable: null as boolean | null,
    });

    // --- transparent EventSource wrapper ---
    const OrigES = W.EventSource;
    function ObservingES(url: string, opts?: any) {
      const es = opts !== undefined ? new OrigES(url, opts) : new OrigES(url);
      const conn = M.es.length;
      M.es.push({ url, t: performance.now(), es });
      const isSession = typeof url === "string" && url.indexOf("/vh/stream") !== -1 && url.indexOf("sessions=mp") !== -1;
      if (isSession) {
        const origAdd = es.addEventListener.bind(es);
        es.addEventListener = function (type: string, listener: any, options?: any) {
          return origAdd(
            type,
            (ev: MessageEvent) => {
              try {
                const tCb = performance.now();
                const d = typeof ev.data === "string" ? ev.data : "";
                let tDec = tCb;
                if (d) {
                  JSON.parse(d); // decode-cost proxy on the same payload/event loop
                  tDec = performance.now();
                }
                const id = ev.lastEventId || "";
                M.events.push({ type, id, tCb, tDec, len: d.length, conn });
                if (!(conn in M.connFirst)) M.connFirst[conn] = { url, type, t: tCb };
                if (type === "snapshot") M.snapshots.push({ t: tCb, conn });
                if (type === "part.append" && d) {
                  let start: number | null = null;
                  let textLen = 0;
                  let textStr: string | null = null;
                  try {
                    const p = JSON.parse(d);
                    if (typeof p.start === "number") start = p.start;
                    if (typeof p.text === "string") { textLen = p.text.length; textStr = p.text; }
                  } catch { /* counted via events row */ }
                  // textLen is CHARS; the wire `start` is a UTF-8 BYTE offset.
                  // Keep the string ref (no hot-path encode) — byte lengths are
                  // computed once at collect time.
                  M.frames.push({ start, textLen, textStr, tCb, tDec: performance.now(), id, conn });
                }
              } catch { /* never break the real listener */ }
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
    W.EventSource = ObservingES;

    // --- store-apply boundary: the SPA's own flush-collector slot ---
    W.__vhFlushCollector = (n: number) => {
      M.flushes.push({ t: performance.now(), n });
    };

    // --- DOM progress: markers in NEWLY ADDED text nodes only (streamMd
    // appends fresh text nodes; reading only addedNodes keeps observation
    // O(new text), never O(transcript)) ---
    const MARK = /\[p(\d+)r(\d+)c(\d{6})\]/g;
    let best = 0;
    let lastRun = -1;
    const start = () => {
      if (!document.body) { setTimeout(start, 50); return; }
      const mo = new MutationObserver((muts) => {
        const tgt = W.__mpTarget;
        if (!tgt) return;
        if (tgt.run !== lastRun) { lastRun = tgt.run; best = 0; }
        let changed = false;
        for (const m of muts) {
          for (const nd of Array.from(m.addedNodes)) {
            const txt = nd.nodeType === 3 ? nd.data || "" : nd.textContent || "";
            if (txt.length < 12) continue;
            MARK.lastIndex = 0;
            let mm: RegExpExecArray | null;
            while ((mm = MARK.exec(txt)) !== null) {
              if (Number(mm[1]) === M.proj && Number(mm[2]) === tgt.run) {
                const k = Number(mm[3]);
                if (k > best) { best = k; changed = true; }
              } else {
                M.foreign++;
              }
            }
          }
        }
        if (changed) M.markers.push({ k: best, t: performance.now() });
      });
      mo.observe(document.body, { childList: true, subtree: true });
    };
    start();

    // --- rAF interval sampler (paint opportunities; NOT proof of pixels) ---
    const rl = (ts: number) => {
      if (M.rafOn) M.raf.push(ts);
      requestAnimationFrame(rl);
    };
    requestAnimationFrame(rl);

    // --- long tasks (unsupported → "unavailable", never zero) ---
    try {
      const P = W.PerformanceObserver;
      if (P && P.supportedEntryTypes && P.supportedEntryTypes.indexOf("longtask") !== -1) {
        M.ltAvailable = true;
        const po = new P((list: any) => {
          for (const e of list.getEntries()) M.longtasks.push({ s: e.startTime, d: e.duration });
        });
        po.observe({ entryTypes: ["longtask"] });
      } else {
        M.ltAvailable = false;
      }
    } catch {
      M.ltAvailable = false;
    }

    // __mpCollect: snapshot + reset the per-scenario arrays (es registry urls
    // and connFirst persist across scenarios; conn indices stay stable).
    W.__mpCollect = () => {
      const te = new TextEncoder();
      const frames = M.frames.map((f: any) => ({
        start: f.start,
        textLen: f.textLen,
        textBytes: f.textStr !== null ? te.encode(f.textStr).length : -1,
        tCb: f.tCb,
        tDec: f.tDec,
        id: f.id,
        conn: f.conn,
      }));
      const out = {
        proj: M.proj,
        es: M.es.map((e: any) => ({ url: e.url, t: e.t, state: e.es.readyState })),
        events: M.events,
        frames,
        flushes: M.flushes,
        markers: M.markers,
        foreign: M.foreign,
        snapshots: M.snapshots,
        connFirst: M.connFirst,
        raf: M.raf,
        longtasks: M.longtasks,
        ltAvailable: M.ltAvailable,
      };
      M.events = [];
      M.frames = [];
      M.flushes = [];
      M.markers = [];
      M.snapshots = [];
      M.raf = [];
      M.longtasks = [];
      M.foreign = 0;
      return out;
    };
  }, proj);
}

// digestMessage: in-page sha256 of the message's rendered PART text (the
// `.md` markdown container inside the row — the row itself also renders
// role/time chrome that would pollute a whole-row textContent digest).
async function digestMessage(page: Page, mid: string) {
  return page.evaluate(async (mid: string) => {
    const row = document.querySelector(`.msg[data-mid="${mid}"], .msg[ln="${mid}"]`);
    if (!row) return { error: "missing" as const };
    const md = row.querySelector(".md");
    if (!md) return { error: "no-md" as const };
    const raw = md.textContent || "";
    // The markdown pipeline appends exactly one trailing "\n" to a streamed
    // block (verified: raw is final_len+1 ending "\n"). Strip ONE trailing
    // newline; anything more than that must fail the byte-exactness gate.
    const txt = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const stripped = raw.length - txt.length;
    const bytes = new TextEncoder().encode(txt);
    const buf = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
    return { hex, bytes: bytes.length, chars: txt.length, rawExtra: raw.length - txt.length, stripped, head: txt.slice(0, 40), tail: txt.slice(-40) };
  }, mid);
}

// freshDigest: cold-hydrate the finished message on a THROWAWAY page (settled
// render path — no live-stream renderer state) and digest it. Used where the
// live page's renderer may legitimately lag (bulk): content correctness is a
// property of the STORE + settled render, not of the live tail.
async function freshDigest(ctx: import("@playwright/test").BrowserContext, e: Expected, i: number) {
  const p = await ctx.newPage();
  try {
    await p.goto(`${pageOrigin(i)}/?dir=${encodeURIComponent(`/work/mproj${i}`)}&session=${e.sid}`, { waitUntil: "commit", timeout: 15_000 });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const dig = await digestMessage(p, e.message_id).catch(() => ({ error: "missing" as const }));
      if (!(dig as any).error && (dig as any).bytes === e.final_len) return dig;
      if (Date.now() > deadline) return dig; // final assertion reports the mismatch
      await p.waitForTimeout(400);
    }
  } finally {
    await p.close();
  }
}

// percentile (linear interpolation is fine for diagnostics).
function pct(xs: number[], p: number): number {
  if (xs.length === 0) return -1;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
function med(xs: number[]): number {
  return pct(xs, 50);
}

// summarizePage: per-tick pipeline (callback→decode→flush→DOM) + rAF/longtask
// rollups. Tick k's wire time = tCb of the frame whose byte range contains the
// END of tick k; apply = first flush at/after that tCb; DOM = marker k.
function summarizePage(col: any, chunkBytes: number, events: number) {
  const frames = [...col.frames].sort((a: any, b: any) => a.start - b.start);
  const decode: number[] = [];
  const apply: number[] = [];
  const render: number[] = [];
  const perTick: any[] = [];
  for (let k = 1; k <= events; k++) {
    const tickEndByte = k * chunkBytes;
    const f = frames.filter((x: any) => x.start !== null && x.start < tickEndByte).pop();
    const mk = (col.markers || []).find((m: any) => m.k === k);
    if (!f || !mk) continue;
    const fl = (col.flushes || []).find((x: any) => x.t >= f.tCb);
    const dDec = f.tDec - f.tCb;
    const dApp = fl ? fl.t - f.tCb : -1;
    const dRen = mk.t - f.tCb;
    decode.push(dDec);
    if (fl) apply.push(dApp);
    render.push(dRen);
    perTick.push({ k, tCb: f.tCb, decode: dDec, apply: dApp, render: dRen, seq: f.id });
  }
  const rafIv: number[] = [];
  for (let i = 1; i < col.raf.length; i++) rafIv.push(col.raf[i] - col.raf[i - 1]);
  const lt = col.longtasks || [];
  return {
    proj: col.proj,
    frames: frames.length,
    flushes: (col.flushes || []).length,
    flushSum: (col.flushes || []).reduce((a: number, b: any) => a + b.n, 0),
    markers: (col.markers || []).length,
    ticksTraced: perTick.length,
    foreignMarkers: col.foreign,
    decodeMs: { med: +med(decode).toFixed(2), p90: +pct(decode, 90).toFixed(2), max: +Math.max(...(decode.length ? decode : [-1])).toFixed(2) },
    applyMs: { med: +med(apply).toFixed(2), p90: +pct(apply, 90).toFixed(2), max: +Math.max(...(apply.length ? apply : [-1])).toFixed(2) },
    renderMs: { med: +med(render).toFixed(2), p90: +pct(render, 90).toFixed(2), max: +Math.max(...(render.length ? render : [-1])).toFixed(2) },
    raf: {
      samples: rafIv.length,
      medMs: +med(rafIv).toFixed(2),
      p90Ms: +pct(rafIv, 90).toFixed(2),
      maxMs: +Math.max(...(rafIv.length ? rafIv : [-1])).toFixed(2),
    },
    longTasks: { available: col.ltAvailable, count: lt.length, totalMs: +lt.reduce((a: number, b: any) => a + b.d, 0).toFixed(1), maxMs: +Math.max(...(lt.length ? lt.map((x: any) => x.d) : [-1])).toFixed(1) },
  };
}

test("A2 seven-page sustained demand: fixture-driven browser attribution", async ({ page, request }) => {
  // Headroom for pollDone's slow-runner allowance (see POLL_STALL_MS).
  test.setTimeout(300_000);
  const t0 = Date.now();
  const fleet: Page[] = [page];
  const runIDs: number[] = [];
  const dump: any = { startedAt: new Date().toISOString(), scenarios: {} as any };

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

    // ================= scenario runner (S2/S3) =================
    // domGate=true asserts live DOM marker progress (warm/small — the live
    // render keeps up); domGate=false (bulk) records live-render progress as
    // DIAGNOSTICS and gates final content on a FRESH cold page instead: for
    // bulk streams the store's per-part cap mechanics (partTextCap) and the
    // un-flushed-suffix→final-upsert handoff make live-tail coverage
    // scenario-dependent, while the settled cold digest stays byte-exact.
    const runStreamingScenario = async (name: string, spec: any, waitDoneMs: number, domGate: boolean) => {
      const start = await startRun(request, spec);
      runIDs.push(start.run_id);
      // Arm per-page targets (marker filter + rAF sampler) BEFORE release.
      await Promise.all(fleet.map((p) => p.evaluate((run) => {
        (window as any).__mpTarget = { run };
        (window as any).__mp.rafOn = true;
      }, start.run_id)));
      const tRelease = Date.now();
      await post(request, "/oc/fixture/mp-workload/release", { run_id: start.run_id });
      const done = await pollDone(request, start.run_id, waitDoneMs);
      // Per page: DOM progress must reach the final tick (bounded). Manual
      // loop (not expect.poll) so a stall reports WHICH page, the last marker,
      // and the live .md length.
      const domLag: number[] = [];
      for (let i = 0; i < PROJECTS; i++) {
        if (domGate) {
          const deadline = Date.now() + 20_000;
          for (;;) {
            const st = await fleet[i].evaluate((mid) => {
              const row = document.querySelector(`.msg[data-mid="${mid}"], .msg[ln="${mid}"]`);
              const md = row ? row.querySelector(".md") : null;
              const M = (window as any).__mp;
              const sesRecs = M.es.filter((e: any) => e.url.indexOf("sessions=mp") !== -1);
              const lastRec = sesRecs[sesRecs.length - 1];
              return {
                k: (M.markers.slice(-1)[0] || { k: 0 }).k,
                mdChars: md ? (md.textContent || "").length : -1,
                frames: M.frames.length,
                frameBytes: M.frames.reduce((a: number, f: any) => a + (f.textStr ? f.textStr.length : 0), 0),
                flushSum: M.flushes.reduce((a: number, f: any) => a + f.n, 0),
                esState: lastRec ? lastRec.es.readyState : -1,
                lastEvents: M.events.slice(-3).map((e: any) => [e.type, Math.round(e.tCb)]),
                visibility: document.visibilityState,
              };
            }, done.expected[i].message_id);
            if (st.k >= spec.events) break;
            if (Date.now() > deadline) {
              throw new Error(
                `page ${i} (${done.expected[i].sid}, chunk=${done.expected[i].chunk_bytes}B) DOM progress stalled at marker ${st.k}/${spec.events}; .md chars=${st.mdChars}; wire frames=${st.frames} frameChars=${st.frameBytes} flushSum=${st.flushSum}; esState=${st.esState} visibility=${st.visibility} lastEvents=${JSON.stringify(st.lastEvents)}`,
              );
            }
            await fleet[i].waitForTimeout(250);
          }
        } else {
          // DIAGNOSTIC ONLY: record how far the live render got after the
          // run completed + settled (a stalled value < events is a finding,
          // not a failure — content is gated cold below).
          await fleet[i].waitForTimeout(1_500);
          const st = await fleet[i].evaluate((mid) => {
            const row = document.querySelector(`.msg[data-mid="${mid}"], .msg[ln="${mid}"]`);
            const md = row ? row.querySelector(".md") : null;
            return {
              k: ((window as any).__mp.markers.slice(-1)[0] || { k: 0 }).k,
              mdChars: md ? (md.textContent || "").length : -1,
            };
          }, done.expected[i].message_id);
          domLag.push(st.k);
          if (i === 0) console.log(`[A2 ${name}] live-render lag diagnostic: lastMarker=${st.k}/${spec.events} mdChars=${st.mdChars}`);
        }
      }
      await fleet[0].waitForTimeout(300); // let the final coalesce/flush settle

      const pages = [];
      for (let i = 0; i < PROJECTS; i++) {
        const p = fleet[i];
        const e = done.expected[i];
        const col = await p.evaluate(() => (window as any).__mpCollect());
        (p as any)._lastCol = col;

        // GATE: byte-exact final content end-to-end (fixture→store→DOM). For
        // bulk (domGate=false) the LIVE page's renderer may lag legitimately
        // (recorded above) — gate on a FRESH cold page loading the settled
        // session, which exercises the settled render + snapshot path.
        const dig = domGate
          ? await digestMessage(p, e.message_id)
          : await freshDigest(page.context(), e, i);
        expect(dig, `page ${i} (${e.sid}) message ${e.message_id} missing or unreadable`).not.toHaveProperty("error");
        expect((dig as any).hex, `page ${i} content digest mismatch (head=${(dig as any).head} tail=${(dig as any).tail} bytes=${(dig as any).bytes} want=${e.final_len})`).toBe(e.digest);
        expect((dig as any).bytes, `page ${i} content byte length`).toBe(e.final_len);
        if (domGate) {
          expect((dig as any).rawExtra, `page ${i} renderer added more than one trailing newline`).toBeLessThanOrEqual(1);
        }

        // GATE: negotiation + contiguous suffix frames. Coverage note: the
        // store hands the un-flushed suffix tail to the final authoritative
        // upsert (by design — the !completed accumulator guard), so wire
        // suffix coverage == final_len exactly for domGate runs and may end
        // short for bulk; contiguity is asserted in BOTH cases.
        const sesUrls = col.es.filter((x: any) => x.url.indexOf(`sessions=${e.sid}`) !== -1).map((x: any) => x.url);
        expect(sesUrls.some((u: string) => u.indexOf("part_delta=1") !== -1), `page ${i} not negotiated`).toBe(true);
        const frames = col.frames.filter((f: any) => f.start !== null).sort((a: any, b: any) => a.start - b.start);
        expect(frames.length, `page ${i} saw no part.append frames`).toBeGreaterThan(0);
        expect(frames.some((f: any) => f.start > 0), `page ${i} no suffix (start>0) frame`).toBe(true);
        let off = 0;
        for (const f of frames) {
          expect(f.start, `page ${i} frame start gap (expected ${off}); frames=${JSON.stringify(frames.map((x: any) => [x.start, x.textBytes]))}`).toBe(off);
          off += f.textBytes;
        }
        if (domGate) {
          expect(off, `page ${i} suffix bytes != final length`).toBe(e.final_len);
        }

        // GATE: flush accounting — every delivered frame flushed exactly once.
        const flushSum = col.flushes.reduce((a: number, b: any) => a + b.n, 0);
        expect(col.flushes.length, `page ${i} no flushes recorded`).toBeGreaterThan(0);
        expect(flushSum, `page ${i} flush ledger sum != frame count`).toBe(frames.length);
        expect(col.flushes.every((f: any) => f.n > 0), `page ${i} empty flush in ledger`).toBe(true);

        // GATE: isolation — no foreign project/run markers in OUR DOM.
        expect(col.foreign, `page ${i} observed foreign markers`).toBe(0);

        pages.push({
          proj: i,
          sid: e.sid,
          chunkBytes: e.chunk_bytes,
          digestOK: true,
          summary: summarizePage(col, e.chunk_bytes, e.events),
          frames: col.frames,
          markers: col.markers,
          flushes: col.flushes,
          raf: col.raf.length ? { count: col.raf.length } : { count: 0 },
          longtasks: col.longtasks,
          ltAvailable: col.ltAvailable,
        });
      }

      // GATE: workload accounting (fixture side).
      expect(done.emitted, `${name} emitted`).toBe(spec.events * PROJECTS);
      expect(done.dropped_run, `${name} fixture subscriber overflow`).toBe(0);

      const wallMs = Date.now() - tRelease;
      dump.scenarios[name] = { runId: start.run_id, spec, emitted: done.emitted, droppedRun: done.dropped_run, wallMs, domLag: domLag.length ? domLag : undefined, pages: pages.map((p) => ({ ...p, frames: undefined, markers: undefined, flushes: undefined, longtasks: undefined })) };
      // Full-resolution rows ride along once (frames/markers/flushes) for the
      // dump only; strip them from the console echo.
      dump.scenarios[name].raw = pages;
      const sm = pages.map((p) => `p${p.proj}(cb=${p.chunkBytes}) cb→apply ${p.summary.applyMs.med}ms cb→render ${p.summary.renderMs.med}ms rafMax ${p.summary.raf.maxMs}ms lt ${p.summary.longTasks.count}/${p.summary.longTasks.totalMs}ms`);
      console.log(`[A2 ${name}] wall=${wallMs}ms | ` + sm.join(" | "));
      return { start, done };
    };

    // ================= S2: warm suffix streaming =================
    const s2 = await runStreamingScenario("warm", {
      projects: PROJECTS, session_idx: 0, events: WARM_EVENTS,
      chunk_bytes: CHUNK_BYTES, bulk_project: -1, cadence_ms: WARM_CADENCE_MS,
    }, 30_000, true);
    await post(request, "/oc/fixture/mp-workload/reset", { run_id: s2.start.run_id });

    // ================= S3: bulk (one project) + six small flows =================
    const s3 = await runStreamingScenario("bulk", {
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
      const reopenMs = firstEv && closed.t >= 0 ? +(firstEv.t - closed.t).toFixed(1) : -1;
      const caughtUpMs = mkLast >= 0 && closed.t >= 0 ? +(mkLast - closed.t).toFixed(1) : -1;
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
              .filter((r) => r.url.indexOf("sessions=mp1_s0") !== -1 && r.i >= fromIdx)
              .map((r) => r.i);
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

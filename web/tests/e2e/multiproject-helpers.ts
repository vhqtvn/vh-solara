import { expect } from "@playwright/test";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";

// Shared rail for the multiproject A2 specs, split by the test-speed plan
// (slice 3, "coverage-preserving soak split"):
//
//   - web/tests/e2e/multiproject-latency.spec.ts — the PR-BLOCKING structural
//     form (scaled-down: 3 pages, short runs; every correctness obligation of
//     the original retained).
//   - web/tests/e2e/multiproject-soak.spec.ts — the FULL-SCALE sustained
//     soak (7 pages, original budgets), excluded from ordinary lane-6
//     discovery and run ONLY via web/playwright.multiproject-soak.config.ts
//     (dispatch lane; see AGENTS.md's testing-lane localization).
//
// Everything here is verbatim-shared test rail (observer, digests, workload
// client, scenario runner) so the two specs cannot drift apart. Scale
// constants live in each spec.
//
// Observer provenance note (both specs): installObserver is a TRANSPARENT
// measurement rail installed BEFORE the SPA boots. Nothing here mocks or
// synthesizes: the REAL native EventSource constructs, connects, and
// dispatches; the wrapper only records.

export const CSRF = { "X-VH-CSRF": "1", "content-type": "application/json" };

export type Expected = {
  sid: string;
  message_id: string;
  part_id: string;
  events: number;
  chunk_bytes: number;
  final_len: number;
  digest: string;
};
export type RunSnap = {
  run_id: number;
  state: string;
  emitted: number;
  bookends: number;
  dropped_run: number;
  dropped_total: number;
  expected: Expected[];
};

export async function post(request: APIRequestContext, p: string, data?: unknown) {
  const res = await request.post(p, { headers: CSRF, data: data ?? {} });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

export async function startRun(request: APIRequestContext, spec: unknown): Promise<RunSnap> {
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
export const POLL_STALL_MS = 15_000;
export async function pollDone(request: APIRequestContext, runID: number, timeoutMs: number): Promise<RunSnap> {
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

// Per-page origins: the SPA holds 3 long-lived SSE connections per page
// (tree + session + project-settings watch); N pages on ONE HTTP/1.1 origin
// need 3N concurrent connections against Chromium's 6-per-host budget, which
// starves later pages entirely (verified by probe at 7 pages: p0-p2 hydrate,
// p3-p6 sit at "No sessions yet" forever). Real same-origin deployments hit
// this too unless served over h2 — recorded as a finding, worked around HERE
// by giving each page its own *.localhost loopback host alias (same server,
// same context, same process — only the origin label differs; per-origin
// storage was never shared across different origins anyway, so the
// same-profile fidelity that matters — shared process/GPU/scheduling — is
// preserved).
export function pageOrigin(i: number): string {
  const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8099";
  const port = new URL(base).port || "8099";
  return `http://mp${i}.localhost:${port}`;
}

// installObserver — see the module header. Mirrors the delegating-observer
// pattern of part-delta.spec.ts.
export async function installObserver(page: Page, proj: number) {
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
            const txt = nd.nodeType === 3 ? (nd as Text).data || "" : nd.textContent || "";
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
export async function digestMessage(page: Page, mid: string) {
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
export async function freshDigest(ctx: BrowserContext, e: Expected, i: number) {
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
export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return -1;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
export function med(xs: number[]): number {
  return pct(xs, 50);
}

// summarizePage: per-tick pipeline (callback→decode→flush→DOM) + rAF/longtask
// rollups. Tick k's wire time = tCb of the frame whose byte range contains the
// END of tick k; apply = first flush at/after that tCb; DOM = marker k.
export function summarizePage(col: any, chunkBytes: number, events: number) {
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

// MpScenarioCtx is the closed-over state the streaming-scenario runner needs
// from its spec: the fixture API handle, the page fleet, the spec's page
// count, and the shared bookkeeping (run ids + metrics dump).
export type MpScenarioCtx = {
  request: APIRequestContext;
  fleet: Page[];
  projects: number;
  runIDs: number[];
  dump: any;
};

// runStreamingScenario — the S2/S3 scenario runner shared by both specs.
// domGate=true asserts live DOM marker progress (warm/small — the live
// render keeps up); domGate=false (bulk) records live-render progress as
// DIAGNOSTICS and gates final content on a FRESH cold page instead: for
// bulk streams the store's per-part cap mechanics (partTextCap) and the
// un-flushed-suffix→final-upsert handoff make live-tail coverage
// scenario-dependent, while the settled cold digest stays byte-exact.
export async function runStreamingScenario(
  ctx: MpScenarioCtx,
  name: string,
  spec: any,
  waitDoneMs: number,
  domGate: boolean,
): Promise<{ start: RunSnap; done: RunSnap }> {
  const { request, fleet, runIDs, dump } = ctx;
  const PROJECTS = ctx.projects;
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
      : await freshDigest(fleet[0].context(), e, i);
    expectDefined(dig, `page ${i} (${e.sid}) message ${e.message_id} missing or unreadable`);
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
}

// expectDefined: narrow the digest result — a digest carrying an `error`
// property (missing row / missing .md container) must fail loudly with the
// caller's context message rather than surfacing as an undefined-field diff.
function expectDefined(v: any, msg: string) {
  expect(v, msg).not.toHaveProperty("error");
}

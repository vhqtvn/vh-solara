import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Slice A (send-net-resilience) — the convergence cascade's real-browser crux.
// BINDING CONTRACT:
// researches/decisions/2026-10-10-send-convergence-cascade-and-connstatus.md.
// A tunnel-shape disconnect of the tree SSE stream (transport-level CLOSED +
// error — the shape the browser sees when the yamux tunnel drops) must
// converge WITHOUT a page reload, the server's ring-gap signal
// (tree.snapshot cause:"reconnect" — previously dropped on the floor by the
// FE) must be consumed, and the unified queue-reconcile trigger must fire
// FROM the cascade (the same reconcileOutbox+fetch surface session-open/focus
// use — no third caller).
//
// Scenario shape:
//   1. Boot against the real fixture (tree ES + session ES live).
//   2. INJECT THE DROP: an init-script EventSource wrapper closes the tree ES
//      and fires its onerror (the native fatal-error shape) → the transport's
//      CLOSED branch arms its 1s backoff reconnect.
//   3. The reconnect request is ROUTE-ABORTED once (a genuinely failed
//      reconnect — the browser's native auto-retry follows).
//   4. The next reconnect is FULFILLED with a synthetic coherent SSE trio
//      (tree.snapshot cause:"reconnect" + scoped-partial detail snapshot +
//      snapshot.complete, identity = the LIVE daemon's X-VH-Epoch/X-VH-Seq)
//      — the exact wire shape the server emits on a ring-gap fallback
//      (hasCursor && !replayOK). pkg/fixtures is fenced this slice, so the
//      ring-gap cannot be forced server-side; the synthetic response delivers
//      the same bytes the server would.
//   5. The synthetic body ends → the ES native-retries (retry: 300) onto the
//      REAL fixture stream → live-tail resumes.
//
// Assertions: the server-ring-gap and cascade-queue-reconcile counters (the
// window.__vhSyncDiag stable recovery codes) fire; a post-drop prompt runs
// its turn end-to-end (real convergence); location.reload was NEVER invoked
// (AMEND-A7 instrumentation — this scenario contains no update flow, so any
// reload is a recovery cheat).

// The tree stream URL carries sessions= EMPTY ("sessions=&"); the session
// stream carries sessions=<id>. Only the TREE stream is dropped.
const isTreeStreamUrl = (url: string): boolean =>
  url.includes("/vh/stream") && !/[?&]sessions=[^&]/.test(url);

test("tunnel-shape tree-SSE drop converges without reload; ring-gap cause consumed; cascade queue reconcile fires", async ({ page }) => {
  test.setTimeout(90_000);

  // AMEND-A7 no-reload instrumentation (installed BEFORE goto so every reload
  // in the page's life is counted; intentional update-flow reloads are
  // excluded by scenario design — none occur here).
  await page.addInitScript(() => {
    (window as unknown as { __reloadCount: number }).__reloadCount = 0;
    const orig = window.location.reload.bind(window.location);
    (window.location as unknown as { reload: (...a: unknown[]) => void }).reload =
      function (...args: unknown[]) {
        (window as unknown as { __reloadCount: number }).__reloadCount++;
        return (orig as (...a: unknown[]) => void)(...args);
      };
  });

  // EventSource wrapper: capture the FIRST tree ES so the test can inject the
  // tunnel-drop shape (close → CLOSED + onerror — exactly what the transport's
  // fatal-error branch expects). Mirrors the unit-suite MockEventSource static
  // surface (EventSource.CLOSED etc. are read by tree-transport).
  await page.addInitScript(() => {
    const OrigES = window.EventSource;
    let firstTreeES: EventSource | null = null;
    const Wrapped = function (this: EventSource, url: string | URL, opts?: EventSourceInit) {
      const es = opts !== undefined ? new OrigES(url, opts) : new OrigES(url);
      const u = typeof url === "string" ? url : String(url);
      if (u.indexOf("/vh/stream") !== -1 && !/[?&]sessions=[^&]/.test(u) && !firstTreeES) {
        firstTreeES = es;
      }
      return es;
    } as unknown as { new (url: string | URL, opts?: EventSourceInit): EventSource; CLOSED: number; OPEN: number; CONNECTING: number };
    Wrapped.prototype = OrigES.prototype;
    const W = Wrapped as unknown as { CLOSED: number; OPEN: number; CONNECTING: number };
    W.CLOSED = OrigES.CLOSED;
    W.OPEN = OrigES.OPEN;
    W.CONNECTING = OrigES.CONNECTING;
    window.EventSource = Wrapped as unknown as typeof EventSource;
    (window as unknown as { __vhDropTree: () => boolean }).__vhDropTree = () => {
      const es = firstTreeES;
      if (!es) return false;
      firstTreeES = null; // one shot
      es.close(); // readyState → CLOSED
      if (typeof es.onerror === "function") es.onerror(new Event("error"));
      return true;
    };
  });

  // Capture the live daemon identity (X-VH-Epoch / X-VH-Seq on every /vh/*
  // response — server.go stampMeta). Passthrough; the stream handler reads
  // the LATEST values when it authors the synthetic reconnect.
  const live = { epoch: "", seq: 0 };
  await page.route("**/vh/version", async (route) => {
    const resp = await route.fetch();
    live.epoch = resp.headers()["x-vh-epoch"] || "";
    live.seq = Number(resp.headers()["x-vh-seq"] || "0");
    await route.fulfill({ response: resp });
  });

  // Tree-stream request lifecycle:
  //   #1 (boot)          → passthrough (real fixture stream)
  //   #2 (post-drop)     → ABORT once (a genuinely failed reconnect)
  //   #3 (auto-retry)    → FULFILL the synthetic ring-gap reconnect
  //   #4+ (post-synthetic) → passthrough (the real stream resumes)
  let treeReq = 0;
  await page.route("**/vh/stream**", async (route) => {
    const url = route.request().url();
    if (!isTreeStreamUrl(url)) return route.continue();
    treeReq++;
    if (treeReq === 2) {
      return route.abort("connectionreset");
    }
    if (treeReq === 3) {
      const S = live.seq; // head at capture time — ≥ the page's accepted cursor
      const E = live.epoch;
      expect(E).not.toBe(""); // the identity capture must have landed
      const node = {
        id: "demo",
        parentId: null,
        title: "Demo session",
        activity: "idle",
        childCount: 0,
        loaded: true,
        flags: {
          pendingInput: false,
          subtreeNeedsInput: false,
          permission: false,
          archived: false,
          orphan: false,
        },
        updatedMs: Date.now(),
      };
      const treeSnap = {
        tree: "2",
        epoch: E,
        seq: S,
        cause: "reconnect", // the ring-gap signal (server.go hasCursor && !replayOK)
        nodes: [node],
      };
      const detailSnap = {
        seq: S,
        epoch: E,
        sessions: [{ id: "demo", title: "Demo session" }],
        partial: {
          mode: "tree-stream-1-frontier",
          scope: ["demo"], // scoped MERGE — buried detail preserved
          authority: {
            sessions: "frontier",
            activity: "frontier",
            gate: "frontier",
            lastAgents: "frontier",
            currentVerbs: "frontier",
            questions: "global",
            permissions: "global",
            unread: "global",
            todos: "omitted",
            statuses: "omitted",
            messages: "omitted",
          },
        },
      };
      const complete = { epoch: E, revision: S, projections: ["tree", "detail"] };
      const frame = (id: string, event: string, data: unknown) =>
        `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      const body =
        "retry: 300\n" +
        frame(`${S}.0`, "tree.snapshot", treeSnap) +
        frame(`${S}.0`, "snapshot", detailSnap) +
        frame(`${S}`, "snapshot.complete", complete);
      return route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream" }, body });
    }
    return route.continue();
  });

  // Boot: real fixture, demo session selected + transcript rendered.
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.getByText("Refactor the parser and explain the change.")).toBeVisible({
    timeout: 15_000,
  });

  // Refresh the captured identity right before the drop (demo is idle, but be
  // exact — the synthetic capture seq must be ≥ the page's accepted cursor).
  await page.evaluate(async () => {
    await fetch("/vh/version", { cache: "no-store" });
  });

  // Baseline: neither signal has fired yet.
  const diagBefore = await page.evaluate(() =>
    (window as unknown as { __vhSyncDiag: () => { recovery: Record<string, { count: number }> } })
      .__vhSyncDiag()
      .recovery,
  );
  expect(diagBefore["server-ring-gap"]?.count ?? 0).toBe(0);
  expect(diagBefore["cascade-queue-reconcile"]?.count ?? 0).toBe(0);

  // INJECT THE DROP (tunnel shape: CLOSED + error on the live tree stream).
  expect(await page.evaluate(() => (window as unknown as { __vhDropTree: () => boolean }).__vhDropTree())).toBe(true);

  // The cascade consumed the ring-gap cause and fired the unified
  // queue-reconcile trigger at convergence (bounded generously — the path is
  // close(1s backoff) → abort(browser auto-retry) → synthetic → install).
  await page.waitForFunction(
    () =>
      ((window as unknown as { __vhSyncDiag: () => { recovery: Record<string, { count: number }> } })
        .__vhSyncDiag()
        .recovery["server-ring-gap"]?.count ?? 0) >= 1,
    undefined,
    { timeout: 30_000, polling: 500 },
  );
  await page.waitForFunction(
    () =>
      ((window as unknown as { __vhSyncDiag: () => { recovery: Record<string, { count: number }> } })
        .__vhSyncDiag()
        .recovery["cascade-queue-reconcile"]?.count ?? 0) >= 1,
    undefined,
    { timeout: 15_000, polling: 500 },
  );

  // Post-drop END-TO-END convergence (the real passthrough stream resumed):
  // a fresh prompt completes its full turn through the recovered stack. The
  // fixture's dummy model finishes the turn FASTER than the transient
  // .working pill can be observed reliably — the completed turn (reply + the
  // Done. Updated idle marker) is the convergence proof, not the pill.
  await page.getByPlaceholder("Message…").fill("cascade e2e post-drop");
  await page.keyboard.press("Enter");
  await expect(page.getByText("cascade e2e post-drop").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Done\. Updated/).first()).toBeVisible({ timeout: 30_000 });

  // The honest no-reload assertion (AMEND-A7): recovery never reloaded the page.
  expect(await page.evaluate(() => (window as unknown as { __reloadCount: number }).__reloadCount)).toBe(0);
});

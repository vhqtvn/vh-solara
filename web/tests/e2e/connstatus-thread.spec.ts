import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Slice B (send-net-resilience) — the graded ConnStatus thread's real-browser
// crux. BINDING CONTRACT:
// researches/decisions/2026-10-10-send-convergence-cascade-and-connstatus.md
// (debate-1 Q5 observational-only + debate-3 A6 precedence).
//
// THE USER-VISIBLE THREAD: a tunnel-shape drop of the tree SSE stream must
// (a) DEGRADE the visible status (the ConnectionToast — now driven by the
// SHARED connstatus reduction — shows "Connection lost — reconnecting…"),
// (b) consume the PRECISE ring-gap signal (partial.ringGap — Slice B's
// discrimination switch) into the cascade, (c) count the benign
// cause:"reconnect" replay-resume telemetry separately (the new
// server-reconnect-resume code), (d) RECOVER to the "live" grade only at
// CONVERGENCE (the "Reconnected" ok toast fires when the live grade lands —
// which requires the post-reconnect cascade pass to have completed; this is
// the F3-folded composition the unit suite pins at the transport seam), and
// (e) prove real convergence with a post-drop prompt turn — all WITHOUT a
// page reload.
//
// The fixture server has NO tunnel provider wired (X-VH-Tunnel-State absent
// by design): the tunnel reads "unknown" the whole run — unknown ≠ down, so
// the thread is driven by client observations exactly as the local-server
// topology degrades. OBSERVATIONAL ONLY — no delivery/retry behavior may key
// off any of this.
//
// Drop-injection machinery (EventSource wrapper + __reloadCount) mirrors
// cascade-reconnect.spec.ts (the Slice-A template).

// The tree stream URL carries sessions= EMPTY ("sessions=&"); the session
// stream carries sessions=<id>. Only the TREE stream is dropped.
const isTreeStreamUrl = (url: string): boolean =>
  url.includes("/vh/stream") && !/[?&]sessions=[^&]/.test(url);

test("tunnel-drop degrades the visible status, converges via the precise ring-gap signal, and restores live at convergence — without reload", async ({ page }) => {
  test.setTimeout(90_000);

  // No-reload instrumentation (installed BEFORE goto so every reload in the
  // page's life is counted; this scenario contains no update flow, so any
  // reload is a recovery cheat).
  await page.addInitScript(() => {
    (window as unknown as { __reloadCount: number }).__reloadCount = 0;
    const orig = window.location.reload.bind(window.location);
    (window.location as unknown as { reload: (...a: unknown[]) => void }).reload =
      function (...args: unknown[]) {
        (window as unknown as { __reloadCount: number }).__reloadCount++;
        return (orig as (...a: unknown[]) => void)(...args);
      };
  });

  // Passive toast-history recorder: the ConnectionToast is <Show>-conditional
  // and its "Reconnected" ok only lives 2.5s — too transient for a polling
  // expect to catch deterministically. A MutationObserver records every text
  // the role="status" surface EVER rendered, in order, so the assertions are
  // durable AND order-checkable (lost BEFORE reconnected). Pure observation —
  // no behavior change to the app.
  await page.addInitScript(() => {
    (window as unknown as { __vhToastHistory: string[] }).__vhToastHistory = [];
    let last = "";
    const record = () => {
      const el = document.querySelector('[role="status"]');
      const text = el && el.textContent ? el.textContent.trim() : "";
      if (text && text !== last) {
        (window as unknown as { __vhToastHistory: string[] }).__vhToastHistory.push(text);
      }
      last = text;
    };
    const obs = new MutationObserver(record);
    const start = () => {
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
      record();
    };
    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start);
  });

  // EventSource wrapper: capture the FIRST tree ES so the test can inject the
  // tunnel-drop shape (close → CLOSED + onerror — exactly what the
  // transport's fatal-error branch expects).
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
      // The EXACT wire shape the server emits on a ring-gap fallback: the
      // tree.snapshot carries cause:"reconnect" (stamped on EVERY
      // cursor-resume reconnect — hardcoded on the replay-success re-seed
      // snapshots, derived from the hasCursor && !replayOK gate on the
      // fresh-snapshot branch), while the SOLE true-gap signal is
      // partial.ringGap:true on the scoped detail snapshot
      // (`detailSnap.Partial.RingGap` — the only stamping site; field
      // semantics: PartialMeta.RingGap in pkg/state/store.go). Slice B
      // keys the cascade on the PRECISE flag and demotes the bare cause
      // to benign telemetry.
      const treeSnap = {
        tree: "2",
        epoch: E,
        seq: S,
        cause: "reconnect", // benign replay-resume telemetry (server-reconnect-resume)
        nodes: [node],
      };
      const detailSnap = {
        seq: S,
        epoch: E,
        sessions: [{ id: "demo", title: "Demo session" }],
        partial: {
          mode: "tree-stream-1-frontier",
          scope: ["demo"], // scoped MERGE — buried detail preserved
          ringGap: true, // THE precise true-gap signal (sole stamp: detailSnap.Partial.RingGap)
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

  // Baseline: none of the thread's signals has fired yet.
  const diagBefore = await page.evaluate(() =>
    (window as unknown as { __vhSyncDiag: () => { recovery: Record<string, { count: number }> } })
      .__vhSyncDiag()
      .recovery,
  );
  expect(diagBefore["server-ring-gap"]?.count ?? 0).toBe(0);
  expect(diagBefore["server-reconnect-resume"]?.count ?? 0).toBe(0);
  expect(diagBefore["cascade-queue-reconcile"]?.count ?? 0).toBe(0);

  // INJECT THE DROP (tunnel shape: CLOSED + error on the live tree stream).
  expect(await page.evaluate(() => (window as unknown as { __vhDropTree: () => boolean }).__vhDropTree())).toBe(true);

  // (a) THE VISIBLE DEGRADATION — the shared reduction drives the toast (the
  // 1.2s debounce must elapse while reconnecting; the abort+retry path keeps
  // the grade down for several seconds, so the polling expect catches it).
  const toast = page.getByRole("status");
  await expect(toast.filter({ hasText: "Connection lost" })).toBeVisible({ timeout: 15_000 });

  // (b) The PRECISE ring-gap signal fired the cascade (frame consumed).
  await page.waitForFunction(
    () =>
      ((window as unknown as { __vhSyncDiag: () => { recovery: Record<string, { count: number }> } })
        .__vhSyncDiag()
        .recovery["server-ring-gap"]?.count ?? 0) >= 1,
    undefined,
    { timeout: 30_000, polling: 500 },
  );

  // (c) The benign replay-resume telemetry counted SEPARATELY (the bare
  // cause:"reconnect" on the synthetic tree.snapshot).
  await page.waitForFunction(
    () =>
      ((window as unknown as { __vhSyncDiag: () => { recovery: Record<string, { count: number }> } })
        .__vhSyncDiag()
        .recovery["server-reconnect-resume"]?.count ?? 0) >= 1,
    undefined,
    { timeout: 15_000, polling: 500 },
  );

  // (d) RECOVERY AT CONVERGENCE — the "Reconnected" ok toast fires only when
  // the live grade lands, which requires the cascade pass (armed by the
  // ring-gap signal) to have completed via a truthfully-applied baseline (the
  // F3-folded composition). Asserted on the DURABLE toast history (the ok
  // toast lives only 2.5s — too transient for a polling locator) and with
  // the ORDER pinned: the degradation toast preceded the recovery toast.
  await page.waitForFunction(
    () => {
      const h = (window as unknown as { __vhToastHistory: string[] }).__vhToastHistory;
      const lost = h.findIndex((t) => t.includes("Connection lost"));
      const ok = h.findIndex((t) => t.includes("Reconnected"));
      return lost !== -1 && ok !== -1 && lost < ok;
    },
    undefined,
    { timeout: 30_000, polling: 250 },
  );

  // The unified queue-reconcile trigger fired FROM the converged cascade.
  await page.waitForFunction(
    () =>
      ((window as unknown as { __vhSyncDiag: () => { recovery: Record<string, { count: number }> } })
        .__vhSyncDiag()
        .recovery["cascade-queue-reconcile"]?.count ?? 0) >= 1,
    undefined,
    { timeout: 15_000, polling: 500 },
  );

  // (e) Post-drop END-TO-END convergence (the real passthrough stream
  // resumed): a fresh prompt completes its full turn through the recovered
  // stack. The completed turn (reply + the Done. Updated idle marker) is the
  // convergence proof, not the transient .working pill.
  await page.getByPlaceholder("Message…").fill("connstatus e2e post-drop");
  await page.keyboard.press("Enter");
  await expect(page.getByText("connstatus e2e post-drop").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Done\. Updated/).first()).toBeVisible({ timeout: 30_000 });

  // The honest no-reload assertion: recovery never reloaded the page.
  expect(await page.evaluate(() => (window as unknown as { __reloadCount: number }).__reloadCount)).toBe(0);
});

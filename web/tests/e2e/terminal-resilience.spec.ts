import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page, type WebSocketRoute } from "@playwright/test";

// Terminal input resilience — send-net-resilience slice 4b (debate-2 Q4).
//
// The terminal pane's private ws (/vh/term/ws) previously DISCARDED keystrokes
// while the socket was down or half-open: `send()` only wrote when
// readyState===OPEN and dropped everything else, silently (research-packet-2
// §B5 — "the real risk is LOST input in the half-open window").
//
// Contract under test (BINDING):
//  1. Disconnected / half-open state is VISIBLE in the pane before the user
//     types a paragraph into the void.
//  2. Typed TEXT is never silently discarded — it routes into a visible
//     compose buffer shown as NOT SENT, and never reaches the PTY/ws.
//  3. On reconnect the buffer HOLDS (no auto-flush — queue-and-replay of raw
//     PTY input is prohibited) until an explicit user send (button or
//     Enter-on-buffer), which writes it to the ws exactly once.
//  4. While connected, typing passes straight through with zero friction.
//
// Lane: web e2e (fixtureserver serves the REAL /vh/term/ws handler over a real
// PTY — same seam as terminal.spec.ts). The ws is driven from the test via
// page.routeWebSocket: test A drops the REAL connection (code 1000 = the
// pane's stay-down shape) and reconnects for real; test B runs a controlled
// mock route to produce the TRUE half-open shape (socket OPEN, keepalives
// silently stop) without waiting 32 wall-clock seconds — page.clock jumps the
// pane's liveness bookkeeping past TERM_STALE_MS.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

async function resetAllTerminals(request: APIRequestContext): Promise<void> {
  // Same hygiene as terminal.spec.ts: termReg is a package-global map that
  // persists across the whole serial fixtureserver process, so every test
  // starts from clean PTY state.
  const res = await request.get("/vh/term/list");
  const terms = res.ok() ? ((await res.json()) as Array<{ dir: string; id: string }>) : [];
  await Promise.all(
    terms.map((t) =>
      request.post("/vh/term/kill", {
        headers: { "X-VH-CSRF": "1" },
        data: { dir: t.dir, id: t.id },
      }),
    ),
  );
}

async function openTerminal(page: Page): Promise<void> {
  await page.goto(`/?dir=${encodeURIComponent(repoRoot)}`);
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.waitForSelector(".term-host");
  await page.waitForSelector(".term-status.open", { timeout: 10000 });
}

test.beforeEach(async ({ request }) => {
  await resetAllTerminals(request);
});

// A. REAL-PTY crux: live passthrough → drop (clean close = pane stays down) →
// typed text held visibly as NOT SENT → real reconnect replays scrollback but
// does NOT flush the buffer → explicit Send writes it to the PTY once.
// Exactly-once is pinned by a real side effect: the held command appends to a
// run-unique file, so a double-send would leave two lines and any auto-flush
// would leave a line BEFORE the explicit send.
test("terminal offline: typed input is held visibly, survives reconnect, and sends only explicitly", async ({ page }) => {
  const live = `LIVE_A_${Date.now()}`;
  const held = `HELD_A_${Date.now()}`;
  const witness = `tmp/term-4b-witness-${Date.now()}.txt`; // PTY cwd = repoRoot
  const witnessAbs = path.join(repoRoot, witness);
  let up = true;
  let route: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/vh\/term\/ws/, (ws) => {
    if (up) {
      route = ws;
      ws.connectToServer();
    } else {
      ws.close(); // reconnect attempts while down fail fast
    }
  });

  await openTerminal(page);
  await page.locator(".term-host").click();

  // (4) Connected typing passes straight through — the live path is unchanged.
  await page.keyboard.type(`echo ${live}`);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await page.locator(".xterm-rows").innerText()).includes(live), { timeout: 10000 })
    .toBe(true);
  await expect(page.locator(".term-compose")).toHaveCount(0); // zero friction while live

  // Drop the connection with a clean close: the pane surfaces "disconnected"
  // (no auto-retry) — a stable, deterministic !sendable state.
  up = false;
  (route as WebSocketRoute | null)?.close({ code: 1000, reason: "e2e-simulated-shell-exit" });
  await page.waitForSelector(".term-status.disconnected", { timeout: 10000 });

  // (1)+(2) The compose strip appears and typing lands in it, visibly not sent.
  await page.waitForSelector(".term-compose");
  await expect(page.locator(".term-compose")).toHaveClass(/held/);
  // (1b) Production-bundle CSS-content guard (slice-4b review c-F1, the
  // agent-hydration-send 4d pattern): the webServer serves the PRODUCTION
  // build (fixture-web.sh runs `npm run build`), so a computed style here
  // proves co-located TerminalPane.css reached the bundle — the former
  // pure-:global TerminalPane.module.css was tree-shaken from it (empty
  // locals → moduleSideEffects:false), leaving the strip's border/background
  // inert while class-name asserts kept passing. The border shorthand exists
  // ONLY in this stylesheet (no reset/legacy rule touches .term-compose), so
  // unstyled computes none/0px.
  await expect(page.locator(".term-compose")).toHaveCSS("border-top-style", "solid");
  await expect(page.locator(".term-compose")).toHaveCSS("border-top-width", "1px");
  await expect(page.locator(".term-compose-badge")).toContainText(/not sent/i);
  await page.keyboard.type(`echo ${held} >> ${witness}`);
  await page.keyboard.press("Enter"); // newline IN the buffer — the explicit send submits the line (\r on the wire)
  await expect(page.locator(".term-compose-input")).toHaveValue(`echo ${held} >> ${witness}\n`);

  // (3) Reconnect for real: scrollback replay restores the LIVE marker (PTY
  // persisted), but the held buffer is NOT auto-flushed and nothing was sent
  // (no witness line, no input echo of the held command).
  up = true;
  await page.locator(".term-reconnect").click();
  await page.waitForSelector(".term-status.open", { timeout: 10000 });
  await expect
    .poll(async () => (await page.locator(".xterm-rows").innerText()).includes(live), { timeout: 10000 })
    .toBe(true);
  await expect(page.locator(".term-compose")).toHaveClass(/restored/);
  await expect(page.locator(".term-compose-input")).toHaveValue(`echo ${held} >> ${witness}\n`);
  expect(await page.locator(".xterm-rows").innerText()).not.toContain(held);
  expect(fs.existsSync(witnessAbs), "no auto-flush: nothing may execute before the explicit send").toBe(false);

  // Explicit send — the ONLY path the buffer ever reaches the PTY. The side
  // effect must land EXACTLY once: one line, no more.
  await page.locator(".term-compose-send").click();
  await expect
    .poll(async () => (await page.locator(".xterm-rows").innerText()).includes(held), { timeout: 10000 })
    .toBe(true);
  await expect(page.locator(".term-compose")).toHaveCount(0); // cleared + live again
  await expect
    .poll(() => (fs.existsSync(witnessAbs) ? fs.readFileSync(witnessAbs, "utf8") : ""), { timeout: 10000 })
    .toContain(held);
  const lines = fs.readFileSync(witnessAbs, "utf8").trim().split("\n");
  expect(lines.length, "the explicit send executes exactly once — never a blind replay").toBe(1);
  fs.rmSync(witnessAbs, { force: true });
});

// B. TRUE half-open shape (mock route): the socket still reads OPEN while the
// server has gone silent. TERM_STALE_MS of silence flips the pane to a visible
// held state BEFORE the 45s watchdog tears the link; input buffers through the
// xterm path; a returning keepalive clears staleness WITHOUT touching the
// buffer; Enter-on-buffer sends exactly once.
//
// Wire observation: this Playwright surfaces route frames with `data:
// undefined` (no payload for client messages), so byte-exact content is NOT
// assertable here — it is pinned by Test A (the real PTY echoes the exact
// composed line into .xterm-rows) plus the unit suite (toWireText CR mapping,
// round-trip). What this test pins at the route is EXACTLY-ONCE delivery: the
// explicit send must produce exactly one client→server frame.
test("terminal half-open: staleness is visible, input is held, recovery keeps the buffer until Enter sends once", async ({ page }) => {
  const m1 = `HELD_B1_${Date.now()}`;
  const m2 = `HELD_B2_${Date.now()}`;
  let clientFrames = 0;
  let route: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/vh\/term\/ws/, (ws) => {
    route = ws; // no connectToServer: a controlled stand-in for a silent server
    ws.onMessage(() => {
      clientFrames++;
    });
  });
  await page.clock.install();
  await page.clock.pauseAt(new Date());

  await openTerminal(page); // status "open" — the half-open deception

  // Jump past TERM_STALE_MS (32s) but stay under the 45s force-reconnect: the
  // pane must SHOW the suspected-dead link instead of eating keystrokes.
  await page.clock.fastForward(40_000);
  await page.waitForSelector(".term-compose");
  await expect(page.locator(".term-status")).toHaveClass(/stale/);
  await expect(page.locator(".term-status")).toHaveClass(/open/); // socket itself still "open"
  await expect(page.locator(".term-compose-badge")).toContainText(/not sent/i);
  await expect(page.locator(".term-compose-send")).toBeDisabled();

  // Type through BOTH paths: the compose textarea (auto-focused when the pane
  // entered the held state) and the xterm surface itself (no overlay during
  // stale — keystrokes reach onData and must route into the buffer, not ws).
  await page.keyboard.type(m1);
  await page.locator(".term-host").click();
  await page.keyboard.type(m2);
  await expect(page.locator(".term-compose-input")).toHaveValue(m1 + m2);

  // Recover the SAME socket (a keepalive finally arrives): staleness clears,
  // the buffer HOLDS (no auto-flush — explicit send is the only path).
  (route as WebSocketRoute | null)?.send('{"ka":1}');
  await expect(page.locator(".term-compose")).toHaveClass(/restored/);
  await expect(page.locator(".term-compose-send")).toBeEnabled();
  await expect(page.locator(".term-compose-input")).toHaveValue(m1 + m2);

  // Enter-on-buffer = the explicit send. Deterministic frame accounting: the
  // buffer clears → the strip hides → the pane's ResizeObserver fires ONE
  // resize control frame, plus the ONE buffered-text frame the send writes.
  // A double buffer-send would read 3 (caught here AND by Test A's witness
  // file, which pins exactly-once against the real PTY).
  const before = clientFrames;
  await page.locator(".term-compose-input").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".term-compose")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(clientFrames - before, "one buffered-text frame + one strip-hide resize frame").toBe(2);
});

// C. Discard affordance: held text can be thrown away explicitly, and it never
// reaches the PTY.
test("terminal offline: Discard clears the held buffer; the text never reaches the PTY", async ({ page }) => {
  const live = `LIVE_C_${Date.now()}`;
  const held = `HELD_C_${Date.now()}`;
  let up = true;
  let route: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/vh\/term\/ws/, (ws) => {
    if (up) {
      route = ws;
      ws.connectToServer();
    } else {
      ws.close();
    }
  });

  await openTerminal(page);
  await page.locator(".term-host").click();
  await page.keyboard.type(`echo ${live}`);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await page.locator(".xterm-rows").innerText()).includes(live), { timeout: 10000 })
    .toBe(true);

  up = false;
  (route as WebSocketRoute | null)?.close({ code: 1000, reason: "e2e-simulated-shell-exit" });
  await page.waitForSelector(".term-status.disconnected", { timeout: 10000 });
  await page.keyboard.type(held);
  await expect(page.locator(".term-compose-input")).toHaveValue(held);

  await page.locator(".term-compose-clear").click();
  await expect(page.locator(".term-compose-input")).toHaveValue("");

  up = true;
  await page.locator(".term-reconnect").click();
  await page.waitForSelector(".term-status.open", { timeout: 10000 });
  await expect
    .poll(async () => (await page.locator(".xterm-rows").innerText()).includes(live), { timeout: 10000 })
    .toBe(true);
  expect(await page.locator(".xterm-rows").innerText()).not.toContain(held);
});

// D. E-ink history paging (UX Slice 2) — the spied-write transport contract:
// paging actions page the xterm normal-buffer scrollback through viewport
// APIs ONLY. Every client→server frame is counted at the routeWebSocket seam
// (the same spy surface test B uses): prev/next/latest must emit ZERO frames
// — no PTY input, no resize chatter — while real typing still produces a
// frame (proving the spy is live, so the zero is meaningful). Transport
// continuity: one open status throughout, and the .term-host node is never
// remounted (expando witness). The profile is enabled via its saved
// preference BEFORE boot so the toolbar is present from the first layout
// (mounting it mid-session legitimately fires one PTY resize — that is the
// toggle's cost, not a paging action's).
test("e-ink history paging: zero PTY/ws bytes from paging actions; no reconnect, no remount", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("vh.prefs.einkProfile.v1", JSON.stringify({ v: 1, data: true }));
  });
  let clientFrames = 0;
  await page.routeWebSocket(/\/vh\/term\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      clientFrames++;
      // Registering onMessage on the page-side route DISABLES Playwright's
      // automatic page→server forwarding — re-send every frame through the
      // server-side handle or the PTY never sees keystrokes (the documented
      // routeWebSocket forwarding contract).
      server.send(message);
    });
  });

  await openTerminal(page);
  await page.locator(".term-host").click();

  // Deep scrollback: 200 numbered marker lines, tail visible afterwards.
  await page.keyboard.type("seq -f 'HISTLINE_%g' 1 200");
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => (await page.locator(".xterm-rows").innerText()).includes("HISTLINE_200"), { timeout: 15000 })
    .toBe(true);

  await page.evaluate(() => {
    (document.querySelector(".term-host") as unknown as { __vhPageMark?: string }).__vhPageMark = "live";
  });

  // THE SPY: pure paging actions — deep page-ups through history, a page
  // down, and back to the tail — must not write a single frame.
  const bar = page.locator('[data-eink="term-paging"]');
  const framesBefore = clientFrames;
  for (let i = 0; i < 3; i++) await page.locator('[data-eink="term-prev"]').click();
  await expect(bar).toHaveAttribute("data-parked", "true");
  await expect
    .poll(async () => (await page.locator(".xterm-rows").innerText()).includes("HISTLINE_200"), { timeout: 5000 })
    .toBe(false); // real traversal: the tail scrolled offscreen
  await page.locator('[data-eink="term-next"]').click();
  await page.locator('[data-eink="term-latest"]').click();
  await expect(bar).toHaveAttribute("data-parked", "false");
  await expect
    .poll(async () => (await page.locator(".xterm-rows").innerText()).includes("HISTLINE_200"), { timeout: 5000 })
    .toBe(true);
  await page.waitForTimeout(300); // settle: any deferred write would land here
  expect(clientFrames - framesBefore, "paging actions must emit zero PTY/ws frames").toBe(0);

  // Transport continuity: still open, still the same terminal host node.
  await expect(page.locator(".term-status.open")).toHaveCount(1);
  expect(
    await page.evaluate(() => (document.querySelector(".term-host") as unknown as { __vhPageMark?: string }).__vhPageMark),
  ).toBe("live");

  // Control: real typing DOES produce a frame — the spy is live, so the
  // zero above is a real absence, not a dead counter. The control char is
  // SUBMITTED and the prompt settles before the 1004 phase, so its line
  // cannot contaminate the printf below (an unsubmitted "x" would make the
  // shell run "xprintf" and silently skip enabling the mode — review A1).
  await page.keyboard.type("x");
  await page.waitForTimeout(300);
  expect(clientFrames - framesBefore).toBeGreaterThanOrEqual(1);
  await page.keyboard.press("Enter"); // execute the stray line; prompt returns
  await page.waitForTimeout(400);

  // THE FOCUS-REPORTING MODE (review a-F1/a-F2): an application that enables
  // DECSET 1004 (vim/less/tmux and shell integrations commonly do) makes
  // xterm report textarea blur/refocus as ESC[O / ESC[I PTY bytes. The
  // toolbar buttons preventDefault pointerdown so a paging click never
  // transfers focus out of the terminal — under 1004, paging must STILL be
  // byte-silent. Enable the mode from the APP side (printf emits the
  // sequence; we never intercept).
  await page.keyboard.type("printf '\\033[?1004h'");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600); // enabling frame(s) + echo settle

  // POSITIVE mode establishment: one deliberate focus cycle (click a
  // non-interactive dock element → blur; click the terminal → refocus)
  // MUST produce frames under 1004 — proving focus reporting is actually
  // active before the paging battery claims zero frames in it.
  const establishBase = clientFrames;
  await page.locator(".term-dock-head > svg").first().click(); // neutral icon → textarea blurs
  await page.locator(".term-host").click(); // terminal refocus
  await page.waitForTimeout(400);
  expect(
    clientFrames - establishBase,
    "focus cycle under DECSET 1004 must report ESC[O/ESC[I — mode proven active",
  ).toBeGreaterThanOrEqual(1);

  const framesBeforeFocusMode = clientFrames;
  await page.locator('[data-eink="term-prev"]').click();
  await page.locator('[data-eink="term-prev"]').click();
  await expect(bar).toHaveAttribute("data-parked", "true");
  await page.locator('[data-eink="term-next"]').click(); // one page back down: still parked
  await expect(bar).toHaveAttribute("data-parked", "true");
  await page.locator('[data-eink="term-latest"]').click();
  await expect(bar).toHaveAttribute("data-parked", "false");
  await page.waitForTimeout(300);
  expect(
    clientFrames - framesBeforeFocusMode,
    "paging under DECSET 1004 focus reporting must emit zero frames (no blur/refocus)",
  ).toBe(0);
  // Focus stayed in the terminal throughout: the xterm helper textarea is
  // still the active element (no button stole it).
  expect(
    await page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea")),
  ).toBe(true);

  // Restore default (no focus reporting) for the shared-PTY hygiene.
  await page.keyboard.type("printf '\\033[?1004l'");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
});

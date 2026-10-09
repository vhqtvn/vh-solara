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
  route?.close({ code: 1000, reason: "e2e-simulated-shell-exit" });
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
  route?.send('{"ka":1}');
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
  route?.close({ code: 1000, reason: "e2e-simulated-shell-exit" });
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

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// =============================================================================
// Real-embedding host-web e2e — LANE 8 (durable, graduated from the Phase-0′
// spike). The FIRST host-web lane to embed the REAL production `web/` SPA
// (built + materialized into pkg/web/dist/, served by a real `local-server`
// binary) instead of the mock content page.
//
// Topology (cross-ORIGIN, same-SITE — the production subdomain analog):
//   host parent  : http://localhost:5183   (host-web SolidJS/Dockview shell,
//                                           VITE_IFRAME_ORIGIN=:8765)
//   embedded SPA : http://localhost:8765   (real vh-solara local-server,
//                                           --auth-mode none (loopback default),
//                                           --frame-ancestors localhost:5183)
//
// NO-AUTH posture: --auth-mode none is the server default (cmd/auth_flags.go),
// permitted on a loopback bind. The server binds 127.0.0.1:8765 (loopback) and
// is addressed as localhost:8765 so both origins share the `localhost`
// registrable site. There is NO login step and NO session cookie in this lane —
// the cookie crux (SameSite=Lax cookie riding the cross-origin/same-site iframe
// load) was PROVEN by the Phase-0′ spike in passphrase mode and is NOT one of
// the two open cruxes this lane closes (heartbeat-emitter-live + real-server
// survival). The two open cruxes are cookie-INDEPENDENT (heartbeat is
// postMessage; survival is renderer:'always'), so no-auth fully exercises them.
//
// Scheduled/dispatchable ONLY (nightly + workflow_dispatch); NOT in the
// push/PR matrix. Additive to the PR-blocking mock survival gate, which stays
// untouched. Heavier than the mock lane (real Go binary + built SPA), so it is
// not PR-blocking until measured stable.
//
// The real Go binary MUST be pre-built at repo-root/vh-solara before this suite
// runs (the webServer below starts it). CI / `make test-host-web-real-embed`
// build it (web SPA → materialize → go build) before invoking Playwright.
// Override the binary path with VH_SOLARA_BIN (default ../vh-solara from
// host-web/).
//
// Run:  cd host-web && npx playwright test --config=playwright.real-embed.config.ts
//       (after building the binary; or `make test-host-web-real-embed` for the
//        full local pipeline).
// =============================================================================

const hostRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(hostRoot, "..");

const REAL_PORT = process.env.REAL_EMBED_REAL_PORT ?? "8765";
const HOST_PORT = process.env.REAL_EMBED_HOST_PORT ?? "5183";
// localhost (not 127.0.0.1) so both origins share the `localhost` registrable
// site — required for same-site framing semantics. Servers bind 127.0.0.1.
const REAL_ORIGIN = `http://localhost:${REAL_PORT}`;
const HOST_ORIGIN = `http://localhost:${HOST_PORT}`;

// Go binary built at repo root (make build / CI). From host-web/ that's
// ../vh-solara. Override with VH_SOLARA_BIN for non-default locations.
const vhBin = process.env.VH_SOLARA_BIN ?? path.join(repoRoot, "vh-solara");

const artifactRoot =
  process.env.PLAYWRIGHT_ARTIFACTS_DIR ??
  path.join(repoRoot, "tmp/agent-runs/host-web-real-embed");

export default defineConfig({
  testDir: path.join(hostRoot, "tests/real-embed-e2e"),
  testMatch: /real-embed\.spec\.ts/,
  // Serial: the host SPA holds shared live Dockview state; run one engine at a
  // time. Also heavier (real Go server) — keep it deterministic.
  fullyParallel: false,
  workers: 1,
  // retries: 0 for honest stability measurement (a retry-passed run would mask
  // flake). The nightly job surfaces raw pass/fail per engine; repeat-stability
  // is measured by running the suite N times (--repeat-each or a CI loop).
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.join(artifactRoot, "report") }],
  ],
  outputDir: path.join(artifactRoot, "output"),
  use: {
    baseURL: HOST_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    // WebKit opt-in: uncomment (or pass --project=webkit) once it is measured
    // stable on Chromium+Firefox. The mock survival lane already covers WebKit.
    // { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: [
    {
      // Real vh-solara local-server (:8765). NO-AUTH (loopback default),
      // --frame-ancestors allows the host origin (REPLACES 'self', omits
      // X-Frame-Options so cross-origin framing is permitted). --opencode-url
      // is a dead loopback target so the server STAYS UP (decoupled design,
      // ocLife=failed) and the SPA renders its real shell with empty state.
      command: `"${vhBin}" local-server --addr 127.0.0.1:${REAL_PORT} --frame-ancestors ${HOST_ORIGIN} --opencode-url http://127.0.0.1:1`,
      cwd: hostRoot,
      url: `http://127.0.0.1:${REAL_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Host dev server (:5183) embedding the real server cross-origin. Distinct
      // port from the mock lane (:5173) so concurrent runs don't clash. The
      // inline env sets VITE_IFRAME_ORIGIN for this process tree only (Vite
      // inherits it), so each pane's iframe points at the real server.
      command: `VITE_IFRAME_ORIGIN=${REAL_ORIGIN} npm run dev:host:real-embed`,
      cwd: hostRoot,
      url: `http://127.0.0.1:${HOST_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

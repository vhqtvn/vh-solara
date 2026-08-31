import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// =============================================================================
// FOLDED-POSTURE host-web e2e — the production-fold restore lane.
//
// WHY THIS LANE EXISTS (2026-08-31 round-3 diagnosis): the operator's Android
// PWA loses its layout on relaunch while every headless lane passes. Every
// existing host-web lane runs the host via the Vite DEV server (`npm run
// dev:*`), where the host bundle is (a) a DEV build (import.meta.env.DEV,
// DEV bridges present, mock fleet) and (b) NOT folded (VITE_HOST_FOLDED
// unset → base "/", mock default fleet). The operator's device runs the
// FOLDED PRODUCTION host: VITE_HOST_FOLDED=1, base /host/, self-seed fleet
// ([origin + "/app"]), minified, no bridges — served BY THE REAL BINARY at
// `/` with the host CSP. This lane reproduces exactly that posture: the
// webServer boots the REAL vh-solara binary (both SPAs embedded via
// //go:embed) and the tests drive the host the binary serves at `/` — no
// Vite dev server anywhere. The embedded SPA iframes are SAME-ORIGIN
// (`origin + /app`), matching the fold topology.
//
// Assertions are PRODUCTION-SAFE (no DEV bridge — it is dead-code-eliminated
// in the folded build): DOM (`.pane`, `[data-testid=…]`), localStorage reads
// (the layout blob + the ALWAYS-ON diag ring, layoutDiag.ts), and the URL
// hash. The diag ring is the same instrument the operator's on-device
// "Copy layout diagnostics" produces, so a failure here prints the same
// fingerprint the operator pastes.
//
// The binary MUST be pre-built in the FOLDED posture before this suite runs:
//   make embed-materialize && go build -o tmp/vh-solara-folded .
// (or: bash host-web/scripts/folded-restore-run.sh for the full pipeline).
// Override the binary path with VH_FOLDED_BIN (default <repo>/tmp/vh-solara-folded).
//
// Run: cd host-web && npx playwright test --config=playwright.folded.config.ts
// =============================================================================

const hostRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(hostRoot, "..");

const FOLDED_PORT = process.env.VH_FOLDED_PORT ?? "8811";
const FOLDED_ORIGIN = `http://127.0.0.1:${FOLDED_PORT}`;

const vhBin = process.env.VH_FOLDED_BIN ?? path.join(repoRoot, "tmp/vh-solara-folded");

const artifactRoot =
  process.env.PLAYWRIGHT_ARTIFACTS_DIR ??
  path.join(repoRoot, "tmp/agent-runs/host-web-folded");

export default defineConfig({
  testDir: path.join(hostRoot, "tests/folded-e2e"),
  testMatch: /folded-restore\.spec\.ts/,
  // Serial: one real server, shared origin state (localStorage/SW) across a
  // context would leak between workers. Each TEST uses its own fresh context.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.join(artifactRoot, "report") }],
  ],
  outputDir: path.join(artifactRoot, "output"),
  use: {
    baseURL: FOLDED_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Firefox opt-in: the restore logic under test is engine-independent
    // (storage + dockview serialization); add when measured stable.
    // { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: [
    {
      // The REAL binary in the FOLDED posture: host shell at `/` (host-dist
      // embed, built with VITE_HOST_FOLDED=1), single-server SPA at `/app`.
      // --auth-mode none is the loopback default; --opencode-url is a dead
      // loopback target so the server STAYS UP decoupled (ocLife=failed) and
      // the embedded /app SPA renders its real shell with empty state — the
      // lane-8 precedent. Same-origin /app framing needs no --frame-ancestors
      // (default frame-ancestors 'self' permits it).
      command: `"${vhBin}" local-server --addr 127.0.0.1:${FOLDED_PORT} --opencode-url http://127.0.0.1:1`,
      cwd: hostRoot,
      url: `${FOLDED_ORIGIN}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

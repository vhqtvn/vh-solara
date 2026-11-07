import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
// =============================================================================
// DEPLOY-TRANSITION host-web e2e — the BUILD_ID deploy lane (lane-9 posture:
// dispatchable, NOT PR-blocking).
//
// Serves the REAL folded production topology (real `local-server` binary,
// both SPAs embedded via //go:embed, host shell at `/`, same-origin /app pane
// iframes — no Vite dev server) and proves the deploy-update transition:
// TWO binaries built from the same tree with DIFFERENT BUILD_ID stamps, the
// second booted on the SAME port mid-test after the first is killed.
//
// Unlike every other host-web lane there is NO webServer entry: a mid-test
// port swap (kill A → boot B on :PORT) cannot be expressed by a config-level
// webServer. The SPEC (tests/folded-e2e/deploy-transition.spec.ts) spawns,
// kills, and swaps the two binaries itself.
//
// Prerequisites (the runner does all of it):
//   bash host-web/scripts/deploy-transition-run.sh
//   (or: make test-host-web-deploy-transition)
// which builds the web/ SPA TWICE (two BUILD_ID stamps — the swBuildId vite
// plugin stamps per build), builds host-web FOLDED once, materializes both
// embeds, builds tmp/vh-solara-deploy-a + tmp/vh-solara-deploy-b, and writes
// the stamps.json receipt the spec asserts against.
//
// Run: cd host-web && npx playwright test --config=playwright.deploy-transition.config.ts
// Engines: chromium (default). firefox is dispatch-gated to OPT-IN since
// 2026-11-07 — environment-driven evaluate-channel starvation on the lane
// host (see the projects block below for the full justification + receipts);
// webkit opt-in as before (lane-9 posture).
// =============================================================================
const hostRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(hostRoot, "..");

const PORT = process.env.VH_DEPLOY_PORT ?? "8821"; // fresh range: not 8099/8765/8767/8811
const ORIGIN = `http://127.0.0.1:${PORT}`;

const artifactRoot =
  process.env.PLAYWRIGHT_ARTIFACTS_DIR ??
  path.join(repoRoot, "tmp/agent-runs/page-load-perf-deploy-lane");

export default defineConfig({
  testDir: path.join(hostRoot, "tests/folded-e2e"),
  // ONLY the deploy-transition spec — the folded lane's own config matches the
  // four folded-restore specs, so the two lanes never import each other's tests.
  testMatch: /deploy-transition\.spec\.ts/,
  // Serial: one port, one server pair, browser state (SW registrations +
  // caches) is origin-wide — parallel workers would swap servers under each
  // other. Each test uses its own fresh context.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 360_000, // base per-test budget (two ~32s binary boots + warm + swap + retries)
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.join(artifactRoot, "report") }],
  ],
  outputDir: path.join(artifactRoot, "output"),
  use: {
    baseURL: ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Firefox OPT-IN (dispatch-gated 2026-11-07, environment-driven — the
    // webkit-style slot below it). Diagnosis (receipts:
    // tmp/agent-runs/lane10-ff-diag/REPORT.md, G8:
    // tmp/agent-runs/g8-lane10-verify/): firefox on the lane host starves
    // the Playwright evaluate channel under the host's persistent baseline
    // load (Android emulator w/ software GL since 2026-10-30) — per-Evaluate
    // cost grows 10s → 100s → 1000s+ → hang while the page itself stays
    // healthy (steady SPA polling, DOM/inspector reads fine).
    // Deterministic 4/4 red (G8 ×2 @360s, no-self-load rerun @360s, post-fix
    // @1200s despite the deploy transition itself LANDING at +36s per the
    // network trace); chromium green on the same binaries/host/load;
    // spec+config unchanged since the 2026-10-10 firefox pass. Budget raise
    // (project timeout below) and ~3× round-trip batching (spec, 2026-11-07)
    // are both already in — and both demonstrably insufficient: ANY evaluate
    // can stall unboundedly (a standalone probe's FIRST trivial evaluate
    // hung 14m). The project timeout derivation (measured p50 ≈ 12s,
    // p90 ≈ 25s per round-trip; healthy path ≈ ~36 round-trips ≈ ~560s;
    // worst legal ≈ ~950s → 1200s) is retained for a re-enable on hosts
    // WITHOUT the starvation pathology; re-enable (uncomment) when the host
    // baseline changes or a firefox run completes within it.
    // { name: "firefox", use: { ...devices["Desktop Firefox"] }, timeout: 1_200_000 },
    // Webkit opt-in (disclosed skip by default — lane-9 posture):
    // { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  // NO webServer: the spec manages the two real binaries itself (see header).
});

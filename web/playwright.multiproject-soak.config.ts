import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Dedicated config for the multiproject SOAK spec (test-speed plan slice 3,
// dispatch-only) — the full-scale seven-page sustained-demand form of
// multiproject-latency.spec.ts (~49s body; see the spec header).
//
// Mirrors playwright.queue-delivery.config.ts (the established dispatch-lane
// pattern); DIFFERENCES from the ordinary lane-6 config
// (playwright.config.ts), every one deliberate:
//   - FRESH PROCESS + FRESH DIRS: distinct port, repo-local VH_DEMO_DIR and
//     VH_STATE_DIR (never the shared tmp/fixture-demo), reuseExistingServer
//     false, and NO globalSetup — nothing inherited, nothing reused, and none
//     of the ordinary run's destructive cleanup firing against a live server
//     we do not own. The fresh-dir wipe runs as a probe-guarded pre-step of
//     the webServer command (see wipeAndServe below) — importing this config
//     module is side-effect-free.
//   - EXACT-SCOPE DISCOVERY: testMatch selects ONLY the soak spec; the
//     ordinary config testIgnores it, so each lane runs precisely its own
//     scope.
//   - serviceWorkers blocked: the SW cache could serve stale stream/snapshot
//     responses and confound the sustained-demand measurement.
//   - retries 0: a soak failure is a finding to triage, not to mask.
//
// Run (chromium, serial, zero retries; headless is fine — the soak asserts
// wire/DOM state, not pixels):
//   cd web && npx playwright test --config=playwright.multiproject-soak.config.ts \
//     --project=chromium --workers=1 --retries=0
// CI: nightly cron + workflow_dispatch job (multiproject-soak in
// .github/workflows/ci.yml) — NOT in the PR matrix.
const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "..");

// Fresh, deterministic, repo-local (never /tmp, never the shared lane dirs).
const demoDir = path.join(repoRoot, "tmp", "mp-soak-e2e", "demo");
const stateDir = path.join(repoRoot, "tmp", "mp-soak-e2e", "state");

// MUST be set at config-eval time so BOTH the webServer child and the worker
// processes (forked from this one) inherit them BEFORE anything loads — the
// exact mechanism the ordinary config uses for tmp/fixture-demo. (Set on
// process.env rather than webServer.env so PATH and friends are preserved for
// the script's npm/go invocations.) Importing this module has NO filesystem
// side effects: Playwright re-imports the config in every test worker AFTER
// the webServer has booted, and a --list invocation never boots anything.
// The lane's address is PINNED (no env override): the probe below decides
// whether THESE dirs are safe to wipe by asking exactly this address, so the
// probe axis and the ownership axis must be the SAME constant (the
// queue-delivery lane's commit-review round-3 t1b-F1 lesson). Two concurrent
// lane invocations therefore ALWAYS contend on this one port — intended for a
// single-tenant, dispatch-only lane.
const addr = "127.0.0.1:8097"; // 8098 = queue-delivery, 8099 = ordinary lane
const baseURL = `http://${addr}`;
process.env.VH_DEMO_DIR = demoDir;
process.env.VH_STATE_DIR = stateDir;
process.env.VH_FIXTURE_ADDR = addr;
// Export the lane's base URL too: the multiproject specs' pageOrigin() (in
// multiproject-helpers.ts) derives each page's mp<i>.localhost:<port> alias
// from process.env.PLAYWRIGHT_BASE_URL, falling back to the ORDINARY lane's
// 8099 — which would refuse-connect against this lane's 8097 fixture. Same
// config-eval inheritance mechanism as the VH_* vars above.
process.env.PLAYWRIGHT_BASE_URL = baseURL;

// The fresh-dir wipe lives INSIDE the webServer command — the one place that
// runs exactly once per run, BEFORE the fixtureserver boots, and only in the
// invocation that actually owns the lane. Two fail-closed guards (same shape
// as the queue-delivery lane):
//   - the probe tool must EXIST (a curl-less host refuses to wipe rather
//     than silently losing the live-lane guard);
//   - a live lane answering on the PINNED address (the webServer's own
//     readiness route) SKIPS the wipe — the subsequent fixtureserver fails to
//     bind the occupied port, surfacing the conflict without destroying the
//     live lane's state.
const wipeAndServe = [
  `if ! command -v curl >/dev/null 2>&1; then`,
  `  echo "[mp-soak] curl unavailable — refusing to wipe (cannot probe for a live lane)" >&2;`,
  `  exit 1;`,
  `fi`,
  `if curl -sf "${baseURL}/vh/healthz" >/dev/null 2>&1; then`,
  `  echo "[mp-soak] a lane server already answers on ${addr} — SKIPPING the fresh-dir wipe (its state is live)";`,
  `else`,
  `  rm -rf ${JSON.stringify(path.join(demoDir, ".vh-solara"))} ${JSON.stringify(stateDir)};`,
  `fi`,
  `exec bash scripts/fixture-web.sh`,
].join("\n");

export default defineConfig({
  testDir: path.join(webRoot, "tests/e2e"),
  testMatch: /multiproject-soak\.spec\.ts$/,
  // No globalSetup: this lane owns its fresh dirs and must not inherit the
  // ordinary lane's wipe-and-disarm behavior (wrong port, wrong dirs).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: path.join(repoRoot, "tmp", "mp-soak-e2e", "playwright-output"),
  use: {
    baseURL,
    serviceWorkers: "block",
    trace: "on",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Same real build+serve pipeline as lane 6 (SPA build → materialize →
    // real aggregator + web server via the fake OpenCode), on this lane's
    // fresh dirs/port (all via the inherited env set at config-eval above).
    // The probe-guarded wipe (wipeAndServe) runs as the command's pre-step:
    // exactly once per run, never on config import, never on --list, and
    // never against a live lane's dirs.
    command: wipeAndServe,
    cwd: webRoot,
    url: `${baseURL}/vh/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

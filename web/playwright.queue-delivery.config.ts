import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Dedicated config for the queue-delivery-custody spec (O3, dispatch-only).
//
// DIFFERENCES from the ordinary lane-6 config (playwright.config.ts), every
// one deliberate:
//   - DAEMON DISPATCH: the webServer passes VH_FIXTURE_DAEMON_DISPATCH=1 so
//     scripts/fixture-web.sh forwards -daemon-dispatch — the daemon's custody
//     drain loop owns queue dispatch; the SPA runs its observe-only
//     projection. The ordinary lane keeps the browser-dispatch posture.
//   - FRESH PROCESS + FRESH DIRS: distinct port, repo-local VH_DEMO_DIR and
//     VH_STATE_DIR (never the shared tmp/fixture-demo), reuseExistingServer
//     false, and NO globalSetup — nothing inherited, nothing reused, and none
//     of the ordinary run's destructive cleanup firing against a live server
//     we do not own. The fresh-dir wipe runs as a probe-guarded pre-step of
//     the webServer command (see wipeAndServe below) — importing this config
//     module is side-effect-free.
//   - EXACT-SCOPE DISCOVERY: testMatch selects ONLY the custody spec; the
//     ordinary config testIgnores it, so each lane runs precisely its own
//     server posture.
//   - serviceWorkers blocked: the SW cache could serve stale queue responses
//     and confound the controlled stale-pull this spec performs.
//
// Run (chromium, serial, zero retries; headed per the repo interaction rules —
// use xvfb-run or a display, see the queue-delivery runbook in the spec):
//   cd web && npx playwright test --config=playwright.queue-delivery.config.ts \
//     --project=chromium --headed --workers=1 --retries=0
const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "..");

// Fresh, deterministic, repo-local (never /tmp, never the shared lane dirs).
const demoDir = path.join(repoRoot, "tmp", "queue-delivery-e2e", "demo");
const stateDir = path.join(repoRoot, "tmp", "queue-delivery-e2e", "state");

// MUST be set at config-eval time so BOTH the webServer child and the worker
// processes (forked from this one) inherit them BEFORE anything loads — the
// exact mechanism the ordinary config uses for tmp/fixture-demo. (Set on
// process.env rather than webServer.env so PATH and friends are preserved for
// the script's npm/go invocations.) Importing this module has NO filesystem
// side effects: Playwright re-imports the config in every test worker
// (workerProcessEntry → deserializeConfig → loadUserConfig) AFTER the
// webServer has booted, and a --list invocation never boots anything — a
// module-top rmSync would either delete the LIVE fixtureserver's cwd/runtime
// state (it chdirs into VH_STATE_DIR/managed-project) or wipe on plain
// discovery.
// The lane's address is PINNED (no env override): the probe below decides
// whether THESE dirs are safe to wipe by asking exactly this address, so the
// probe axis and the ownership axis must be the SAME constant. An overridable
// address with fixed dirs would let a second invocation on a different port
// conclude "no live lane" and delete the first invocation's live state
// (commit-review round-3 t1b-F1). Two concurrent lane invocations therefore
// ALWAYS contend on this one port — which is the intent for a single-tenant,
// dispatch-only lane.
const addr = "127.0.0.1:8098";
const baseURL = `http://${addr}`;
process.env.VH_DEMO_DIR = demoDir;
process.env.VH_STATE_DIR = stateDir;
process.env.VH_FIXTURE_ADDR = addr;
process.env.VH_FIXTURE_DAEMON_DISPATCH = "1";

// The fresh-dir wipe lives INSIDE the webServer command — the one place that
// runs exactly once per run, BEFORE the fixtureserver boots, and only in the
// invocation that actually owns the lane. Two fail-closed guards:
//   - the probe tool must EXIST (a curl-less host refuses to wipe rather
//     than silently losing the live-lane guard);
//   - a live lane answering 200 on the PINNED address (the webServer's own
//     readiness route) SKIPS the wipe — the subsequent fixtureserver fails
//     to bind the occupied port, surfacing the conflict without destroying
//     the live lane's state (it chdirs into VH_STATE_DIR/managed-project).
// Discovery-only invocations (--list) never execute the webServer command
// at all.
const wipeAndServe = [
  `if ! command -v curl >/dev/null 2>&1; then`,
  `  echo "[queue-delivery] curl unavailable — refusing to wipe (cannot probe for a live lane)" >&2;`,
  `  exit 1;`,
  `fi`,
  `if curl -sf "${baseURL}/vh/healthz" >/dev/null 2>&1; then`,
  `  echo "[queue-delivery] a lane server already answers on ${addr} — SKIPPING the fresh-dir wipe (its state is live)";`,
  `else`,
  `  rm -rf ${JSON.stringify(path.join(demoDir, ".vh-solara"))} ${JSON.stringify(stateDir)};`,
  `fi`,
  `exec bash scripts/fixture-web.sh`,
].join("\n");

export default defineConfig({
  testDir: path.join(webRoot, "tests/e2e"),
  testMatch: /queue-delivery-custody\.spec\.ts$/,
  // No globalSetup: this lane owns its fresh dirs and must not inherit the
  // ordinary lane's wipe-and-disarm behavior (wrong port, wrong dirs).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: path.join(repoRoot, "tmp", "queue-delivery-e2e", "playwright-output"),
  use: {
    baseURL,
    serviceWorkers: "block",
    trace: "on",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Same real build+serve pipeline as lane 6 (SPA build → materialize → real
    // aggregator + web server via the fake OpenCode), with the daemon-dispatch
    // opt-in and this lane's fresh dirs/port (all via the inherited env set
    // at config-eval above). The probe-guarded wipe (wipeAndServe) runs as
    // the command's pre-step: exactly once per run, never on config import,
    // never on --list, and never against a live lane's dirs.
    command: wipeAndServe,
    cwd: webRoot,
    url: `${baseURL}/vh/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

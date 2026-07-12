import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "..");

// The consolidated demo project dir, shared by the Go fixtureserver (which
// creates it on disk) and the TS test harness (which builds ?dir= URLs from
// util.demoDir). MUST be the SAME path fixture-web.sh passes to the
// fixtureserver, else the attach upload (writes under <dir>/.vh-solara/...) and
// the ?dir= the tests load won't match. Set before tests load util.ts.
process.env.VH_DEMO_DIR = process.env.VH_DEMO_DIR || path.join(repoRoot, "tmp", "fixture-demo");

// Artifacts stay under repo-scoped tmp/ (mirrors trueai-dev's discipline).
const artifactRoot = process.env.PLAYWRIGHT_ARTIFACTS_DIR
  ? path.resolve(process.env.PLAYWRIGHT_ARTIFACTS_DIR)
  : path.join(repoRoot, "tmp/agent-runs/playwright");

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8099";

// Fixture-backed by default. Set PLAYWRIGHT_USE_EXISTING_WEB_SERVER=1 and
// PLAYWRIGHT_BASE_URL=<live daemon> to run the same specs against a real
// `--web=vh` daemon.
const useExistingWebServer = process.env.PLAYWRIGHT_USE_EXISTING_WEB_SERVER === "1";

export default defineConfig({
  globalSetup: path.resolve(webRoot, "global-setup.ts"),
  testDir: path.join(webRoot, "tests/e2e"),
  fullyParallel: false,
  // One shared fixture backend with mutable session state -> run serially so
  // state-mutating specs don't perturb each other.
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.join(artifactRoot, "report") }],
  ],
  outputDir: path.join(artifactRoot, "output"),
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Firefox runs ONLY the codeview regression. The parent<->iframe ready
    // handshake can lose the open command on firefox (the child's vh-code:ready
    // is processed before the iframe `load` event, so the parent flushed through
    // a still-null frame reference) but not on chromium, which ordered them the
    // other way and masked the bug. codeview.spec.ts is the one flow that needs
    // a second engine. Scoped via testMatch so the serial, fixture-state-shared
    // suite is NOT re-run wholesale on a second engine (flakiness/noise).
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, testMatch: /codeview\.spec\.ts/ },
  ],
  webServer: useExistingWebServer
    ? undefined
    : {
        // Builds the SPA, then serves it through the real aggregator + web
        // server backed by the fake OpenCode fixtures.
        command: "bash scripts/fixture-web.sh",
        cwd: webRoot,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});

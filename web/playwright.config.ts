import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "..");

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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
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

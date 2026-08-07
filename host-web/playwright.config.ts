import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const hostRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(hostRoot, "..");

// Artifacts stay under repo-scoped tmp/.
const artifactRoot =
  process.env.PLAYWRIGHT_ARTIFACTS_DIR ??
  path.join(repoRoot, "tmp/agent-runs/host-web-playwright");

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173";

export default defineConfig({
  testDir: path.join(hostRoot, "tests/e2e"),
  // Serial: the host SPA holds shared live Dockview state; run one engine at a
  // time to keep assertions deterministic.
  fullyParallel: false,
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
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: [
    {
      // WS echo server (:5175) — assigns the connId reload signal. /health is
      // polled for readiness (a raw WS server has no HTTP URL to poll).
      command: "npm run dev:ws",
      cwd: hostRoot,
      url: "http://127.0.0.1:5175/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Cross-origin iframe content (:5174) — the mock "vh-solara server"
      // page each pane embeds. Distinct origin from the host (:5173) by port.
      command: "npm run dev:iframe",
      cwd: hostRoot,
      url: "http://127.0.0.1:5174/",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Host SPA (:5173) — SolidJS/Dockview shell.
      command: "npm run dev:host",
      cwd: hostRoot,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

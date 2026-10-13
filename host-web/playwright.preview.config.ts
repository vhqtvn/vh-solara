import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// PRODUCTION-BUILD shell proof. Runs ONLY the DOM-only preview shell spec
// (tests/preview-e2e) against `vite preview` (a real production bundle), NOT the
// Vite dev server. Purpose: prove the host shell's layout ops work in a build
// where window.__host is absent (the DEV-only test bridge is eliminated). This
// complements tests/e2e (DEV-only, depends on window.__host) — it must NOT pull
// in survival.spec.ts (its negative controls need the bridge that prod omits).
//
// The iframe content (:5174) and WS echo (:5175) dev servers are reused as-is:
// they are independent of the host build mode. Only the host is swapped from
// `dev:host` → `build && preview`.

const hostRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(hostRoot, "..");

const artifactRoot =
  process.env.PLAYWRIGHT_ARTIFACTS_DIR ??
  path.join(repoRoot, "tmp/agent-runs/host-web-playwright-preview");

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173";

export default defineConfig({
  testDir: path.join(hostRoot, "tests/preview-e2e"),
  fullyParallel: false,
  workers: 1,
  // CI retries absorb runner-level transients (browser/context killed at test
  // start — e.g. "Target page, context or browser has been closed" at the first
  // page.goto, seen on GitHub runners where this lane runs second, after the
  // 3-engine survival lane, on a memory-pressured box). Same pattern as
  // host-web/playwright.config.ts and web/playwright.config.ts — a dead browser
  // fixture is only recoverable by a test-level retry in a fresh worker, never
  // by an in-test goto retry. Local runs stay at 0 retries.
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.join(artifactRoot, "report") }],
  ],
  outputDir: path.join(artifactRoot, "output"),
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: [
    {
      // WS echo server (:5175) — assigns the connId signal. Build-mode-independent.
      command: "npm run dev:ws",
      cwd: hostRoot,
      url: "http://127.0.0.1:5175/health",
      reuseExistingServer: true,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Cross-origin iframe content (:5174). Build-mode-independent.
      command: "npm run dev:iframe",
      cwd: hostRoot,
      url: "http://127.0.0.1:5174/",
      reuseExistingServer: true,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Host SPA — PRODUCTION build served by `vite preview` (NOT the dev
      // server). reuseExistingServer:false so we never accidentally reuse a
      // lingering dev:host (which would invalidate the production proof).
      command: "npm run build && npm run preview",
      cwd: hostRoot,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

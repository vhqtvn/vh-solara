import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { FLEET_HOST_BASE, FLEET_JSON } from "./tests/fleet-e2e/fleet-data";

// Config-driven fleet proof config (Phase-1′). Starts a DEDICATED host dev
// server on :5177 with VITE_SERVERS set (pointing pane urls at the existing mock
// content page :5174 as a stand-in "real" server), so resolveFleet() returns the
// configured {url,label} pairs instead of the mock fleet. The :5174 iframe
// content and :5175 WS echo dev servers are reused as-is (build-mode- and
// fleet-independent). Chromium-only: this proves CONFIG SEEDING, not cross-
// browser survival (the survival lane already covers Chromium+Firefox).

const hostRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(hostRoot, "..");

const artifactRoot =
  process.env.PLAYWRIGHT_ARTIFACTS_DIR ??
  path.join(repoRoot, "tmp/agent-runs/host-web-playwright-fleet");

export default defineConfig({
  testDir: path.join(hostRoot, "tests/fleet-e2e"),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  outputDir: path.join(artifactRoot, "output"),
  use: {
    baseURL: FLEET_HOST_BASE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // WS echo server (:5175) — assigns the connId signal. Fleet-independent.
      command: "npm run dev:ws",
      cwd: hostRoot,
      url: "http://127.0.0.1:5175/health",
      reuseExistingServer: true,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Cross-origin mock content page (:5174) — reused as the stand-in "real"
      // server target (the configured urls point here with distinct query params).
      command: "npm run dev:iframe",
      cwd: hostRoot,
      url: "http://127.0.0.1:5174/",
      reuseExistingServer: true,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Dedicated host dev server on :5177 WITH VITE_SERVERS set, so Vite bakes
      // import.meta.env.VITE_SERVERS = FLEET_JSON into the bundle and
      // resolveFleet() returns the configured real fleet. The inline env is set
      // for this command's process tree only (Vite inherits it from npm).
      command: `VITE_SERVERS='${FLEET_JSON}' npm run dev:host:fleet`,
      cwd: hostRoot,
      url: FLEET_HOST_BASE,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

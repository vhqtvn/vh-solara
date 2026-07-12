import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default async function globalSetup() {
  // Existing-server mode (PLAYWRIGHT_USE_EXISTING_WEB_SERVER=1) runs the suite
  // against a REAL live --web=vh daemon/project. Never wipe there — only in
  // fixture-backed mode, where VH_DEMO_DIR is a throwaway dir. An unconditional
  // rmSync would destroy a live project's persisted queue.json + attachments.
  if (process.env.PLAYWRIGHT_USE_EXISTING_WEB_SERVER === "1") return;

  // Wipe persisted per-session queue + attachment state left by prior runs so
  // each run starts from a clean queue store (cross-run bleed fix). Only
  // per-session state lives under .vh-solara/sessions/. Playwright starts the
  // CI webServer BEFORE globalSetup, but the queue store loads LAZILY on first
  // access (pkg/web/queue.go load(): a missing queue.json → empty queue), so
  // wiping here before any test runs yields a clean first load. NOTE: this does
  // NOT clear a reused local server's in-memory registry — kill the server to
  // reset that; and it does NOT cover within-run retry bleed (requires a vh
  // reset route, deferred).
  //
  // VH_DEMO_DIR is the codebase's single source of truth for the demo dir —
  // set by playwright.config.ts at config-eval time (which precedes globalSetup),
  // and honored by scripts/fixture-web.sh and tests/e2e/util.ts. Honoring it
  // here matches those and wipes the correct dir when overridden; the ESM-derived
  // path below is only the fallback default. (ESM `"type": "module"`, so
  // `__dirname` is NOT available — hence import.meta.url.)
  const webRoot = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(webRoot, "..");
  const demoDir = process.env.VH_DEMO_DIR || path.join(repoRoot, "tmp", "fixture-demo");
  rmSync(path.join(demoDir, ".vh-solara", "sessions"), { recursive: true, force: true });
}

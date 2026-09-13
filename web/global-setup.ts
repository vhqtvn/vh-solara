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

  // --- suite-level hold-latch disarm (crash-safety) --------------------------
  //
  // A hard-killed run (SIGKILL'd Playwright, crashed worker) skips every
  // afterEach, so the fixtureserver's test-only hold latches can stay ARMED:
  // the agent-evidence hold (/oc/fixture/agent-hold/*) and the new-session
  // cold hold (/oc/fixture/new-session-hold/*) that parks ses_new* message-
  // LIST GETs. Locally reuseExistingServer:!CI then REUSES that orphaned
  // server for the next run, and the first spec whose flow mints a ses_new*
  // session (or observes agenthold) parks its cold fetch on the stranded
  // latch → suite-wide timeouts in unrelated specs. Release BOTH latches
  // here, before any spec runs.
  //
  // Ordering: Playwright brings the webServer up (readiness-gated on `url`)
  // BEFORE globalSetup — the same assumption the queue-wipe above rests on —
  // but a reused or just-bound server can still race the first connect, so
  // each release retries until the server answers or a 15s budget expires.
  // Both endpoints are idempotent (a clean prior run disarms nothing), the
  // X-VH-CSRF header is required (csrfGuard covers POST /oc/*), and a non-2xx
  // response is WARNED rather than thrown: the disarm is a safety net and
  // must not become a new way to fail the lane.
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:8099";
  for (const p of ["/oc/fixture/new-session-hold/release", "/oc/fixture/agent-hold/release"]) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const res = await fetch(baseURL + p, { method: "POST", headers: { "X-VH-CSRF": "1" } });
        console.log(`[global-setup] hold-latch disarm: POST ${p} -> ${res.status}`);
        break;
      } catch (err) {
        if (Date.now() >= deadline) {
          console.log(`[global-setup] WARNING: hold-latch disarm POST ${p} never connected: ${String(err)}`);
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
}

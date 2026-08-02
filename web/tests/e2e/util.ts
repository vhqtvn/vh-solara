// Shared e2e helpers.

import type { APIRequestContext } from "@playwright/test";

// demoDir is the single consolidated project directory under which ALL real
// fixture sessions live (pkg/fixtures/opencode.go seeds demo/sub/other/slow and
// any opt-in bench session with this directory). The fixture's /session handler
// returns the full real session set for this dir, reproducing the
// everything-visible behavior the suite used to get from the synthetic
// default-project/cwd path. Every session-reliant e2e loads this dir via
// projectUrl() so no test depends on cwd anymore.
//
// It MUST be a real writable path on disk: the attach-upload handler writes to
// <dir>/.vh-solara/sessions/<id>/attachments (pkg/web/attach.go). The
// fixtureserver creates the dir and the Go fixture reports it; this const reads
// the SAME VH_DEMO_DIR playwright.config.ts sets (repo-relative tmp/fixture-demo
// by default) so the ?dir= the tests load matches the dir the fixture writes.
//
// managed.spec.ts is the ONE intentional cwd-stayer: the repo-declared managed
// project (.vh-solara/project.jsonc) is seeded under the fixtureserver's cwd
// (orch.OpenProject("")), so it lives at dir="" and is exercised there — it does
// NOT migrate to demoDir.
export const demoDir = process.env.VH_DEMO_DIR || "/work/demo";

// projectUrl returns the root-relative app URL for the demo project, merging a
// `dir=` query param idempotently into the given path/query. Examples:
//   projectUrl("/")              → "/?dir=%2Fwork%2Fdemo"
//   projectUrl("/?session=demo") → "/?session=demo&dir=%2Fwork%2Fdemo"
// Any existing `dir` param is overwritten (not duplicated). The input is a
// root-relative path beginning with "/". Uses URLSearchParams so the encoding
// matches encodeURIComponent (the app decodes via URLSearchParams, which
// round-trips %2F → / correctly — same form terminal.spec.ts already uses).
export function projectUrl(pathOrQuery: string): string {
  const query = pathOrQuery.startsWith("/?") ? pathOrQuery.slice(2) : "";
  const params = new URLSearchParams(query);
  params.set("dir", demoDir);
  return "/?" + params.toString();
}

// resetPins clears the worker's durable pin doc to initialized+empty via the
// real /vh/pins API (GET to read the current revision, then a CSRF-bearing PUT
// with an empty orderedSessionIds list). The Playwright e2e suite is SERIAL
// (workers:1, fullyParallel:false) over ONE shared fixtureserver process, so
// server-side pin state persists across specs within a suite run — and a pin is
// a SERVER concern now (Phase 4+), not a client-local one. Any spec that pins a
// session MUST bracket itself with beforeEach/afterEach resetPins, otherwise it
// leaks pinned state into sibling specs: a pinned session is hoisted into the
// .tree-pinned group and dedup'd OUT of the tree body, which silently breaks
// tree-body assertions elsewhere (this is exactly what broke tree2-parity test 2
// once pins became server-managed).
//
// Uses the bare `request` fixture (NOT page.request): in beforeEach the page has
// not navigated yet, so page.request would resolve the relative URL against
// about:blank and silently no-op (see scroll-follow.spec.ts for the same
// rationale). The fixture server enforces no auth; only the CSRF guard applies,
// which GET is exempt from and PUT satisfies via the X-VH-CSRF header.
//
// Clears to initialized=true/empty rather than to an uninitialized doc so a
// freshly-loaded browser does NOT fire its one-shot legacy migration PUT (which
// would otherwise race the next test's assertions). Retries on 409: a concurrent
// revision advance is unlikely in the serial suite, but a just-closed browser's
// in-flight migration could in principle race a fast reset — re-read and retry
// rather than fail the setup.
export async function resetPins(request: APIRequestContext): Promise<void> {
  const csrf = { "X-VH-CSRF": "1" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await request.get("/vh/pins");
    if (!cur.ok()) {
      throw new Error(`resetPins: GET /vh/pins -> ${cur.status()} ${cur.statusText()}`);
    }
    const baseRevision = (await cur.json()).revision as number;
    const put = await request.put("/vh/pins", {
      headers: csrf,
      data: { baseRevision, orderedSessionIds: [] },
    });
    if (put.ok()) return;
    if (put.status() === 409) continue; // revision advanced under us; re-read + retry
    throw new Error(`resetPins: PUT /vh/pins -> ${put.status()} ${put.statusText()}`);
  }
  throw new Error("resetPins: exhausted retries on repeated 409 (revision kept advancing)");
}

// resetLabels clears the worker-wide labels doc to empty via the real
// /vh/labels CAS API (GET to read the current revision, then a CSRF-bearing PUT
// with empty groups/tags/tagIdsByRootSessionId). Mirrors resetPins exactly: the
// serial Playwright suite shares ONE fixtureserver process, so server-side
// label state persists across specs within a suite run — any spec that creates
// a group/tag/assignment MUST bracket itself with beforeEach/afterEach
// resetLabels, otherwise it leaks state into sibling specs (a grouped root
// renders under a GroupHeader and OUT of the ungrouped list, silently breaking
// tree-body / section assertions elsewhere — the same cross-spec failure mode
// resetPins exists for).
//
// Uses the bare `request` fixture (NOT page.request): in beforeEach the page has
// not navigated yet. The fixture server enforces no auth; only the CSRF guard
// applies (GET exempt, PUT satisfied via X-VH-CSRF). Retries on 409: a concurrent
// revision advance is unlikely in the serial suite, but a just-closed browser's
// in-flight mutation could race a fast reset — re-read and retry rather than fail
// setup.
export async function resetLabels(request: APIRequestContext): Promise<void> {
  // Mirror the SPA: stamp x-opencode-directory so reqDir resolves to the demo
  // project key (the same one the SPA's installCsrf stamps on every request).
  // Without this the raw `request` GET/PUT resolves to the daemon cwd project
  // (the fixtureserver's managed-project cwd, distinct from VH_DEMO_DIR), so
  // PUT writes one store while the bootstrap snapshot reads another (empty) →
  // [data-group-id] never renders.
  const csrf = { "X-VH-CSRF": "1", "x-opencode-directory": demoDir };
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await request.get("/vh/labels", { headers: csrf });
    if (!cur.ok()) {
      throw new Error(`resetLabels: GET /vh/labels -> ${cur.status()} ${cur.statusText()}`);
    }
    const baseRevision = (await cur.json()).revision as number;
    const put = await request.put("/vh/labels", {
      headers: csrf,
      data: {
        baseRevision,
        groups: [],
        tags: [],
        tagIdsByRootSessionId: {},
      },
    });
    if (put.ok()) return;
    if (put.status() === 409) continue; // revision advanced under us; re-read + retry
    throw new Error(`resetLabels: PUT /vh/labels -> ${put.status()} ${put.statusText()}`);
  }
  throw new Error("resetLabels: exhausted retries on repeated 409 (revision kept advancing)");
}

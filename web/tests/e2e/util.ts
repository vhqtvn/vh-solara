// Shared e2e helpers.

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

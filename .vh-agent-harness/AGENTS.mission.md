# vh-solara — Mission & Engineering Notes

This repository builds **vh-solara** — a single Go binary that runs next to
OpenCode on each machine: it aggregates OpenCode's state into a resumable,
real-time view and serves a custom, mobile-first web UI (a SolidJS SPA,
installable as a PWA) embedded via `//go:embed`. Each instance connects to a
central controller through a persistent multiplexed WebSocket tunnel (yamux), so
an operator can reach and drive any machine's OpenCode sessions from one URL with
**no inbound network access to the worker**.

It lets an operator:
- watch and drive OpenCode sessions/subsessions (tree, streaming chat, diffs,
  terminal, git actions) from a phone or desktop, in real time;
- reach worker machines through the controller tunnel without exposing them;
- declare repo-resident managed processes + embedded views per project.

## Toolchain

- **`go` may not be on `PATH`.** It lives at `/usr/local/go/bin/go`; prefix:
  `export PATH=$PATH:/usr/local/go/bin`.
- Module: `github.com/vhqtvn/vh-solara`, Go 1.25.
- Build the CLI: `go build ./...` (uses the committed `pkg/web/dist/` placeholder,
  so no frontend build is needed for a plain build or `go test`).
- Run Go tests: `go test ./...`. Format check: `gofmt -l pkg cmd main.go`.
- Releases are **tag-driven**: pushing a `v*` tag triggers the GitHub Actions
  release workflow, which stamps `cmd.Version` via ldflags. There is no in-repo
  version constant — "bump version" = create and push the next `vX.Y.Z` tag.

## Web frontend (`web/`)

- SolidJS SPA built with Vite; TypeScript. `make web` builds the SPA into a
  **gitignored staging dir** (`web/dist-build/`), NOT into `pkg/web/dist/`. A
  self-contained fallback `pkg/web/dist/placeholder.html` is tracked so
  `//go:embed dist` compiles and a cold `go build`/`go test` works with **no
  frontend build** (it renders a "web UI was not built" banner — fully
  self-contained, with no `/assets` or `/sw.js` references). Generated
  `pkg/web/dist/index.html` (the real SPA shell) and its assets are gitignored.
  Embed-producing targets (`make build`/`install`/`fixtures`, the release
  workflow) **materialize** — copy `web/dist-build/*` → `pkg/web/dist/` —
  immediately before `go build`, so the binary embeds the real SPA. `make web`
  alone leaves `git status` clean (a CI guard asserts
  `pkg/web/dist/placeholder.html` is untouched). `make build`/materialize writes
  the gitignored generated `index.html` + assets under `pkg/web/dist/` locally —
  since those are gitignored, `git status` stays clean; `make clean-web-embed`
  removes the generated artifacts and returns to the true cold-fallback embed
  state (placeholder.html only).
- Full build (Node ≥ 24): `make build` (or `make web` for the SPA only).
- SPA unit tests: `cd web && npm run test:unit` (preferred over bare `npx vitest run`, which from the repo root can resolve to a cached vitest that lacks the project jsdom config). Typecheck: `npm run typecheck`.
- Playwright e2e: `cd web && export PATH=$PATH:/usr/local/go/bin && npx playwright
  test` (the `webServer` runs `scripts/fixture-web.sh`, which builds the SPA and
  `go run ./tools/fixtureserver`, so go must be on PATH). The e2e suite is serial
  and shares fixture state.
- Go e2e harness: `tests/e2e/` (`e2e.StartCluster()`).
- **CSS architecture (AI-first):** component styles are co-located CSS Modules
  (`Component.module.css` beside `Component.tsx`); global tokens/theme/z-index
  live in `web/src/styles/foundation/`; `legacy.css` is a transitional remainder
  being carved down. See
  [`docs/ai/web-css-architecture.md`](../docs/ai/web-css-architecture.md) for the
  migration rules and conventions before adding or moving component CSS.

## Web frontend performance — Firefox/WebRender GPU gotchas

The UI runs on the user's GPU. Firefox/WebRender punishes a few CSS patterns far
harder than Chromium and can pin a GPU to ~99°C while looking innocent. Avoid
these on large/scrolling/always-present surfaces (the chat scroll, message list,
reasoning body):

- **`mask-image` / `-webkit-mask` on a scroll container is the worst** — it forces
  the whole scrollable content to render to an offscreen surface and re-rasterize.
  A gradient edge-fade mask on `.chat-scroll`/`.reasoning-body` re-rastered the
  entire transcript **on every scroll frame** ("scroll and the temp climbs"). It
  was the actual culprit behind a long heat saga; removed (see `lib/scrollEdges.ts`).
- **`backdrop-filter: blur` re-blurs the backdrop every frame** — don't use it on
  overlays (removed from `.restart-overlay`).
- **`contain: paint` / `content-visibility: auto` per element made it WORSE** on
  Firefox WebRender (each becomes a compositing surface/blob; too many blow past
  the GPU surface budget into a stuck-hot state). Not a perf fix here.
- **Per-frame work scales with total DOM** (a repaint/animation can trigger a
  full-document display-list rebuild), so cap streaming re-render rate (the live
  markdown stream is coalesced to ~5fps in `components/Part.tsx`) and prefer cheap
  DOM ops (`lib/streamMd.ts` appends text nodes; never rewrites a growing node).
- Diagnosing: a bare repro page often won't reproduce it — the cost is the real
  app's complex scene. Capture a Firefox profiler trace and look under
  `Update the rendering → Paint` for `ViewportFrame::BuildDisplayList` (display
  list) vs `Grouper`/`GetBlobItemData` (blob raster). Headless browsers do not
  GPU-rasterize, so they cannot reproduce the heat.

## Testing rules (this repo)

> The core `## Testing rules` section above is generic harness boilerplate
> (pytest, `tests/unit/`) that **does not apply to this repo**. This section is
> the authoritative testing reference.

Every meaningful change should add or update tests. This repo has two test
trees (Go and web) and four runner families across six lanes. There is **no
`tests/unit/` directory** — Go unit tests are co-located in `pkg/`. There is
**no pytest** anywhere in this repo.

> **Go PATH note:** `go` may not be on `PATH`. Prefix Go commands with
> `export PATH=$PATH:/usr/local/go/bin` (or use the harness equivalent:
> `vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go ...'`).

### The six lanes

1. **Go co-located unit** — `pkg/*/*_test.go` beside the source under test.
   Runner: `go test ./pkg/<pkg>/` (whole tree: `go test ./pkg/...`).

2. **Go integration** — `tests/integration/` (e.g. `opencode_lifecycle_test.go`).
   Runner: `go test ./tests/integration/`.

3. **Go e2e (in-process)** — `tests/e2e/`. Real controller daemon + real worker
   over an actual yamux tunnel + fake OpenCode (`pkg/fixtures`). No docker, no
   real opencode binary, no LLM. Entry helper `StartCluster()` at
   `tests/e2e/harness.go:47`.
   Runner: `go test ./tests/e2e/`.

4. **Go e2e (docker gold)** — `tests/e2e-docker/run.sh`. Real opencode + fake
   LLM through the real aggregator/web, in docker. The `assert*.py` files
   (`assert.py`, `assert_sub.py`, `assert_tool.py`, `assert_perm.py`,
   `assert_perm_done.py`) are JSON assertion helpers invoked by `run.sh` —
   they read JSON on stdin and check fields, then print `OK`/`WAIT` and exit
   0. They are **not** a python test framework (there is no pytest, no test
   runner, no collection).
   Runner: `bash tests/e2e-docker/run.sh` (docker-gated).

5. **Web unit** — `web/tests/unit/*.test.{ts,tsx}` (Vitest). Component tests use
   `@solidjs/testing-library`. `vitest.config.ts` default environment is **node**
   (`environment: "node"` at line 10); jsdom is a per-file opt-in via the
   `// @vitest-environment jsdom` docblock (36 of 52 test files opt in; the
   remaining 16 are pure-logic tests that stay in node).
   Runner: `npm --prefix web run test:unit`.
   Typecheck: `npm --prefix web run typecheck`.

6. **Web e2e** — `web/tests/e2e/*.spec.ts` (Playwright). Runs **serially** by
   design (`web/playwright.config.ts`: `fullyParallel: false` at line 30,
   `workers: 1` at line 33, `retries: process.env.CI ? 2 : 0` at line 34) — one
   shared mutable fixture backend (`pkg/fixtures/opencode.go`). The `webServer`
   config runs `scripts/fixture-web.sh` which builds the SPA and starts
   `go run ./tools/fixtureserver`, so go must be on PATH.
   Runner: `npm --prefix web run test:e2e`.

Execution examples:

```bash
# Go co-located unit (whole tree):
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./pkg/...'
# Go integration:
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./tests/integration/'
# Go in-process e2e:
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && go test ./tests/e2e/'
# Go docker gold (docker-gated):
vh-agent-harness exec bash tests/e2e-docker/run.sh
# Web unit + typecheck:
vh-agent-harness exec npm --prefix web run test:unit
vh-agent-harness exec npm --prefix web run typecheck
# Web e2e (serial; go must be on PATH for the fixtureserver):
vh-agent-harness exec bash -c 'export PATH=$PATH:/usr/local/go/bin && npm --prefix web run test:e2e'
```

For any substantial boundary change, also update the relevant docs.

## Conventions

- State-changing `/vh/*` requests require the `X-VH-CSRF: 1` header (the SPA's
  `installCsrf()` adds it automatically; raw `fetch` in tests must set it).
- Per-project runtime data lives under `.vh-solara/` (gitignored — distinct from
  this harness's `.vh-agent-harness/`). A project may commit
  `.vh-solara/project.jsonc` to declare managed processes — see
  [`docs/guides/managed-projects.md`](../docs/guides/managed-projects.md). Building the embedded
  view app itself: [`docs/guides/custom-views.md`](../docs/guides/custom-views.md).

## Not applicable

vh-solara is a host-run Go binary + embedded SPA — **not** container-first, and it
has no datasets, promotable model components, or credentialed demo API. The
container-first / dataset / component-promotion / demo-API sections of the mission
template are intentionally omitted.

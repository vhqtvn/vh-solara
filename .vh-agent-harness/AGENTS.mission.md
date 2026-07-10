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

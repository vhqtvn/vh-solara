# AGENTS.md

Notes for agents and contributors working in this repo.

## Toolchain

- **`go` is not on `PATH` in some environments.** The binary lives at
  `/usr/local/go/bin/go`. Prefix every go command:
  `export PATH=$PATH:/usr/local/go/bin`.
- Module: `github.com/vhqtvn/vh-solara`, Go 1.25.
- Build the CLI: `go build ./...` (uses the committed `pkg/web/dist/`
  placeholder, so no frontend build needed for a plain build or `go test`).
- Run all Go tests: `go test ./...`.

## Web frontend (`web/`)

- SolidJS SPA built with Vite; TypeScript. The built bundle under
  `pkg/web/dist/` is gitignored **except** a placeholder `index.html` that exists
  only so `//go:embed dist` compiles without a frontend build. **Do not commit a
  real `vite build` output** — `make web` (or the release workflow) rebuilds it.
- Full build (needs Node ≥ 20): `make build` (or `make web` for the SPA only).
- SPA unit tests: `cd web && npx vitest run`.
- Playwright e2e: `cd web && export PATH=$PATH:/usr/local/go/bin && npx playwright test`
  (the `webServer` runs `scripts/fixture-web.sh`, which builds the SPA and
  `go run ./tools/fixtureserver`, so go must be on PATH).
- Go e2e harness: `tests/e2e/` (`e2e.StartCluster()`).

## Web frontend performance — Firefox/WebRender GPU gotchas

The UI runs on the user's GPU. Firefox/WebRender punishes a few CSS patterns far
harder than Chromium, and they can pin a GPU to ~99°C while looking innocent. A
long saga traced the heat to these — avoid them on large/scrolling/always-present
surfaces (the chat scroll, message list, reasoning body):

- **`mask-image` / `-webkit-mask` on a scroll container is the worst.** It forces
  the WHOLE scrollable content to render to an offscreen surface and
  re-rasterize. We had a gradient edge-fade mask on `.chat-scroll`/`.reasoning-body`
  that re-rastered the entire transcript **on every scroll frame** → "scroll
  up/down and the temp climbs," in any session. Removed (see `lib/scrollEdges.ts`).
  This was the actual culprit; everything else below was secondary.
- **`backdrop-filter: blur` is a per-frame full re-blur** of whatever's behind it.
  Don't use it on overlays (removed from `.restart-overlay`).
- **`contain: paint` / `content-visibility: auto` per element can make it WORSE,
  not better.** Each becomes its own compositing surface/blob; with many of them
  the GPU blows past its surface budget into a degraded, stuck-hot state. They
  did NOT help here — don't reach for them as a perf fix on Firefox.
- **Per-frame work scales with total DOM,** because a repaint/animation can trigger
  a full-document display-list rebuild. So cap streaming re-render rate (the live
  markdown stream is coalesced to ~5fps in `Part.tsx`) and prefer cheap DOM ops
  (the `StreamMd` engine appends text nodes; it never rewrites a growing node).
- Diagnosing: a bare repro page often won't reproduce it — the cost is the real
  app's complex scene. Capture a Firefox profiler trace and look under
  `Update the rendering → Paint` for `ViewportFrame::BuildDisplayList` (display
  list) vs `Grouper`/`GetBlobItemData` (blob raster). Headless browsers don't
  GPU-rasterize, so they can't reproduce the heat.

## Conventions

- State-changing `/vh/*` requests require the `X-VH-CSRF: 1` header (the SPA's
  `installCsrf()` adds it automatically; raw `fetch` in tests must set it).
- Per-project runtime data lives under `.vh-solara/` (gitignored). A project may
  commit `.vh-solara/project.jsonc` to declare managed processes — see
  [`docs/managed-projects.md`](docs/managed-projects.md).

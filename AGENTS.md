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

## Conventions

- State-changing `/vh/*` requests require the `X-VH-CSRF: 1` header (the SPA's
  `installCsrf()` adds it automatically; raw `fetch` in tests must set it).
- Per-project runtime data lives under `.vh-solara/` (gitignored). A project may
  commit `.vh-solara/project.jsonc` to declare managed processes — see
  [`docs/managed-projects.md`](docs/managed-projects.md).

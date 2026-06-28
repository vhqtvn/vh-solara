# vh-solara

vh-solara is a single Go binary that runs next to OpenCode on each machine: it aggregates OpenCode's state into a resumable, real-time view and serves a custom, mobile-first web UI (a SolidJS SPA, installable as a PWA) embedded via `//go:embed`. Each instance connects to a central controller through a persistent multiplexed WebSocket tunnel (yamux), so an operator can reach and drive any machine's OpenCode sessions from one URL with no inbound network access to the worker.

## Architecture

- Single Go binary (module `github.com/vhqtvn/vh-solara`, Go 1.25) that embeds the web UI via `//go:embed` and serves it from `pkg/web/dist/`.
- Web UI is a mobile-first SolidJS SPA built with Vite + TypeScript (installable as a PWA), source in `web/`; `pkg/web/dist/` holds a committed placeholder `index.html` so the Go build compiles without a frontend build.
- Controller<->worker topology: each worker opens an outbound, persistent multiplexed WebSocket tunnel (yamux) to a central controller, so workers expose no inbound ports; an operator reaches and drives any worker's OpenCode from one controller URL.
- Aggregates OpenCode session/subsession state into a resumable, real-time tree view (streaming chat, diffs, terminal, git actions), drivable from phone or desktop.
- Per-project managed processes and embedded views are declared via a repo-resident `.vh-solara/project.jsonc`.
- Tag-driven releases: pushing a `v*` tag triggers a GitHub Actions workflow that builds the SPA and stamps `cmd.Version` via ldflags.

## How to work here

- Read `AGENTS.md` for the full harness rules (term-contract, shell hygiene,
  command hygiene, delegation, commit gate, memory model).
- Run all commands through `vh-agent-harness exec`. Do not rely on host-installed tooling.
- The coordinator is read-only; delegate all coding/research/git to specialists.
- Git mutations route through the `committer` subagent (gated-commit protocol).
- Keep scratch under `./tmp/` (repo-relative). Never absolute home-dir paths.

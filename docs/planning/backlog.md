# Backlog

Canonical task-status source of truth for the vh-solara repo. One row per
task; status drives where it lives. Active work stays in `Now` / `Next` /
`Later`; completed/cancelled work moves to `Done` / `Cancelled` and is archived
under `docs/planning/archive/` by
`.opencode/scripts/normalize-backlog.js`.

Conventions live in [`AGENTS.md`](../../AGENTS.md) → "Backlog tracking rules".
Run `/backlog-cleanup` (or
`vh-agent-harness exec node .opencode/scripts/normalize-backlog.js`) after any
status change that completes, cancels, or reorders work, so the active sections
stay active-only and history is archived.

Row format: `| ID | Status | Area | Task | Owner | Notes | Links |`.
Statuses: `todo`, `in_progress`, `blocked`, `done`, `cancelled`. Put a
machine-readable completion date (`YYYY-MM-DD`) in `Notes` for `done` /
`cancelled` rows so the normalizer can file them into the right archive quarter.

## Area Legend

| Code | Boundary | Notes |
| --- | --- | --- |
| `WEB` | `web/` | SolidJS SPA (Vite + TS), embedded via `//go:embed`. |
| `API` | `pkg/web/`, `pkg/server/` | The `/vh/*` HTTP API + daemon handlers. |
| `TUNNEL` | `pkg/tunnel/` | Controller ↔ worker multiplexed WebSocket tunnel (yamux). |
| `AGG` | `pkg/aggregator/`, `pkg/state/`, `pkg/opencode/` | OpenCode state aggregation + session store. |
| `AUTH` | `pkg/auth/` | Controller auth / worker enrollment. |
| `PWA` | `web/public/`, manifest, service worker | Installable PWA surface. |
| `REL` | `.github/`, `install.sh`, `Dockerfile*`, `Makefile` | Tag-driven release + packaging. |
| `DOCS` | `docs/` | Durable repo guidance. |
| `HARNESS` | `.opencode/`, `.vh-agent-harness/` | Agent harness integration. |

## Archive Index

Older `done` and `cancelled` history lives under [docs/planning/archive/index.md](archive/index.md) and is meant for on-demand reading instead of auto-loading into the active backlog context.

- No archive files yet.

## Now

| ID | Status | Area | Task | Owner | Notes | Links |
| --- | --- | --- | --- | --- | --- | --- |

## Next

| ID | Status | Area | Task | Owner | Notes | Links |
| --- | --- | --- | --- | --- | --- | --- |
| P0-API-001 | todo | API | Tighten CSP `script-src` to `'self'` (drop `unsafe-inline` / `eval`) once stable. |  | From TODO at pkg/web/server.go:601. |  |
| P0-API-002 | todo | API | Map opencode session alias / share slug into `shapeSessions` once the pinned opencode version exposes it in session JSON. |  | From TODO at pkg/web/sessions.go:283. |  |

## Later

| ID | Status | Area | Task | Owner | Notes | Links |
| --- | --- | --- | --- | --- | --- | --- |

## Done

| ID | Status | Area | Task | Owner | Notes | Links |
| --- | --- | --- | --- | --- | --- | --- |
| P0-WEB-001 | done | WEB | Disable native pinch-zoom on mobile; keep the in-app UI-zoom slider as the only zoom (fixes the composer-floats / dead-space layout bug). |  | 2026-06-28 commit f301a94. |  |
| P0-WEB-002 | done | WEB | Raise UI-zoom ceiling to 200% (WCAG 1.4.4) and byte-mirror the initial viewport meta to runtime output. |  | 2026-06-28 commit 1221bcf. |  |

## Cancelled

| ID | Status | Area | Task | Owner | Notes | Links |
| --- | --- | --- | --- | --- | --- | --- |

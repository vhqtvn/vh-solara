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
| P1-WEB-001 | todo | WEB | Tighten or fix the dropped session-switch cursor save: a scroll-up→switch inside the 400ms debounce window fully misses (pending flushReadCursor cancelled before writing), so the scrolled-up position is lost entirely on reopen — comment overstates it as a one-idle-period lag. Either correct the comment, or add a synchronous cursor snapshot on switch for a stronger guarantee. |  | D-F1 from commit-review of acdef8e. ChatView.tsx session-switch effect (~:555-577) + scheduleReadCursor debounce (~:467-470). |  |
| P1-WEB-002 | todo | WEB | Extract isCursorAhead (the monotonic read-cursor invariant) into a pure orderAhead(cand, stored, order) helper in web/src/lib/scroll.ts and add unit-test cases (stored missing → true, cand===stored → false, cand newer, cand older, both absent). Currently a private closure in ChatView.tsx:505-510, untested. |  | D-F2 / A-F2 from commit-review of acdef8e. Model the tests on the existing bottommostRead tests in web/tests/unit/scroll.test.ts. |  |
| P1-WEB-003 | todo | WEB | Add Playwright e2e covering the browser-smoke gap for the scroll read-position feature: (a) stream into a following viewport, scroll up mid-stream, assert the .jump "↓ Latest" button appears; (b) reload with a stored read anchor and assert the viewport lands on the anchored [data-mid] row. |  | C-F1 / D-F3 from commit-review of acdef8e. Web e2e suite runs via `cd web && npx playwright test`; webServer is scripts/fixture-web.sh. |  |

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

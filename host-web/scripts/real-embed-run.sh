#!/usr/bin/env bash
# host-web/scripts/real-embed-run.sh — full local pipeline for the host-web
# real-embedding e2e lane (LANE 8). NOT PR-blocking; nightly-grade.
#
# Builds the production `web/` SPA, materializes it into pkg/web/dist/ (the
# //go:embed path), builds the real vh-solara binary, then runs the Playwright
# real-embed suite. The suite's webServer config (playwright.real-embed.config.ts)
# boots the real :8765 server (no-auth, --frame-ancestors) + the host :5183 dev
# server (VITE_IFRAME_ORIGIN=:8765) cross-origin and tears them down on exit.
#
# Cheapest-auth: --auth-mode none (the server default, loopback-permitted). No
# login step, no session cookie. See the spec header for the auth rationale.
#
# Requires: go (prefixed onto PATH here), Node >= 24, Playwright browsers
# installed (`npx playwright install chromium firefox` once).
#
# Usage:
#   bash host-web/scripts/real-embed-run.sh                 # full pipeline
#   bash host-web/scripts/real-embed-run.sh --project=chromium   # one engine
#   bash host-web/scripts/real-embed-run.sh --repeat-each=3  # stability measure
# Extra args are forwarded to `npx playwright test`.
#
# Or use the Makefile target: `make test-host-web-real-embed`.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

# go may not be on PATH (see AGENTS.md toolchain). Set INSIDE the bash payload,
# never as a host prefix before the harness.
export PATH="$PATH:/usr/local/go/bin"

echo "==> [1/5] build web/ SPA (into gitignored web/dist-build/)"
( cd web && npm ci && npm run build )

echo "==> [2/5] materialize SPA into pkg/web/dist/ (the //go:embed path)"
bash web/scripts/materialize.sh

echo "==> [3/5] build vh-solara binary (embeds the real SPA)"
go build -o vh-solara .

echo "==> [4/5] install host-web deps"
( cd host-web && npm ci )

echo "==> [5/5] run real-embed Playwright suite (webServer boots :8765 + :5183)"
# Forward any extra args (e.g. --project, --repeat-each, --grep) to Playwright.
( cd host-web && npx playwright test --config=playwright.real-embed.config.ts "$@" )

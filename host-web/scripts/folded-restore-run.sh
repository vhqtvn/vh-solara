#!/usr/bin/env bash
# host-web/scripts/folded-restore-run.sh — full local pipeline for the
# host-web FOLDED-POSTURE restore e2e lane (LANE 9).
#
# Builds BOTH SPAs (web/ + host-web with VITE_HOST_FOLDED=1), materializes
# them into pkg/web/dist + pkg/web/host-dist (the //go:embed paths), builds
# the real vh-solara binary to tmp/vh-solara-folded, then runs the Playwright
# folded-restore suite. The suite's webServer config (playwright.folded.config.ts)
# boots the real binary (local-server, --auth-mode none loopback default,
# dead --opencode-url) and drives the host shell the binary serves at `/` —
# the operator's production fold topology (same-origin /app pane iframes, no
# Vite dev server anywhere).
#
# This is the lane built for the round-3 on-device PWA relayout-loss
# diagnosis: every prior lane runs the host via the Vite DEV server (dev
# build, mock fleet, not folded), so a folded-build-specific restore defect
# was untestable before this lane existed.
#
# Requires: go (prefixed onto PATH here), Node >= 24, Playwright browsers
# (`npx playwright install chromium` once).
#
# Usage:
#   bash host-web/scripts/folded-restore-run.sh                # full pipeline
#   bash host-web/scripts/folded-restore-run.sh --project=chromium
# Extra args are forwarded to `npx playwright test`.
#
# Or the Makefile target: `make test-host-web-folded`.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

# go may not be on PATH (see AGENTS.md toolchain). Set INSIDE the bash payload,
# never as a host prefix before the harness.
export PATH="$PATH:/usr/local/go/bin"

echo "==> [1/5] build web/ SPA (into gitignored web/dist-build/)"
( cd web && npm ci && npm run build )

echo "==> [2/5] build host-web FOLDED (VITE_HOST_FOLDED=1, into host-web/dist)"
( cd host-web && npm ci && VITE_HOST_FOLDED=1 npm run build )

echo "==> [3/5] materialize BOTH SPAs into the Go embed dirs"
bash web/scripts/materialize.sh
bash host-web/scripts/materialize.sh

echo "==> [4/5] build vh-solara binary to tmp/vh-solara-folded (embeds both SPAs)"
go build -o tmp/vh-solara-folded .

echo "==> [5/5] run folded-restore Playwright suite (webServer boots the real :8811)"
( cd host-web && npx playwright test --config=playwright.folded.config.ts "$@" )

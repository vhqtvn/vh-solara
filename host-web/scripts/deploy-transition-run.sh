#!/usr/bin/env bash
# host-web/scripts/deploy-transition-run.sh — full local pipeline for the
# host-web DEPLOY-TRANSITION e2e lane (BUILD_ID deploy semantics, lane-9
# posture: dispatchable, NOT PR-blocking).
#
# Builds the web/ SPA TWICE — every build stamps a fresh BUILD_ID into
# sw.js (web/vite.config.ts swBuildId plugin: Date36+random, replacing
# web/public/sw.js's __BUILD_ID__ at closeBundle) — builds host-web FOLDED
# once (shared by both binaries), materializes each web dist into pkg/web/dist
# (the //go:embed path) and builds TWO real vh-solara binaries:
#
#   tmp/vh-solara-deploy-a  (embeds dist-a → serves stamp X)
#   tmp/vh-solara-deploy-b  (embeds dist-b → serves stamp Y)
#
# then runs the Playwright deploy-transition suite, whose spec boots binary A
# on :8821, warms the folded host + panes, KILLS A, boots B on the SAME port
# (the deploy), drives the SW update the product way, and asserts the four
# transition invariants (exactly-one pane reload, host not reloaded, caches
# reaped, panes stay controlled). This ports the S3a X6 cross-reload matrix
# (tmp-only fixtures) onto the REAL binary path.
#
# Receipts land in tmp/agent-runs/page-load-perf-deploy-lane/:
#   stamps.json      {a,b} — the two BUILD_IDs (asserted by the spec)
#   stamp-diff.txt   which artifacts differ between the two builds
#   receipts/…       per-engine transition receipts from the spec
#
# Requires: go (prefixed onto PATH here), Node >= 24, Playwright browsers
# (`npx playwright install chromium firefox` once).
#
# Usage:
#   bash host-web/scripts/deploy-transition-run.sh                # full pipeline
#   bash host-web/scripts/deploy-transition-run.sh --project=chromium
#   VH_DEPLOY_SKIP_BUILD=1 bash host-web/scripts/deploy-transition-run.sh
#     # reuse previously built tmp/vh-solara-deploy-{a,b} + stamps.json
# Extra args are forwarded to `npx playwright test`.
#
# Or the Makefile target: `make test-host-web-deploy-transition`.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

# go may not be on PATH (see AGENTS.md toolchain). Set INSIDE the bash payload,
# never as a host prefix before the harness.
export PATH="$PATH:/usr/local/go/bin"

lane_tmp="tmp/deploy-lane"
artifacts="tmp/agent-runs/page-load-perf-deploy-lane"
mkdir -p "$lane_tmp" "$artifacts"

# Materialize a web dist dir into pkg/web/dist (mirror of
# web/scripts/materialize.sh, sourced from the lane cache instead of
# web/dist-build). Preserves the tracked placeholder.html.
materialize_web_dist() {
  local src="$1"
  local dest="pkg/web/dist"
  rm -rf "$dest/assets" "$dest"/index.html "$dest"/*.js "$dest"/*.map \
    "$dest"/*.webmanifest "$dest"/*.svg "$dest"/*.png 2>/dev/null || true
  cp -r "$src/." "$dest/"
}

extract_stamp() {
  sed -n 's/^const BUILD_ID = "\(.*\)";$/\1/p' "$1/sw.js"
}

if [ "${VH_DEPLOY_SKIP_BUILD:-0}" != "1" ]; then
  echo "==> [1/6] build web/ SPA twice (two BUILD_ID stamps) into $lane_tmp"
  ( cd web && { [ -d node_modules ] || npm ci; } && npm run build )
  rm -rf "$lane_tmp/dist-a"
  cp -r web/dist-build "$lane_tmp/dist-a"
  ( cd web && npm run build )
  rm -rf "$lane_tmp/dist-b"
  cp -r web/dist-build "$lane_tmp/dist-b"

  stamp_a="$(extract_stamp "$lane_tmp/dist-a")"
  stamp_b="$(extract_stamp "$lane_tmp/dist-b")"
  if [ -z "$stamp_a" ] || [ -z "$stamp_b" ]; then
    echo "FATAL: BUILD_ID stamp missing (a='$stamp_a' b='$stamp_b') — is sw.js stamped?" >&2
    exit 1
  fi
  if [ "$stamp_a" = "$stamp_b" ]; then
    echo "FATAL: the two web builds produced the SAME BUILD_ID ($stamp_a)" >&2
    exit 1
  fi
  printf 'stamp A (tmp/vh-solara-deploy-a): %s\nstamp B (tmp/vh-solara-deploy-b): %s\n' \
    "$stamp_a" "$stamp_b" | tee "$artifacts/stamps.txt"
  printf '{"a":"%s","b":"%s"}\n' "$stamp_a" "$stamp_b" > "$artifacts/stamps.json"
  # Receipt: which artifacts differ between the two builds (expected: sw.js only).
  diff -rq "$lane_tmp/dist-a" "$lane_tmp/dist-b" > "$artifacts/stamp-diff.txt" || true
  echo "    build delta (expected sw.js only):"
  sed 's/^/      /' "$artifacts/stamp-diff.txt"

  echo "==> [2/6] build host-web FOLDED (VITE_HOST_FOLDED=1, shared by both binaries)"
  ( cd host-web && { [ -d node_modules ] || npm ci; } && VITE_HOST_FOLDED=1 npm run build )
  bash host-web/scripts/materialize.sh

  echo "==> [3/6] materialize dist-a + build binary A (tmp/vh-solara-deploy-a)"
  materialize_web_dist "$lane_tmp/dist-a"
  go build -o tmp/vh-solara-deploy-a .

  echo "==> [4/6] materialize dist-b + build binary B (tmp/vh-solara-deploy-b)"
  materialize_web_dist "$lane_tmp/dist-b"
  go build -o tmp/vh-solara-deploy-b .

  echo "==> [5/6] binaries built; pkg/web/dist left materialized with dist-b (gitignored)"
else
  echo "==> VH_DEPLOY_SKIP_BUILD=1 — reusing tmp/vh-solara-deploy-{a,b} + $artifacts/stamps.json"
  [ -f "$artifacts/stamps.json" ] || { echo "FATAL: $artifacts/stamps.json missing — run the full pipeline once" >&2; exit 1; }
fi

echo "==> [6/6] run deploy-transition Playwright suite (spec boots/swaps the real :${VH_DEPLOY_PORT:-8821})"
( cd host-web && npx playwright test --config=playwright.deploy-transition.config.ts "$@" )

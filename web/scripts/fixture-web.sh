#!/usr/bin/env bash
# Build the SPA, then serve it via the real aggregator + web server backed by
# the fake OpenCode fixtures. Used as the Playwright webServer (fixture lane)
# and runnable directly for manual browser checks.
set -euo pipefail

ADDR="${VH_FIXTURE_ADDR:-127.0.0.1:8099}"

web_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$web_dir/.." && pwd)"

echo "[fixture-web] building SPA…"
(cd "$web_dir" && npm run build >/dev/null)

echo "[fixture-web] materializing staged SPA into pkg/web/dist…"
bash "$web_dir/scripts/materialize.sh"

echo "[fixture-web] starting fixture server on $ADDR"
cd "$repo_root"
# Demo quota for the Usage panel is baked into fixtureserver (VH_QUOTA_FIXTURE);
# export it here only to override.
exec go run ./tools/fixtureserver -addr "$ADDR"

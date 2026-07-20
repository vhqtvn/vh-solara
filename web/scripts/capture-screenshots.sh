#!/usr/bin/env bash
# Build the SPA, serve it through the real aggregator + web fixture server, and
# capture the two PWA store screenshots (wide desktop + narrow mobile) into
# web/public/screenshots/. Re-runnable: run as `bash web/scripts/capture-screenshots.sh`.
#
# Output PNGs are tracked under web/public/ so the materialize step copies them
# into pkg/web/dist/ for the embed. Do NOT commit anything under pkg/web/dist/.
set -euo pipefail

ADDR="${VH_FIXTURE_ADDR:-127.0.0.1:8099}"
web_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$web_dir/.." && pwd)"

echo "[capture] building SPA…"
(cd "$web_dir" && npm run build >/dev/null)

echo "[capture] materializing staged SPA into pkg/web/dist…"
bash "$web_dir/scripts/materialize.sh"

# The consolidated demo project dir MUST be a real writable path on disk. Match
# the default the Playwright config and fixture-web.sh use so the seeded demo
# sessions are the ones the capture clicks open.
export VH_DEMO_DIR="${VH_DEMO_DIR:-$repo_root/tmp/fixture-demo}"

echo "[capture] starting fixture server on $ADDR"
cd "$repo_root"
go run ./tools/fixtureserver -addr "$ADDR" >/tmp/vh-capture-srv.log 2>&1 &
srv=$!
trap 'kill $srv 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -fsS "http://$ADDR/" >/dev/null 2>&1 && break
  sleep 0.3
done

BASE="http://$ADDR" node "$web_dir/scripts/capture-screenshots.mjs"

#!/usr/bin/env bash
# Chat-view performance benchmark: builds the SPA, serves it via the fixture
# server seeded with VH_BENCH_MESSAGES (default 300) complex messages (markdown
# + code + tool calls + diffs), and runs scripts/bench.mjs to report
# load-to-render, DOM size, content-visibility effectiveness, scroll jank and
# JS heap. Needs Node >= 24.
set -euo pipefail

N="${VH_BENCH_MESSAGES:-300}"
ADDR="${VH_FIXTURE_ADDR:-127.0.0.1:8099}"
web_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$web_dir/.." && pwd)"

echo "[bench] building SPA…"
(cd "$web_dir" && npm run build >/dev/null)

echo "[bench] starting fixture server ($N messages) on $ADDR"
cd "$repo_root"
VH_BENCH_MESSAGES="$N" go run ./tools/fixtureserver -addr "$ADDR" >/tmp/vh-bench-srv.log 2>&1 &
srv=$!
trap 'kill $srv 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -fsS "http://$ADDR/" >/dev/null 2>&1 && break
  sleep 0.3
done

BASE="http://$ADDR" node "$web_dir/scripts/bench.mjs"

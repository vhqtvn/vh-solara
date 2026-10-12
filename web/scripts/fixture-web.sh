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
# The consolidated demo project dir MUST be a real writable path on disk (the
# attach-upload handler writes <dir>/.vh-solara/sessions/<id>/attachments). The
# fixtureserver creates it and repoints the Go fixture at it; the TS test
# harness computes the SAME repo-relative path (playwright.config.ts) so both
# agree. Overridable via VH_DEMO_DIR.
export VH_DEMO_DIR="${VH_DEMO_DIR:-$repo_root/tmp/fixture-demo}"
# Demo quota for the Usage panel is baked into fixtureserver (VH_QUOTA_FIXTURE);
# export it here only to override.
#
# Opt-in daemon dispatch (queue-delivery-custody lane): VH_FIXTURE_DAEMON_DISPATCH=1
# forwards the fixtureserver's existing -daemon-dispatch flag so the daemon's
# custody drain loop owns queue dispatch (browser observe-only). DEFAULT
# UNCHANGED: unset/0 keeps the browser-dispatch posture the ordinary lane-6
# suite runs under (no extra flag is passed — behaviorally identical).
extra_args=""
if [[ "${VH_FIXTURE_DAEMON_DISPATCH:-0}" == "1" ]]; then
  extra_args="-daemon-dispatch"
  echo "[fixture-web] daemon dispatch ENABLED (queue custody active)"
fi
exec go run ./tools/fixtureserver -addr "$ADDR" $extra_args

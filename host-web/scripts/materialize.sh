#!/usr/bin/env bash
# Materialize the staged host shell (host-web/dist/) into the Go embed dir
# (pkg/web/host-dist/). Mirror of web/scripts/materialize.sh.
#
# Clean generated outputs first to avoid stale-asset accumulation across repeated
# local builds. The cleanup removes generated artifacts (stale index.html, assets/,
# *.js, *.map) but EXPLICITLY preserves the tracked pkg/web/host-dist/placeholder.html
# (the cold-build fallback banner). Safe on a cold clone with empty staging
# (cp is a no-op; placeholder.html untouched).
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
staging="$repo_root/host-web/dist"
dest="$repo_root/pkg/web/host-dist"
# Remove generated host artifacts, preserving the tracked placeholder.html.
rm -rf "$dest/assets" "$dest"/index.html "$dest"/*.js "$dest"/*.map 2>/dev/null || true
cp -r "$staging/." "$dest/"
